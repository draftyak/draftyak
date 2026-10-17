import { type Gmail, header, type Message, type MessagePart, type MessageRef } from "./api.ts";
import { decodeText, normalizeAddresses, normalizeSubject, textSha256 } from "./mime.ts";

// What the attempt row holds after the claim (plan §3 Gmail send and reconcile).
export interface Attempt {
	readonly messageId: string;
	readonly threadId?: string;
	readonly to: readonly string[];
	readonly cc: readonly string[];
	readonly subject: string;
	readonly textSha256: string;
	readonly attemptedAt: number;
}

export type ReconcileResult =
	| {
			readonly status: "sent";
			readonly id: string;
			readonly threadId: string;
			readonly via: "rfc822msgid" | "fallback";
	  }
	| { readonly status: "not_found"; readonly scanned: number; readonly complete: boolean }
	| { readonly status: "ambiguous"; readonly ids: readonly string[] };

export interface ReconcileOptions {
	// Off if S8 finds that Gmail replaces our Message-ID.
	readonly byMessageId?: boolean;
	// How far before the attempt time the in:sent search starts (the clock rule allows 2 min).
	readonly skewMs?: number;
	readonly maxPages?: number;
}

// Mail scheduled in the Gmail web UI, drafts and anything without SENT never count as sent.
export function countsAsSent(labelIds: readonly string[] | undefined): boolean {
	const labels = new Set(labelIds ?? []);
	return labels.has("SENT") && !labels.has("SCHEDULED") && !labels.has("DRAFT");
}

// The first text/plain part that isn't an attachment, decoded as Gmail's format=full returns it.
export function plainText(part: MessagePart | undefined): string | undefined {
	if (part === undefined) return undefined;
	if (part.mimeType?.toLowerCase() === "text/plain" && !part.filename) {
		const charset = /charset="?([\w.:-]+)/i.exec(header(part, "Content-Type") ?? "")?.[1];
		return decodeText(charset ?? "utf-8", Buffer.from(part.body?.data ?? "", "base64url"));
	}
	for (const child of part.parts ?? []) {
		const text = plainText(child);
		if (text !== undefined) return text;
	}
	return undefined;
}

async function byMessageId(gmail: Gmail, attempt: Attempt): Promise<Message[]> {
	const list = await gmail.listMessages({ q: `rfc822msgid:${attempt.messageId.slice(1, -1)}` });
	const found: Message[] = [];
	for (const ref of list.messages ?? []) {
		const message = await gmail.getMessage(ref.id, { format: "minimal" });
		if (countsAsSent(message.labelIds)) found.push(message);
	}
	return found;
}

// in:sent since the attempt, matched on threadId, normalized To/Cc/Subject and the text's SHA-256.
// Headers are read first, and only a header match costs a body read. Gmail starts a new thread
// when a reply's subject or references don't fit (SendResult.threadKept), so once a complete scan
// finds nothing in the thread, a match elsewhere counts if its thread began after the attempt.
async function bySent(
	gmail: Gmail,
	attempt: Attempt,
	options: Required<ReconcileOptions>,
): Promise<{ matches: Message[]; scanned: number; complete: boolean }> {
	const since = attempt.attemptedAt - options.skewMs;
	const q = `in:sent after:${Math.floor(since / 1000)}`;
	const want = [attempt.to, attempt.cc].map((list) => normalizeAddresses(list).join());
	const subject = normalizeSubject(attempt.subject);
	let scanned = 0;
	const check = async (ref: MessageRef): Promise<Message | undefined> => {
		scanned++;
		const meta = await gmail.getMessage(ref.id, {
			format: "metadata",
			metadataHeaders: ["To", "Cc", "Subject"],
		});
		const got = ["To", "Cc"].map((name) => normalizeAddresses(header(meta.payload, name)).join());
		if (
			!countsAsSent(meta.labelIds) ||
			Number(meta.internalDate ?? 0) < since ||
			got[0] !== want[0] ||
			got[1] !== want[1] ||
			normalizeSubject(header(meta.payload, "Subject")) !== subject
		) {
			return undefined;
		}
		const full = await gmail.getMessage(ref.id, { format: "full" });
		const text = plainText(full.payload);
		return text !== undefined && textSha256(text) === attempt.textSha256 ? full : undefined;
	};
	const matches: Message[] = [];
	const elsewhere: MessageRef[] = [];
	let complete = false;
	let pageToken: string | undefined;
	for (let page = 0; page < options.maxPages && !complete; page++) {
		const list = await gmail.listMessages({ q, maxResults: 100, pageToken });
		for (const ref of list.messages ?? []) {
			if (attempt.threadId !== undefined && ref.threadId !== attempt.threadId) {
				elsewhere.push(ref);
				continue;
			}
			const found = await check(ref);
			if (found !== undefined) matches.push(found);
		}
		pageToken = list.nextPageToken;
		complete = pageToken === undefined;
	}
	for (const ref of matches.length === 0 && complete ? elsewhere : []) {
		const found = await check(ref);
		if (found === undefined) continue;
		const thread = await gmail.getThread(ref.threadId, { format: "minimal" });
		const dates = (thread.messages ?? []).map((message) => Number(message.internalDate ?? 0));
		if (dates.length > 0 && Math.min(...dates) >= since) matches.push(found);
	}
	return { matches, scanned, complete };
}

// Found → SENT; not found → NEEDS_REAPPROVAL (not_found), never an automatic resend.
export async function reconcile(
	gmail: Gmail,
	attempt: Attempt,
	options: ReconcileOptions = {},
): Promise<ReconcileResult> {
	const settings = { byMessageId: true, skewMs: 120_000, maxPages: 5, ...options };
	const pick = (found: Message[], via: "rfc822msgid" | "fallback"): ReconcileResult | null => {
		const [only, ...rest] = found;
		if (only === undefined) return null;
		if (rest.length > 0) return { status: "ambiguous", ids: found.map((message) => message.id) };
		return { status: "sent", id: only.id, threadId: only.threadId, via };
	};
	if (settings.byMessageId) {
		const result = pick(await byMessageId(gmail, attempt), "rfc822msgid");
		if (result !== null) return result;
	}
	const { matches, scanned, complete } = await bySent(gmail, attempt, settings);
	return pick(matches, "fallback") ?? { status: "not_found", scanned, complete };
}

// The outbox step after reconcile (plan §3). Two matching copies still mean the mail went out, so
// ambiguous is SENT too, flagged for the owner; only not_found goes to re-approval, never a resend.
export function afterReconcile(
	result: ReconcileResult,
):
	| { readonly state: "SENT"; readonly flagged: boolean }
	| { readonly state: "NEEDS_REAPPROVAL"; readonly reason: "not_found" } {
	return result.status === "not_found"
		? { state: "NEEDS_REAPPROVAL", reason: "not_found" }
		: { state: "SENT", flagged: result.status === "ambiguous" };
}
