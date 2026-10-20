import {
	type ContextId,
	ContextIds,
	type DraftOutputCheck,
	normalizeDraftOutput,
	validateDraftOutput,
} from "./draft-output.ts";
import { JcsError, parseStrict } from "./jcs.ts";

export const MAX_DRAFT_OUTPUT_TEXT_BYTES: number = 262_144;
const utf8 = new TextEncoder();

/**
 * Parses a completed final answer only after the adapter maps refusal, truncation and other
 * stop reasons to their outcomes. The hub owns the single repair retry.
 */
export function parseDraftOutputText(
	text: string,
	contextIds: readonly ContextId[],
): DraftOutputCheck {
	if (!ContextIds.safeParse(contextIds).success)
		throw new TypeError("Invalid draft context catalogue");
	if (typeof text !== "string") throw new TypeError("Draft text must be a string");
	try {
		// Check UTF-16 length before allocating a bounded UTF-8 encoding.
		if (
			text.length > MAX_DRAFT_OUTPUT_TEXT_BYTES ||
			utf8.encode(text).byteLength > MAX_DRAFT_OUTPUT_TEXT_BYTES
		)
			return { ok: false, problems: ["output: too_big"] };
		return validateDraftOutput(normalizeDraftOutput(parseStrict(text), contextIds));
	} catch (error) {
		if (error instanceof JcsError) return { ok: false, problems: ["output: invalid_JSON"] };
		throw error;
	}
}
