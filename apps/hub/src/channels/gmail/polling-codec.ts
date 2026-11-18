import { type GmailPollingSnapshot, restoreGmailPollingState } from "./polling.ts";

const MAX_PAYLOAD_BYTES = 16_384;
const INVALID = "Invalid Gmail polling payload";

function fail(): never {
	throw new TypeError(INVALID);
}

function checked(value: unknown, journalRevision: number): GmailPollingSnapshot {
	if (!Number.isSafeInteger(journalRevision) || journalRevision < 0) fail();
	const current = restoreGmailPollingState(value);
	if (current.revision !== journalRevision) fail();
	return current;
}

function bounded(value: string): string {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		!value.isWellFormed() ||
		Buffer.byteLength(value, "utf8") > MAX_PAYLOAD_BYTES
	) {
		fail();
	}
	return value;
}

/** Encodes validated cadence DATA for the supplied journal row revision. */
export function encodeGmailPollingPayload(
	snapshot: GmailPollingSnapshot,
	journalRevision: number,
): string {
	try {
		const current = checked(snapshot, journalRevision);
		return bounded(JSON.stringify(current));
	} catch {
		return fail();
	}
}

/**
 * Restores exact canonical DATA without resetting due times or unresolved runs.
 * The row revision is correlation DATA; it grants no scope or execution rights.
 */
export function decodeGmailPollingPayload(
	payload: string,
	journalRevision: number,
): GmailPollingSnapshot {
	try {
		const parsed: unknown = JSON.parse(bounded(payload));
		const current = checked(parsed, journalRevision);
		if (JSON.stringify(current) !== payload) fail();
		return current;
	} catch {
		return fail();
	}
}
