import { afterEach, describe, expect, it, vi } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import type { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import type { LoadExtensionsResult } from "../../src/extensibility/extensions/types";
import type { PlanModeState } from "../../src/plan-mode/state";
import type { CreateAgentSessionOptions, CreateAgentSessionResult } from "../../src/sdk";
import * as sdkModule from "../../src/sdk";
import type { AgentSession, AgentSessionEvent, PromptOptions } from "../../src/session/agent-session";
import { TaskTool } from "../../src/task";
import * as discoveryModule from "../../src/task/discovery";
import type { AgentDefinition, TaskParams } from "../../src/task/types";
import type { IsolationHandle, WorktreeBaseline } from "../../src/task/worktree";
import * as worktreeModule from "../../src/task/worktree";
import type { ToolSession } from "../../src/tools";
import "../../src/tools/yield";
import { EventBus } from "../../src/utils/event-bus";

const TEST_TASK: TaskParams = {
	agent: "task",
	tasks: [{ id: "CheckLsp", description: "Check LSP availability", assignment: "Inspect LSP tools." }],
};

function createAssistantStopMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: text ? [{ type: "text", text }] : [],
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function createYieldingSession(): AgentSession {
	const listeners: Array<(event: AgentSessionEvent) => void> = [];
	const state = { messages: [] as AssistantMessage[] };

	const emit = (event: AgentSessionEvent) => {
		for (const listener of listeners) listener(event);
	};

	return {
		state,
		agent: { state: { systemPrompt: ["test"] } },
		model: undefined,
		extensionRunner: undefined,
		sessionManager: {
			appendSessionInit: () => {},
		},
		getActiveToolNames: () => ["yield"],
		setActiveToolsByName: async () => {},
		subscribe: (listener: (event: AgentSessionEvent) => void) => {
			listeners.push(listener);
			return () => {
				const index = listeners.indexOf(listener);
				if (index >= 0) listeners.splice(index, 1);
			};
		},
		prompt: async (_text: string, _options?: PromptOptions) => {
			state.messages.push(createAssistantStopMessage("done"));
			emit({
				type: "tool_execution_end",
				toolCallId: "yield-call",
				toolName: "yield",
				result: {
					content: [{ type: "text", text: "Result submitted." }],
					details: { status: "success", data: { ok: true } },
				},
				isError: false,
			});
		},
		waitForIdle: async () => {},
		getLastAssistantMessage: () => state.messages[state.messages.length - 1],
		abort: async () => {},
		dispose: async () => {},
	} as unknown as AgentSession;
}

function createSession(
	options: {
		isolationMode?: "none" | "auto";
		parentEnableLsp?: boolean;
		planMode?: PlanModeState;
		taskEnableLsp?: boolean;
	} = {},
): ToolSession {
	const modelRegistry = {
		authStorage: undefined,
		refresh: async () => {},
		getAvailable: () => [],
		getApiKey: async () => null,
	} as unknown as ModelRegistry;

	return {
		cwd: "/tmp",
		hasUI: false,
		enableLsp: options.parentEnableLsp,
		settings: Settings.isolated({
			"async.enabled": false,
			"task.isolation.mode": options.isolationMode ?? "none",
			...(options.taskEnableLsp !== undefined ? { "task.enableLsp": options.taskEnableLsp } : {}),
		}),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		modelRegistry,
		getPlanModeState: () => options.planMode,
	} as unknown as ToolSession;
}

function mockAgents(agent: AgentDefinition): void {
	vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
		agents: [agent],
		projectAgentsDir: null,
	});
}

function mockCreateAgentSession(): { getOptions: () => CreateAgentSessionOptions | undefined } {
	let capturedOptions: CreateAgentSessionOptions | undefined;
	vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async (options = {}) => {
		capturedOptions = options;
		return {
			session: createYieldingSession(),
			extensionsResult: {} as unknown as LoadExtensionsResult,
			setToolUIContext: () => {},
			eventBus: new EventBus(),
		} satisfies CreateAgentSessionResult;
	});
	return { getOptions: () => capturedOptions };
}

function mockIsolation(): void {
	const baseline: WorktreeBaseline = {
		root: {
			repoRoot: "/repo",
			headCommit: "HEAD",
			staged: "",
			unstaged: "",
			untracked: [],
			untrackedPatch: "",
		},
		nested: [],
	};
	const isolationHandle: IsolationHandle = {
		mergedDir: "/tmp/isolated-subagent",
		backend: worktreeModule.parseIsolationMode("rcopy")!,
		fellBack: false,
		fallbackReason: null,
	};

	vi.spyOn(worktreeModule, "getRepoRoot").mockResolvedValue("/repo");
	vi.spyOn(worktreeModule, "captureBaseline").mockResolvedValue(baseline);
	vi.spyOn(worktreeModule, "ensureIsolation").mockResolvedValue(isolationHandle);
	vi.spyOn(worktreeModule, "captureDeltaPatch").mockResolvedValue({ rootPatch: "", nestedPatches: [] });
	vi.spyOn(worktreeModule, "cleanupIsolation").mockResolvedValue();
}

