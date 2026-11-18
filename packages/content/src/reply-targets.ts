import { types } from "node:util";
import { EmailAddress } from "@draftyak/protocol/entities/common";
import type { ParsedMail } from "./mail.ts";
import { normalizeAddress } from "./mail-parser.ts";

export type EmailReplyMode = "reply" | "reply-all";
export type EmailReplySelection =
	| {
			status: "selected";
			to: readonly string[];
			cc: readonly string[];
			provenance: readonly {
				address: string;
				kind: "from" | "reply-to" | "to" | "cc";
				field: "to" | "cc";
			}[];
	  }
	| {
			status: "refused";
			code:
				| "INVALID_INPUT"
				| "AMBIGUOUS_FROM"
				| "AMBIGUOUS_REPLY_TO"
				| "NO_RECIPIENTS"
				| "RECIPIENT_LIMIT";
	  };

type Selected = Extract<EmailReplySelection, { status: "selected" }>;
type Origin = Selected["provenance"][number];
const MAX_SOURCE_ADDRESSES = 500;
const MAX_RECIPIENTS = 100;

function object(value: unknown): object {
	if (!value || typeof value !== "object" || types.isProxy(value))
		throw new Error("Invalid recipient data");
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== null && prototype !== Object.prototype)
		throw new Error("Invalid recipient data");
	return value;
}

function field(value: object, key: string): unknown {
	const descriptor = Object.getOwnPropertyDescriptor(value, key);
	if (!descriptor || !("value" in descriptor)) throw new Error("Invalid recipient data");
	return descriptor.value;
}

function array(value: unknown, minimum = 0): unknown[] {
	if (!Array.isArray(value) || types.isProxy(value)) throw new Error("Invalid recipient data");
	const length = field(value, "length");
	if (
		typeof length !== "number" ||
		!Number.isInteger(length) ||
		length < minimum ||
		length > MAX_SOURCE_ADDRESSES
	)
		throw new Error("Invalid recipient data");
	const captured: unknown[] = [];
	for (let index = 0; index < length; index++) captured.push(field(value, String(index)));
	return captured;
}

function address(value: unknown): string {
	const normalized = typeof value === "string" ? normalizeAddress(value) : undefined;
	if (normalized === undefined || !EmailAddress.safeParse(normalized).success)
		throw new Error("Invalid recipient data");
	return normalized;
}

function mailboxes(value: unknown): string[] {
	return array(value).map((mailbox) => address(field(object(mailbox), "address")));
}

/** Select untrusted recipient DATA only; no thread, sender or approval authority is inferred. */
export function selectEmailReplyTargets(
	mail: ParsedMail,
	mode: EmailReplyMode,
	ownAddresses: readonly string[],
): EmailReplySelection {
	try {
		if (mode !== "reply" && mode !== "reply-all")
			return { status: "refused", code: "INVALID_INPUT" };
		const own = new Set(array(ownAddresses, 1).map(address));
		const input = object(mail);
		const from = mailboxes(field(input, "from"));
		const originalTo = mailboxes(field(input, "to"));
		const originalCc = mailboxes(field(input, "cc"));
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
		const to: string[] = [];
		const cc: string[] = [];
		const provenance: Origin[] = [];
		const seen = new Set<string>();
		const append = (
			addresses: readonly string[],
			kind: Origin["kind"],
			destination: Origin["field"],
		): boolean => {
			const recipients = destination === "to" ? to : cc;
			for (const candidate of addresses) {
				if (own.has(candidate) || seen.has(candidate)) continue;
				seen.add(candidate);
				recipients.push(candidate);
				provenance.push({ address: candidate, kind, field: destination });
				if (recipients.length > MAX_RECIPIENTS) return false;
			}
			return true;
		};
		if (
			!append(
				replyToHeaderCount === 1 ? replyTo : from,
				replyToHeaderCount === 1 ? "reply-to" : "from",
				"to",
			) ||
			(mode === "reply-all" && (!append(originalTo, "to", "to") || !append(originalCc, "cc", "cc")))
		)
			return { status: "refused", code: "RECIPIENT_LIMIT" };
		if (to.length === 0 && cc.length === 0) return { status: "refused", code: "NO_RECIPIENTS" };
		return { status: "selected", to, cc, provenance };
	} catch {
		return { status: "refused", code: "INVALID_INPUT" };
	}
}
