import * as z from "zod";
import {
	type ContextId,
	ContextIds,
	DraftOutputV1,
	MAX_DRAFT_PROBLEMS,
	normalizeDraftOutput,
} from "./draft-output.ts";
import {
	checkToolResult,
	type ExtensionContract,
	PluginError,
	ProbeResult,
	type ResultCheck,
	type ToolContract,
	wellFormedText,
} from "./extension.ts";

export const AI_PROVIDER_V1 = "io.github.draftyak/ai-provider";

export const ModelId: z.ZodString = z
	.string()
	.min(1)
	.max(256)
	.regex(/^[!-~]+$/)
	.meta({ description: "A provider's model id: visible ASCII, no spaces." });

// "<path>: <issue>", as validateDraftOutput and M0.30's parser name a problem: words, never content.
export const DraftProblem: z.ZodString = z
	.string()
	.max(200)
	.regex(/^[A-Za-z0-9_]+(?:[.][A-Za-z0-9_]+)*: [A-Za-z0-9_]+(?: [A-Za-z0-9_]+)*$/)
	.meta({ description: "A schema path and an issue, such as output.body: too_big." });

export interface AiDescription {
	readonly name: string;
	// native: the provider enforces the JSON Schema; validated: the plugin checks it after the call.
	readonly structuredOutput: "native" | "validated";
}
export interface ModelInfo {
	readonly id: string;
	readonly name?: string;
	readonly contextTokens?: number;
	readonly fallbacks?: boolean;
}

// The prompt parts the hub built (§5 Prompt layout): the trusted instructions as `system`; owner
// context, any <context-…> block, the <thread-…> block and the reminder as `prompt`.
export interface DraftRequest {
	readonly model: string;
	readonly system: string;
	readonly prompt: string;
	readonly contextIds: readonly ContextId[];
}

interface Outcome {
	// The model that answered, after any fallback.
	readonly model: string;
	readonly fallback: boolean;
	readonly usage: { readonly input: number | null; readonly output: number };
}
// M0.30's outcome model: the stop reason is read before the output is parsed.
export type DraftOutcome = Outcome &
	(
		| { readonly kind: "draft"; readonly output: DraftOutputV1 }
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

const outcome = {
	model: ModelId,
	fallback: z.boolean(),
	usage: z.strictObject({ input: z.int().min(0).nullable(), output: z.int().min(0) }),
};
export const DraftOutcome: z.ZodType<DraftOutcome> = z
	.discriminatedUnion("kind", [
		z.strictObject({ kind: z.literal("draft"), ...outcome, output: DraftOutputV1 }),
		z.strictObject({
			kind: z.literal("refusal"),
			...outcome,
			category: wellFormedText(64).nullable(),
			explanation: wellFormedText(2_000).nullable(),
			recommendedModel: ModelId.nullable(),
		}),
		z.strictObject({
			kind: z.literal("truncated"),
			...outcome,
			stopReason: z.enum(["max_tokens", "model_context_window_exceeded"]),
		}),
		// The schema problems, by path and issue, for the hub's one repair retry.
		z.strictObject({
			kind: z.literal("invalid"),
			...outcome,
			problems: z.array(DraftProblem).min(1).max(MAX_DRAFT_PROBLEMS),
		}),
		z.strictObject({
			kind: z.literal("unexpected"),
			...outcome,
			stopReason: wellFormedText(64).nullable(),
		}),
	])
	.meta({
		type: "object",
		title: "DraftOutcome",
		description: "How a draft call ended, with its usage.",
	});

export type AiProviderV1Tools = {
	readonly ai_describe: ToolContract<Readonly<Record<string, never>>, AiDescription>;
	readonly ai_models_list: ToolContract<
		Readonly<Record<string, never>>,
		{ readonly models: readonly ModelInfo[] }
	>;
	readonly ai_probe: ToolContract<{ readonly model?: string }, ProbeResult>;
	readonly ai_draft_generate: ToolContract<DraftRequest, DraftOutcome>;
};

const empty = z.strictObject({});

export const aiProviderV1: ExtensionContract<AiProviderV1Tools> = {
	id: AI_PROVIDER_V1,
	version: 1,
	title: "io.github.draftyak/ai-provider v1",
	path: "schemas/ai-provider-v1.schema.json",
	error: PluginError,
	tools: {
		ai_describe: {
			description: "The provider's name and how its structured output is enforced.",
			input: empty,
			output: z.strictObject({
				name: wellFormedText(64),
				structuredOutput: z.enum(["native", "validated"]),
			}),
		},
		ai_models_list: {
			description: "The models the instance can use.",
			input: empty,
			output: z.strictObject({
				models: z
					.array(
						z.strictObject({
							id: ModelId,
							name: wellFormedText(128).optional(),
							contextTokens: z.int().min(1).optional(),
							fallbacks: z.boolean().optional(),
						}),
					)
					.max(500),
			}),
		},
		ai_probe: {
			description: "Checks the endpoint and credentials with a minimal call; returns status only.",
			input: z.strictObject({ model: ModelId.optional() }),
			output: ProbeResult,
		},
		ai_draft_generate: {
			description:
				"Drafts a reply from the hub-built prompt parts, reporting progress while it works. " +
				"Only contextIds may appear in the draft's contextRefs.",
			input: z.strictObject({
				model: ModelId,
				system: wellFormedText(100_000),
				prompt: wellFormedText(1_000_000),
				contextIds: ContextIds,
			}),
			output: DraftOutcome,
		},
	},
};

// How the hub reads an ai_draft_generate result for a job: a draft's contextRefs are first narrowed
// to the job's own context ids, as normalizeDraftOutput does, so they never fail the draft.
export function checkDraftOutcome(result: unknown, contextIds: readonly ContextId[]): ResultCheck {
	const body = result as { isError?: unknown; structuredContent?: unknown } | null;
	const content = body?.structuredContent as { kind?: unknown; output?: unknown } | null;
	if (typeof body !== "object" || body?.isError === true || content?.kind !== "draft") {
		return checkToolResult(aiProviderV1, "ai_draft_generate", result);
	}
	const output = normalizeDraftOutput(content.output, contextIds);
	const structuredContent = { ...content, output };
	return checkToolResult(aiProviderV1, "ai_draft_generate", { ...body, structuredContent });
}
