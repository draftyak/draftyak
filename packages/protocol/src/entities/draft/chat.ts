import * as z from "zod";
import { ProviderId } from "../../normalized-change.ts";
import { bodyText } from "../common.ts";

export const ChatDraftContent: z.ZodObject<
	{
		channel: z.ZodLiteral<"chat">;
		threadTs: z.ZodNullable<typeof ProviderId>;
		broadcast: z.ZodBoolean;
		body: z.ZodString;
	},
	z.core.$strict
> = z
	.strictObject({
		channel: z.literal("chat"),
		threadTs: ProviderId.nullable(),
		broadcast: z.boolean(),
		body: bodyText(40_000),
	})
	.refine((content) => content.threadTs !== null || !content.broadcast, {
		message: "only a thread reply is broadcast",
	})
	.meta({
		anyOf: [
			{ properties: { broadcast: { const: false } } },
			{ properties: { threadTs: { type: "string" } } },
		],
		id: "draftyak.entities.ChatDraftContent",
		description:
			"A chat draft in its conversation: a top-level post (threadTs null) or a thread reply, " +
			"which broadcast also posts to the channel.",
	});
export type ChatDraftContent = z.infer<typeof ChatDraftContent>;
