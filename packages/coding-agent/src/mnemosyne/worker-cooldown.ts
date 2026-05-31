/**
 * Worker-scoped persistent model cooldown store.
 *
 * Derived from the MIT-licensed pi-blackhole cooldown design
 * (`src/om/cooldown.ts`), rewritten for omp:
 *
 *  - Per (workerKind, provider, modelId) keys so a rate-limit on the observer
 *    worker never silences the reflector or the user's interactive model.
 *  - Structured classification first (HTTP `status`, then narrow regex), with
 *    auth (401/403), schema/validation, abort, and unknown errors explicitly
 *    excluded from cooldown to avoid silently suppressing usable models.
 *  - Atomic JSON writes via temp-file + rename. Corrupt files are renamed to
 *    `<path>.corrupt-<ts>` and replaced with an empty document rather than
 *    silently wiped.
 *  - Min/max TTL clamping so a bad config cannot suppress a worker model for
 *    arbitrarily long.
 */
import * as fs from "node:fs";
import * as path from "node:path";

const DEFAULT_MIN_HOURS = 0.25;
const DEFAULT_MAX_HOURS = 8;

const STATUS_RATE_LIMIT_BUCKET: CooldownBucket = "rate_limit";
const STATUS_SERVER_BUCKET: CooldownBucket = "server_error";

/** Coarse reason a worker model was cooled down. */
export type CooldownBucket = "rate_limit" | "server_error" | "timeout" | "network";

/** Result of classifying an error before deciding whether to cool a model down. */
export interface CooldownClassification {
	cooldown: boolean;
	bucket?: CooldownBucket;
	reason: string;
}

/** Persisted shape on disk. */
export interface CooldownEntry {
	workerKind: string;
	provider: string;
	modelId: string;
	untilMs: number;
	reason: string;
	bucket: CooldownBucket;
}

/** Options for a {@link WorkerCooldownStore}. */
export interface WorkerCooldownStoreOptions {
	/** Floor on cooldown duration in hours. */
	minHours?: number;
	/** Ceiling on cooldown duration in hours. Bad config must not suppress a model indefinitely. */
	maxHours?: number;
}

/**
 * Inspect an error and decide whether it should cool down its source model.
 *
 * The classification gates `WorkerCooldownStore.record()` calls; auth errors
 * (`401`/`403`), invalid-model errors, prompt/tool/schema validation failures,
 * and abort signals are NEVER eligible — those are operator-fixable and would
 * silently silence a model for hours otherwise.
 */
export function classifyWorkerError(error: unknown): CooldownClassification {
	const status = readErrorStatus(error);
	const name = readErrorName(error);
	const message = readErrorMessage(error);

	if (name === "AbortError") return { cooldown: false, reason: "aborted" };
	if (status === 401 || status === 403) return { cooldown: false, reason: `auth ${status}` };
	if (status === 400 || status === 404 || status === 422) {
		return { cooldown: false, reason: `client ${status}` };
	}
	if (status === 429) {
		return { cooldown: true, bucket: STATUS_RATE_LIMIT_BUCKET, reason: "HTTP 429 rate limited" };
	}
	if (status !== undefined && status >= 500 && status < 600) {
		return { cooldown: true, bucket: STATUS_SERVER_BUCKET, reason: `HTTP ${status} server error` };
	}

	if (/\bAbortError\b/.test(message)) return { cooldown: false, reason: "aborted" };
	// Auth-shaped messages without a status (pi-native gateway, custom transports)
	// must NOT cool down — see issue #986 / unauthorized signals.
	if (/\bauth(?:entication)?(?:_| )(?:error|unavailable)\b/i.test(message)) {
		return { cooldown: false, reason: "auth error" };
	}
	if (/\binvalid\s+(?:api[_-]?key|credential|token)\b/i.test(message)) {
		return { cooldown: false, reason: "invalid credential" };
	}
	if (/\bunknown\s+model\b|\bmodel\s+not\s+found\b|\binvalid\s+model\b/i.test(message)) {
		return { cooldown: false, reason: "model misconfigured" };
	}
	if (/\bschema\s+validation\b|\bparameters?\s+invalid\b|\bToolError\b|\btypebox\b/i.test(message)) {
		return { cooldown: false, reason: "tool/schema error" };
	}

	if (/\b(?:rate[_ ]?limit(?:ed)?|too\s+many\s+requests)\b/i.test(message)) {
		return { cooldown: true, bucket: STATUS_RATE_LIMIT_BUCKET, reason: "rate limit" };
	}
	if (/\b(?:timed?\s*out|timeout|deadline\s+exceeded)\b/i.test(message)) {
		return { cooldown: true, bucket: "timeout", reason: "timeout" };
	}
	if (
		/\b(?:ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|fetch\s+failed|socket\s+hang\s+up|network\s+error|connection\s+(?:reset|refused|lost))\b/i.test(
			message,
		)
	) {
		return { cooldown: true, bucket: "network", reason: "network failure" };
	}
	if (
		/\b(?:service\s+unavailable|server\s+error|internal\s+error|upstream\s+error|bad\s+gateway|overloaded)\b/i.test(
			message,
		)
	) {
		return { cooldown: true, bucket: STATUS_SERVER_BUCKET, reason: "upstream/server error" };
	}

	return { cooldown: false, reason: "unrecognized" };
}

