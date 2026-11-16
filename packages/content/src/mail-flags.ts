import { types } from "node:util";
import { EmailAddress } from "@draftyak/protocol/entities/common";
import { EmailDraftContent } from "@draftyak/protocol/entities/draft/email";
import { type Flag, Flags } from "@draftyak/protocol/flags";
import type { ParsedMail } from "./mail.ts";
import { normalizeAddress } from "./mail-parser.ts";

export type EmailReplyRedirectFlags =
	| { status: "classified"; flags: readonly Flag[] }
	| {
			status: "refused";
			code: "INVALID_INPUT" | "AMBIGUOUS_FROM" | "AMBIGUOUS_REPLY_TO";
	  };

const draftRecipients = EmailDraftContent.pick({ channel: true, to: true, cc: true, bcc: true });

function object(value: unknown): object {
	if (!value || typeof value !== "object" || types.isProxy(value))
		throw new Error("Invalid mail flag data");
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== null && prototype !== Object.prototype)
		throw new Error("Invalid mail flag data");
	return value;
}

function field(value: object, key: string): unknown {
	const descriptor = Object.getOwnPropertyDescriptor(value, key);
	if (!descriptor || !("value" in descriptor)) throw new Error("Invalid mail flag data");
	return descriptor.value;
}

function array(value: unknown, maximum: number): unknown[] {
	if (!Array.isArray(value) || types.isProxy(value)) throw new Error("Invalid mail flag data");
	const length = field(value, "length");
	if (typeof length !== "number" || !Number.isInteger(length) || length < 0 || length > maximum)
		throw new Error("Invalid mail flag data");
	const captured: unknown[] = [];
	for (let index = 0; index < length; index++) captured.push(field(value, String(index)));
	return captured;
}

function address(value: unknown): string {
	const normalized = typeof value === "string" ? normalizeAddress(value) : undefined;
	if (normalized === undefined || !EmailAddress.safeParse(normalized).success)
		throw new Error("Invalid mail flag data");
	return normalized;
}

function mailboxes(value: unknown): string[] {
	return array(value, 500).map((mailbox) => address(field(object(mailbox), "address")));
}

/** Classify untrusted recipient DATA only; this does not verify a source or authorize a draft. */
export function classifyEmailReplyRedirectFlags(
	mail: ParsedMail,
	draft: Pick<EmailDraftContent, "channel" | "to" | "cc" | "bcc">,
): EmailReplyRedirectFlags {
	try {
		const input = object(mail);
		const from = mailboxes(field(input, "from"));
		const replyTo = mailboxes(field(input, "replyTo"));
		const reason = field(object(field(input, "auth")), "reason");
		if (typeof reason !== "string") return { status: "refused", code: "INVALID_INPUT" };
		if (from.length !== 1 || reason === "ambiguous-from")
			return { status: "refused", code: "AMBIGUOUS_FROM" };
		const count = Object.getOwnPropertyDescriptor(input, "replyToHeaderCount");
		const replyToHeaderCount = count && "value" in count ? count.value : undefined;
		if (
			(replyToHeaderCount !== 0 && replyToHeaderCount !== 1) ||
			(replyToHeaderCount === 0 && replyTo.length !== 0) ||
			(replyToHeaderCount === 1 && replyTo.length === 0)
		)
			return { status: "refused", code: "AMBIGUOUS_REPLY_TO" };
		const actual = object(draft);
		const channel = field(actual, "channel");
		if (channel !== "email") return { status: "refused", code: "INVALID_INPUT" };
		const captured = draftRecipients.parse({
			channel,
			to: array(field(actual, "to"), 100).map(address),
			cc: array(field(actual, "cc"), 100).map(address),
			bcc: array(field(actual, "bcc"), 100).map(address),
		});
		const recipients = new Set([...captured.to, ...captured.cc, ...captured.bcc]);
		const seen = new Set<string>();
		const flags: Flag[] = [];
		for (const candidate of replyTo) {
			if (candidate === from[0] || !recipients.has(candidate) || seen.has(candidate)) continue;
			seen.add(candidate);
			flags.push({ code: "REPLY_TO_REDIRECT", severity: "ack", detail: candidate });
		}
		return { status: "classified", flags: Flags.parse(flags) };
	} catch {
		return { status: "refused", code: "INVALID_INPUT" };
	}
}
