import {
	DraftOutcome,
	ModelId,
	type DraftOutcome as Outcome,
} from "@draftyak/protocol/ai-provider-v1";
import {
	type ContextId,
	ContextIds,
	type DraftOutputCheck,
	normalizeDraftOutput,
	validateDraftOutput,
} from "@draftyak/protocol/draft-output";
import { parseStrict } from "@draftyak/protocol/jcs";
import { ResponsesError, record } from "./shared.ts";

export const MAX_OUTPUT_BYTES = 262_144;
export const MAX_OUTPUT_ITEMS = 64;
export const MAX_CONTENT_BLOCKS = 16;

export function parseDraft(text: string, contextIds: readonly ContextId[]): DraftOutputCheck {
	try {
		if (!ContextIds.safeParse(contextIds).success)
			return { ok: false, problems: ["output: invalid_context_ids"] };
		if (
			typeof text !== "string" ||
			text.length > MAX_OUTPUT_BYTES ||
			Buffer.byteLength(text) > MAX_OUTPUT_BYTES
		)
			return { ok: false, problems: ["output: too_big"] };
		return validateDraftOutput(normalizeDraftOutput(parseStrict(text), contextIds));
	} catch {
		return { ok: false, problems: ["output: invalid_JSON"] };
	}
}

function content(
	output: unknown,
): { text: string } | { refusal: true } | { problems: readonly string[] } {
	const invalid = { problems: ["output: invalid_content"] };
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
			if (block.text.length > MAX_OUTPUT_BYTES) return { problems: ["output: too_big"] };
			text = block.text;
		}
	}
	return text === undefined ? invalid : { text };
}

export function readDraft(response: unknown, contextIds: readonly ContextId[]): Outcome {
	try {
		if (
			!record(response) ||
			!ModelId.safeParse(response.model).success ||
			!ContextIds.safeParse(contextIds).success ||
			!record(response.usage)
		)
			throw new ResponsesError("INVALID_RESPONSE");
		const usage = response.usage;
		if (
			!Number.isSafeInteger(usage.output_tokens) ||
			Number(usage.output_tokens) < 0 ||
			(usage.input_tokens != null &&
				(!Number.isSafeInteger(usage.input_tokens) || Number(usage.input_tokens) < 0))
		)
			throw new ResponsesError("INVALID_RESPONSE");
		const base = {
			model: response.model as string,
			fallback: false,
			usage: {
				input: (usage.input_tokens ?? null) as number | null,
				output: usage.output_tokens as number,
			},
		};
		let result: Outcome;
		if (response.status === "incomplete") {
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
		} else if (response.status !== "completed") {
			result = {
				...base,
				kind: "unexpected",
				stopReason:
					typeof response.status === "string" &&
					["failed", "cancelled", "queued", "in_progress"].includes(response.status)
						? response.status
						: null,
			};
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
			else {
				const parsed =
					"text" in served
						? parseDraft(served.text, contextIds)
						: { ok: false as const, problems: served.problems };
				result = parsed.ok
					? { ...base, kind: "draft", output: parsed.output }
					: { ...base, kind: "invalid", problems: parsed.problems };
			}
		}
		if (!DraftOutcome.safeParse(result).success) throw new ResponsesError("INVALID_RESPONSE");
		return result;
	} catch {
		throw new ResponsesError("INVALID_RESPONSE");
	}
}

export type RepairPlan =
	| { readonly kind: "stop" }
	| { readonly kind: "repair"; readonly problems: readonly string[] };
export function repairPlan(outcome: Outcome, repairsUsed: 0 | 1): RepairPlan {
	if (!DraftOutcome.safeParse(outcome).success || (repairsUsed !== 0 && repairsUsed !== 1))
		throw new ResponsesError("INVALID_INPUT");
	return outcome.kind === "invalid" && repairsUsed === 0
		? { kind: "repair", problems: [...outcome.problems] }
		: { kind: "stop" };
}