/**
 * Persistent, lock-free cooldown ledger for worker models.
 *
 * All public methods perform a fresh read-modify-write so independent processes
 * (e.g. crash-restarted workers) converge on the latest state. The JSON write
 * itself is atomic via temp-file + rename; on corruption the bad file is
 * preserved with a timestamp suffix and the in-memory state is reset to empty.
 */
export class WorkerCooldownStore {
	readonly path: string;
	readonly #minMs: number;
	readonly #maxMs: number;

	constructor(filePath: string, options: WorkerCooldownStoreOptions = {}) {
		this.path = filePath;
		this.#minMs = clampPositive(options.minHours ?? DEFAULT_MIN_HOURS) * 3_600_000;
		this.#maxMs = clampPositive(options.maxHours ?? DEFAULT_MAX_HOURS) * 3_600_000;
	}

	/** Whether the given (worker, provider, model) triple is currently suppressed. */
	isCooled(workerKind: string, provider: string, modelId: string, now: number = Date.now()): boolean {
		const entries = this.#read();
		const key = entryKey(workerKind, provider, modelId);
		const entry = entries.get(key);
		if (!entry) return false;
		if (entry.untilMs <= now) {
			entries.delete(key);
			this.#write(entries);
			return false;
		}
		return true;
	}

	/**
	 * Record a cooldown for a (worker, provider, model) triple if the error
	 * classifies as retryable. Returns the entry that was written, or
	 * `undefined` when the error was not eligible (auth, schema, abort, …).
	 */
	record(
		workerKind: string,
		provider: string,
		modelId: string,
		error: unknown,
		options: { hours?: number; now?: number } = {},
	): CooldownEntry | undefined {
		const classification = classifyWorkerError(error);
		if (!classification.cooldown || !classification.bucket) return undefined;

		const now = options.now ?? Date.now();
		const requestedMs = Math.max(0, (options.hours ?? 1) * 3_600_000);
		const ttlMs = Math.min(this.#maxMs, Math.max(this.#minMs, requestedMs));
		const entry: CooldownEntry = {
			workerKind,
			provider,
			modelId,
			untilMs: now + ttlMs,
			reason: classification.reason,
			bucket: classification.bucket,
		};

		const entries = this.#read();
		entries.set(entryKey(workerKind, provider, modelId), entry);
		this.#write(entries);
		return entry;
	}

	/** Drop every entry whose TTL has elapsed. */
	expire(now: number = Date.now()): void {
		const entries = this.#read();
		let changed = false;
		for (const [key, entry] of entries) {
			if (entry.untilMs <= now) {
				entries.delete(key);
				changed = true;
			}
		}
		if (changed) this.#write(entries);
	}

	/** Read-only snapshot for diagnostics and UI surfaces (e.g. `/memory stats`). */
	snapshot(now: number = Date.now()): CooldownEntry[] {
		const entries = this.#read();
		const live: CooldownEntry[] = [];
		for (const entry of entries.values()) {
			if (entry.untilMs > now) live.push(entry);
		}
		live.sort((a, b) => a.untilMs - b.untilMs);
		return live;
	}

	/** Wipe the cooldown ledger entirely. Used by `/memory clear` and tests. */
	clear(): void {
		this.#write(new Map());
	}

	#read(): Map<string, CooldownEntry> {
		let raw: string;
		try {
			raw = fs.readFileSync(this.path, "utf-8");
		} catch (error) {
			if (isEnoentLike(error)) return new Map();
			return new Map();
		}
		try {
			const parsed = JSON.parse(raw);
			if (!Array.isArray(parsed)) return new Map();
			const map = new Map<string, CooldownEntry>();
			for (const candidate of parsed) {
				const entry = normalizeEntry(candidate);
				if (!entry) continue;
				map.set(entryKey(entry.workerKind, entry.provider, entry.modelId), entry);
			}
			return map;
		} catch {
			this.#quarantineCorrupt(raw);
			return new Map();
		}
	}

