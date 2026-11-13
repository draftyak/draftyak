import { boundedText, ContentError, MAX_TEXT_BYTES } from "./limits.ts";

const MAX_DISTINCT_TOKENS = 512;
// FEFF is also JavaScript whitespace: keep it in its span so it cannot hide an inner URI.
const SPANS = /(?:[^\s<>"'`]|\uFEFF)+/gu;
const PREFIX_WORD_END = /[\p{L}\p{N}\p{M}_%]$/u;
const UNSAFE_SPAN =
	// biome-ignore lint/suspicious/noControlCharactersInRegex: Reject controls without repairing a URI.
	/[\p{Default_Ignorable_Code_Point}\u0000-\u001f\u007f-\u009f\\]/u;

function schemeCharacter(code: number): boolean {
	return (
		(code >= 65 && code <= 90) ||
		(code >= 97 && code <= 122) ||
		(code >= 48 && code <= 57) ||
		code === 43 ||
		code === 45 ||
		code === 46
	);
}

/**
 * Literal HTTP(S) DATA only: no flag, complete-search or currentness claim. Whitespace, quotes,
 * backticks and angle brackets delimit outer spans. Opening punctuation may precede a scheme;
 * URL-valid trailing punctuation stays literal, including a closing prose bracket in a path.
 * No case folding, decoding, normalization, punctuation trimming or URL serialization is applied.
 */
export function extractLiteralHttpUrlTokens(input: unknown): readonly string[] {
	if (typeof input !== "string") throw new ContentError("INVALID_INPUT");
	// Bound UTF-16 work before the shared well-formedness and UTF-8 checks.
	if (input.length > MAX_TEXT_BYTES) throw new ContentError("INPUT_LIMIT");
	boundedText(input);
	const result = new Set<string>();
	for (const [span] of input.matchAll(SPANS)) {
		if (UNSAFE_SPAN.test(span)) continue;
		// Inspect only the first outer colon, never an inner HTTP URL in another URI's payload.
		const colon = span.indexOf(":");
		if (colon < 0) continue;
		let start = colon;
		while (start > 0 && schemeCharacter(span.charCodeAt(start - 1))) start--;
		if (start > 0 && PREFIX_WORD_END.test(span.slice(Math.max(0, start - 2), start))) continue;
		if (!/^https?$/i.test(span.slice(start, colon))) continue;
		if (span.slice(colon + 1, colon + 3) !== "//") continue;
		// URL() repairs a missing authority in https:///host; literal tokens must not do that.
		const authorityStart = colon + 3;
		if (authorityStart >= span.length || "/?#".includes(span.charAt(authorityStart))) continue;
		const literal = span.slice(start);
		let parsed: URL;
		try {
			parsed = new URL(literal);
		} catch {
			continue;
		}
		if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || !parsed.hostname) continue;
		if (result.has(literal)) continue;
		if (result.size === MAX_DISTINCT_TOKENS) throw new ContentError("STRUCTURE_LIMIT");
		result.add(literal);
	}
	return Object.freeze([...result]);
}
