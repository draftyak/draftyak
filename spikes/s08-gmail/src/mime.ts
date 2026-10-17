import { createHash, randomBytes } from "node:crypto";
import { domainToASCII } from "node:url";
import addressparser from "nodemailer/lib/addressparser";
import MailComposer, { type MailComposerOptions } from "nodemailer/lib/mail-composer";

// gmail-rfc5322 (plan §4 Renderers): the hub's own MIME through nodemailer 10.1.2's MailComposer.
// Every header value is checked here first: MailComposer would quietly turn a CR or LF into a
// space, so the sent text would differ from the approved text.

export interface Mailbox {
	readonly address: string;
	readonly name?: string;
}

export interface Attachment {
	readonly filename: string;
	readonly contentType: string;
	readonly content: Uint8Array;
}

export interface MimeInput {
	readonly from: Mailbox;
	readonly to: readonly Mailbox[];
	readonly cc?: readonly Mailbox[];
	readonly bcc?: readonly Mailbox[];
	readonly subject: string;
	readonly text: string;
	readonly inReplyTo?: string;
	readonly references?: readonly string[];
	// List-* headers by the part after "List-" (MailComposer itself ignores its `list` option).
	readonly list?: Readonly<Record<string, string>>;
	readonly attachments?: readonly Attachment[];
}

// Generated at the claim and stored in the attempt row before the request (plan §3).
export interface ClaimStamp {
	readonly messageId: string;
	readonly date: Date;
	readonly baseBoundary: string;
}

export interface Rendered {
	readonly raw: Buffer;
	readonly stamp: ClaimStamp;
	readonly to: readonly string[];
	readonly cc: readonly string[];
	readonly subject: string;
	// The text part's hash for reconcile, not the send ticket's bodySha256 of the request (plan §4).
	readonly textSha256: string;
}

// messages.send's mediaUpload.maxSize in the discovery document (35 MB), Gmail's message cap.
export const MAX_BYTES = 36_700_160;
export const MAX_RECIPIENTS = 500;
export const LIST_HEADERS: readonly string[] = [
	"archive",
	"help",
	"id",
	"owner",
	"post",
	"subscribe",
	"unsubscribe",
	"unsubscribe-post",
];

export type MimeErrorCode =
	| "HEADER_CRLF"
	| "HEADER_CONTROL"
	| "BAD_ADDRESS"
	| "BAD_MESSAGE_ID"
	| "BAD_LIST_HEADER"
	| "BAD_ATTACHMENT"
	| "BAD_STAMP"
	| "NO_RECIPIENTS"
	| "TOO_MANY_RECIPIENTS"
	| "TOO_LARGE"
	| "LINE_TOO_LONG";

export class MimeError extends Error {
	readonly code: MimeErrorCode;
	readonly field: string;

	constructor(code: MimeErrorCode, field: string) {
		super(`mime: ${code} in ${field}`);
		this.name = "MimeError";
		this.code = code;
		this.field = field;
	}
}

export function newClaimStamp(fromAddress: string, now: number = Date.now()): ClaimStamp {
	const domain = fromAddress.slice(fromAddress.lastIndexOf("@") + 1).toLowerCase();
	return {
		messageId: `<${randomBytes(16).toString("hex")}@${domain}>`,
		date: new Date(Math.floor(now / 1000) * 1000),
		baseBoundary: randomBytes(12).toString("hex"),
	};
}

function headerText(value: string, field: string): void {
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
		if (code === 10 || code === 13) throw new MimeError("HEADER_CRLF", field);
		if ((code < 32 && code !== 9) || code === 127) throw new MimeError("HEADER_CONTROL", field);
	}
}

const ADDRESS = /^[^\s@<>()",;:\\[\]]+@[^\s@<>()",;:\\[\]]+$/;
const MESSAGE_ID = /^<[^\s<>@]+@[^\s<>@]+>$/;
const PRINTABLE = /^[\x20-\x7e]{1,998}$/;
// One leaf part: multipart/* would need inner parts, and message/* goes out unencoded.
const MEDIA_TYPE = /^(?!(?:multipart|message)\/)[\w.+-]+\/[\w.+-]+$/i;

