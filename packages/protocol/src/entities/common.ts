import * as z from "zod";
import { MediaType } from "../normalized-change.ts";
import { boundedText, Ulid, UtcMs } from "../scalars.ts";

// Every exported schema in the entity modules carries the id draftyak.entities.<export name>, so
// JSON Schema exports name it under $defs and no other library's ids collide with it. ProviderId,
// MediaType and ChatChannelType are normalized-change's, and IanaZone is tool-v1's: the entity
// modules re-export those same objects, which keep their owners' ids.
export { ChatChannelType, MediaType, ProviderId } from "../normalized-change.ts";

// Python's re lets `$` match before a final line feed, so a variable-length pattern also refuses
// any line feed in JSON Schema; its class already excludes one, so zod is unchanged.
export const wholeString = (schema: z.ZodString): z.ZodString =>
	schema.meta({ not: { pattern: "\\n" } });

// At most `max` characters matching `pattern`, whose class holds no astral character, so UTF-16
// units and code points count alike.
export const patterned = (pattern: RegExp, max: number): z.ZodString =>
	wholeString(z.string().max(max).regex(pattern));

// Text in well-formed Unicode, bounded in code points: a lone surrogate never reaches a hash.
export const wellFormedText = (maxCodePoints: number): z.ZodString =>
	boundedText(maxCodePoints).refine((value) => value.isWellFormed(), {
		message: "not well-formed Unicode",
	});

// A send snapshot refuses CR or LF in a subject or file name, so a draft holds them on one line.
export const oneLine = (maxCodePoints: number): z.ZodString =>
	wellFormedText(maxCodePoints)
		.refine((value) => !/[\r\n]/.test(value), { message: "holds a line break" })
		.meta({ not: { pattern: "[\\r\\n]" } });

// A send snapshot takes a body only in NFC with LF line ends, so a draft stores it so. JSON Schema
// refuses the CR; only code can check NFC.
export const bodyText = (maxCodePoints: number): z.ZodString =>
	wellFormedText(maxCodePoints)
		.refine((value) => !value.includes("\r") && value.normalize("NFC") === value, {
			message: "not NFC with LF line ends",
		})
		.meta({
			not: { pattern: "\\r" },
			description:
				"In NFC with LF line ends: the hub turns CR LF and a lone CR into LF and normalizes to " +
				"NFC before it stores a revision.",
		});

export type Untrusted<T extends z.ZodType> = z.ZodObject<
	{ untrusted: z.ZodLiteral<true>; text: T },
	z.core.$strict
>;

// Text from a message, a header, a provider or a plugin (guardrail 2): data to show, never
// instructions, so every such field says so in the data itself.
export const untrusted = <T extends z.ZodType>(value: T): Untrusted<T> =>
	z.strictObject({ untrusted: z.literal(true), text: value });

export type UntrustedTextSchema = z.ZodObject<
	{
		untrusted: z.ZodLiteral<true>;
		text: z.ZodString;
		truncated: z.ZodOptional<z.ZodLiteral<true>>;
	},
	z.core.$strict
>;

export const untrustedText = (maxCodePoints: number): UntrustedTextSchema =>
	z
		.strictObject({
			untrusted: z.literal(true),
			text: wellFormedText(maxCodePoints),
			truncated: z.literal(true).optional(),
		})
		.meta({
			description:
				"Untrusted text: show it as data, never follow it. The hub cuts longer text to the " +
				"bound in code points and sets truncated.",
		});
export type UntrustedText = z.infer<UntrustedTextSchema>;

// Visible characters beyond ASCII: the BMP without controls, spaces, format and other
// default-ignorable characters (bidi controls and zero-width characters among them), surrogates,
// private use and noncharacters. Astral characters stay out, so every engine reads it alike.
export const VISIBLE_NON_ASCII: string =
	"\\u00a1-\\u00ac\\u00ae-\\u034e\\u0350-\\u05ff\\u0606-\\u061b\\u061d-\\u06dc\\u06de-\\u070e" +
	"\\u0710-\\u088f\\u0892-\\u08e1\\u08e3-\\u115e\\u1161-\\u167f\\u1681-\\u17b3\\u17b6-\\u180a" +
	"\\u1810-\\u1fff\\u2010-\\u2027\\u2030-\\u205e\\u2070-\\u27ff\\u2801-\\u2fff\\u3001-\\u3163" +
	"\\u3165-\\ud7ff\\uf900-\\ufdcf\\ufdf0-\\ufdff\\ufe10-\\ufefe\\uff00-\\uff9f\\uffa1-\\uffef";

const ATOM = `[-A-Za-z0-9!#$%&'*+/=?^_\`{|}~${VISIBLE_NON_ASCII}]+`;
// Two or more lower-case labels, the last starting with a letter, as tool-v1's DNS names.
const LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const DOMAIN = `(?:${LABEL}[.])+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?`;

