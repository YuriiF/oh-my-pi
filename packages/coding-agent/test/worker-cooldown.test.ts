import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	classifyWorkerError,
	WorkerCooldownStore,
} from "@oh-my-pi/pi-coding-agent/mnemosyne/worker-cooldown";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("classifyWorkerError", () => {
	test("auth statuses (401/403) never cool down", () => {
		expect(classifyWorkerError({ status: 401, message: "Unauthorized" }).cooldown).toBe(false);
		expect(classifyWorkerError({ status: 403, message: "Forbidden" }).cooldown).toBe(false);
	});

	test("auth-shaped messages without a status never cool down", () => {
		const cases = [
			new Error("503 auth_unavailable: no auth available (providers=codex, model=gpt-5)"),
			new Error("invalid api_key for provider"),
			new Error("authentication error: token expired"),
		];
		for (const error of cases) {
			expect(classifyWorkerError(error)).toMatchObject({ cooldown: false });
		}
	});

	test("schema/tool/model errors never cool down", () => {
		expect(classifyWorkerError(new Error("schema validation failed: missing field"))).toMatchObject({
			cooldown: false,
		});
		expect(classifyWorkerError(new Error("Unknown model: gpt-9000-pro"))).toMatchObject({ cooldown: false });
		expect(classifyWorkerError({ status: 400, message: "Bad request: parameters invalid" })).toMatchObject({
			cooldown: false,
		});
	});

	test("aborts never cool down", () => {
		const abort = new Error("aborted");
		abort.name = "AbortError";
		expect(classifyWorkerError(abort).cooldown).toBe(false);
	});

	test("429 / rate limit / 5xx / timeout / network classify as retryable buckets", () => {
		expect(classifyWorkerError({ status: 429, message: "rate limited" })).toMatchObject({
			cooldown: true,
			bucket: "rate_limit",
		});
		expect(classifyWorkerError(new Error("too many requests, retry later"))).toMatchObject({
			cooldown: true,
			bucket: "rate_limit",
		});
		expect(classifyWorkerError({ status: 502, message: "Bad Gateway" })).toMatchObject({
			cooldown: true,
			bucket: "server_error",
		});
		expect(classifyWorkerError(new Error("timed out after 60s"))).toMatchObject({
			cooldown: true,
			bucket: "timeout",
		});
		expect(classifyWorkerError(new Error("ECONNRESET while streaming"))).toMatchObject({
			cooldown: true,
			bucket: "network",
		});
		expect(classifyWorkerError(new Error("service unavailable"))).toMatchObject({
			cooldown: true,
			bucket: "server_error",
		});
	});

	test("unknown errors never cool down (fail open to avoid silencing usable models)", () => {
		expect(classifyWorkerError(new Error("the moon was full"))).toMatchObject({ cooldown: false });
	});
});

describe("WorkerCooldownStore", () => {
	let tempDir: TempDir;
	let storePath: string;

	beforeEach(() => {
		tempDir = TempDir.createSync("@omp-worker-cooldown-");
		storePath = path.join(tempDir.path(), "worker-cooldowns.json");
	});

	afterEach(async () => {
		await tempDir.remove();
	});

	test("auth/abort/schema errors are NOT recorded", () => {
		const store = new WorkerCooldownStore(storePath);
		expect(store.record("observer", "p", "m", { status: 401, message: "auth" })).toBeUndefined();
		expect(store.record("observer", "p", "m", new Error("schema validation failed"))).toBeUndefined();
		const abort = new Error("aborted");
		abort.name = "AbortError";
		expect(store.record("observer", "p", "m", abort)).toBeUndefined();
		expect(store.isCooled("observer", "p", "m")).toBe(false);
	});

	test("429 is recorded with the requested TTL, clamped to [min, max]", () => {
		const store = new WorkerCooldownStore(storePath, { minHours: 1, maxHours: 4 });
		const now = 1_700_000_000_000;
		const entry = store.record("observer", "openai", "gpt", { status: 429, message: "rate" }, { hours: 2, now });
		expect(entry).toBeDefined();
		expect(entry!.bucket).toBe("rate_limit");
		expect(entry!.untilMs).toBe(now + 2 * 3_600_000);

		store.record("observer", "openai", "gpt", { status: 429, message: "rate" }, { hours: 12, now });
		expect(store.snapshot(now)[0].untilMs).toBe(now + 4 * 3_600_000);

		store.record("observer", "openai", "gpt", { status: 429, message: "rate" }, { hours: 0.001, now });
		expect(store.snapshot(now)[0].untilMs).toBe(now + 1 * 3_600_000);
	});

	test("cooldowns are per (worker, provider, model) so the observer never silences the reflector", () => {
		const store = new WorkerCooldownStore(storePath);
		const now = 1_000;
		store.record("observer", "openai", "gpt-5", { status: 429, message: "rate" }, { hours: 1, now });

		expect(store.isCooled("observer", "openai", "gpt-5", now + 1)).toBe(true);
		expect(store.isCooled("reflector", "openai", "gpt-5", now + 1)).toBe(false);
		expect(store.isCooled("observer", "openai", "gpt-4o", now + 1)).toBe(false);
		expect(store.isCooled("observer", "anthropic", "gpt-5", now + 1)).toBe(false);
	});

	test("expired entries self-clean on read and via expire()", () => {
		const store = new WorkerCooldownStore(storePath);
		store.record("observer", "p", "m", { status: 500, message: "err" }, { hours: 1, now: 0 });
		const past = 10 * 3_600_000;
		expect(store.isCooled("observer", "p", "m", past)).toBe(false);
		expect(store.snapshot(past)).toHaveLength(0);

		store.record("observer", "p", "m2", { status: 500, message: "err" }, { hours: 1, now: 0 });
		store.expire(past);
		expect(store.snapshot(past)).toHaveLength(0);
	});

	test("a corrupt file is quarantined and the store proceeds with an empty ledger", () => {
		fs.mkdirSync(path.dirname(storePath), { recursive: true });
		fs.writeFileSync(storePath, "{not valid json", "utf-8");

		const store = new WorkerCooldownStore(storePath);
		expect(store.snapshot()).toHaveLength(0);

		store.record("observer", "p", "m", { status: 503, message: "down" }, { hours: 1, now: 5 });
		expect(store.isCooled("observer", "p", "m", 6)).toBe(true);

		const siblings = fs.readdirSync(path.dirname(storePath));
		expect(siblings.some(name => name.startsWith("worker-cooldowns.json.corrupt-"))).toBe(true);
	});

	test("two independent stores converge on the latest entry through atomic disk writes", () => {
		const a = new WorkerCooldownStore(storePath);
		const b = new WorkerCooldownStore(storePath);
		const now = 1_000;
		a.record("observer", "openai", "gpt", { status: 429, message: "rate" }, { hours: 1, now });
		b.record("reflector", "openai", "gpt", { status: 500, message: "err" }, { hours: 2, now });

		// Both writes must persist; a fresh reader sees both, regardless of order.
		const seen = new WorkerCooldownStore(storePath).snapshot(now + 1);
		const keys = seen.map(entry => `${entry.workerKind}/${entry.provider}/${entry.modelId}`).sort();
		expect(keys).toEqual(["observer/openai/gpt", "reflector/openai/gpt"]);
	});
});
