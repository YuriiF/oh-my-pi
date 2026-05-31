import { describe, expect, test } from "bun:test";
import {
	buildObservationMetadata,
	importanceFromRelevance,
	OBSERVATION_METADATA_KIND,
	OBSERVATION_METADATA_VERSION,
	readObservationMetadata,
} from "@oh-my-pi/pi-coding-agent/mnemosyne/observations";

describe("buildObservationMetadata", () => {
	test("captures relevance, sourceEntryIds, and timestamp; pins kind+version", () => {
		const meta = buildObservationMetadata({
			content: "user prefers boring changes",
			timestamp: "2026-05-31 04:14",
			relevance: "high",
			sourceEntryIds: ["e1", "e2"],
		});
		expect(meta).toMatchObject({
			kind: OBSERVATION_METADATA_KIND,
			version: OBSERVATION_METADATA_VERSION,
			relevance: "high",
			source_entry_ids: ["e1", "e2"],
			captured_at: "2026-05-31 04:14",
		});
	});

	test("dedupes source entry ids preserving first occurrence order", () => {
		const meta = buildObservationMetadata({
			content: "x",
			relevance: "low",
			sourceEntryIds: ["a", "b", "a", "c", "b"],
		});
		expect(meta.source_entry_ids).toEqual(["a", "b", "c"]);
	});

	test("rejects observations with no source evidence", () => {
		expect(() => buildObservationMetadata({ content: "x", relevance: "low", sourceEntryIds: [] })).toThrow(
			/sourceEntryId/,
		);
	});

	test("falls back to the current local time when no timestamp is supplied", () => {
		const meta = buildObservationMetadata({
			content: "x",
			relevance: "medium",
			sourceEntryIds: ["e1"],
		});
		expect(meta.captured_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
	});

	test("caller extras are preserved but cannot overwrite reserved keys", () => {
		const meta = buildObservationMetadata({
			content: "x",
			relevance: "low",
			sourceEntryIds: ["e1"],
			extra: { worker_model: "smol", kind: "tampered", version: 999 },
		});
		expect(meta.worker_model).toBe("smol");
		expect(meta.kind).toBe(OBSERVATION_METADATA_KIND);
		expect(meta.version).toBe(OBSERVATION_METADATA_VERSION);
	});
});

describe("importanceFromRelevance", () => {
	test("maps relevance grades to a strictly increasing importance score", () => {
		expect(importanceFromRelevance("low")).toBeLessThan(importanceFromRelevance("medium"));
		expect(importanceFromRelevance("medium")).toBeLessThan(importanceFromRelevance("high"));
		expect(importanceFromRelevance("high")).toBeLessThan(importanceFromRelevance("critical"));
	});
});

describe("readObservationMetadata", () => {
	test("recovers metadata from the parsed `metadata` field", () => {
		const meta = buildObservationMetadata({
			content: "x",
			relevance: "high",
			sourceEntryIds: ["e1"],
		});
		const row = { metadata: meta };
		expect(readObservationMetadata(row)?.source_entry_ids).toEqual(["e1"]);
	});

	test("falls back to parsing `metadata_json` when only the serialized column is present", () => {
		const meta = buildObservationMetadata({
			content: "x",
			relevance: "high",
			sourceEntryIds: ["e1"],
		});
		const row = { metadata_json: JSON.stringify(meta) };
		expect(readObservationMetadata(row)?.relevance).toBe("high");
	});

	test("returns undefined for rows that are not observation rows", () => {
		expect(readObservationMetadata({ metadata: { kind: "something-else" } })).toBeUndefined();
		expect(readObservationMetadata({ metadata: null })).toBeUndefined();
		expect(readObservationMetadata({ metadata_json: "{not json" })).toBeUndefined();
	});

	test("returns undefined when required fields are missing or malformed", () => {
		expect(
			readObservationMetadata({
				metadata: { kind: OBSERVATION_METADATA_KIND, version: 1, relevance: "high", source_entry_ids: [], captured_at: "x" },
			})?.source_entry_ids,
		).toEqual([]);
		expect(
			readObservationMetadata({
				metadata: {
					kind: OBSERVATION_METADATA_KIND,
					version: 1,
					relevance: "bogus",
					source_entry_ids: ["e"],
					captured_at: "x",
				},
			}),
		).toBeUndefined();
		expect(
			readObservationMetadata({
				metadata: {
					kind: OBSERVATION_METADATA_KIND,
					version: 1,
					relevance: "high",
					source_entry_ids: [42],
					captured_at: "x",
				},
			}),
		).toBeUndefined();
	});
});
