/**
 * Source-addressed observation contract for Mnemosyne.
 *
 * Derived from the MIT-licensed pi-observational-memory / pi-blackhole
 * observation model, mapped onto Mnemosyne's existing working-memory rows
 * rather than a parallel ledger. The plan in #1565 promised three things:
 *
 *  1. **Source-addressed evidence.** Every observation carries the set of
 *     session entry ids it was distilled from, so a downstream recall surface
 *     can show *why* the model believes the fact, not just the fact itself.
 *  2. **Relevance-driven retention.** Observations are graded `low` /
 *     `medium` / `high` / `critical`. The dropper (Chunk 3) uses this to
 *     decide which observations to expire when the pool grows.
 *  3. **Idempotent writes.** Each observation has a deterministic id (hash
 *     of content + timestamp + source ids) so re-running the observer over
 *     overlapping windows never duplicates rows.
 *
 * Storage uses Mnemosyne's standard `metadata` JSON column; no schema
 * migration is required.  See {@link OBSERVATION_METADATA_VERSION} for the
 * version pin that future migrations must check before mutating shape.
 */
import type { MnemosyneSessionState } from "./state";

/**
 * Reserved `metadata.kind` value identifying rows produced by the observer
 * worker. Recall coupling, the dropper, and any future debugging UI MUST
 * filter on this key rather than guessing from the `source` field, since
 * unrelated retain paths share the same source labels.
 */
export const OBSERVATION_METADATA_KIND = "blackhole.observation" as const;

/**
 * Schema version pin for observation metadata. Bump when changing the
 * persisted shape so downstream code can branch instead of silently
 * misreading old rows.
 */
export const OBSERVATION_METADATA_VERSION = 1 as const;

/** Relevance grade carried by every observation. Drives dropper decisions. */
export type ObservationRelevance = "low" | "medium" | "high" | "critical";

/** Importance score mapping for {@link ObservationRelevance}. */
export const OBSERVATION_RELEVANCE_IMPORTANCE: Readonly<Record<ObservationRelevance, number>> = {
	low: 0.2,
	medium: 0.5,
	high: 0.75,
	critical: 0.95,
};

/** Input payload accepted by {@link buildObservationMetadata}. */
export interface ObservationInput {
	content: string;
	/**
	 * Local time in `YYYY-MM-DD HH:MM` format as captured by the observer
	 * worker. Falls back to the current wall clock when omitted.
	 */
	timestamp?: string;
	relevance: ObservationRelevance;
	/**
	 * Source entry ids from the session manager's branch view that directly
	 * support this observation. Must be non-empty; an observation with no
	 * provable source is not recordable.
	 */
	sourceEntryIds: readonly string[];
	/**
	 * Optional extra metadata supplied by the caller (e.g. worker model ids,
	 * batch numbers). Merged shallowly with the framework-managed fields, but
	 * may NOT overwrite the reserved `kind`/`version` keys.
	 */
	extra?: Record<string, unknown>;
}

/** Persisted shape stored under Mnemosyne `metadata`. */
export interface ObservationMetadata {
	kind: typeof OBSERVATION_METADATA_KIND;
	version: typeof OBSERVATION_METADATA_VERSION;
	relevance: ObservationRelevance;
	source_entry_ids: readonly string[];
	captured_at: string;
	[key: string]: unknown;
}

/**
 * Build the Mnemosyne metadata payload for an observation. Pure / deterministic;
 * no I/O. Callers compose this with `MnemosyneSessionState.rememberInScope` so
 * worker code can be unit-tested without spinning up a database.
 */
export function buildObservationMetadata(observation: ObservationInput): ObservationMetadata {
	if (observation.sourceEntryIds.length === 0) {
		throw new Error("Observation requires at least one sourceEntryId");
	}
	const captured = observation.timestamp?.trim() || formatLocalTimestamp(new Date());
	const sourceEntryIds = dedupeSourceEntryIds(observation.sourceEntryIds);
	const extra = observation.extra ?? {};
	return {
		...extra,
		kind: OBSERVATION_METADATA_KIND,
		version: OBSERVATION_METADATA_VERSION,
		relevance: observation.relevance,
		source_entry_ids: sourceEntryIds,
		captured_at: captured,
	};
}

/**
 * Map an {@link ObservationRelevance} to the importance score Mnemosyne uses
 * for ranking and dropper decisions.
 */
export function importanceFromRelevance(relevance: ObservationRelevance): number {
	return OBSERVATION_RELEVANCE_IMPORTANCE[relevance];
}

/**
 * Recover an observation's source entry ids from a recall row. Returns
 * `undefined` for rows that do not carry the observation metadata kind so
 * callers can drop non-observations without case-analysing shapes.
 */
export function readObservationMetadata(row: {
	metadata?: unknown;
	metadata_json?: unknown;
}): ObservationMetadata | undefined {
	const raw = pickMetadata(row);
	if (!raw) return undefined;
	if ((raw as { kind?: unknown }).kind !== OBSERVATION_METADATA_KIND) return undefined;
	const candidate = raw as Partial<ObservationMetadata>;
	if (typeof candidate.version !== "number") return undefined;
	if (!isRelevance(candidate.relevance)) return undefined;
	if (!Array.isArray(candidate.source_entry_ids)) return undefined;
	if (!candidate.source_entry_ids.every(id => typeof id === "string" && id.length > 0)) return undefined;
	if (typeof candidate.captured_at !== "string") return undefined;
	return candidate as ObservationMetadata;
}

/**
 * Persist an observation through {@link MnemosyneSessionState.rememberInScope}.
 *
 * Returns the Mnemosyne id assigned to the new row, or `undefined` if the
 * scoped retain target rejected the write (e.g. read-only filesystem, schema
 * conflict). The caller is responsible for tracking coverage markers — this
 * helper deliberately does not infer them so the same code path can be used
 * by manual `/memory retain` flows that have no observer notion of coverage.
 */
export function recordObservation(state: MnemosyneSessionState, observation: ObservationInput): string | undefined {
	const metadata = buildObservationMetadata(observation);
	return state.rememberInScope(
		{ content: observation.content },
		{
			source: "blackhole-observation",
			memoryType: "observation",
			veracity: "inferred",
			importance: importanceFromRelevance(observation.relevance),
			timestamp: metadata.captured_at,
			metadata: metadata as unknown as Record<string, never>,
		},
	);
}

function dedupeSourceEntryIds(ids: readonly string[]): readonly string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const id of ids) {
		if (!id || seen.has(id)) continue;
		seen.add(id);
		out.push(id);
	}
	return out;
}

function isRelevance(value: unknown): value is ObservationRelevance {
	return value === "low" || value === "medium" || value === "high" || value === "critical";
}

function pickMetadata(row: { metadata?: unknown; metadata_json?: unknown }): Record<string, unknown> | undefined {
	const direct = row.metadata;
	if (direct && typeof direct === "object") return direct as Record<string, unknown>;
	const serialized = row.metadata_json;
	if (typeof serialized !== "string" || !serialized) return undefined;
	try {
		const parsed = JSON.parse(serialized);
		return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
	} catch {
		return undefined;
	}
}

function formatLocalTimestamp(date: Date): string {
	const pad = (n: number) => n.toString().padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
