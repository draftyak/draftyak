import * as z from "zod";
import { Ulid, UtcMs } from "../scalars.ts";
import {
	patterned,
	type Untrusted,
	type UntrustedTextSchema,
	untrusted,
	untrustedText,
	VISIBLE_NON_ASCII,
} from "./common.ts";

export const AddressNorm: z.ZodString = patterned(
	new RegExp(`^[!-~${VISIBLE_NON_ASCII}]+$`),
	320,
).meta({
	id: "draftyak.entities.AddressNorm",
	description:
		"An address in the form the hub normalizes it to for its channel, such as an email " +
		"address or a user id: visible characters only, no spaces or invisible characters.",
});

export const Contact: z.ZodObject<
	{
		accountId: typeof Ulid;
		addressNorm: Untrusted<typeof AddressNorm>;
		name: z.ZodNullable<UntrustedTextSchema>;
		known: z.ZodBoolean;
		lastActivityAt: typeof UtcMs;
	},
	z.core.$strict
> = z
	.strictObject({
		accountId: Ulid,
		addressNorm: untrusted(AddressNorm),
		name: untrustedText(256).nullable(),
		known: z.boolean(),
		lastActivityAt: UtcMs,
	})
	.meta({
		id: "draftyak.entities.Contact",
		description:
			"Keyed by accountId and addressNorm, which come from other people's messages. known " +
			"comes only from the hub's own verified sends and the sent mail it parsed.",
	});
export type Contact = z.infer<typeof Contact>;
