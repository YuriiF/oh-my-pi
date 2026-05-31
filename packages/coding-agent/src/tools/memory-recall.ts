import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { logger, untilAborted } from "@oh-my-pi/pi-utils";
import * as z from "zod/v4";
import { formatCurrentTime, formatMemories } from "../hindsight/content";
import recallDescription from "../prompts/tools/recall.md" with { type: "text" };
import type { ToolSession } from ".";

const memoryRecallSchema = z.object({
	query: z.string().describe("natural language search query"),
});

export type MemoryRecallParams = z.infer<typeof memoryRecallSchema>;

export class MemoryRecallTool implements AgentTool<typeof memoryRecallSchema> {
	readonly name = "recall";
	readonly approval = "read" as const;
	readonly label = "Recall";
	readonly description = recallDescription;
	readonly parameters = memoryRecallSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly summary = "Search memory for relevant prior context";

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): MemoryRecallTool | null {
		const backend = session.settings.get("memory.backend");
		if (backend !== "hindsight" && backend !== "mnemosyne") return null;
		return new MemoryRecallTool(session);
	}

	async execute(_id: string, params: MemoryRecallParams, signal?: AbortSignal): Promise<AgentToolResult> {
		return untilAborted(signal, async () => {
			const backend = this.session.settings.get("memory.backend");
			if (backend === "mnemosyne") {
				const state = this.session.getMnemosyneSessionState?.();
				if (!state) {
					throw new Error("Mnemosyne backend is not initialised for this session.");
				}
				try {
					const idQuery = parseRecallIdQuery(params.query);
					if (idQuery) {
						const hit = state.lookupScopedById(idQuery);
						if (!hit) {
							return {
								content: [{ type: "text", text: `No memory with id ${idQuery} found in the scoped banks.` }],
								details: { id: idQuery },
							};
						}
						return {
							content: [
								{
									type: "text",
									text: `Memory ${idQuery} (bank: ${hit.bank}, as of ${formatCurrentTime()} UTC):\n\n${formatMemoryRow(hit.row)}`,
								},
							],
							details: { id: idQuery, bank: hit.bank },
						};
					}

					const results = state.recallResultsScoped(params.query);
					if (results.length === 0) {
						return {
							content: [{ type: "text", text: "No relevant memories found." }],
							details: {},
						};
					}
					const formatted = state.formatScopedRecallWithIds(results);
					return {
						content: [
							{
								type: "text",
								text: `Found ${results.length} relevant ${results.length === 1 ? "memory" : "memories"} (as of ${formatCurrentTime()} UTC):\n\n${formatted}`,
							},
						],
						details: {},
					};
				} catch (err) {
					logger.warn("recall failed", { backend: "mnemosyne", bank: state.config.bank, error: String(err) });
					throw err instanceof Error ? err : new Error(String(err));
				}
			}

			const state = this.session.getHindsightSessionState?.();
			if (!state) {
				throw new Error("Hindsight backend is not initialised for this session.");
			}

			try {
				const response = await state.client.recall(state.bankId, params.query, {
					budget: state.config.recallBudget,
					maxTokens: state.config.recallMaxTokens,
					types: state.config.recallTypes.length > 0 ? state.config.recallTypes : undefined,
					tags: state.recallTags,
					tagsMatch: state.recallTagsMatch,
				});
				const results = response.results ?? [];
				if (results.length === 0) {
					return {
						content: [{ type: "text", text: "No relevant memories found." }],
						details: {},
					};
				}
				const formatted = formatMemories(results);
				return {
					content: [
						{
							type: "text",
							text: `Found ${results.length} relevant ${results.length === 1 ? "memory" : "memories"} (as of ${formatCurrentTime()} UTC):\n\n${formatted}`,
						},
					],
					details: {},
				};
			} catch (err) {
				logger.warn("recall failed", { bankId: state.bankId, error: String(err) });
				throw err instanceof Error ? err : new Error(String(err));
			}
		});
	}
}

/**
 * Detect `id:<…>` / `[id:<…>]` shapes anywhere in the query and return the
 * bare id. Used by the recall tool to short-circuit to an exact lookup when
 * the model already knows the id printed by `formatScopedRecallWithIds()`.
 */
export function parseRecallIdQuery(query: string): string | undefined {
	if (!query) return undefined;
	const trimmed = query.trim();
	const explicit = /^id:\s*([A-Za-z0-9_:-]{4,})$/.exec(trimmed);
	if (explicit) return explicit[1];
	const bracketed = /\[id:\s*([A-Za-z0-9_:-]{4,})\]/i.exec(trimmed);
	if (bracketed) return bracketed[1];
	return undefined;
}

function formatMemoryRow(row: Record<string, unknown>): string {
	const content = pickString(row.content) ?? "(empty content)";
	const source = pickString(row.source);
	const timestamp = pickString(row.timestamp);
	const importance = typeof row.importance === "number" ? row.importance.toFixed(1) : undefined;
	const veracity = pickString(row.veracity);
	const metaFields: string[] = [];
	if (source) metaFields.push(`source: ${source}`);
	if (timestamp) metaFields.push(`timestamp: ${timestamp}`);
	if (importance) metaFields.push(`importance: ${importance}`);
	if (veracity) metaFields.push(`veracity: ${veracity}`);
	return metaFields.length > 0 ? `${content}\n(${metaFields.join(", ")})` : content;
}

function pickString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}