function checkMailboxes(boxes: readonly Mailbox[], field: string): void {
	for (const box of boxes) {
		headerText(box.address, field);
		if (!ADDRESS.test(box.address)) throw new MimeError("BAD_ADDRESS", field);
		if (box.name !== undefined) headerText(box.name, field);
	}
}

function checkMessageId(value: string, field: string): void {
	headerText(value, field);
	if (!MESSAGE_ID.test(value)) throw new MimeError("BAD_MESSAGE_ID", field);
}

// Refuses before anything reaches MailComposer.
export function validateMime(input: MimeInput, stamp: ClaimStamp): void {
	headerText(input.subject, "subject");
	for (const [name, value] of Object.entries(input.list ?? {})) {
		headerText(value, `List-${name}`);
		if (!LIST_HEADERS.includes(name.toLowerCase()) || !PRINTABLE.test(value)) {
			throw new MimeError("BAD_LIST_HEADER", `List-${name}`);
		}
	}
	checkMailboxes([input.from], "from");
	const groups = { to: input.to, cc: input.cc ?? [], bcc: input.bcc ?? [] };
	for (const [field, boxes] of Object.entries(groups)) checkMailboxes(boxes, field);
	const count = groups.to.length + groups.cc.length + groups.bcc.length;
	if (count === 0) throw new MimeError("NO_RECIPIENTS", "to");
	if (count > MAX_RECIPIENTS) throw new MimeError("TOO_MANY_RECIPIENTS", "to");
	if (input.inReplyTo !== undefined) checkMessageId(input.inReplyTo, "inReplyTo");
	for (const id of input.references ?? []) checkMessageId(id, "references");
	checkMessageId(stamp.messageId, "messageId");
	if (!/^[0-9a-f]{16,64}$/.test(stamp.baseBoundary) || !Number.isFinite(stamp.date.getTime())) {
		throw new MimeError("BAD_STAMP", "stamp");
	}
	let bytes = Buffer.byteLength(input.text);
	for (const attachment of input.attachments ?? []) {
		const keys = Object.keys(attachment).toSorted().join();
		if (keys !== "content,contentType,filename" || !(attachment.content instanceof Uint8Array)) {
			throw new MimeError("BAD_ATTACHMENT", "attachments");
		}
		headerText(attachment.filename, "attachments");
		if (!MEDIA_TYPE.test(attachment.contentType)) {
			throw new MimeError("BAD_ATTACHMENT", "attachments");
		}
		bytes += attachment.content.byteLength;
	}
	if (bytes > MAX_BYTES) throw new MimeError("TOO_LARGE", "message");
}

const mailbox = (box: Mailbox): { name: string; address: string } => ({
	name: box.name ?? "",
	address: box.address,
});

const listName = (name: string): string =>
	`List-${name
		.toLowerCase()
		.split("-")
		.map((word) => word.charAt(0).toUpperCase() + word.slice(1))
		.join("-")}`;

// The MailComposer options for an input that passed validateMime. Content only from memory: file
// and URL sources are refused, so nodemailer never reads a path or fetches (its TLS default
// doesn't matter here).
export function composerOptions(input: MimeInput, stamp: ClaimStamp): MailComposerOptions {
	return {
		from: mailbox(input.from),
		to: input.to.map(mailbox),
		cc: (input.cc ?? []).map(mailbox),
		bcc: (input.bcc ?? []).map(mailbox),
		subject: input.subject,
		text: input.text,
		...(input.inReplyTo === undefined ? {} : { inReplyTo: input.inReplyTo }),
		...(input.references === undefined ? {} : { references: [...input.references] }),
		messageId: stamp.messageId,
		date: stamp.date,
		headers: Object.fromEntries(
			Object.entries(input.list ?? {}).map(([name, value]) => [listName(name), value]),
		),
		attachments: (input.attachments ?? []).map((attachment) => ({
			filename: attachment.filename,
			contentType: attachment.contentType,
			content: Buffer.from(attachment.content),
		})),
		baseBoundary: stamp.baseBoundary,
		textEncoding: "Q",
		newline: "windows",
		disableFileAccess: true,
		disableUrlAccess: true,
	};
}

