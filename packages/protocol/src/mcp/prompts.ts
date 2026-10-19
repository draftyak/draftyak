import * as z from "zod";
import { Alias, Ulid } from "../scalars.ts";
import type { McpScope } from "./scopes.ts";

export const WINDOWS: readonly ["24h", "72h", "7d"] = Object.freeze(["24h", "72h", "7d"]);
export const TONES: readonly ["brief", "neutral", "warm"] = Object.freeze([
	"brief",
	"neutral",
	"warm",
]);
export type PromptWindow = (typeof WINDOWS)[number];
export type PromptTone = (typeof TONES)[number];
export const PromptWindow: z.ZodEnum<z.core.util.ToEnum<PromptWindow>> = z.enum(WINDOWS);
export const PromptTone: z.ZodEnum<z.core.util.ToEnum<PromptTone>> = z.enum(TONES);
export interface TriageInboxArguments {
	account?: string | undefined;
	window?: PromptWindow | undefined;
}
export interface SummarizeThreadArguments {
	conversationId?: string | undefined;
}
export interface DraftReplyArguments {
	conversationId?: string | undefined;
	tone?: PromptTone | undefined;
}
export interface PrepareSendRequestArguments {
	draftId?: string | undefined;
}
export type PromptArgumentValues =
	| TriageInboxArguments
	| SummarizeThreadArguments
	| DraftReplyArguments
	| PrepareSendRequestArguments;
export const TriageInboxArguments: z.ZodType<TriageInboxArguments> = z.strictObject({
	account: Alias.optional(),
	window: PromptWindow.optional(),
});
export const SummarizeThreadArguments: z.ZodType<SummarizeThreadArguments> = z.strictObject({
	conversationId: Ulid.optional(),
});
export const DraftReplyArguments: z.ZodType<DraftReplyArguments> = z.strictObject({
	conversationId: Ulid.optional(),
	tone: PromptTone.optional(),
});
export const PrepareSendRequestArguments: z.ZodType<PrepareSendRequestArguments> = z.strictObject({
	draftId: Ulid.optional(),
});
export type PromptName =
	| "triage_inbox"
	| "summarize_thread"
	| "draft_reply"
	| "prepare_send_request";
export const PromptName: z.ZodEnum<z.core.util.ToEnum<PromptName>> = z.enum([
	"triage_inbox",
	"summarize_thread",
	"draft_reply",
	"prepare_send_request",
]);
export interface PromptDefinition {
	readonly name: PromptName;
	readonly scopes: readonly McpScope[];
	readonly arguments: z.ZodType<PromptArgumentValues>;
	readonly defaultWindow?: "24h";
}
const definitions: readonly PromptDefinition[] = [
	{
		name: "triage_inbox",
		scopes: ["inbox:read"],
		arguments: TriageInboxArguments,
		defaultWindow: "24h",
	},
	{ name: "summarize_thread", scopes: ["inbox:read"], arguments: SummarizeThreadArguments },
	{ name: "draft_reply", scopes: ["inbox:read", "drafts:write"], arguments: DraftReplyArguments },
	{
		name: "prepare_send_request",
		scopes: ["inbox:read", "outbox:propose"],
		arguments: PrepareSendRequestArguments,
	},
];
export const PROMPTS: readonly PromptDefinition[] = Object.freeze(
	definitions.map((prompt) =>
		Object.freeze({ ...prompt, scopes: Object.freeze([...prompt.scopes]) }),
	),
);

export type PromptGetRequest =
	| { name: "triage_inbox"; arguments?: TriageInboxArguments | undefined }
	| { name: "summarize_thread"; arguments?: SummarizeThreadArguments | undefined }
	| { name: "draft_reply"; arguments?: DraftReplyArguments | undefined }
	| { name: "prepare_send_request"; arguments?: PrepareSendRequestArguments | undefined };
export const PromptGetRequest: z.ZodType<PromptGetRequest> = z.discriminatedUnion("name", [
	z.strictObject({ name: z.literal("triage_inbox"), arguments: TriageInboxArguments.optional() }),
	z.strictObject({
		name: z.literal("summarize_thread"),
		arguments: SummarizeThreadArguments.optional(),
	}),
	z.strictObject({ name: z.literal("draft_reply"), arguments: DraftReplyArguments.optional() }),
	z.strictObject({
		name: z.literal("prepare_send_request"),
		arguments: PrepareSendRequestArguments.optional(),
	}),
]);

export function promptsFor(scopes: readonly McpScope[]): PromptDefinition[] {
	return PROMPTS.filter((prompt) => prompt.scopes.every((scope) => scopes.includes(scope)));
}

/** An unknown or unheld prompt has the same refusal; this is scope filtering, not authentication. */
export function parsePromptArguments(
	name: unknown,
	args: unknown,
	scopes: readonly McpScope[],
): PromptArgumentValues {
	const parsed = PromptName.safeParse(name);
	const prompt = parsed.success
		? promptsFor(scopes).find((item) => item.name === parsed.data)
		: undefined;
	if (!prompt) throw new Error("Prompt unavailable");
	try {
		const result = prompt.arguments.safeParse(args === undefined ? {} : args);
		if (result.success) return result.data;
	} catch {
		// Refusals never repeat caller-chosen member names or values.
	}
	throw new Error("Prompt unavailable");
}
