import { createHash } from "node:crypto";
import { domainToASCII } from "node:url";
import type { MessageDirection } from "@draftyak/protocol/entities/common";
import PostalMime, { type Address, addressParser } from "postal-mime";
import { type MailHeader, verifyMailAuth } from "./auth-results.ts";
import { cleanHtml } from "./html.ts";
import { cleanText, type HygieneResult } from "./hygiene.ts";
import {
	boundedText,
	ContentError,
	type ContentErrorCode,
	MAX_MAIL_BYTES,
	MAX_TEXT_BYTES,
} from "./limits.ts";
import type { MailEvidence, ParsedMail, ParsedMailbox } from "./mail.ts";

const MAX_HEADERS = 200;
const MAX_HEADER_BYTES = 64 * 1024;
const MAX_PARTS = 100;
const MAX_ADDRESSES = 500;
const digest = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

export function normalizeAddress(value: string): string | undefined {
	const at = value.lastIndexOf("@");
	if (at < 1 || value.length > 254) return undefined;
	const local = value.slice(0, at);
	if (!/^[\p{L}\p{M}\p{N}!#$%&'*+\-/=?^_`{|}~.]+$/u.test(local)) return undefined;
	if (local.startsWith(".") || local.endsWith(".") || local.includes("..")) return undefined;
	const domainInput = value.slice(at + 1);
	// URL host parsing must not discard or decode part of a mailbox domain.
	if (!/^[^\s@<>()",;:\\[\]/#?%]+$/.test(domainInput)) return undefined;
	const domain = domainToASCII(domainInput).toLowerCase();
	const address = `${local}@${domain}`;
	return address;
}

function mailboxes(addresses: readonly Address[]): ParsedMailbox[] {
	const flat = addresses.flatMap((address) => address.group ?? [address]);
	if (flat.length > MAX_ADDRESSES) throw new ContentError("STRUCTURE_LIMIT");
	return flat.flatMap(({ address, name }) => {
		const normalized = normalizeAddress(address);
		if (!normalized) return [];
		boundedText(name, 2048);
		return [{ address: normalized, ...(name ? { name } : {}) }];
	});
}

function wireHeaders(raw: Uint8Array): MailHeader[] {
	// Scan only the bounded header block, retaining wire order and every duplicate.
	let end = -1;
	for (let i = 0; i < Math.min(raw.length, MAX_HEADER_BYTES + 4); i++) {
		if (raw[i] === 10 && (raw[i + 1] === 10 || (raw[i + 1] === 13 && raw[i + 2] === 10))) {
			end = i + 1;
			break;
		}
	}
	// RFC 5322 permits a header-only message without a trailing empty line.
	if (end < 0 && raw.length <= MAX_HEADER_BYTES) end = raw.length;
	if (end < 0 || end > MAX_HEADER_BYTES) throw new ContentError("STRUCTURE_LIMIT");
	const headers: { key: string; value: string }[] = [];
	for (const line of Buffer.from(raw.subarray(0, end)).toString("utf8").split(/\r?\n/)) {
		if (!line) continue;
		if (
			[...line].some((character) => {
				const code = character.charCodeAt(0);
				return (code < 32 && code !== 9) || code === 127;
			})
		)
			throw new ContentError("INVALID_INPUT");
		if (/^[ \t]/.test(line)) {
			const previous = headers.at(-1);
			if (!previous) throw new ContentError("INVALID_INPUT");
			previous.value += ` ${line.trim()}`;
			continue;
		}
		const match = /^([!-9;-~]+):[ \t]*(.*)$/.exec(line);
		if (!match) {
			throw new ContentError("INVALID_INPUT");
		}
		headers.push({ key: (match[1] ?? "").toLowerCase(), value: match[2] ?? "" });
		if (headers.length > MAX_HEADERS) throw new ContentError("STRUCTURE_LIMIT");
	}
	return headers;
}

function strictFrom(value: string): boolean {
	const mailbox = (address: string): boolean => {
		const at = address.indexOf("@");
		return (
			at > 0 &&
			at === address.lastIndexOf("@") &&
			at < address.length - 1 &&
			/^[^\s<>()",;:@]+$/.test(address.slice(0, at)) &&
			/^[^\s<>()",;:@]+$/.test(address.slice(at + 1))
		);
	};
	let angle = value.indexOf("<");
	if (value.startsWith('"')) {
		let end = -1;
		for (let i = 1; i < value.length; i++) {
			if (value[i] === "\\") i++;
			else if (value[i] === '"') {
				end = i;
				break;
			}
		}
		if (end < 0) return false;
		angle = end + 1;
		while (value[angle] === " " || value[angle] === "\t") angle++;
		if (value[angle] !== "<") return false;
	}
	if (angle < 0) return mailbox(value);
	if (
		value.indexOf("<", angle + 1) >= 0 ||
		value.indexOf(">", angle + 1) !== value.length - 1 ||
		!mailbox(value.slice(angle + 1, -1))
	)
		return false;
	const name = value.slice(0, angle).trimEnd();
	if (!name.startsWith('"')) return !/[<>()",;:]/.test(name);
	// Scan a quoted display name once; no overlapping whitespace quantifiers.
	for (let i = 1; i < name.length; i++) {
		if (name[i] === "\\") {
			i++;
			if (i >= name.length) return false;
		} else if (name[i] === '"') return i === name.length - 1;
	}
	return false;
}

/** Worker parser core. The parent applies the shared mailbox contract before exposing results. */
export async function parseMailCore(raw: Uint8Array, evidence: MailEvidence): Promise<ParsedMail> {
	if (!(raw instanceof Uint8Array) || !raw.length) throw new ContentError("INVALID_INPUT");
	if (raw.byteLength > MAX_MAIL_BYTES) throw new ContentError("INPUT_LIMIT");
	if (
		!evidence ||
		!["gmail", "generic"].includes(evidence.provider) ||
		!Array.isArray(evidence.ownerAddresses)
	) {
		throw new ContentError("INVALID_INPUT");
	}
	if (evidence.ownerAddresses.length > MAX_ADDRESSES) throw new ContentError("STRUCTURE_LIMIT");
	try {
		const headers = wireHeaders(raw);
		const rawSha256 = digest(raw);
		const parser = new PostalMime({
			maxNestingDepth: 12,
			maxHeadersSize: MAX_HEADER_BYTES,
			maxPartCount: MAX_PARTS,
			maxForwardedAddresses: 100,
			maxRfc822NestingDepth: 0,
			forceRfc822Attachments: true,
			attachmentEncoding: "arraybuffer",
		});
		const parsed = await parser.parse(raw);
		if (parsed.attachments.length > MAX_PARTS) throw new ContentError("STRUCTURE_LIMIT");
		let attachmentBytes = 0;
		const fromHeaders = headers.filter(({ key }) => key === "from");
		const fromInput = fromHeaders.flatMap(({ value }) => addressParser(value));
		const from = mailboxes(fromInput);
		const fromValue = fromHeaders[0]?.value.trim() ?? "";
		const singleFrom =
			strictFrom(fromValue) &&
			fromHeaders.length === 1 &&
			fromInput.length === 1 &&
			!fromInput[0]?.group &&
			from.length === 1
				? from[0]?.address
				: undefined;
		const owners = evidence.ownerAddresses.map(normalizeAddress);
		if (owners.some((address) => address === undefined)) throw new ContentError("INVALID_INPUT");
		const owner = singleFrom !== undefined && owners.includes(singleFrom);
		const sent = evidence.sentEvidence;
		const validSent =
			sent !== undefined &&
			["verified-send", "provider-sent"].includes(sent.kind) &&
			sent.messageSha256 === rawSha256;
		// Without hub evidence of an actual send, retain the message as inbound.
		const direction: MessageDirection = owner && validSent ? "outbound" : "inbound";
		let body: HygieneResult;
		let bodyRefusal: ContentErrorCode | undefined;
		try {
			// postal-mime 4.0.7 omits empty HTML from Email. Its pinned runtime
			// text-type set preserves presence without a second MIME parser.
			const textTypes = (parser as unknown as { textTypes?: unknown }).textTypes;
			if (!(textTypes instanceof Set)) throw new ContentError("INVALID_INPUT");
			const hasHtml = textTypes.has("html");
			const text = hasHtml ? (parsed.html ?? "") : (parsed.text ?? "");
			boundedText(text, MAX_TEXT_BYTES);
			body = hasHtml ? cleanHtml(text) : cleanText(text);
		} catch (error) {
			// An unmodelled HTML body must never expose its text/plain alternative.
			bodyRefusal = error instanceof ContentError ? error.code : "INVALID_INPUT";
			body = cleanText("");
		}
		boundedText(parsed.subject ?? "", 8192);
		const metadata: { messageId?: string; inReplyTo?: string; references?: string; date?: string } =
			{};
		for (const key of ["messageId", "inReplyTo", "references", "date"] as const) {
			const value = parsed[key];
			if (value !== undefined) {
				boundedText(value, 8192);
				metadata[key] = value;
			}
		}
		return {
			rawSha256,
			direction,
			auth: verifyMailAuth(headers, evidence.provider, singleFrom),
			from,
			to: mailboxes(parsed.to ?? []),
			cc: mailboxes(parsed.cc ?? []),
			bcc: mailboxes(parsed.bcc ?? []),
			replyTo: mailboxes(parsed.replyTo ?? []),
			subject: parsed.subject ?? "",
			...metadata,
			body,
			...(bodyRefusal ? { bodyRefusal } : {}),
			attachments: parsed.attachments.map(({ filename, mimeType, content }) => {
				if (filename !== null) boundedText(filename, 2048);
				boundedText(mimeType, 255);
				if (typeof content === "string") throw new ContentError("INVALID_INPUT");
				const bytes = content instanceof Uint8Array ? content : new Uint8Array(content);
				attachmentBytes += bytes.byteLength;
				if (attachmentBytes > MAX_MAIL_BYTES) throw new ContentError("OUTPUT_LIMIT");
				return {
					...(filename ? { filename } : {}),
					mimeType,
					size: bytes.byteLength,
					sha256: digest(bytes),
				};
			}),
		};
	} catch (error) {
		if (error instanceof ContentError) throw error;
		throw new ContentError("INVALID_INPUT");
	}
}
