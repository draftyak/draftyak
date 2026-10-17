import * as z from "zod";
import { boundedText } from "./scalars.ts";

const pluginErrorCodes = [
	"AUTH_EXPIRED",
	"AUTH_REVOKED",
	"RATE_LIMITED",
	"QUOTA_EXCEEDED",
	"CURSOR_EXPIRED",
	"NOT_FOUND",
	"PERMISSION_DENIED",
	"TRANSIENT",
	"INVALID_INPUT",
	"UNSUPPORTED",
	"SEND_REJECTED",
	"SEND_UNCERTAIN",
] as const;
export type PluginErrorCode = (typeof pluginErrorCodes)[number];
export const PluginErrorCode: z.ZodEnum<z.core.util.ToEnum<PluginErrorCode>> =
	z.enum(pluginErrorCodes);

// What a plugin's `isError` result carries, in every SDK language.
export const PluginErrorResult: z.ZodObject<
	{
		code: typeof PluginErrorCode;
		retryAfterMs: z.ZodOptional<z.ZodInt>;
		detail: z.ZodOptional<z.ZodString>;
	},
	z.core.$strict
> = z
	.strictObject({
		code: PluginErrorCode,
		retryAfterMs: z.int().min(0).optional(),
		detail: boundedText(1000).optional(),
	})
	.meta({ title: "PluginErrorResult", description: "A plugin tool's error result." });
export type PluginErrorResult = z.infer<typeof PluginErrorResult>;

const hubErrorCodes = [
	"DRAFT_LOCKED",
	"SCHEDULE_LIMIT",
	"SCHEDULING_UNAVAILABLE",
	"NONEXISTENT_LOCAL_TIME",
	"AMBIGUOUS_LOCAL_TIME",
	"RATE_LIMITED",
] as const;
export type HubErrorCode = (typeof hubErrorCodes)[number];
export const HubErrorCode: z.ZodEnum<z.core.util.ToEnum<HubErrorCode>> = z.enum(hubErrorCodes);
