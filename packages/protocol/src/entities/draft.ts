import * as z from "zod";
import { Flags } from "../flags.ts";
import { Sha256Hex, Ulid, UtcMs } from "../scalars.ts";
import * as channels from "./draft/channels.ts";
import { channelUnion } from "./fields.ts";

export * from "./draft/channels.ts";
export { DraftAttachment } from "./draft/email.ts";

const draftStates = ["open", "sent", "discarded"] as const;
export type DraftState = (typeof draftStates)[number];
export const DraftState: z.ZodEnum<z.core.util.ToEnum<DraftState>> = z.enum(draftStates).meta({
	id: "draftyak.entities.DraftState",
	description: "sent and discarded drafts take no new revisions.",
});

export const Draft: z.ZodObject<
	{
		id: typeof Ulid;
		accountId: typeof Ulid;
		conversationId: z.ZodNullable<typeof Ulid>;
		rev: z.ZodInt;
		state: typeof DraftState;
		createdAt: typeof UtcMs;
		updatedAt: typeof UtcMs;
	},
	z.core.$strict
> = z
	.strictObject({
		id: Ulid,
		accountId: Ulid,
		conversationId: Ulid.nullable(),
		rev: z.int().min(1),
		state: DraftState,
		createdAt: UtcMs,
		updatedAt: UtcMs,
	})
	.meta({
		id: "draftyak.entities.Draft",
		description:
			"A draft and its latest revision number, which an edit names as the one it expects. " +
			"conversationId is null for a new email conversation; a chat draft always has one.",
	});
export type Draft = z.infer<typeof Draft>;

const authorKinds = ["owner", "ai", "agent", "plugin"] as const;
export type DraftAuthorKind = (typeof authorKinds)[number];

export const DraftAuthor: z.ZodObject<
	{ kind: z.ZodEnum<z.core.util.ToEnum<DraftAuthorKind>>; id: typeof Ulid },
	z.core.$strict
> = z.strictObject({ kind: z.enum(authorKinds), id: Ulid }).meta({
	id: "draftyak.entities.DraftAuthor",
	description:
		"Who wrote a revision: the owner (a user id), the hub's AI (an AI run id), an agent (a " +
		"grant or agent token id) or a plugin (a plugin instance id).",
});
export type DraftAuthor = z.infer<typeof DraftAuthor>;

type DraftContentVariant = (typeof channels)[keyof typeof channels];

export const DraftContent: z.ZodDiscriminatedUnion<DraftContentVariant[], "channel"> = channelUnion(
	channels,
).meta({
	id: "draftyak.entities.DraftContent",
	description: "What a revision says and to whom, in its account's channel.",
});
export type DraftContent = z.infer<typeof DraftContent>;

export const DraftRevision: z.ZodObject<
	{
		draftId: typeof Ulid;
		rev: z.ZodInt;
		author: typeof DraftAuthor;
		content: typeof DraftContent;
		contentSha256: typeof Sha256Hex;
		flags: typeof Flags;
		createdAt: typeof UtcMs;
	},
	z.core.$strict
> = z
	.strictObject({
		draftId: Ulid,
		rev: z.int().min(1),
		author: DraftAuthor,
		content: DraftContent,
		contentSha256: Sha256Hex,
		flags: Flags,
		createdAt: UtcMs,
	})
	.meta({
		id: "draftyak.entities.DraftRevision",
		description:
			"An immutable revision: its content, contentSha256 the SHA-256 of the JCS of that " +
			"content, and the flags computed against it.",
	});
export type DraftRevision = z.infer<typeof DraftRevision>;
