import * as z from "zod";
import { ProviderId } from "../../normalized-change.ts";
import { type UntrustedTextSchema, untrustedText } from "../common.ts";
import { conversationFields } from "../fields.ts";

export const EmailConversation: z.ZodObject<
	{ channel: z.ZodLiteral<"email"> } & typeof conversationFields & {
			threadId: typeof ProviderId;
			subject: UntrustedTextSchema;
			labelIds: z.ZodArray<typeof ProviderId>;
		},
	z.core.$strict
> = z
	.strictObject({
		channel: z.literal("email"),
		...conversationFields,
		threadId: ProviderId,
		subject: untrustedText(2000),
		labelIds: z.array(ProviderId).max(256),
	})
	.meta({
		id: "draftyak.entities.EmailConversation",
		description: "A thread, with the labels its messages carry.",
	});
export type EmailConversation = z.infer<typeof EmailConversation>;
