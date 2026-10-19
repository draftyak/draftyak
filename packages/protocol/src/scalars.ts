import * as z from "zod";
import { CALENDAR_DATE_PATTERN } from "./date-pattern.ts";

// Base64url (RFC 4648 §5) without padding, in its one canonical form: the unused low bits of the
// last character are zero, so every byte string has exactly one encoding.
export const BASE64URL: RegExp =
	/^(?:[A-Za-z0-9_-]{4})*(?:[A-Za-z0-9_-][AQgw]|[A-Za-z0-9_-]{2}[AEIMQUYcgkosw048])?$/;

// Exported patterns are ECMA-262 with explicit ASCII classes; fixed-length scalars also carry their
// length, which holds even where `$` matches before a final line feed (Python's re).
export const Ulid: z.ZodString = z
	.string()
	.length(26)
	.regex(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/)
	.meta({ description: "A ULID: 26 upper-case Crockford base32 characters." });
export type Ulid = z.infer<typeof Ulid>;

export const Alias: z.ZodString = z
	.string()
	.regex(/^[a-z0-9][a-z0-9-]{0,31}$/)
	.meta({ description: "An owner-chosen account alias." });
export type Alias = z.infer<typeof Alias>;

export const Sha256Hex: z.ZodString = z
	.string()
	.length(64)
	.regex(/^[0-9a-f]{64}$/)
	.meta({ description: "A SHA-256 digest as 64 lower-case hex characters." });
export type Sha256Hex = z.infer<typeof Sha256Hex>;

export const Base64Url: z.ZodString = z
	.string()
	.regex(BASE64URL)
	.meta({ description: "Bytes as unpadded, canonical base64url." });
export type Base64Url = z.infer<typeof Base64Url>;

export const UtcMs: z.ZodInt = z
	.int()
	.min(0)
	.meta({ description: "An instant as UTC milliseconds since the epoch, a safe integer." });
export type UtcMs = z.infer<typeof UtcMs>;

// A real date, leap years included. zod's own datetime pattern writes \d, which Python's re and
// Rust's regex read as any Unicode digit.
export const Iso8601Utc: z.ZodString = z
	.string()
	.length(24)
	.regex(
		new RegExp(
			`^(?:${CALENDAR_DATE_PATTERN})T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]\\.[0-9]{3}Z$`,
		),
	)
	.meta({ format: "date-time", description: "An instant as YYYY-MM-DDTHH:mm:ss.sssZ." });
export type Iso8601Utc = z.infer<typeof Iso8601Utc>;

// Text limits count code points, as JSON Schema's maxLength does, so every language enforces the
// same bound. The text is well-formed too: a lone surrogate has no UTF-8 form, so JCS and every
// hash refuse it. Rust's strings can't hold one, but Python's and Kotlin's can, and JSON Schema
// can't state the rule, so their code checks it as this refine does.
export function boundedText(maxCodePoints: number): z.ZodString {
	return z
		.string()
		.refine((text) => [...text].length <= maxCodePoints, {
			message: `at most ${maxCodePoints} characters`,
		})
		.refine((text) => text.isWellFormed(), { message: "lone surrogate" })
		.meta({ maxLength: maxCodePoints });
}

// Decodes canonical base64url, or returns undefined; Buffer's own decoder skips invalid characters.
export function fromBase64Url(text: string): Uint8Array | undefined {
	return typeof text === "string" && BASE64URL.test(text)
		? new Uint8Array(Buffer.from(text, "base64url"))
		: undefined;
}

export const toBase64Url = (bytes: Uint8Array): string =>
	Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64url");
