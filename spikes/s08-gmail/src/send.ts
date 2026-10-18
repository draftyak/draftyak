import { randomBytes } from "node:crypto";
import { type Gmail, GmailError, header, type Message } from "./api.ts";
import type { Rendered } from "./mime.ts";

// Google says a 200 doesn't prove the mail went out, so a sent item reads "Accepted by Gmail".
export const ACCEPTED = "Accepted by Gmail";

export interface ReadBack {
	readonly labelIds: readonly string[];
	readonly messageId: string | null;
	readonly date: string | null;
	readonly internalDate: number | null;
}

// Gmail's own Date would be its receive time (internalDate), to the second. A stamp this close to
// it can't show whether Gmail kept ours, so the live probe stamps the claim 90 s back.
export const DATE_AMBIGUITY_MS = 2_000;

export interface SendResult {
	readonly status: typeof ACCEPTED;
	readonly id: string;
	readonly threadId: string;
	readonly labelIds: readonly string[];
	// Gmail starts a new thread when In-Reply-To, References or Subject don't fit the requested one.
	readonly threadKept: boolean | null;
	// null if the read-back failed or lacked the header; the send stands and reconcile fills the gap.
	readonly readBack: ReadBack | null;
	readonly messageIdKept: boolean | null;
	// "inconclusive": the stamp is within DATE_AMBIGUITY_MS of Gmail's receive time.
	readonly dateKept: boolean | "inconclusive" | null;
}

export interface Upload {
	readonly body: Uint8Array<ArrayBuffer>;
	readonly contentType: string;
}

// uploadType=multipart: a multipart/related body of the Message metadata (JSON), then the message.
export function multipartUpload(
	metadata: Readonly<Record<string, string>>,
	raw: Uint8Array,
): Upload {
	const message = Buffer.from(raw);
	let boundary = "";
	do boundary = `dy_${randomBytes(16).toString("hex")}`;
	while (message.includes(boundary));
	const head =
		`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
		`${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: message/rfc822\r\n\r\n`;
	const body = Buffer.concat([Buffer.from(head), message, Buffer.from(`\r\n--${boundary}--\r\n`)]);
	return { body: new Uint8Array(body), contentType: `multipart/related; boundary=${boundary}` };
}

export async function readBack(gmail: Gmail, id: string): Promise<ReadBack> {
	const message = await gmail.getMessage(id, {
		format: "metadata",
		metadataHeaders: ["Message-ID", "Date"],
	});
	const received = Number(message.internalDate);
	return {
		labelIds: message.labelIds ?? [],
		messageId: header(message.payload, "Message-ID") ?? null,
		date: header(message.payload, "Date") ?? null,
		internalDate: Number.isFinite(received) ? received : null,
	};
}

export function dateKept(back: ReadBack | null, stamp: Date): SendResult["dateKept"] {
	if (back?.date == null) return null;
	if (Date.parse(back.date) !== stamp.getTime()) return false;
	const apart = back.internalDate === null ? 0 : Math.abs(back.internalDate - stamp.getTime());
	return apart > DATE_AMBIGUITY_MS ? true : "inconclusive";
}

// messages.send as a multipart upload into the reply's thread, then a metadata read-back.
export async function sendMessage(
	gmail: Gmail,
	rendered: Rendered,
	options: { readonly threadId?: string } = {},
): Promise<SendResult> {
	const upload = multipartUpload(
		options.threadId === undefined ? {} : { threadId: options.threadId },
		rendered.raw,
	);
	const sent = (await gmail.call("POST", "upload/gmail/v1/users/me/messages/send", {
		query: { uploadType: "multipart" },
		body: upload.body,
		contentType: upload.contentType,
	})) as Partial<Message> | undefined;
	if (typeof sent?.id !== "string" || typeof sent.threadId !== "string") {
		throw new GmailError(200, { kind: "unknown", reason: "no_message_id" }, sent);
	}
	const back = await readBack(gmail, sent.id).catch(() => null);
	return {
		status: ACCEPTED,
		id: sent.id,
		threadId: sent.threadId,
		labelIds: sent.labelIds ?? [],
		threadKept: options.threadId === undefined ? null : sent.threadId === options.threadId,
		readBack: back,
		messageIdKept: back?.messageId == null ? null : back.messageId === rendered.stamp.messageId,
		dateKept: dateKept(back, rendered.stamp.date),
	};
}
