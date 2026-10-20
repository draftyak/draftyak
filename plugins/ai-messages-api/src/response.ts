import {
	DraftOutcome,
	ModelId,
	type DraftOutcome as Outcome,
} from "@draftyak/protocol/ai-provider-v1";
import {
	type ContextId,
	ContextIds,
	normalizeDraftOutput,
	validateDraftOutput,
} from "@draftyak/protocol/draft-output";
import { parseStrict } from "@draftyak/protocol/jcs";
import { boundedText, isModel, isRecord, MessagesError } from "./shared.ts";

export const MAX_OUTPUT_BYTES = 262_144;
export type ParsedDraft = ReturnType<typeof validateDraftOutput>;

export function parseDraft(text: string, contextIds: readonly ContextId[]): ParsedDraft {
	try {
		if (!ContextIds.safeParse(contextIds).success)
			return { ok: false, problems: ["output: invalid_context_ids"] };
		if (
			typeof text !== "string" ||
			text.length > MAX_OUTPUT_BYTES ||
			new TextEncoder().encode(text).byteLength > MAX_OUTPUT_BYTES
		)
			return { ok: false, problems: ["output: too_big"] };
		const value = parseStrict(text);
		return validateDraftOutput(normalizeDraftOutput(value, contextIds));
	} catch {
		return { ok: false, problems: ["output: invalid_JSON"] };
	}
}

function servedText(content: unknown): { text: string } | { problems: readonly string[] } {
	const bad = { problems: ["output: invalid_content"] };
	if (!Array.isArray(content) || content.length > 128) return bad;
	let text = "";
	let segmentTexts = 0;
	let totalTexts = 0;
	for (const block of content) {
		if (!isRecord(block)) return bad;
		if (block.type === "fallback") segmentTexts = 0;
		else if (block.type === "text") {
			if (typeof block.text !== "string" || ++segmentTexts > 1) return bad;
			totalTexts++;
			if (text.length + block.text.length > MAX_OUTPUT_BYTES)
				return { problems: ["output: too_big"] };
			text += block.text;
		} else if (block.type !== "thinking" && block.type !== "redacted_thinking") return bad;
	}
	return totalTexts ? { text } : bad;
}

const knownStops = new Set(["tool_use", "pause_turn", "stop_sequence", "compaction"]);

export function readDraft(message: unknown, contextIds: readonly ContextId[]): Outcome {
	try {
		if (
			!isRecord(message) ||
			!isModel(message.model) ||
			!isRecord(message.usage) ||
			!ContextIds.safeParse(contextIds).success
		)
			throw new MessagesError("INVALID_RESPONSE");
		const usage = message.usage;
		if (
			!Number.isSafeInteger(usage.output_tokens) ||
			Number(usage.output_tokens) < 0 ||
			(usage.input_tokens != null &&
				(!Number.isSafeInteger(usage.input_tokens) || Number(usage.input_tokens) < 0))
		)
			throw new MessagesError("INVALID_RESPONSE");
		if (
			usage.iterations != null &&
			(!Array.isArray(usage.iterations) || usage.iterations.length > 32)
		)
			throw new MessagesError("INVALID_RESPONSE");
		const base = {
			model: message.model,
			fallback:
				Array.isArray(usage.iterations) &&
				usage.iterations.some((item) => isRecord(item) && item.type === "fallback_message"),
			usage: {
				input: (usage.input_tokens ?? null) as number | null,
				output: usage.output_tokens as number,
			},
		};
		const stop = message.stop_reason;
		let result: Outcome;
		if (stop === "refusal") {
			const details = isRecord(message.stop_details) ? message.stop_details : {};
			result = {
				...base,
				kind: "refusal",
				category: boundedText(details.category, 64) ? details.category : null,
				explanation: boundedText(details.explanation, 2_000) ? details.explanation : null,
				recommendedModel: ModelId.safeParse(details.recommended_model).success
					? (details.recommended_model as string)
					: null,
			};
		} else if (stop === "max_tokens" || stop === "model_context_window_exceeded") {
			result = { ...base, kind: "truncated", stopReason: stop };
		} else if (stop !== "end_turn") {
			result = {
				...base,
				kind: "unexpected",
				stopReason: typeof stop === "string" && knownStops.has(stop) ? stop : null,
			};
		} else {
			const served = servedText(message.content);
			const parsed =
				"text" in served
					? parseDraft(served.text, contextIds)
					: { ok: false as const, problems: served.problems };
			result = parsed.ok
				? { ...base, kind: "draft", output: parsed.output }
				: { ...base, kind: "invalid", problems: parsed.problems };
		}
		if (!DraftOutcome.safeParse(result).success) throw new MessagesError("INVALID_RESPONSE");
		return result;
	} catch {
		throw new MessagesError("INVALID_RESPONSE");
	}
}

export type RepairPlan =
	| { readonly kind: "stop" }
	| { readonly kind: "repair"; readonly problems: readonly string[] };

export function repairPlan(outcome: Outcome, repairsUsed: 0 | 1): RepairPlan {
	if (!DraftOutcome.safeParse(outcome).success || (repairsUsed !== 0 && repairsUsed !== 1))
		throw new MessagesError("INVALID_INPUT");
	return outcome.kind === "invalid" && repairsUsed === 0
		? { kind: "repair", problems: [...outcome.problems] }
		: { kind: "stop" };
}
