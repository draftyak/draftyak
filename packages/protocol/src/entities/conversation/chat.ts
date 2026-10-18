import * as z from "zod";
import { ChatChannelType, ProviderId } from "../../normalized-change.ts";
import { type UntrustedTextSchema, untrustedText } from "../common.ts";
import { conversationFields } from "../fields.ts";

export const ChatConversation: z.ZodObject<
	{ channel: z.ZodLiteral<"chat"> } & typeof conversationFields & {
			channelId: typeof ProviderId;
			name: z.ZodNullable<UntrustedTextSchema>;
			type: typeof ChatChannelType;
			external: z.ZodBoolean;
			memberCount: z.ZodInt;
			channelArchived: z.ZodBoolean;
			member: z.ZodBoolean;
		},
	z.core.$strict
> = z
	.strictObject({
		channel: z.literal("chat"),
		...conversationFields,
		channelId: ProviderId,
		name: untrustedText(256).nullable(),
		type: ChatChannelType,
		external: z.boolean(),
		memberCount: z.int().min(0),
		channelArchived: z.boolean(),
		member: z.boolean(),
	})
	.meta({
		id: "draftyak.entities.ChatConversation",
		description:
			"A channel or direct message as the provider last described it: name is null for a " +
			"direct message; external when shared with another organization; channelArchived is " +
			"the provider's archive, archived the hub's; member whether the owner still belongs.",
	});
export type ChatConversation = z.infer<typeof ChatConversation>;
