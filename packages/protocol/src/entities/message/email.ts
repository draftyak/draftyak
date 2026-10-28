import * as z from "zod";
import { ProviderId } from "../../normalized-change.ts";
import {
	AttachmentMeta,
	DmarcResult,
	MAX_EMAIL_LIST_ITEMS,
	Mailbox,
	type UntrustedTextSchema,
	untrustedText,
} from "../common.ts";
import { messageFields } from "../fields.ts";

type Mailboxes = z.ZodArray<typeof Mailbox>;
type Cut = z.ZodOptional<z.ZodLiteral<true>>;

const mailboxes: Mailboxes = z.array(Mailbox).max(MAX_EMAIL_LIST_ITEMS);

// A cut list says so, as untrustedText's truncated does for text.
const cut = (list: string): Cut =>
	z
		.literal(true)
		.optional()
		.meta({
			description:
				`Set when the hub cut the ${list} list: it keeps the first ${MAX_EMAIL_LIST_ITEMS} items ` +
				"of a longer one, in the message's order, and a result with a smaller budget, such as " +
				"message_get's, may keep fewer.",
		});

export const EmailMessage: z.ZodObject<
	{ channel: z.ZodLiteral<"email"> } & typeof messageFields & {
			providerRef: z.ZodObject<
				{ messageId: typeof ProviderId; threadId: typeof ProviderId },
				z.core.$strict
			>;
			from: Mailboxes;
			fromTruncated: Cut;
			replyTo: Mailboxes;
			replyToTruncated: Cut;
			to: Mailboxes;
			toTruncated: Cut;
			cc: Mailboxes;
			ccTruncated: Cut;
			bcc: Mailboxes;
			bccTruncated: Cut;
			subject: UntrustedTextSchema;
			snippet: UntrustedTextSchema;
			labelIds: z.ZodArray<typeof ProviderId>;
			dmarc: typeof DmarcResult;
			attachments: z.ZodArray<typeof AttachmentMeta>;
			attachmentsTruncated: Cut;
		},
	z.core.$strict
> = z
	.strictObject({
		channel: z.literal("email"),
		...messageFields,
		providerRef: z.strictObject({ messageId: ProviderId, threadId: ProviderId }),
		from: mailboxes,
		fromTruncated: cut("from"),
		replyTo: mailboxes,
		replyToTruncated: cut("replyTo"),
		to: mailboxes,
		toTruncated: cut("to"),
		cc: mailboxes,
		ccTruncated: cut("cc"),
		bcc: mailboxes,
		bccTruncated: cut("bcc"),
		subject: untrustedText(2000),
		snippet: untrustedText(500),
		labelIds: z.array(ProviderId).max(256),
		dmarc: DmarcResult,
		attachments: z.array(AttachmentMeta).max(MAX_EMAIL_LIST_ITEMS),
		attachmentsTruncated: cut("attachments"),
	})
	.meta({
		id: "draftyak.entities.EmailMessage",
		description:
			"A message the hub parsed from the raw RFC 822 bytes. Until the hub has parsed a " +
			"message, no view shows it, though it already counts as inbound for holds. Header text " +
			"is the message's, cut to its bound, and mailboxes as Mailbox reads them; only dmarc " +
			"and direction are the hub's own findings. The body is fetched apart.",
	});
export type EmailMessage = z.infer<typeof EmailMessage>;