	#write(entries: Map<string, CooldownEntry>): void {
		try {
			fs.mkdirSync(path.dirname(this.path), { recursive: true });
		} catch (error) {
			if (!isEexistLike(error)) return;
		}
		const tmp = `${this.path}.tmp-${process.pid}-${Date.now().toString(36)}`;
		const payload = `${JSON.stringify([...entries.values()], null, 2)}\n`;
		try {
			fs.writeFileSync(tmp, payload, { encoding: "utf-8" });
			fs.renameSync(tmp, this.path);
		} catch {
			try {
				fs.unlinkSync(tmp);
			} catch {
				/* ignore */
			}
		}
	}

	#quarantineCorrupt(raw: string): void {
		try {
			const suffix = `${Date.now().toString(36)}-${process.pid}`;
			fs.writeFileSync(`${this.path}.corrupt-${suffix}`, raw, { encoding: "utf-8" });
		} catch {
			/* best-effort */
		}
	}
}

function entryKey(workerKind: string, provider: string, modelId: string): string {
	return `${workerKind}\u0000${provider}\u0000${modelId}`;
}

function normalizeEntry(candidate: unknown): CooldownEntry | undefined {
	if (!candidate || typeof candidate !== "object") return undefined;
	const c = candidate as Record<string, unknown>;
	const workerKind = typeof c.workerKind === "string" ? c.workerKind : undefined;
	const provider = typeof c.provider === "string" ? c.provider : undefined;
	const modelId = typeof c.modelId === "string" ? c.modelId : undefined;
	const untilMs = typeof c.untilMs === "number" && Number.isFinite(c.untilMs) ? c.untilMs : undefined;
	const reason = typeof c.reason === "string" ? c.reason : "";
	const bucket = readBucket(c.bucket);
	if (!workerKind || !provider || !modelId || untilMs === undefined || !bucket) return undefined;
	return { workerKind, provider, modelId, untilMs, reason, bucket };
}

function readBucket(value: unknown): CooldownBucket | undefined {
	if (value === "rate_limit" || value === "server_error" || value === "timeout" || value === "network") return value;
	return undefined;
}

function clampPositive(value: number): number {
	if (!Number.isFinite(value) || value <= 0) return DEFAULT_MIN_HOURS;
	return value;
}

function readErrorStatus(error: unknown): number | undefined {
	if (!error || typeof error !== "object") return undefined;
	const status = (error as { status?: unknown }).status;
	if (typeof status === "number" && Number.isFinite(status)) return status;
	return undefined;
}

function readErrorName(error: unknown): string {
	if (!error || typeof error !== "object") return "";
	const name = (error as { name?: unknown }).name;
	return typeof name === "string" ? name : "";
}

function readErrorMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	if (typeof error === "string") return error;
	if (error && typeof error === "object" && "message" in error && typeof error.message === "string") {
		return error.message;
	}
	return "";
}

function isEnoentLike(error: unknown): boolean {
	return Boolean(error && typeof error === "object" && (error as { code?: unknown }).code === "ENOENT");
}

function isEexistLike(error: unknown): boolean {
	return Boolean(error && typeof error === "object" && (error as { code?: unknown }).code === "EEXIST");
}
