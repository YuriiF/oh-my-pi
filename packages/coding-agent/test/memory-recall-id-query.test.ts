import { describe, expect, test } from "bun:test";
import { parseRecallIdQuery } from "@oh-my-pi/pi-coding-agent/tools/memory-recall";

describe("parseRecallIdQuery", () => {
	test("returns the id from a bare id:<value> prefix", () => {
		expect(parseRecallIdQuery("id:abc123def456")).toBe("abc123def456");
		expect(parseRecallIdQuery("  id: abc123def456  ")).toBe("abc123def456");
	});

	test("returns the id from a bracketed [id: …] token embedded in the query", () => {
		expect(parseRecallIdQuery("look up [id:hex-12345678]")).toBe("hex-12345678");
		expect(parseRecallIdQuery("Memory recall result included [ID: abc987654321]")).toBe("abc987654321");
	});

	test("does NOT treat a natural-language query as an id lookup", () => {
		expect(parseRecallIdQuery("what did we decide about auth?")).toBeUndefined();
		expect(parseRecallIdQuery("user prefers boring changes")).toBeUndefined();
		expect(parseRecallIdQuery("")).toBeUndefined();
	});

	test("rejects ids that are too short or contain invalid characters", () => {
		expect(parseRecallIdQuery("id:abc")).toBeUndefined();
		expect(parseRecallIdQuery("id:hello world")).toBeUndefined();
	});
});
