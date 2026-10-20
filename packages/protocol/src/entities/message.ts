import type * as z from "zod";
import { channelUnion } from "./fields.ts";
import * as channels from "./message/channels.ts";

export * from "./message/channels.ts";

type MessageVariant = (typeof channels)[keyof typeof channels];

export const Message: z.ZodDiscriminatedUnion<MessageVariant[], "channel"> = channelUnion(
	channels,
).meta({
	id: "draftyak.entities.Message",
	description:
		"A synced message. Every text field from it is untrusted; direction is the hub's, and " +
		"provenance names what delivered it.",
});
export type Message = z.infer<typeof Message>;
