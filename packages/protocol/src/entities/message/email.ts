import * as z from "zod";
import { ProviderId } from "../../normalized-change.ts";
import {
	AttachmentMeta,
	DmarcResult,
	Mailbox,
	type UntrustedTextSchema,
	untrustedText,
} from "../common.ts";
import { messageFields } from "../fields.ts";

type Mailboxes = z.ZodArray<typeof Mailbox>;

export const EmailMessage: z.ZodObject<
	{ channel: z.ZodLiteral<"email"> } & typeof messageFields & {
			providerRef: z.ZodObject<
				{ messageId: typeof ProviderId; threadId: typeof ProviderId },
				z.core.$strict
			>;
			from: Mailboxes;
			replyTo: Mailboxes;
			to: Mailboxes;
			cc: Mailboxes;
			bcc: Mailboxes;
			subject: UntrustedTextSchema;
			snippet: UntrustedTextSchema;
			labelIds: z.ZodArray<typeof ProviderId>;
			dmarc: typeof DmarcResult;
			attachments: z.ZodArray<typeof AttachmentMeta>;
		},
	z.core.$strict
> = z
	.strictObject({
		channel: z.literal("email"),
		...messageFields,
		providerRef: z.strictObject({ messageId: ProviderId, threadId: ProviderId }),
		from: z.array(Mailbox),
		replyTo: z.array(Mailbox),
		to: z.array(Mailbox),
		cc: z.array(Mailbox),
		bcc: z.array(Mailbox),
		subject: untrustedText(2000),
		snippet: untrustedText(500),
		labelIds: z.array(ProviderId).max(256),
		dmarc: DmarcResult,
		attachments: z.array(AttachmentMeta),
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
