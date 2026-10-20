import * as z from "zod";
import { Alias } from "../scalars.ts";
import { promptsFor, TONES, WINDOWS } from "./prompts.ts";
import type { McpScope } from "./scopes.ts";

export const COMPLETION_METHOD = "completion/complete";
export const MAX_COMPLETION_VALUES = 20;
export const COMPLETION_LIMIT = 60;
export const COMPLETION_WINDOW_MS = 60_000;
export interface CompletionRequest {
	ref: { type: "ref/prompt"; name: string } | { type: "ref/resource"; uri: string };
	argument: { name: string; value: string };
}
export const CompletionRequest: z.ZodType<CompletionRequest> = z.strictObject({
	ref: z.discriminatedUnion("type", [
		z.strictObject({ type: z.literal("ref/prompt"), name: z.string().max(64) }),
		z.strictObject({ type: z.literal("ref/resource"), uri: z.string().max(1024) }),
	]),
	argument: z.strictObject({ name: z.string().max(64), value: z.string().max(256) }),
});
export interface CompletionResult {
	values: string[];
	total: number;
	hasMore: boolean;
}
export const CompletionResult: z.ZodType<CompletionResult> = z
	.strictObject({
		values: z.array(Alias).max(MAX_COMPLETION_VALUES),
		total: z.int().min(0),
		hasMore: z.boolean(),
	})
	.refine(
		(result) =>
			result.total >= result.values.length &&
			result.hasMore === result.total > result.values.length,
	);
export const AuthorizedAliases: z.ZodType<AuthorizedAliases> = z.strictObject({
	aliases: z.array(Alias),
});
export interface AuthorizedAliases {
	readonly aliases: readonly string[];
}

/** Only native allowlist/routing-projected aliases belong here; never provider records. */
export function completionTarget(
	request: CompletionRequest,
	scopes: readonly McpScope[],
): "account" | "window" | "tone" | null {
	try {
		const parsed = CompletionRequest.parse(request);
		if (parsed.ref.type !== "ref/prompt") return null;
		const promptName = parsed.ref.name;
		if (!promptsFor(scopes).some((prompt) => prompt.name === promptName)) return null;
		if (
			parsed.ref.name === "triage_inbox" &&
			(parsed.argument.name === "account" || parsed.argument.name === "window")
		)
			return parsed.argument.name;
		return parsed.ref.name === "draft_reply" && parsed.argument.name === "tone" ? "tone" : null;
	} catch {
		throw new Error("Completion unavailable");
	}
}

/** No session is needed for aliases. Rate accounting/audit belong to the authenticated caller. */
export function completeArgument(
	request: CompletionRequest,
	authorized: AuthorizedAliases,
	scopes: readonly McpScope[],
): CompletionResult {
	try {
		const input = CompletionRequest.parse(request),
			target = completionTarget(input, scopes);
		const choices =
			target === "account"
				? AuthorizedAliases.parse(authorized).aliases
				: target === "window"
					? WINDOWS
					: target === "tone"
						? TONES
						: [];
		const matches = [...new Set(choices)].filter((value) => value.startsWith(input.argument.value));
		const values = matches.slice(0, MAX_COMPLETION_VALUES);
		return { values, total: matches.length, hasMore: matches.length > values.length };
	} catch {
		throw new Error("Completion unavailable");
	}
}
