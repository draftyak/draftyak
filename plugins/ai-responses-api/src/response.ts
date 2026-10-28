import {
	DraftOutcome,
	ModelId,
	type DraftOutcome as Outcome,
} from "@draftyak/protocol/ai-provider-v1";
import { type ContextId, ContextIds } from "@draftyak/protocol/draft-output";
import {
	MAX_DRAFT_OUTPUT_TEXT_BYTES,
	parseDraftOutputText,
} from "@draftyak/protocol/draft-output-text";
import { normalizeError, ResponsesError, record } from "./shared.ts";

export const MAX_OUTPUT_ITEMS = 64;
export const MAX_CONTENT_BLOCKS = 16;

function content(output: unknown): { text: string } | { refusal: true } | { unexpected: true } {
	const invalid = { unexpected: true as const };
	if (!Array.isArray(output) || output.length > MAX_OUTPUT_ITEMS) return invalid;
	// A refusal stops the job even if other bounded blocks are malformed or oversized.
	// Inspect only block tags here; neither refused text nor partial JSON is read.
	for (const item of output) {
		if (!record(item) || !Array.isArray(item.content) || item.content.length > MAX_CONTENT_BLOCKS)
			continue;
		if (item.content.some((block) => record(block) && block.type === "refusal"))
			return { refusal: true };
	}
	let text: string | undefined;
	let messages = 0;
	for (const item of output) {
		if (!record(item)) return invalid;
		if (item.type === "reasoning") continue;
		if (
			item.type !== "message" ||
			item.role !== "assistant" ||
			item.status !== "completed" ||
			(item.phase != null && item.phase !== "final_answer") ||
			++messages > 1 ||
			!Array.isArray(item.content) ||
			item.content.length > MAX_CONTENT_BLOCKS
		)
			return invalid;
		for (const block of item.content) {
			if (!record(block)) return invalid;
			if (block.type !== "output_text" || typeof block.text !== "string" || text !== undefined)
				return invalid;
			if (
				block.text.length > MAX_DRAFT_OUTPUT_TEXT_BYTES ||
				Buffer.byteLength(block.text) > MAX_DRAFT_OUTPUT_TEXT_BYTES
			)
				return invalid;
			text = block.text;
		}
	}
	return text === undefined ? invalid : { text };
}

export function readDraft(response: unknown, contextIds: readonly ContextId[]): Outcome {
	try {
		if (!ContextIds.safeParse(contextIds).success) throw new ResponsesError("INVALID_INPUT");
		if (!record(response)) throw new ResponsesError("TRANSIENT");
		const status = response.status;
		if (status === "failed") throw normalizeError(response.error);
		const model = response.model;
		if (!ModelId.safeParse(model).success) throw new ResponsesError("TRANSIENT");
		const usage = response.usage;
		let tokens: { input: number | null; output: number } = { input: null, output: 0 };
		if (usage == null) {
			if (status === "completed" || status === "incomplete") throw new ResponsesError("TRANSIENT");
		} else {
			if (!record(usage)) throw new ResponsesError("TRANSIENT");
			const outputTokens = usage.output_tokens;
			const inputTokens = usage.input_tokens;
			if (
				!Number.isSafeInteger(outputTokens) ||
				Number(outputTokens) < 0 ||
				(inputTokens != null && (!Number.isSafeInteger(inputTokens) || Number(inputTokens) < 0))
			)
				throw new ResponsesError("TRANSIENT");
			tokens = {
				input: (inputTokens ?? null) as number | null,
				output: outputTokens as number,
			};
		}
		if (status !== "completed" && status !== "incomplete") {
			return {
				model: model as string,
				fallback: false,
				usage: tokens,
				kind: "unexpected",
				stopReason:
					status === "cancelled" || status === "queued" || status === "in_progress" ? status : null,
			};
		}
		const base = {
			model: model as string,
			fallback: false,
			usage: tokens,
		};
		let result: Outcome;
		if (status === "incomplete") {
			const reason = record(response.incomplete_details)
				? response.incomplete_details.reason
				: null;
			result =
				reason === "max_output_tokens"
					? { ...base, kind: "truncated", stopReason: "max_tokens" }
					: reason === "content_filter"
						? {
								...base,
								kind: "refusal",
								category: "content_filter",
								explanation: null,
								recommendedModel: null,
							}
						: { ...base, kind: "unexpected", stopReason: "incomplete" };
		} else {
			const served = content(response.output);
			if ("refusal" in served)
				result = {
					...base,
					kind: "refusal",
					category: null,
					explanation: null,
					recommendedModel: null,
				};
			else if ("unexpected" in served)
				result = { ...base, kind: "unexpected", stopReason: "unexpected_output" };
			else {
				const parsed = parseDraftOutputText(served.text, contextIds);
				result = parsed.ok
					? { ...base, kind: "draft", output: parsed.output }
					: { ...base, kind: "invalid", problems: parsed.problems };
			}
		}
		if (!DraftOutcome.safeParse(result).success) throw new ResponsesError("TRANSIENT");
		return result;
	} catch (error) {
		throw normalizeError(error);
	}
}
