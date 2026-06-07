const WORKFLOW_PATH = ".github/workflows/ci.yml";
const NODE24_OPT_IN = "FORCE_JAVASCRIPT_ACTIONS_TO_NODE24";
/** Action pins covered by the workflow Node 24 JavaScript runtime opt-in. */
export type AffectedAction =
	| "actions/checkout@v4"
	| "actions/cache@v4"
	| "actions/download-artifact@v4"
	| "actions/setup-node@v4";

const AFFECTED_ACTIONS: readonly AffectedAction[] = [
	"actions/checkout@v4",
	"actions/cache@v4",
	"actions/download-artifact@v4",
	"actions/setup-node@v4",
];

/** Count of an action reference that still needs the Node 24 opt-in. */
export interface AffectedActionCount {
	action: AffectedAction;
	count: number;
}

/** Validation result for the CI workflow Node 24 JavaScript action opt-in. */
export interface CiWorkflowNode24Check {
	affectedActions: AffectedActionCount[];
	hasTopLevelNode24OptIn: boolean;
	messages: string[];
}

/** Verifies that affected JavaScript action pins are protected by the Node 24 opt-in. */
export function checkCiWorkflowNode24OptIn(workflow: string): CiWorkflowNode24Check {
	const affectedActions = countAffectedActions(workflow);
	const hasTopLevelNode24OptIn = findTopLevelNode24OptIn(workflow);
	const messages: string[] = [];

	if (affectedActions.length > 0 && !hasTopLevelNode24OptIn) {
		messages.push(
			`${WORKFLOW_PATH} uses JavaScript actions covered by the Node 20 runner deprecation: ${affectedActions
				.map(({ action, count }) => `${action} (${count})`)
				.join(", ")}.`,
		);
		messages.push(`Add a top-level env block with ${NODE24_OPT_IN}: true.`);
	}

	return { affectedActions, hasTopLevelNode24OptIn, messages };
}

function countAffectedActions(workflow: string): AffectedActionCount[] {
	const counts: Record<AffectedAction, number> = {
		"actions/cache@v4": 0,
		"actions/checkout@v4": 0,
		"actions/download-artifact@v4": 0,
		"actions/setup-node@v4": 0,
	};

	for (const line of workflow.split(/\r?\n/)) {
		const action = parseUsesAction(line);
		if (action === null) continue;
		counts[action]++;
	}

	const affectedActions: AffectedActionCount[] = [];
	for (const action of AFFECTED_ACTIONS) {
		const count = counts[action];
		if (count > 0) affectedActions.push({ action, count });
	}
	return affectedActions;
}

function parseUsesAction(line: string): AffectedAction | null {
	const trimmed = line.trim();
	if (trimmed.startsWith("- uses: ")) return toAffectedAction(trimmed.slice(8));
	if (trimmed.startsWith("uses: ")) return toAffectedAction(trimmed.slice(6));
	return null;
}

function toAffectedAction(value: string): AffectedAction | null {
	const action = readActionReference(value);
	switch (action) {
		case "actions/cache@v4":
		case "actions/checkout@v4":
		case "actions/download-artifact@v4":
		case "actions/setup-node@v4":
			return action;
		default:
			return null;
	}
}

function readActionReference(value: string): string {
	const separator = value.search(/\s/);
	return separator === -1 ? value : value.slice(0, separator);
}

function findTopLevelNode24OptIn(workflow: string): boolean {
	const lines = workflow.split(/\r?\n/);
	for (let index = 0; index < lines.length; index++) {
		if (lines[index] !== "env:") continue;
		if (topLevelEnvContainsOptIn(lines, index + 1)) return true;
	}
	return false;
}

function topLevelEnvContainsOptIn(lines: string[], startIndex: number): boolean {
	for (let index = startIndex; index < lines.length; index++) {
		const line = lines[index];
		if (line.length === 0 || line.trimStart().startsWith("#")) continue;
		if (!line.startsWith(" ")) return false;
		if (line.trim() === `${NODE24_OPT_IN}: true`) return true;
	}
	return false;
}

if (import.meta.main) {
	const workflow = await Bun.file(WORKFLOW_PATH).text();
	const result = checkCiWorkflowNode24OptIn(workflow);
	if (result.messages.length > 0) {
		process.stderr.write(`${result.messages.join("\n")}\n`);
		process.exit(1);
	}
}
