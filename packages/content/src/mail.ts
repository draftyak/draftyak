import { EmailAddress, type MessageDirection } from "@draftyak/protocol/entities/common";
import type { MailAuth } from "./auth-results.ts";
import type { HygieneResult } from "./hygiene.ts";
import { ContentError, type ContentErrorCode, MAX_MAIL_BYTES } from "./limits.ts";
import { normalizeAddress, parseMailCore } from "./mail-parser.ts";

/** Hub- or broker-observed provider/send evidence; never plugin sync claims or message headers. */
export interface MailEvidence {
	readonly provider: "gmail" | "generic";
	readonly ownerAddresses: readonly string[];
	readonly sentEvidence?: {
		readonly kind: "verified-send" | "provider-sent";
		readonly messageSha256: string;
	};
}
export interface ParsedMailbox {
	readonly address: string;
	readonly name?: string;
}
export interface ParsedMail {
	readonly rawSha256: string;
	readonly direction: MessageDirection;
	readonly auth: MailAuth;
	readonly from: readonly ParsedMailbox[];
	readonly to: readonly ParsedMailbox[];
	readonly cc: readonly ParsedMailbox[];
	readonly bcc: readonly ParsedMailbox[];
	readonly replyTo: readonly ParsedMailbox[];
	readonly subject: string;
	readonly messageId?: string;
	readonly inReplyTo?: string;
	readonly references?: string;
	readonly date?: string;
	readonly body: HygieneResult;
	/** The body was withheld; headers, authentication and attachment metadata remain available. */
	readonly bodyRefusal?: ContentErrorCode;
	readonly attachments: readonly {
		readonly filename?: string;
		readonly mimeType: string;
		readonly size: number;
		readonly sha256: string;
	}[];
}

/** Validate the shared scalar once in the parent, outside each fresh parser heap. */
export function checkedMailEvidence(evidence: MailEvidence): MailEvidence {
	if (
		!evidence ||
		!["gmail", "generic"].includes(evidence.provider) ||
		!Array.isArray(evidence.ownerAddresses)
	)
		throw new ContentError("INVALID_INPUT");
	if (evidence.ownerAddresses.length > 500) throw new ContentError("STRUCTURE_LIMIT");
	const ownerAddresses: string[] = [];
	for (const address of evidence.ownerAddresses) {
		const normalized = typeof address === "string" ? normalizeAddress(address) : undefined;
		if (normalized === undefined || !EmailAddress.safeParse(normalized).success)
			throw new ContentError("INVALID_INPUT");
		ownerAddresses.push(normalized);
	}
	return {
		provider: evidence.provider,
		ownerAddresses,
		...(evidence.sentEvidence ? { sentEvidence: evidence.sentEvidence } : {}),
	};
}

/** A refused From can never retain sender verification or outbound direction. */
export function checkedParsedMail(mail: ParsedMail): ParsedMail {
	const valid = (mailbox: ParsedMailbox): boolean =>
		EmailAddress.safeParse(mailbox.address).success;
	const from = mail.from.filter(valid);
	const refusedFrom = from.length !== mail.from.length;
	const auth: MailAuth = refusedFrom ? { dmarc: "none", reason: "ambiguous-from" } : mail.auth;
	const direction: MessageDirection = refusedFrom ? "inbound" : mail.direction;
	return {
		...mail,
		from,
		to: mail.to.filter(valid),
		cc: mail.cc.filter(valid),
		bcc: mail.bcc.filter(valid),
		replyTo: mail.replyTo.filter(valid),
		auth,
		direction,
	};
}

/** Parse in a worker in production. Returned text and metadata are untrusted display data. */
export async function parseMail(raw: Uint8Array, evidence: MailEvidence): Promise<ParsedMail> {
	if (!(raw instanceof Uint8Array) || !raw.length) throw new ContentError("INVALID_INPUT");
	if (raw.byteLength > MAX_MAIL_BYTES) throw new ContentError("INPUT_LIMIT");
	return checkedParsedMail(await parseMailCore(raw, checkedMailEvidence(evidence)));
}
