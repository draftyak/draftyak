import { types } from "node:util";
import { parseStrict, UtcMs } from "@draftyak/protocol";
import {
	captureNativeGmailSendReceiptData,
	MAX_GMAIL_RECEIPT_METADATA_BYTES,
	type NativeGmailSendReceiptData,
} from "./gmail-receipt.ts";

const MAX_SEND_CANDIDATE_BYTES = 65_536;
const apply = Reflect.apply;
const setBytes = Uint8Array.prototype.set;
const fillBytes = Uint8Array.prototype.fill;
const byteLength = Object.getOwnPropertyDescriptor(
	Object.getPrototypeOf(Uint8Array.prototype),
	"byteLength",
)?.get;

function invalid(): never {
	throw new Error("Invalid Gmail send receipt data");
}

function copyBody(body: Uint8Array, maximum: number): Uint8Array {
	if (types.isProxy(body) || !types.isUint8Array(body) || byteLength === undefined) invalid();
	const length: number = apply(byteLength, body, []);
	if (length < 1 || length > maximum) invalid();
	const owned = new Uint8Array(length);
	try {
		apply(setBytes, owned, [body]);
		return owned;
	} catch (error) {
		apply(fillBytes, owned, [0]);
		throw error;
	}
}

function record(value: unknown): Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) invalid();
	return value as Record<string, unknown>;
}

function field(value: Record<string, unknown>, name: string): unknown {
	if (!Object.hasOwn(value, name)) invalid();
	return value[name];
}

function providerId(value: unknown): string {
	if (
		typeof value !== "string" ||
		value.length < 1 ||
		value.length > 256 ||
		/[^!-~]/u.test(value)
	) {
		invalid();
	}
	return value;
}

/** A response candidate is DATA and does not establish a send outcome. */
export function decodeGmailSendCandidate(status: number, body: Uint8Array): string | undefined {
	if (!Number.isInteger(status) || status < 200 || status > 299) return undefined;
	let owned: Uint8Array | undefined;
	try {
		owned = copyBody(body, MAX_SEND_CANDIDATE_BYTES);
		const value = record(parseStrict(owned));
		return providerId(field(value, "id"));
	} catch {
		return undefined;
	} finally {
		if (owned !== undefined) apply(fillBytes, owned, [0]);
	}
}

/** Project bounded provider metadata without granting account or attempt authority. */
export function decodeGmailSendReceipt(
	requestedProviderId: string,
	body: Uint8Array,
): NativeGmailSendReceiptData {
	let owned: Uint8Array | undefined;
	try {
		const requestedId = providerId(requestedProviderId);
		owned = copyBody(body, MAX_GMAIL_RECEIPT_METADATA_BYTES);
		const value = record(parseStrict(owned));
		const id = providerId(field(value, "id"));
		if (id !== requestedId) invalid();
		const threadId = providerId(field(value, "threadId"));
		const date = field(value, "internalDate");
		if (typeof date !== "string" || /^(?:0|[1-9][0-9]{0,15})$/u.exec(date)?.[0] !== date) {
			invalid();
		}
		const internalDate = Number(date);
		if (!UtcMs.safeParse(internalDate).success) invalid();
		const labels = field(value, "labelIds");
		if (!Array.isArray(labels) || labels.length > 256) invalid();
		const labelIds = labels.map(providerId);
		if (new Set(labelIds).size !== labelIds.length) invalid();
		if (Object.hasOwn(value, "historyId")) {
			const history = value.historyId;
			if (
				typeof history !== "string" ||
				/^(?:0|[1-9][0-9]{0,19})$/u.exec(history)?.[0] !== history ||
				BigInt(history) > 18_446_744_073_709_551_615n
			) {
				invalid();
			}
		}
		let sizeBytes: number | undefined;
		if (Object.hasOwn(value, "sizeEstimate")) {
			const size = value.sizeEstimate;
			if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) invalid();
			sizeBytes = size;
		}
		const payload = record(field(value, "payload"));
		const headers = field(payload, "headers");
		if (!Array.isArray(headers)) invalid();
		let messageIdHeader: string | undefined;
		for (const entry of headers) {
			const header = record(entry);
			const name = field(header, "name");
			const headerValue = field(header, "value");
			if (typeof name !== "string" || typeof headerValue !== "string") invalid();
			if (name.toLowerCase() !== "message-id") continue;
			if (messageIdHeader !== undefined || headerValue.length === 0) invalid();
			messageIdHeader = headerValue;
		}
		if (messageIdHeader === undefined) invalid();
		return captureNativeGmailSendReceiptData({
			message: {
				kind: "email.message",
				providerId: id,
				threadId,
				internalDate,
				labelIds,
				...(sizeBytes === undefined ? {} : { sizeBytes }),
			},
			messageIdHeader,
			bytesRead: owned.byteLength,
		});
	} catch {
		return invalid();
	} finally {
		if (owned !== undefined) apply(fillBytes, owned, [0]);
	}
}
