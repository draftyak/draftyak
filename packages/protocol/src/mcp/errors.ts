import * as z from "zod";
import { wellFormedText } from "../entities/common.ts";

export type McpAppError =
	| {
			readonly code: 1001;
			readonly message: string;
			readonly data: { readonly code: "AGENT_SESSION_REQUIRED" };
	  }
	| {
			readonly code: 1002;
			readonly message: string;
			readonly data: { readonly code: "SCOPE_REQUIRED" };
	  }
	| {
			readonly code: 1003;
			readonly message: string;
			readonly data: { readonly code: "RATE_LIMITED"; readonly retryAfterMs: number };
	  };
const message = wellFormedText(512).min(1);
// First-party tool errors are separate from JSON-RPC application errors and plugin errors.
export interface McpSessionRequiredResult {
	readonly isError: true;
	readonly content: readonly [{ readonly type: "text"; readonly text: string }];
	readonly _meta: {
		readonly "io.github.draftyak/error": { readonly code: "AGENT_SESSION_REQUIRED" };
	};
}
export const McpSessionRequiredResult: z.ZodType<McpSessionRequiredResult> = z.strictObject({
	isError: z.literal(true),
	content: z.tuple([z.strictObject({ type: z.literal("text"), text: message })]),
	_meta: z.strictObject({
		"io.github.draftyak/error": z.strictObject({ code: z.literal("AGENT_SESSION_REQUIRED") }),
	}),
});

export const McpAppError: z.ZodType<McpAppError> = z.discriminatedUnion("code", [
	z.strictObject({
		code: z.literal(1001),
		message,
		data: z.strictObject({ code: z.literal("AGENT_SESSION_REQUIRED") }),
	}),
	z.strictObject({
		code: z.literal(1002),
		message,
		data: z.strictObject({ code: z.literal("SCOPE_REQUIRED") }),
	}),
	z.strictObject({
		code: z.literal(1003),
		message,
		data: z.strictObject({ code: z.literal("RATE_LIMITED"), retryAfterMs: z.int().min(0) }),
	}),
]);
