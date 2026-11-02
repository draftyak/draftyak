import { createHash } from "node:crypto";
import { domainToASCII } from "node:url";
import { EmailAddress } from "@draftyak/protocol/entities/common";
import MailComposer, { type MailComposerOptions } from "nodemailer/lib/mail-composer";
import { copyAddresses, copyClaimStamp, copyMimeInput } from "./data.ts";
import {
	type ClaimStamp,
	MAX_ATTACHMENTS,
	MAX_BYTES,
	MAX_HEADER_INPUT_BYTES,
	MAX_LINE_BYTES,
	MAX_RECIPIENTS,
	MAX_REFERENCES,
	type Mailbox,
	MimeError,
	type MimeInput,
	type RenderedMime,
} from "./model.ts";

export * from "./model.ts";

const LOCAL = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
const ID =
	/^<[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*|\[[\x21-\x5a\x5e-\x7e]*\])>$/;
const MEDIA_TYPE = /^(?!(?:multipart|message)\/)[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/i;

function header(value: unknown): asserts value is string {
	if (typeof value !== "string") throw new MimeError("BAD_INPUT");
	if (!value.isWellFormed()) throw new MimeError("HEADER_UNICODE");
	if (/[\r\n]/.test(value)) throw new MimeError("HEADER_CRLF");
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
		if ((code < 32 && code !== 9) || code === 127) throw new MimeError("HEADER_CONTROL");
	}
	if (Buffer.byteLength(value) > MAX_HEADER_INPUT_BYTES) throw new MimeError("TOO_LARGE");
}

