import { types } from "node:util";
import { EmailAddress, MAX_EMAIL_LIST_ITEMS } from "@draftyak/protocol/entities/common";
import { Contact } from "@draftyak/protocol/entities/contact";
import { Draft } from "@draftyak/protocol/entities/draft";
import { EmailDraftContent } from "@draftyak/protocol/entities/draft/email";
import { type Flag, Flags } from "@draftyak/protocol/flags";
import { ContentError } from "./limits.ts";
import { normalizeAddress } from "./mail-parser.ts";

// A work bound for this DATA comparison, not an account's contact-completeness limit.
export const MAX_CONTACT_FLAG_ROWS = 10_000;

export type EmailNewRecipientFlags =
	| { status: "classified"; flags: readonly Flag[] }
	| { status: "refused"; code: "INVALID_INPUT" | "STRUCTURE_LIMIT" };

const draftRecipients = EmailDraftContent.pick({ channel: true, to: true, cc: true, bcc: true });
const contactFields = Contact.pick({ accountId: true, addressNorm: true, known: true });

function object(value: unknown): object {
	if (!value || typeof value !== "object" || types.isProxy(value))
		throw new ContentError("INVALID_INPUT");
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== null && prototype !== Object.prototype) throw new ContentError("INVALID_INPUT");
	return value;
}

function field(value: object, key: string): unknown {
	const descriptor = Object.getOwnPropertyDescriptor(value, key);
	if (!descriptor || !("value" in descriptor)) throw new ContentError("INVALID_INPUT");
	return descriptor.value;
}

function array(
	value: unknown,
	maximum: number,
	overflow: "INVALID_INPUT" | "STRUCTURE_LIMIT",
): unknown[] {
	if (!value || typeof value !== "object" || types.isProxy(value) || !Array.isArray(value))
		throw new ContentError("INVALID_INPUT");
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== null && prototype !== Array.prototype) throw new ContentError("INVALID_INPUT");
	const length = field(value, "length");
	if (typeof length !== "number" || !Number.isInteger(length) || length < 0)
		throw new ContentError("INVALID_INPUT");
	if (length > maximum) throw new ContentError(overflow);
	const captured: unknown[] = [];
	for (let index = 0; index < length; index++) captured.push(field(value, String(index)));
	return captured;
}

function email(value: string): string | undefined {
	const normalized = normalizeAddress(value);
	if (normalized === undefined) return undefined;
	const parsed = EmailAddress.safeParse(normalized);
	return parsed.success ? parsed.data : undefined;
}

function recipient(value: unknown): string {
	if (typeof value !== "string" || value.length > 254) throw new ContentError("INVALID_INPUT");
	const normalized = email(value);
	if (normalized === undefined) throw new ContentError("INVALID_INPUT");
	return normalized;
}

/** Compare only supplied contact/recipient DATA; known status and account authority are not verified. */
export function classifyEmailNewRecipientFlags(
	accountId: Draft["accountId"],
	draft: Pick<EmailDraftContent, "channel" | "to" | "cc" | "bcc">,
	contacts: readonly Pick<Contact, "accountId" | "addressNorm" | "known">[],
): EmailNewRecipientFlags {
	try {
		if (typeof accountId !== "string" || accountId.length !== 26)
			return { status: "refused", code: "INVALID_INPUT" };
		const account = Draft.shape.accountId.parse(accountId);
		const input = object(draft);
		const channel = field(input, "channel");
		if (channel !== "email") return { status: "refused", code: "INVALID_INPUT" };
		const captured = draftRecipients.parse({
			channel,
			to: array(field(input, "to"), MAX_EMAIL_LIST_ITEMS, "INVALID_INPUT").map(recipient),
			cc: array(field(input, "cc"), MAX_EMAIL_LIST_ITEMS, "INVALID_INPUT").map(recipient),
			bcc: array(field(input, "bcc"), MAX_EMAIL_LIST_ITEMS, "INVALID_INPUT").map(recipient),
		});
		const rows = array(contacts, MAX_CONTACT_FLAG_ROWS, "STRUCTURE_LIMIT");
		const known = new Set<string>();
		const seen = new Map<string, Map<string, boolean>>();
		// Validate every row before classification, including foreign and unknown contacts.
		for (const raw of rows) {
			const row = object(raw);
			const addressNorm = object(field(row, "addressNorm"));
			const text = field(addressNorm, "text");
			// AddressNorm permits only BMP visible characters, at most 320 UTF-16 units.
			if (typeof text !== "string" || text.length > 320) throw new ContentError("INVALID_INPUT");
			const rowAccountId = field(row, "accountId");
			const rowKnown = field(row, "known");
			const untrusted = field(addressNorm, "untrusted");
			if (
				typeof rowAccountId !== "string" ||
				rowAccountId.length !== 26 ||
				typeof rowKnown !== "boolean" ||
				untrusted !== true
			)
				throw new ContentError("INVALID_INPUT");
			// Capture only used own fields; names, activity and other extra fields remain unread.
			const contact = contactFields.parse({
				accountId: rowAccountId,
				addressNorm: {
					untrusted,
					text,
				},
				known: rowKnown,
			});
			const normalized = email(contact.addressNorm.text);
			const key = normalized ?? contact.addressNorm.text;
			let addresses = seen.get(contact.accountId);
			if (!addresses) {
				addresses = new Map<string, boolean>();
				seen.set(contact.accountId, addresses);
			}
			if (addresses.has(key) && addresses.get(key) !== contact.known)
				throw new ContentError("INVALID_INPUT");
			addresses.set(key, contact.known);
			if (contact.accountId === account && contact.known && normalized !== undefined)
				known.add(normalized);
		}

		const flags: Flag[] = [];
		const recipients = new Set([...captured.to, ...captured.cc, ...captured.bcc]);
		for (const address of recipients) {
			if (!known.has(address))
				flags.push({ code: "NEW_RECIPIENT", severity: "ack", detail: address });
		}
		return { status: "classified", flags: Flags.parse(flags) };
	} catch (error) {
		return {
			status: "refused",
			code:
				error instanceof ContentError && error.code === "STRUCTURE_LIMIT"
					? "STRUCTURE_LIMIT"
					: "INVALID_INPUT",
		};
	}
}
