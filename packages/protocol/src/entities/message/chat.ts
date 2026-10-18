import * as z from "zod";
import { ProviderId } from "../../normalized-change.ts";
import { UtcMs } from "../../scalars.ts";
import { AttachmentMeta, patterned, type UntrustedTextSchema, untrustedText } from "../common.ts";
import { messageFields } from "../fields.ts";

const authorKinds = ["user", "bot"] as const;

export const ChatMessage: z.ZodObject<
	{ channel: z.ZodLiteral<"chat"> } & typeof messageFields & {
			providerRef: z.ZodObject<
				{ channelId: typeof ProviderId; ts: typeof ProviderId },
				z.core.$strict
			>;
			threadTs: z.ZodNullable<typeof ProviderId>;
			author: z.ZodObject<
				{
					kind: z.ZodEnum<z.core.util.ToEnum<(typeof authorKinds)[number]>>;
					id: typeof ProviderId;
				},
				z.core.$strict
			>;
			subtype: z.ZodNullable<z.ZodString>;
			text: UntrustedTextSchema;
			editedAt: z.ZodNullable<typeof UtcMs>;
			deleted: z.ZodBoolean;
			attachments: z.ZodArray<typeof AttachmentMeta>;
		},
	z.core.$strict
> = z
	.strictObject({
		channel: z.literal("chat"),
		...messageFields,
		providerRef: z.strictObject({ channelId: ProviderId, ts: ProviderId }),
		threadTs: ProviderId.nullable(),
		author: z.strictObject({ kind: z.enum(authorKinds), id: ProviderId }),
		subtype: patterned(/^[a-z][a-z0-9_]*$/, 64).nullable(),
		text: untrustedText(40_000),
		editedAt: UtcMs.nullable(),
		deleted: z.boolean(),
		attachments: z.array(AttachmentMeta).max(20),
	})
	.meta({
		id: "draftyak.entities.ChatMessage",
		description:
			"A chat message with the provider's user or bot id, never a display name. A deleted " +
			"message keeps its row with deleted set.",
	});
export type ChatMessage = z.infer<typeof ChatMessage>;
