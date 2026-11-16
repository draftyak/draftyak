import { parseStrict } from "@draftyak/protocol/jcs";
import { refuse } from "./types.ts";

export const MAX_AI_REQUEST_JSON_UNITS = 4096;

/**
 * Input is the broker's private captured native byte copy, not an unknown public boundary.
 * For valid JSON, 1 + container opens + commas equals value nodes + empty containers.
 * Scan before constructing values; the original strict parser still owns JSON validation.
 */
export function parseCapturedAiRequestBody(bytes: Uint8Array): unknown {
	let units = 1;
	let quoted = false;
	let escaped = false;
	for (let at = 0; at < bytes.byteLength; at++) {
		const byte = bytes[at];
		if (quoted) {
			if (escaped) escaped = false;
			else if (byte === 92) escaped = true;
			else if (byte === 34) quoted = false;
		} else if (byte === 34) quoted = true;
		else if (byte === 123 || byte === 91 || byte === 44) {
			if (++units > MAX_AI_REQUEST_JSON_UNITS) refuse();
		}
	}
	try {
		return parseStrict(bytes);
	} catch {
		return refuse();
	}
}