export function canonicalAddress(value: string): string {
	header(value);
	const at = value.lastIndexOf("@");
	const local = value.slice(0, at);
	const domainInput = value.slice(at + 1);
	const domain = /^[^\s@<>()",;:\\[\]/#?%]+$/.test(domainInput)
		? domainToASCII(domainInput).toLowerCase()
		: "";
	const address = `${local}@${domain}`;
	if (
		at < 1 ||
		!LOCAL.test(local) ||
		Buffer.byteLength(local) > 64 ||
		!EmailAddress.safeParse(address).success ||
		Buffer.byteLength(address) > 254
	)
		throw new MimeError("BAD_ADDRESS");
	return address;
}

function mailbox(box: Mailbox): { address: string; name: string } {
	if (box.name !== undefined) header(box.name);
	return { address: canonicalAddress(box.address), name: box.name ?? "" };
}

export function normalizeAddresses(addresses: readonly string[]): string[] {
	return [...new Set(copyAddresses(addresses).map(canonicalAddress))].sort();
}

export function textSha256(text: string): string {
	if (typeof text !== "string") throw new MimeError("BAD_INPUT");
	if (text.length > MAX_BYTES || Buffer.byteLength(text) > MAX_BYTES)
		throw new MimeError("TOO_LARGE");
	return createHash("sha256")
		.update(text.replace(/\r\n?/g, "\n").replace(/\n+$/, ""))
		.digest("hex");
}

export function normalizeSubject(subject: string): string {
	if (typeof subject !== "string") throw new MimeError("BAD_INPUT");
	if (
		subject.length > MAX_HEADER_INPUT_BYTES ||
		Buffer.byteLength(subject) > MAX_HEADER_INPUT_BYTES
	)
		throw new MimeError("TOO_LARGE");
	return subject.replace(/\s+/g, " ").trim();
}

function messageId(value: string): void {
	header(value);
	if (!ID.test(value) || Buffer.byteLength(value) > 250) throw new MimeError("BAD_MESSAGE_ID");
}

function stampOptions(stamp: ClaimStamp): void {
	messageId(stamp.messageId);
	if (
		!Number.isSafeInteger(stamp.dateMs) ||
		stamp.dateMs % 1000 !== 0 ||
		!Number.isFinite(new Date(stamp.dateMs).getTime()) ||
		!/^[0-9a-f]{16,64}$/.test(stamp.mimeBoundary) ||
		!/^[A-Za-z0-9_-]{16,64}$/.test(stamp.uploadBoundary)
	)
		throw new MimeError("BAD_STAMP");
}

/** A detached data value only: this validates no approval, account, claim or send authority. */
export function snapshotClaimStamp(raw: unknown): ClaimStamp {
	const stamp = copyClaimStamp(raw);
	stampOptions(stamp);
	return stamp;
}

function options(input: MimeInput, stamp: ClaimStamp): MailComposerOptions {
	header(input.subject);
	if (
		typeof input.text !== "string" ||
		!input.text.isWellFormed() ||
		!Array.isArray(input.to) ||
		(input.cc !== undefined && !Array.isArray(input.cc)) ||
		(input.bcc !== undefined && !Array.isArray(input.bcc)) ||
		(input.references !== undefined && !Array.isArray(input.references)) ||
		(input.attachments !== undefined && !Array.isArray(input.attachments))
	)
		throw new MimeError("BAD_INPUT");
	stampOptions(stamp);
	const count = input.to.length + (input.cc?.length ?? 0) + (input.bcc?.length ?? 0);
	if (count === 0) throw new MimeError("NO_RECIPIENTS");
	if (count > MAX_RECIPIENTS) throw new MimeError("TOO_MANY_RECIPIENTS");
	if ((input.attachments?.length ?? 0) > MAX_ATTACHMENTS)
		throw new MimeError("TOO_MANY_ATTACHMENTS");
	if ((input.references?.length ?? 0) > MAX_REFERENCES) throw new MimeError("TOO_MANY_REFERENCES");
	if (input.inReplyTo !== undefined) messageId(input.inReplyTo);
	for (const id of input.references ?? []) messageId(id);
	const list: Record<string, string> = {};

	for (const [name, value] of Object.entries(input.list ?? {})) {
		header(value);
		if (!/^[\x20-\x7e]{1,998}$/.test(value)) throw new MimeError("BAD_LIST_HEADER");
		list[
			`List-${name
				.split("-")
				.map((part) => part[0]?.toUpperCase() + part.slice(1))
				.join("-")}`
		] = value;
	}
	let bytes = Buffer.byteLength(input.text) + Buffer.byteLength(input.subject);
	for (const item of input.attachments ?? []) {
		header(item.filename);
		if (
			!(item.content instanceof Uint8Array) ||
			typeof item.contentType !== "string" ||
			!MEDIA_TYPE.test(item.contentType) ||
			!item.filename
		)
			throw new MimeError("BAD_ATTACHMENT");
		bytes += item.content.byteLength + Buffer.byteLength(item.filename);
	}
	if (bytes > MAX_BYTES) throw new MimeError("TOO_LARGE");
	if (input.text.includes(`--_NmP-${stamp.mimeBoundary}-Part_`))
		throw new MimeError("BOUNDARY_COLLISION");
	// Only this allowlist reaches MailComposer; its file/URL access remains disabled as defence in depth.
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
		date: new Date(stamp.dateMs),
		headers: list,
		attachments: (input.attachments ?? []).map((item) => ({
			filename: item.filename,
			contentType: item.contentType,
			content: Buffer.from(item.content),
		})),
		baseBoundary: stamp.mimeBoundary,
		textEncoding: "Q",
		newline: "windows",
		disableFileAccess: true,
		disableUrlAccess: true,
	};
}

export async function renderMime(input: MimeInput, stamp: ClaimStamp): Promise<RenderedMime> {
	input = copyMimeInput(input);
	stamp = snapshotClaimStamp(stamp);
	const checked = options(input, stamp);
	// Bcc transport behavior requires ADR 0010 before this renderer can accept it.
	if (input.bcc?.length) throw new MimeError("BCC_UNAVAILABLE");
	const metadata = {
		to: normalizeAddresses(input.to.map((box) => box.address)),
		cc: normalizeAddresses((input.cc ?? []).map((box) => box.address)),
		subject: normalizeSubject(input.subject),
		textSha256: textSha256(input.text),
	};
	let raw: Buffer;
	try {
		const node = new MailComposer(checked).compile();
		raw = await node.build();
	} catch {
		throw new MimeError("COMPOSE_FAILED");
	}
	if (raw.byteLength > MAX_BYTES) throw new MimeError("TOO_LARGE");
	if (
		raw
			.toString("latin1")
			.split("\r\n")
			.some((line) => line.length > MAX_LINE_BYTES)
	) {
		throw new MimeError("LINE_TOO_LONG");
	}
	return { raw, ...metadata };
}
