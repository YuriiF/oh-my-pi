/**
 * Regression tests for the autonomous turn guard introduced in #1137.
 *
 * `AgentSession.setAutonomousTurnGuard` allows ACP mode (and future callers)
 * to intercept `sendCustomMessage(..., { triggerTurn: true })` calls that
 * would otherwise start an ownerless LLM turn after the ACP prompt response
 * has already been returned to the client.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { getBundledModel } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { Snowflake } from "@oh-my-pi/pi-utils";
import { createAssistantMessage } from "./helpers/agent-session-setup";

describe("AgentSession autonomous turn guard", () => {
	let session: AgentSession;
	let tempDir: string;
	const authStorages: AuthStorage[] = [];

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `pi-guard-test-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
	});

	afterEach(async () => {
		if (session) {
			await session.dispose();
		}
		for (const authStorage of authStorages.splice(0)) {
			authStorage.close();
		}
		if (tempDir && fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, { recursive: true });
		}
		vi.restoreAllMocks();
	});

	async function createSession() {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
			},
			streamFn: () => {
				const stream = new AssistantMessageEventStream();
				const msg = createAssistantMessage("done");
				queueMicrotask(() => {
					stream.push({ type: "start", partial: createAssistantMessage("") });
					stream.push({ type: "done", reason: "stop", message: msg });
				});
				return stream;
			},
		});

		const sessionManager = SessionManager.inMemory();
		const settings = Settings.isolated();
		const authStorage = await AuthStorage.create(path.join(tempDir, "testauth.db"));
		authStorages.push(authStorage);
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");

		session = new AgentSession({ agent, sessionManager, settings, modelRegistry });
		return session;
	}

	it("triggers a new turn when no guard is installed", async () => {
		await createSession();
		const spy = vi.spyOn(session.agent, "prompt");

		await session.sendCustomMessage(
			{ customType: "async-result", content: "job done", display: true },
			{ deliverAs: "followUp", triggerTurn: true },
		);

		// Should have called agent.prompt to start a new turn
		expect(spy).toHaveBeenCalledTimes(1);
	});

	it("defers the turn and appends to history when guard returns false", async () => {
		await createSession();
		const spy = vi.spyOn(session.agent, "prompt");

		// Install a guard that always blocks
		session.setAutonomousTurnGuard(() => false);

		const messagesBefore = session.agent.state.messages.length;

		await session.sendCustomMessage(
			{ customType: "async-result", content: "job done", display: true },
			{ deliverAs: "followUp", triggerTurn: true },
		);

		// Must NOT have triggered a new LLM turn
		expect(spy).not.toHaveBeenCalled();

		// Message MUST have been appended to history for the next client-initiated turn
		expect(session.agent.state.messages.length).toBe(messagesBefore + 1);
		const appended = session.agent.state.messages[session.agent.state.messages.length - 1];
		expect(appended?.role).toBe("custom");
	});

	it("allows the turn when guard returns true", async () => {
		await createSession();
		const spy = vi.spyOn(session.agent, "prompt");

		// Guard permits
		session.setAutonomousTurnGuard(() => true);

		await session.sendCustomMessage(
			{ customType: "async-result", content: "job done", display: true },
			{ deliverAs: "followUp", triggerTurn: true },
		);

		expect(spy).toHaveBeenCalledTimes(1);
	});

	it("defers on the nextTurn+triggerTurn path when guard returns false", async () => {
		await createSession();
		const spy = vi.spyOn(session.agent, "prompt");

		session.setAutonomousTurnGuard(() => false);

		const messagesBefore = session.agent.state.messages.length;

		await session.sendCustomMessage(
			{ customType: "async-result", content: "job done", display: true },
			{ deliverAs: "nextTurn", triggerTurn: true },
		);

		expect(spy).not.toHaveBeenCalled();
		expect(session.agent.state.messages.length).toBe(messagesBefore + 1);
	});

	it("guard cleared with undefined restores normal behaviour", async () => {
		await createSession();
		const spy = vi.spyOn(session.agent, "prompt");

		session.setAutonomousTurnGuard(() => false);
		// Clear the guard
		session.setAutonomousTurnGuard(undefined);

		await session.sendCustomMessage(
			{ customType: "async-result", content: "job done", display: true },
			{ deliverAs: "followUp", triggerTurn: true },
		);

		// Guard is gone — turn should fire normally
		expect(spy).toHaveBeenCalledTimes(1);
	});
});
