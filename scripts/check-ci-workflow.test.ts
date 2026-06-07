import { describe, expect, it } from "bun:test";
import { checkCiWorkflowNode24OptIn } from "./check-ci-workflow";

describe("checkCiWorkflowNode24OptIn", () => {
	it("accepts affected action pins when the workflow has a top-level Node 24 opt-in", () => {
		const result = checkCiWorkflowNode24OptIn([
			"name: CI",
			"env:",
			"   FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: true",
			"jobs:",
			"   check:",
			"      steps:",
			"         - uses: actions/checkout@v4",
			"         - name: Cache bun dependencies",
			"           uses: actions/cache@v4",
		].join("\n"));

		expect(result.hasTopLevelNode24OptIn).toBe(true);
		expect(result.messages).toEqual([]);
		expect(result.affectedActions).toEqual([
			{ action: "actions/checkout@v4", count: 1 },
			{ action: "actions/cache@v4", count: 1 },
		]);
	});

	it("rejects affected action pins without the workflow-level opt-in", () => {
		const result = checkCiWorkflowNode24OptIn([
			"name: CI",
			"jobs:",
			"   check:",
			"      steps:",
			"         - uses: actions/download-artifact@v4",
		].join("\n"));

		expect(result.hasTopLevelNode24OptIn).toBe(false);
		expect(result.messages).toContain("Add a top-level env block with FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: true.");
	});

	it("does not accept a job-level opt-in as workflow-wide coverage", () => {
		const result = checkCiWorkflowNode24OptIn([
			"name: CI",
			"jobs:",
			"   check:",
			"      env:",
			"         FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: true",
			"      steps:",
			"         - uses: actions/setup-node@v4",
		].join("\n"));

		expect(result.hasTopLevelNode24OptIn).toBe(false);
		expect(result.messages.length).toBeGreaterThan(0);
	});
});
