import type Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { AutoParseableBetaOutputFormat } from "@anthropic-ai/sdk/lib/beta-parser";
import type {
	BetaContentBlock,
	BetaMessage,
	MessageCreateParamsNonStreaming,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { z } from "zod";
import { FALLBACK_BETA, FALLBACK_MODELS } from "./verify.ts";

// Plugins never generate code from strings (§4), so zod validates without its JIT.
z.config({ jitless: true });

export const DEFAULT_MODEL = "claude-opus-5-5";
export const DRAFT_MAX_TOKENS = 16_000;
export const DRAFT_EFFORT = "medium";
// A job's context ids (plan §5): one per lookup that ran, at most three.
export const CONTEXT_IDS = ["c1", "c2", "c3"] as const;
export type ContextId = (typeof CONTEXT_IDS)[number];

export interface DraftOutputLite {
	body: string;
	ownerNotes: string;
	needsOwnerInput: string[];
	suspectedInstructions: boolean;
	contextRefs: ContextId[];
}

const fields = {
	body: z.string().max(8_000),
	ownerNotes: z.string().max(1_000),
	needsOwnerInput: z.array(z.string().max(300)).max(5),
	suspectedInstructions: z.boolean(),
};

// What the model is asked for. Structured outputs don't enforce lengths, array caps or (through
// the SDK's schema transform) enums, so the parser checks them.
export const draftOutputSchema: z.ZodType<DraftOutputLite> = z.strictObject({
	...fields,
	contextRefs: z.array(z.enum(CONTEXT_IDS)).max(3),
});

// What is read back. contextRefs is informational (plan §5): ids outside the job's set are dropped,
// never failing the draft, and case is ignored (enum casing isn't guaranteed, structured outputs).
const readSchema = z.strictObject({ ...fields, contextRefs: z.array(z.unknown()) });

export type ParseResult =
	| { readonly ok: true; readonly output: DraftOutputLite }
	| { readonly ok: false; readonly problems: readonly string[] };

// The only parser of model output. Problems name schema paths and issue codes, never content.
export const parser: {
	parse(text: string, contextIds?: readonly ContextId[]): ParseResult;
} = {
	parse(text, contextIds = CONTEXT_IDS) {
		let value: unknown;
		try {
			value = JSON.parse(text);
		} catch {
			return { ok: false, problems: ["output: not JSON"] };
		}
		const result = readSchema.safeParse(value);
		if (!result.success) {
			const problems = result.error.issues.map(
				(issue) => `${issue.path.map(String).join(".") || "output"}: ${issue.code}`,
			);
			return { ok: false, problems };
		}
		const refs = result.data.contextRefs.map((ref) =>
			typeof ref === "string" ? ref.toLowerCase() : ref,
		);
		const contextRefs = contextIds.filter((id) => refs.includes(id));
		return { ok: true, output: { ...result.data, contextRefs } };
	},
};

// SDK 0.135.0's messages.parse runs format.parse on every text block whatever the stop_reason, and
// throws on truncated JSON before the caller sees why it stopped. So format.parse returns the text
// as it is, and readDraft parses only after checking stop_reason.
export const draftFormat: AutoParseableBetaOutputFormat<string> = {
	type: "json_schema",
	schema: betaZodOutputFormat(draftOutputSchema).schema,
	parse: (text) => text,
};

export interface DraftInput {
	readonly system: string;
	readonly prompt: string;
	readonly model?: string;
	readonly contextIds?: readonly ContextId[];
}

export type DraftParams = MessageCreateParamsNonStreaming & {
	output_config: { effort: typeof DRAFT_EFFORT; format: typeof draftFormat };
};

export interface DraftCall {
	readonly params: DraftParams;
	// beta.messages.parse appends structured-outputs-2025-12-15 to anthropic-beta, though
	// output_config.format is GA and needs no beta. The header is set here instead: the fallback beta
	// with fallbacks, otherwise none.
	readonly headers: { readonly "anthropic-beta": string | null };
}

export function draftCall(input: DraftInput): DraftCall {
	const model = input.model ?? DEFAULT_MODEL;
	const fallbacks = FALLBACK_MODELS.has(model);
	const params: DraftParams = {
		model,
		max_tokens: DRAFT_MAX_TOKENS,
		system: input.system,
		messages: [{ role: "user", content: input.prompt }],
		output_config: { effort: DRAFT_EFFORT, format: draftFormat },
		...(fallbacks ? { fallbacks: "default" } : {}),
	};
	return { params, headers: { "anthropic-beta": fallbacks ? FALLBACK_BETA : null } };
}

interface Outcome {
	readonly model: string;
	// A fallback model ran (usage.iterations has a fallback_message entry).
	readonly fallback: boolean;
	readonly usage: { readonly input: number | null; readonly output: number };
}

export type DraftResult = Outcome &
	(
		| { readonly kind: "draft"; readonly output: DraftOutputLite }
		| {
				readonly kind: "refusal";
				readonly category: string | null;
				readonly explanation: string | null;
				readonly recommendedModel: string | null;
		  }
		| {
				readonly kind: "truncated";
				readonly stopReason: "max_tokens" | "model_context_window_exceeded";
		  }
		| { readonly kind: "invalid"; readonly problems: readonly string[] }
		| { readonly kind: "unexpected"; readonly stopReason: string | null }
	);

// A fallback block hands the answer to the next model, and each model's part holds at most one text
// block. Non-streaming responses drop a declined part's text; a stream keeps it and the fallback
// model continues it (refusals-and-fallback, Streaming), so the parts' text is joined.
function servedText(content: readonly BetaContentBlock[]): { text: string } | { problem: string } {
	const parts: string[][] = [[]];
	for (const block of content) {
		if (block.type === "fallback") parts.push([]);
		else if (block.type === "text") parts.at(-1)?.push(block.text);
	}
	const crowded = parts.find((texts) => texts.length > 1);
	if (crowded) return { problem: `output: ${crowded.length} text blocks` };
	const texts = parts.flat();
	return texts.length > 0 ? { text: texts.join("") } : { problem: "output: 0 text blocks" };
}

// stop_reason first: a refusal or a cut-off answer never reaches the parser.
export function readDraft(
	message: BetaMessage,
	contextIds: readonly ContextId[] = CONTEXT_IDS,
): DraftResult {
	const outcome: Outcome = {
		model: message.model,
		fallback: (message.usage.iterations ?? []).some((entry) => entry.type === "fallback_message"),
		usage: { input: message.usage.input_tokens, output: message.usage.output_tokens },
	};
	const stop = message.stop_reason;
	if (stop === "refusal") {
		const details = message.stop_details;
		return {
			...outcome,
			kind: "refusal",
			category: details?.category ?? null,
			explanation: details?.explanation ?? null,
			recommendedModel: details?.recommended_model ?? null,
		};
	}
	if (stop === "max_tokens" || stop === "model_context_window_exceeded") {
		return { ...outcome, kind: "truncated", stopReason: stop };
	}
	if (stop !== "end_turn") return { ...outcome, kind: "unexpected", stopReason: stop };
	const served = servedText(message.content);
	if ("problem" in served) return { ...outcome, kind: "invalid", problems: [served.problem] };
	const parsed = parser.parse(served.text, contextIds);
	return parsed.ok
		? { ...outcome, kind: "draft", output: parsed.output }
		: { ...outcome, kind: "invalid", problems: parsed.problems };
}

export async function draft(client: Anthropic, input: DraftInput): Promise<DraftResult> {
	const { params, headers } = draftCall(input);
	return readDraft(await client.beta.messages.parse(params, { headers }), input.contextIds);
}
