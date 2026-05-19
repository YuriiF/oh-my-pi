/**
 * Regression test for issue #1207:
 * deepseek-v4-flash (and similar models that route to deepseek-reasoner) fail with
 * "400 deepseek-reasoner does not support this tool_choice" when reasoning_effort and
 * tools are both present in a request, even without an explicit tool_choice field.
 *
 * Fix: disableReasoningWhenToolsPresent drops reasoning_effort when tools are present
 * for these models. deepseek-v4-pro is unaffected (it does not route to deepseek-reasoner).
 */
import { afterEach, describe, expect, it } from "bun:test";
import { getBundledModel } from "@oh-my-pi/pi-ai/models";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import { detectOpenAICompat } from "@oh-my-pi/pi-ai/providers/openai-completions-compat";
import type { Context, Model, Tool } from "@oh-my-pi/pi-ai/types";
import * as z from "zod/v4";

const originalFetch = global.fetch;

afterEach(() => {
	global.fetch = originalFetch;
});

const echoTool: Tool = {
	name: "echo",
	description: "Echo input",
	parameters: z.object({ text: z.string() }),
};

const contextWithTools: Context = {
	messages: [{ role: "user", content: "call echo", timestamp: Date.now() }],
	tools: [echoTool],
};

const contextWithoutTools: Context = {
	messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
};

function abortedSignal(): AbortSignal {
	const controller = new AbortController();
	controller.abort();
	return controller.signal;
}

async function capturePayload(
	model: Model<"openai-completions">,
	context: Context,
	reasoning: string,
): Promise<Record<string, unknown>> {
	const { promise, resolve } = Promise.withResolvers<unknown>();
	streamOpenAICompletions(model, context, {
		apiKey: "test-key",
		signal: abortedSignal(),
		reasoning: reasoning as "minimal",
		onPayload: payload => resolve(payload),
	});
	return (await promise) as Record<string, unknown>;
}

describe("issue #1207 — deepseek-v4-flash drops reasoning_effort when tools present", () => {
	describe("compat detection", () => {
		it("sets disableReasoningWhenToolsPresent=true for deepseek-v4-flash via direct API", () => {
			const model = getBundledModel("deepseek", "deepseek-v4-flash") as Model<"openai-completions">;
			const compat = detectOpenAICompat(model);
			expect(compat.disableReasoningWhenToolsPresent).toBe(true);
		});

		it("sets disableReasoningWhenToolsPresent=false for deepseek-v4-pro via direct API", () => {
			const model = getBundledModel("deepseek", "deepseek-v4-pro") as Model<"openai-completions">;
			const compat = detectOpenAICompat(model);
			expect(compat.disableReasoningWhenToolsPresent).toBe(false);
		});

		it("sets disableReasoningWhenToolsPresent=true for a user-defined deepseek-v4-flash model via api.deepseek.com", () => {
			const model: Model<"openai-completions"> = {
				...getBundledModel("openai", "gpt-4o-mini"),
				api: "openai-completions",
				id: "deepseek-v4-flash",
				name: "DeepSeek V4 Flash",
				provider: "ds",
				baseUrl: "https://api.deepseek.com/v1",
				reasoning: true,
				compat: {
					supportsReasoningEffort: true,
					reasoningEffortMap: { xhigh: "max" },
				},
			};
			const compat = detectOpenAICompat(model);
			expect(compat.disableReasoningWhenToolsPresent).toBe(true);
		});

		it("does NOT set disableReasoningWhenToolsPresent for deepseek-v4-flash on non-deepseek hosts", () => {
			// e.g. OpenRouter hosts the model but handles reasoning differently
			const model: Model<"openai-completions"> = {
				...getBundledModel("openai", "gpt-4o-mini"),
				api: "openai-completions",
				id: "deepseek/deepseek-v4-flash",
				name: "DeepSeek V4 Flash",
				provider: "openrouter",
				baseUrl: "https://openrouter.ai/api/v1",
				reasoning: true,
			};
			const compat = detectOpenAICompat(model);
			expect(compat.disableReasoningWhenToolsPresent).toBe(false);
		});
	});

	describe("request body", () => {
		it("omits reasoning_effort when tools are present for deepseek-v4-flash", async () => {
			const model = getBundledModel("deepseek", "deepseek-v4-flash") as Model<"openai-completions">;
			const body = await capturePayload(model, contextWithTools, "minimal");
			expect(body.tools).toBeDefined();
			expect(body.reasoning_effort).toBeUndefined();
		});

		it("keeps reasoning_effort when tools are absent for deepseek-v4-flash", async () => {
			const model = getBundledModel("deepseek", "deepseek-v4-flash") as Model<"openai-completions">;
			const body = await capturePayload(model, contextWithoutTools, "minimal");
			expect(body.tools).toBeUndefined();
			expect(body.reasoning_effort).toBe("minimal");
		});

		it("keeps reasoning_effort when tools are present for deepseek-v4-pro (unaffected)", async () => {
			const model = getBundledModel("deepseek", "deepseek-v4-pro") as Model<"openai-completions">;
			const body = await capturePayload(model, contextWithTools, "minimal");
			expect(body.tools).toBeDefined();
			expect(body.reasoning_effort).toBe("minimal");
		});
	});
});