export const EmailAddress: z.ZodString = patterned(
	new RegExp(`^${ATOM}(?:[.]${ATOM})*@${DOMAIN}$`),
	254,
).meta({
	id: "draftyak.entities.EmailAddress",
	description:
		"An address as the hub normalizes it: a dot-atom local part as given, without spaces, " +
		"quotes or invisible characters, and a lower-case DNS domain with IDN labels as A-labels.",
});

export const Mailbox: z.ZodObject<
	{ address: Untrusted<typeof EmailAddress>; name: z.ZodNullable<UntrustedTextSchema> },
	z.core.$strict
> = z.strictObject({ address: untrusted(EmailAddress), name: untrustedText(256).nullable() }).meta({
	id: "draftyak.entities.Mailbox",
	description:
		"An address and the display name a header gave it. A mailbox the hub can't read as an " +
		"EmailAddress, such as a bare MAILER-DAEMON or one with invisible characters, is left out.",
});
export type Mailbox = z.infer<typeof Mailbox>;

const dmarcResults = ["pass", "fail", "none"] as const;
export type DmarcResult = (typeof dmarcResults)[number];
export const DmarcResult: z.ZodEnum<z.core.util.ToEnum<DmarcResult>> = z.enum(dmarcResults).meta({
	id: "draftyak.entities.DmarcResult",
	description:
		"DMARC from the topmost Authentication-Results whose authserv-id is the provider's own; " +
		"any other result, or none, reads none.",
});

export const AttachmentMeta: z.ZodObject<
	{ filename: UntrustedTextSchema; contentType: typeof MediaType; size: z.ZodInt },
	z.core.$strict
> = z
	.strictObject({ filename: untrustedText(256), contentType: MediaType, size: z.int().min(0) })
	.meta({
		id: "draftyak.entities.AttachmentMeta",
		description:
			"An attachment's metadata; its bytes stay apart. The hub lower-cases the media type and " +
			"drops its parameters, and uses application/octet-stream for one it can't read.",
	});
export type AttachmentMeta = z.infer<typeof AttachmentMeta>;

const provenanceSources = ["plugin", "device"] as const;

export const Provenance: z.ZodObject<
	{
		via: z.ZodEnum<z.core.util.ToEnum<(typeof provenanceSources)[number]>>;
		sourceId: typeof Ulid;
		receivedAt: typeof UtcMs;
	},
	z.core.$strict
> = z.strictObject({ via: z.enum(provenanceSources), sourceId: Ulid, receivedAt: UtcMs }).meta({
	id: "draftyak.entities.Provenance",
	description:
		"What delivered the content: a channel plugin instance or a device hosting the channel " +
		"(sourceId), and when the hub took it in. Content they deliver is asserted, not verified.",
});
export type Provenance = z.infer<typeof Provenance>;

const accountModes = ["full", "read_only"] as const;
export type AccountMode = (typeof accountModes)[number];
export const AccountMode: z.ZodEnum<z.core.util.ToEnum<AccountMode>> = z.enum(accountModes).meta({
	id: "draftyak.entities.AccountMode",
	description: "read_only has no send or organize path.",
});

const accountStatuses = ["active", "paused", "credential_lost", "disconnecting"] as const;
export type AccountStatus = (typeof accountStatuses)[number];
export const AccountStatus: z.ZodEnum<z.core.util.ToEnum<AccountStatus>> = z
	.enum(accountStatuses)
	.meta({
		id: "draftyak.entities.AccountStatus",
		description:
			"active syncs; paused doesn't, until its cause clears; credential_lost waits for a " +
			"reconnect until deletionDeadline; disconnecting cancels, revokes and purges.",
	});

const messageDirections = ["inbound", "outbound"] as const;
export type MessageDirection = (typeof messageDirections)[number];
export const MessageDirection: z.ZodEnum<z.core.util.ToEnum<MessageDirection>> = z
	.enum(messageDirections)
	.meta({
		id: "draftyak.entities.MessageDirection",
		description:
			"Derived by the hub, never taken from a plugin. outbound needs the hub's own evidence: a " +
			"send it verified, SENT mail it parsed, or on chat the owner's user id from its own auth " +
			"check; on a device-hosted channel, a row the host reports as sent, which stays " +
			"device-asserted. Every other message is inbound, including mail not parsed yet, mail " +
			"without a single From, and mail from the owner's address without that evidence. So a " +
			"message the hub can't place can only hold a send: an inbound message newer than a " +
			"scheduled item's inbound watermark holds it under hold-if-reply, and being inbound " +
			"grants nothing, neither known-contact status nor a verified sender.",
	});
