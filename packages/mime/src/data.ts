import { types } from "node:util";
import {
	type Attachment,
	type ClaimStamp,
	type ListHeader,
	MAX_ATTACHMENTS,
	MAX_BYTES,
	MAX_HEADER_INPUT_BYTES,
	MAX_RECIPIENTS,
	MAX_REFERENCES,
	type Mailbox,
	MimeError,
	type MimeErrorCode,
	type MimeInput,
} from "./model.ts";

const INPUT_KEYS = [
	"from",
	"to",
	"cc",
	"bcc",
	"subject",
	"text",
	"inReplyTo",
	"references",
	"list",
	"attachments",
];
const LIST_HEADERS: readonly ListHeader[] = [
	"archive",
	"help",
	"id",
	"owner",
	"post",
	"subscribe",
	"unsubscribe",
	"unsubscribe-post",
];
const typedArray = Object.getPrototypeOf(Uint8Array.prototype);
const byteLength = Object.getOwnPropertyDescriptor(typedArray, "byteLength")?.get;
const byteOffset = Object.getOwnPropertyDescriptor(typedArray, "byteOffset")?.get;
const backingBuffer = Object.getOwnPropertyDescriptor(typedArray, "buffer")?.get;
const setBytes = Uint8Array.prototype.set;

function own(
	raw: unknown,
	allowed: readonly string[],
	code: MimeErrorCode,
): Record<string, unknown> {
	if (!raw || typeof raw !== "object" || types.isProxy(raw) || Array.isArray(raw))
		throw new MimeError(code);
	if (![Object.prototype, null].includes(Object.getPrototypeOf(raw))) throw new MimeError(code);
	const keys = Reflect.ownKeys(raw);
	if (keys.length > allowed.length) throw new MimeError(code);
	const copy: Record<string, unknown> = Object.create(null);
	for (const key of keys) {
		if (typeof key !== "string" || !allowed.includes(key)) throw new MimeError(code);
		const descriptor = Object.getOwnPropertyDescriptor(raw, key);
		if (!descriptor?.enumerable || !("value" in descriptor)) throw new MimeError(code);
		copy[key] = descriptor.value;
	}
	return copy;
}

function array(raw: unknown, maximum: number, overflow: MimeErrorCode): readonly unknown[] {
	if (types.isProxy(raw) || !Array.isArray(raw) || Object.getPrototypeOf(raw) !== Array.prototype)
		throw new MimeError("BAD_INPUT");
	const count: unknown = Object.getOwnPropertyDescriptor(raw, "length")?.value;
	if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0)
		throw new MimeError("BAD_INPUT");
	if (count > maximum) throw new MimeError(overflow);
	if (Reflect.ownKeys(raw).length !== count + 1) throw new MimeError("BAD_INPUT");
	const copy: unknown[] = [];
	for (let index = 0; index < count; index++) {
		const descriptor = Object.getOwnPropertyDescriptor(raw, String(index));
		if (!descriptor?.enumerable || !("value" in descriptor)) throw new MimeError("BAD_INPUT");
		copy.push(descriptor.value);
	}
	return Object.freeze(copy);
}

function text(
	raw: unknown,
	maximum = MAX_HEADER_INPUT_BYTES,
	code: MimeErrorCode = "BAD_INPUT",
): string {
	if (typeof raw !== "string") throw new MimeError(code);
	if (raw.length > maximum || Buffer.byteLength(raw) > maximum) throw new MimeError("TOO_LARGE");
	return raw;
}

function mailbox(raw: unknown): Mailbox {
	const box = own(raw, ["address", "name"], "BAD_ADDRESS");
	return Object.freeze({
		address: text(box.address),
		...(box.name === undefined ? {} : { name: text(box.name) }),
	});
}

interface ByteSource {
	readonly view: Uint8Array;
	readonly length: number;
}
function bytes(raw: unknown): ByteSource {
	try {
		if (
			types.isProxy(raw) ||
			!types.isUint8Array(raw) ||
			![Uint8Array.prototype, Buffer.prototype].includes(Object.getPrototypeOf(raw))
		)
			throw new MimeError("BAD_ATTACHMENT");
		const length: unknown = byteLength?.call(raw),
			buffer = backingBuffer?.call(raw),
			offset: unknown = byteOffset?.call(raw);
		if (
			typeof length !== "number" ||
			typeof offset !== "number" ||
			types.isSharedArrayBuffer(buffer)
		)
			throw new MimeError("BAD_ATTACHMENT");
		if (length > MAX_BYTES) throw new MimeError("TOO_LARGE");
		return { length, view: new Uint8Array(buffer, offset, length) };
	} catch (error) {
		if (error instanceof MimeError) throw error;
		throw new MimeError("BAD_ATTACHMENT");
	}
}

