import { types } from "node:util";
import { EmailMessageChange } from "@draftyak/protocol/normalized-change";

export const MAX_GMAIL_RECEIPT_METADATA_BYTES: number = 4 * 1_048_576;
export const MAX_GMAIL_RECEIPT_BLOB_BYTES: number = MAX_GMAIL_RECEIPT_METADATA_BYTES + 65_536;

/** Provider metadata DATA; it grants no approval, account, dispatch or retry authority. */
export interface NativeGmailSendReceiptData {
	readonly message: EmailMessageChange;
	readonly messageIdHeader: string;
	readonly bytesRead: number;
}

function refused(): Error {
	return new Error("Gmail receipt unavailable");
}

function providerId(input: unknown): void {
	if (typeof input !== "string" || !/^[!-~]{1,256}(?![\s\S])/.test(input)) throw refused();
}

function record(input: unknown, keys: readonly string[]): Record<string, unknown> {
	if (
		!input ||
		typeof input !== "object" ||
		Array.isArray(input) ||
		types.isProxy(input) ||
		![Object.prototype, null].includes(Object.getPrototypeOf(input)) ||
		Reflect.ownKeys(input).length !== keys.length
	)
		throw refused();
	const result: Record<string, unknown> = Object.create(null);
	for (const key of keys) {
		const descriptor = Object.getOwnPropertyDescriptor(input, key);
		if (!descriptor || !("value" in descriptor)) throw refused();
		result[key] = descriptor.value;
	}
	return result;
}

/** Capture detached metadata without invoking caller accessors or retaining mutable arrays. */
export function captureNativeGmailSendReceiptData(input: unknown): NativeGmailSendReceiptData {
	const receipt = record(input, ["message", "messageIdHeader", "bytesRead"]);
	if (
		typeof receipt.messageIdHeader !== "string" ||
		receipt.messageIdHeader.length === 0 ||
		!receipt.messageIdHeader.isWellFormed() ||
		Buffer.byteLength(receipt.messageIdHeader) > MAX_GMAIL_RECEIPT_METADATA_BYTES ||
		!Number.isSafeInteger(receipt.bytesRead) ||
		Number(receipt.bytesRead) < 1 ||
		Number(receipt.bytesRead) > MAX_GMAIL_RECEIPT_METADATA_BYTES
	)
		throw refused();
	const rawMessage = receipt.message;
	if (!rawMessage || typeof rawMessage !== "object" || types.isProxy(rawMessage)) throw refused();
	const message = record(rawMessage, [
		"kind",
		"providerId",
		"threadId",
		"internalDate",
		"labelIds",
		...(Object.hasOwn(rawMessage, "sizeBytes") ? ["sizeBytes"] : []),
	]);
	const labels = message.labelIds;
	if (
		!Array.isArray(labels) ||
		types.isProxy(labels) ||
		labels.length > 256 ||
		Reflect.ownKeys(labels).length !== labels.length + 1
	)
		throw refused();
	const ownedLabels: unknown[] = [];
	for (let at = 0; at < labels.length; at++) {
		const descriptor = Object.getOwnPropertyDescriptor(labels, String(at));
		if (!descriptor || !("value" in descriptor)) throw refused();
		ownedLabels.push(descriptor.value);
	}
	const captured = EmailMessageChange.parse({ ...message, labelIds: ownedLabels });
	providerId(captured.providerId);
	providerId(captured.threadId);
	for (const label of captured.labelIds) providerId(label);
	if (new Set(captured.labelIds).size !== captured.labelIds.length) throw refused();
	return Object.freeze({
		message: Object.freeze({ ...captured, labelIds: Object.freeze([...captured.labelIds]) }),
		messageIdHeader: receipt.messageIdHeader,
		bytesRead: Number(receipt.bytesRead),
	});
}
