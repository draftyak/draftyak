import * as z from "zod";
import { MediaType } from "../../normalized-change.ts";
import { Sha256Hex, Ulid } from "../../scalars.ts";
import { bodyText, EmailAddress, MAX_EMAIL_LIST_ITEMS, oneLine } from "../common.ts";

export const DraftAttachment: z.ZodObject<
	{
		blobId: typeof Ulid;
		filename: z.ZodString;
		contentType: typeof MediaType;
		size: z.ZodInt;
		sha256: typeof Sha256Hex;
	},
	z.core.$strict
> = z
	.strictObject({
		blobId: Ulid,
		filename: oneLine(256).min(1),
		contentType: MediaType,
		size: z.int().min(0),
		sha256: Sha256Hex,
	})
	.meta({
		id: "draftyak.entities.DraftAttachment",
		description:
			"A file the hub holds as a blob, with the name, type, size and hash it sends. The hub " +
			"lower-cases the media type it was given and drops its parameters, and uses " +
			"application/octet-stream for one it can't read.",
	});
export type DraftAttachment = z.infer<typeof DraftAttachment>;

type Addresses = z.ZodArray<typeof EmailAddress>;
const addresses: Addresses = z.array(EmailAddress).max(MAX_EMAIL_LIST_ITEMS);

export const EmailDraftContent: z.ZodObject<
	{
		channel: z.ZodLiteral<"email">;
		to: Addresses;
		cc: Addresses;
		bcc: Addresses;
		subject: z.ZodString;
		body: z.ZodString;
		attachments: z.ZodArray<typeof DraftAttachment>;
	},
	z.core.$strict
> = z
	.strictObject({
		channel: z.literal("email"),
		to: addresses,
		cc: addresses,
		bcc: addresses,
		subject: oneLine(2000),
		body: bodyText(100_000),
		attachments: z.array(DraftAttachment).max(MAX_EMAIL_LIST_ITEMS),
	})
	.meta({
		id: "draftyak.entities.EmailDraftContent",
		description:
			"The recipients, subject, body and attachments of an email draft, at most 100 of each " +
			"list. For a reply the hub fills to and cc from the thread, and adds threading when it " +
			"freezes a snapshot.",
	});
export type EmailDraftContent = z.infer<typeof EmailDraftContent>;
