import type * as z from "zod";
import * as channels from "./conversation/channels.ts";
import { channelUnion } from "./fields.ts";

export * from "./conversation/channels.ts";

type ConversationVariant = (typeof channels)[keyof typeof channels];

export const Conversation: z.ZodDiscriminatedUnion<ConversationVariant[], "channel"> = channelUnion(
	channels,
).meta({
	id: "draftyak.entities.Conversation",
	description:
		"A thread or chat. workspaceId and assigneeUserId stay null for a single owner; archived " +
		"and read are the hub's own state where the channel has no provider organize.",
});
export type Conversation = z.infer<typeof Conversation>;
