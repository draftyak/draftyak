import * as z from "zod";
import { Ulid } from "../../scalars.ts";
import { EmailAddress } from "../common.ts";
import { accountFields, withDeadline } from "../fields.ts";

export const EmailAccount: z.ZodObject<
	{ channel: z.ZodLiteral<"email"> } & typeof accountFields & {
			pluginInstanceId: typeof Ulid;
			address: typeof EmailAddress;
		},
	z.core.$strict
> = withDeadline(
	z.strictObject({
		channel: z.literal("email"),
		...accountFields,
		pluginInstanceId: Ulid,
		address: EmailAddress,
	}),
).meta({
	id: "draftyak.entities.EmailAccount",
	description: "A mailbox served by a channel plugin; address is the mailbox's own.",
});
export type EmailAccount = z.infer<typeof EmailAccount>;
