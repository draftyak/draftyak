import { checkedParsedMail, type ParsedMail } from "@draftyak/content";
import { MAX_EMAIL_LIST_ITEMS, MediaType } from "@draftyak/protocol/entities/common";
import { EmailMessage } from "@draftyak/protocol/entities/message";

const displayFields = EmailMessage.pick({
	direction: true,
	from: true,
	fromTruncated: true,
	replyTo: true,
	replyToTruncated: true,
	to: true,
	toTruncated: true,
	cc: true,
	ccTruncated: true,
	bcc: true,
	bccTruncated: true,
	subject: true,
	dmarc: true,
	attachments: true,
	attachmentsTruncated: true,
});

export type ParsedEmailDisplayFields = Readonly<
	Pick<
		EmailMessage,
		| "direction"
		| "from"
		| "fromTruncated"
		| "replyTo"
		| "replyToTruncated"
		| "to"
		| "toTruncated"
		| "cc"
		| "ccTruncated"
		| "bcc"
		| "bccTruncated"
		| "subject"
		| "dmarc"
		| "attachments"
		| "attachmentsTruncated"
	>
>;

export class NativeProjectionError extends Error {
	readonly code = "PROJECTION_UNAVAILABLE";
	constructor() {
		super("Content projection unavailable");
		this.name = "NativeProjectionError";
	}
}

function untrustedText(value: string, maximum: number) {
	if (typeof value !== "string" || !value.isWellFormed()) throw new NativeProjectionError();
	let count = 0;
	let end = 0;
	for (const scalar of value) {
		if (count === maximum)
			return { untrusted: true as const, text: value.slice(0, end), truncated: true as const };
		count++;
		end += scalar.length;
	}
	return { untrusted: true as const, text: value };
}

function mailboxes(values: ParsedMail["from"]) {
	return values.slice(0, MAX_EMAIL_LIST_ITEMS).map((value) => ({
		address: { untrusted: true as const, text: value.address },
		name: value.name === undefined ? null : untrustedText(value.name, 256),
	}));
}

function contentType(value: string): string {
	const normalized = value.split(";", 1)[0]?.trim().toLowerCase();
	const parsed = MediaType.safeParse(normalized);
	return parsed.success ? parsed.data : "application/octet-stream";
}

/** Bounded display fields; canonical IDs, receipt provenance and stored state are joined separately. */
export function projectParsedEmailDisplay(mail: ParsedMail): ParsedEmailDisplayFields {
	try {
		const checked = checkedParsedMail(mail);
		const cut = (values: readonly unknown[]) =>
			values.length > MAX_EMAIL_LIST_ITEMS ? (true as const) : undefined;
		const result = displayFields.parse({
			direction: checked.direction,
			from: mailboxes(checked.from),
			...(cut(checked.from) ? { fromTruncated: true } : {}),
			replyTo: mailboxes(checked.replyTo),
			...(cut(checked.replyTo) ? { replyToTruncated: true } : {}),
			to: mailboxes(checked.to),
			...(cut(checked.to) ? { toTruncated: true } : {}),
			cc: mailboxes(checked.cc),
			...(cut(checked.cc) ? { ccTruncated: true } : {}),
			bcc: mailboxes(checked.bcc),
			...(cut(checked.bcc) ? { bccTruncated: true } : {}),
			subject: untrustedText(checked.subject, 2000),
			dmarc: checked.auth.dmarc,
			attachments: checked.attachments.slice(0, MAX_EMAIL_LIST_ITEMS).map((attachment) => ({
				// An unnamed attachment has an empty untrusted name, without an invented filename.
				filename: untrustedText(attachment.filename ?? "", 256),
				contentType: contentType(attachment.mimeType),
				size: attachment.size,
			})),
			...(cut(checked.attachments) ? { attachmentsTruncated: true } : {}),
		});
		return Object.freeze(result);
	} catch {
		throw new NativeProjectionError();
	}
}