describe("subagent LSP availability", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("disables LSP for subagents by default", async () => {
		mockAgents({
			name: "task",
			description: "Task agent",
			systemPrompt: "Use LSP when useful.",
			source: "bundled",
			tools: ["lsp"],
		});
		const { getOptions } = mockCreateAgentSession();

		const tool = await TaskTool.create(createSession());
		await tool.execute("tool-call", TEST_TASK);

		expect(getOptions()?.enableLsp).toBe(false);
	});

	it("enables subagent LSP when task.enableLsp is set", async () => {
		mockAgents({
			name: "task",
			description: "Task agent",
			systemPrompt: "Use normal tools.",
			source: "bundled",
			tools: ["lsp"],
		});
		const { getOptions } = mockCreateAgentSession();

		const tool = await TaskTool.create(createSession({ taskEnableLsp: true }));
		await tool.execute("tool-call", TEST_TASK);

		expect(getOptions()?.enableLsp).toBe(true);
		expect(getOptions()?.toolNames).toContain("lsp");
	});

	it("keeps subagent LSP disabled when the parent session disables LSP", async () => {
		mockAgents({
			name: "task",
			description: "Task agent",
			systemPrompt: "Use normal tools.",
			source: "bundled",
			tools: ["lsp"],
		});
		const { getOptions } = mockCreateAgentSession();

		const tool = await TaskTool.create(createSession({ parentEnableLsp: false, taskEnableLsp: true }));
		await tool.execute("tool-call", TEST_TASK);

		expect(getOptions()?.enableLsp).toBe(false);
	});

	it("disables LSP for isolated subagents by default", async () => {
		mockAgents({
			name: "task",
			description: "Task agent",
			systemPrompt: "Use LSP when useful.",
			source: "bundled",
			tools: ["lsp"],
		});
		mockIsolation();
		const { getOptions } = mockCreateAgentSession();

		const tool = await TaskTool.create(createSession({ isolationMode: "auto" }));
		await tool.execute("tool-call", { ...TEST_TASK, isolated: true });

		expect(getOptions()?.cwd).toBe("/tmp/isolated-subagent");
		expect(getOptions()?.enableLsp).toBe(false);
	});

	it("applies plan-mode subagent tools and honors task.enableLsp", async () => {
		mockAgents({
			name: "task",
			description: "Task agent",
			systemPrompt: "Use normal tools.",
			source: "bundled",
			tools: ["bash"],
		});
		const { getOptions } = mockCreateAgentSession();
		const planMode = { enabled: true, planFilePath: "local://PLAN.md" };

		const tool = await TaskTool.create(createSession({ planMode, taskEnableLsp: true }));
		await tool.execute("tool-call", TEST_TASK);

		expect(getOptions()?.enableLsp).toBe(true);
		expect(getOptions()?.toolNames).toEqual(["read", "search", "find", "lsp", "web_search", "irc"]);
	});

	it("preserves agent-declared read-only specialty tools in plan mode (issue #1998)", async () => {
		mockAgents({
			name: "reviewer",
			description: "Reviewer agent",
			systemPrompt: "Call report_finding then yield.",
			source: "bundled",
			tools: ["read", "search", "find", "bash", "lsp", "web_search", "ast_grep", "report_finding"],
		});
		const { getOptions } = mockCreateAgentSession();
		const planMode = { enabled: true, planFilePath: "local://PLAN.md" };

		const tool = await TaskTool.create(createSession({ planMode }));
		await tool.execute("tool-call", { ...TEST_TASK, agent: "reviewer" });

		// `bash` dropped (not in PLAN_MODE_EXTRA_TOOLS); `report_finding` and
		// `ast_grep` preserved so reviewer's prompt and tool inventory agree.
		const toolNames = getOptions()?.toolNames;
		expect(toolNames).toContain("report_finding");
		expect(toolNames).toContain("ast_grep");
		expect(toolNames).not.toContain("bash");
	});

	it("drops read-tier but state-mutating agent tools in plan mode (e.g. memory_edit)", async () => {
		mockAgents({
			name: "memo_scout",
			description: "Custom scout that edits long-term memory",
			systemPrompt: "Scout the codebase and record memories.",
			source: "project",
			// `memory_edit`, `retain`, `reflect`, `checkpoint`, and `todo` are all
			// approval-tier "read" but mutate persistent state — they must not
			// survive the plan-mode tool filter.
			tools: ["read", "search", "memory_edit", "retain", "reflect", "checkpoint", "todo"],
		});
		const { getOptions } = mockCreateAgentSession();
		const planMode = { enabled: true, planFilePath: "local://PLAN.md" };

		const tool = await TaskTool.create(createSession({ planMode }));
		await tool.execute("tool-call", { ...TEST_TASK, agent: "memo_scout" });

		const toolNames = getOptions()?.toolNames ?? [];
		expect(toolNames).not.toContain("memory_edit");
		expect(toolNames).not.toContain("retain");
		expect(toolNames).not.toContain("reflect");
		expect(toolNames).not.toContain("checkpoint");
		expect(toolNames).not.toContain("todo");
	});
});
