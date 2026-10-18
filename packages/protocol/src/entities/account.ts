import type * as z from "zod";
import * as channels from "./account/channels.ts";
import { channelUnion } from "./fields.ts";

export * from "./account/channels.ts";

type AccountVariant = (typeof channels)[keyof typeof channels];

export const Account: z.ZodDiscriminatedUnion<AccountVariant[], "channel"> = channelUnion(
	channels,
).meta({
	id: "draftyak.entities.Account",
	description:
		"A connected account. alias is the owner's own name for it, never taken from provider data.",
});
export type Account = z.infer<typeof Account>;