export function copyAddresses(raw: unknown): readonly string[] {
	return Object.freeze(
		array(raw, MAX_RECIPIENTS, "TOO_MANY_RECIPIENTS").map((value) => text(value)),
	);
}

export function copyClaimStamp(raw: unknown): ClaimStamp {
	const stamp = own(raw, ["messageId", "dateMs", "mimeBoundary", "uploadBoundary"], "BAD_STAMP");
	if (typeof stamp.dateMs !== "number") throw new MimeError("BAD_STAMP");
	return Object.freeze({
		messageId: text(stamp.messageId, MAX_HEADER_INPUT_BYTES, "BAD_STAMP"),
		dateMs: stamp.dateMs,
		mimeBoundary: text(stamp.mimeBoundary, MAX_HEADER_INPUT_BYTES, "BAD_STAMP"),
		uploadBoundary: text(stamp.uploadBoundary, MAX_HEADER_INPUT_BYTES, "BAD_STAMP"),
	});
}

/** Fixed-shape own-data snapshot. All native attachment sizes are charged before any byte copy. */
export function copyMimeInput(raw: unknown): MimeInput {
	const input = own(raw, INPUT_KEYS, "BAD_INPUT"),
		to = array(input.to, MAX_RECIPIENTS, "TOO_MANY_RECIPIENTS"),
		cc = input.cc === undefined ? [] : array(input.cc, MAX_RECIPIENTS, "TOO_MANY_RECIPIENTS"),
		bcc = input.bcc === undefined ? [] : array(input.bcc, MAX_RECIPIENTS, "TOO_MANY_RECIPIENTS");
	if (to.length + cc.length + bcc.length > MAX_RECIPIENTS)
		throw new MimeError("TOO_MANY_RECIPIENTS");
	const references =
		input.references === undefined
			? undefined
			: Object.freeze(
					array(input.references, MAX_REFERENCES, "TOO_MANY_REFERENCES").map((value) =>
						text(value),
					),
				);
	const from = mailbox(input.from),
		recipients = {
			to: Object.freeze(to.map(mailbox)),
			cc: Object.freeze(cc.map(mailbox)),
			bcc: Object.freeze(bcc.map(mailbox)),
		};
	const subject = text(input.subject),
		body = text(input.text, MAX_BYTES),
		inReplyTo = input.inReplyTo === undefined ? undefined : text(input.inReplyTo);
	let total = Buffer.byteLength(subject) + Buffer.byteLength(body);
	const sources = (
		input.attachments === undefined
			? []
			: array(input.attachments, MAX_ATTACHMENTS, "TOO_MANY_ATTACHMENTS")
	).map((rawAttachment) => {
		const attachment = own(rawAttachment, ["filename", "contentType", "content"], "BAD_ATTACHMENT"),
			filename = text(attachment.filename),
			contentType = text(attachment.contentType, MAX_HEADER_INPUT_BYTES, "BAD_ATTACHMENT"),
			content = bytes(attachment.content);
		total += Buffer.byteLength(filename) + content.length;
		if (total > MAX_BYTES) throw new MimeError("TOO_LARGE");
		return { filename, contentType, content };
	});
	if (total > MAX_BYTES) throw new MimeError("TOO_LARGE");
	let list: Partial<Record<ListHeader, string>> | undefined;
	if (input.list !== undefined) {
		const rawList = own(input.list, LIST_HEADERS, "BAD_LIST_HEADER");
		list = Object.freeze(
			Object.fromEntries(Object.entries(rawList).map(([key, value]) => [key, text(value)])),
		);
	}
	const attachments: Attachment[] = sources.map(({ filename, contentType, content }) => {
		const copy = new Uint8Array(content.length);
		setBytes.call(copy, content.view);
		return Object.freeze({ filename, contentType, content: copy });
	});
	return Object.freeze({
		from,
		...recipients,
		subject,
		text: body,
		...(inReplyTo === undefined ? {} : { inReplyTo }),
		...(references === undefined ? {} : { references }),
		...(list === undefined ? {} : { list }),
		attachments: Object.freeze(attachments),
	});
}
