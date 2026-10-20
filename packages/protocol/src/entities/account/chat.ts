import * as z from "zod";
import { ProviderId } from "../../normalized-change.ts";
import { Ulid } from "../../scalars.ts";
import { accountFields, withDeadline } from "../fields.ts";

export const ChatAccount: z.ZodObject<
	{ channel: z.ZodLiteral<"chat"> } & typeof accountFields & {
			pluginInstanceId: typeof Ulid;
			teamId: z.ZodNullable<typeof ProviderId>;
			selfUserId: typeof ProviderId;
		},
	z.core.$strict
> = withDeadline(
	z.strictObject({
		channel: z.literal("chat"),
		...accountFields,
		pluginInstanceId: Ulid,
		teamId: ProviderId.nullable(),
		selfUserId: ProviderId,
	}),
).meta({
	id: "draftyak.entities.ChatAccount",
	description:
		"A chat workspace served by a channel plugin. selfUserId is the owner's own user id, " +
		"which the hub checks itself, so it can tell the owner's messages from others'.",
});
export type ChatAccount = z.infer<typeof ChatAccount>;