// RFC 5322 caps a line at 998 characters, and MailComposer folds only at whitespace.
function checkLines(raw: Buffer): void {
	let field = "message";
	for (const line of raw.toString("latin1").split("\r\n")) {
		field = /^([\x21-\x39\x3b-\x7e]+):/.exec(line)?.[1] ?? field;
		if (line.length > 998) throw new MimeError("LINE_TOO_LONG", field);
	}
}

export async function renderMime(input: MimeInput, stamp: ClaimStamp): Promise<Rendered> {
	validateMime(input, stamp);
	const node = new MailComposer(composerOptions(input, stamp)).compile();
	// Gmail takes Bcc recipients from the uploaded header; that delivered copies lack it is an
	// assumption M0.29 checks live.
	node.keepBcc = true;
	const raw = await node.build();
	if (raw.byteLength > MAX_BYTES) throw new MimeError("TOO_LARGE", "message");
	checkLines(raw);
	return {
		raw,
		stamp,
		to: normalizeAddresses(input.to.map((box) => box.address)),
		cc: normalizeAddresses((input.cc ?? []).map((box) => box.address)),
		subject: input.subject,
		textSha256: textSha256(input.text),
	};
}

// Line endings and trailing newlines don't count, so Gmail's decoded copy hashes the same.
export function textSha256(text: string): string {
	const normalized = text.replace(/\r\n?/g, "\n").replace(/\n+$/, "");
	return createHash("sha256").update(normalized, "utf8").digest("hex");
}

// MailComposer writes a domain in ASCII (punycode); Gmail may show either form.
function asciiDomain(address: string): string {
	const at = address.lastIndexOf("@");
	const domain = address.slice(at + 1);
	return at === -1 ? address : `${address.slice(0, at)}@${domainToASCII(domain) || domain}`;
}

// Addresses only (display names don't count), lowercased with ASCII domains, sorted and unique.
export function normalizeAddresses(value: string | readonly string[] | undefined): string[] {
	const list = typeof value === "string" ? [value] : (value ?? []);
	const addresses = list.flatMap((item) =>
		addressparser(item, { flatten: true }).map((entry) =>
			asciiDomain(entry.address.trim().toLowerCase()),
		),
	);
	return [...new Set(addresses.filter((address) => address !== ""))].toSorted();
}

export function normalizeSubject(value: string | undefined): string {
	return decodeWords(value ?? "")
		.replace(/\s+/g, " ")
		.trim();
}

const ENCODED_WORD = /=\?([^?\s]+)\?([BbQq])\?([^?\s]*)\?=/g;

export function decodeText(charset: string, bytes: Buffer): string {
	if (bytes.byteLength === 0) return "";
	try {
		return new TextDecoder(charset).decode(bytes);
	} catch {
		return bytes.toString("latin1");
	}
}

function qBytes(text: string): Buffer {
	const bytes: number[] = [];
	for (let index = 0; index < text.length; index++) {
		const hex = text.slice(index + 1, index + 3);
		if (text[index] === "=" && /^[0-9a-f]{2}$/i.test(hex)) {
			bytes.push(Number.parseInt(hex, 16));
			index += 2;
		} else {
			bytes.push(text[index] === "_" ? 0x20 : text.charCodeAt(index) & 0xff);
		}
	}
	return Buffer.from(bytes);
}

// RFC 2047 encoded words; adjacent words are joined (the whitespace between them is dropped) and
// decoded together, so a character split across two words survives.
export function decodeWords(value: string): string {
	let out = "";
	let last = 0;
	let charset = "";
	let parts: Buffer[] = [];
	for (const match of value.matchAll(ENCODED_WORD)) {
		const between = value.slice(last, match.index);
		const wordCharset = (match[1] ?? "").split("*")[0]?.toLowerCase() ?? "";
		const adjacent = parts.length > 0 && between.trim() === "";
		if (!adjacent || wordCharset !== charset) {
			out += decodeText(charset, Buffer.concat(parts));
			parts = [];
			if (!adjacent) out += between;
		}
		charset = wordCharset;
		const text = match[3] ?? "";
		parts.push(match[2]?.toUpperCase() === "B" ? Buffer.from(text, "base64") : qBytes(text));
		last = match.index + match[0].length;
	}
	return out + decodeText(charset, Buffer.concat(parts)) + value.slice(last);
}
