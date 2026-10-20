import * as z from "zod";
import { wellFormedText } from "./extension.ts";
import { Base64Url, Ulid, UtcMs } from "./scalars.ts";

// One sync page carries at most MAX_CHANGES changes; bytes travel inline up to MAX_INLINE_BYTES,
// and anything larger as a blob the hub holds.
export const MAX_CHANGES = 500;
export const MAX_INLINE_BYTES = 65_536;

// Python's re lets `$` match before a final line feed, so the JSON Schema also refuses one.
const noLineFeed = { not: { pattern: "\\n" } };

// The entities use these too: one definition each.
export const ProviderId: z.ZodString = z
	.string()
	.min(1)
	.max(256)
	.regex(/^[!-~]+$/)
	.meta({
		id: "draftyak.normalized-change.ProviderId",
		description: "A provider's own id, opaque to the hub: visible ASCII, no spaces.",
		...noLineFeed,
	});

export const MediaType: z.ZodString = z
	.string()
	.min(3)
	.max(255)
	.regex(/^[a-z0-9!#$&^_.+-]+[/][a-z0-9!#$&^_.+-]+$/)
	.meta({
		id: "draftyak.normalized-change.MediaType",
		description: "A lower-case type/subtype without parameters, such as image/png.",
		...noLineFeed,
	});

export interface BlobRef {
	readonly ref: string;
}
export const BlobRef: z.ZodType<BlobRef> = z
	.strictObject({ ref: Ulid })
	.meta({ description: "Bytes the hub holds, such as a host/fetch response saved as a blob." });

export type Bytes = BlobRef | { readonly base64: string };
export const Bytes: z.ZodType<Bytes> = z.union([
	BlobRef,
	z.strictObject({ base64: Base64Url.max(Math.ceil((MAX_INLINE_BYTES * 4) / 3)) }),
]);

export interface EmailMessageChange {
	readonly kind: "email.message";
	readonly providerId: string;
	readonly threadId: string;
	readonly internalDate: number;
	readonly labelIds: readonly string[];
	readonly sizeBytes?: number;
	readonly raw?: Bytes;
}
export interface EmailDeletedChange {
	readonly kind: "email.deleted";
	readonly providerId: string;
}
export interface EmailLabelsChange {
	readonly kind: "email.labels";
	readonly providerId: string;
	readonly threadId: string;
	readonly labelIds: readonly string[];
}

const labelIds = z.array(ProviderId).max(256);
// The hub parses email itself (§3 Apply), so a message is its provider ids and the RFC 5322 bytes,
// never fields a plugin parsed. Without `raw` the hub fetches it with channel_body_fetch.
const emailMessage = z.strictObject({
	kind: z.literal("email.message"),
	providerId: ProviderId,
	threadId: ProviderId,
	internalDate: UtcMs,
	labelIds,
	sizeBytes: z.int().min(0).optional(),
	raw: Bytes.optional(),
});
export const EmailMessageChange: z.ZodType<EmailMessageChange> = emailMessage;
const emailDeleted = z.strictObject({ kind: z.literal("email.deleted"), providerId: ProviderId });
const emailLabels = z.strictObject({
	kind: z.literal("email.labels"),
	providerId: ProviderId,
	threadId: ProviderId,
	labelIds,
});

export interface ChatFile {
	readonly id: string;
	readonly name: string;
	readonly contentType: string;
	readonly size: number;
}
export interface ChatMessageChange {
	readonly kind: "chat.message";
	readonly channelId: string;
	readonly ts: string;
	readonly threadTs?: string;
	readonly sentAt: number;
	readonly author: { readonly kind: "user" | "bot"; readonly id: string };
	readonly subtype?: string;
	readonly text: string;
	readonly editedAt?: number;
	readonly files?: readonly ChatFile[];
}
export interface ChatDeletedChange {
	readonly kind: "chat.deleted";
	readonly channelId: string;
	readonly ts: string;
}
export const CHAT_CHANNEL_TYPES = ["dm", "group_dm", "public", "private"] as const;
export type ChatChannelType = (typeof CHAT_CHANNEL_TYPES)[number];
export const ChatChannelType: z.ZodEnum<z.core.util.ToEnum<ChatChannelType>> = z
	.enum(CHAT_CHANNEL_TYPES)
	.meta({
		id: "draftyak.normalized-change.ChatChannelType",
		description: "A direct message, a group direct message, or a public or private channel.",
	});
export interface ChatConversationChange {
	readonly kind: "chat.conversation";
	readonly channelId: string;
	readonly name?: string;
	readonly type: ChatChannelType;
	readonly external: boolean;
	readonly memberCount: number;
	readonly archived: boolean;
	readonly member: boolean;
}

// `ts` is the message's id within its conversation (Slack's ts); `sentAt` orders and dates it.
// Direction is the hub's to derive, from the author id and its own auth check (§3 Apply).
const chatMessage = z.strictObject({
	kind: z.literal("chat.message"),
	channelId: ProviderId,
	ts: ProviderId,
	threadTs: ProviderId.optional(),
	sentAt: UtcMs,
	author: z.strictObject({ kind: z.enum(["user", "bot"]), id: ProviderId }),
	subtype: z
		.string()
		.max(64)
		.regex(/^[a-z][a-z0-9_]*$/)
		.optional(),
	text: wellFormedText(40_000),
	editedAt: UtcMs.optional(),
	files: z
		.array(
			z.strictObject({
				id: ProviderId,
				name: wellFormedText(255),
				contentType: MediaType,
				size: z.int().min(0),
			}),
		)
		.max(20)
		.optional(),
});
export const ChatMessageChange: z.ZodType<ChatMessageChange> = chatMessage;
const chatDeleted = z.strictObject({
	kind: z.literal("chat.deleted"),
	channelId: ProviderId,
	ts: ProviderId,
});
// The facts a scheduled send's claim re-checks (§3 Pre-claim): `archived` is the provider's
// archive, never the hub's own flag, and `member` whether the owner still is one.
const chatConversation = z.strictObject({
	kind: z.literal("chat.conversation"),
	channelId: ProviderId,
	name: wellFormedText(256).optional(),
	type: ChatChannelType,
	external: z.boolean(),
	memberCount: z.int().min(0),
	archived: z.boolean(),
	member: z.boolean(),
});

export type PluginChange =
	| EmailMessageChange
	| EmailDeletedChange
	| EmailLabelsChange
	| ChatMessageChange
	| ChatDeletedChange
	| ChatConversationChange;
const pluginChanges = [
	emailMessage,
	emailDeleted,
	emailLabels,
	chatMessage,
	chatDeleted,
	chatConversation,
] as const;

// What a channel plugin may report. Device-hosted channels never join it: they are closed to
// plugins (§4), so their changes extend NormalizedChange alone.
export const PluginChange: z.ZodType<PluginChange> = z
	.discriminatedUnion("kind", pluginChanges)
	.meta({ title: "PluginChange" });

// A message with its body, as channel_body_fetch returns it.
export type MessageBody = (EmailMessageChange & { readonly raw: Bytes }) | ChatMessageChange;
export const MessageBody: z.ZodType<MessageBody> = z.discriminatedUnion("kind", [
	emailMessage.required({ raw: true }),
	chatMessage,
]);

// Every change the hub applies (§3 Sync engine), one transaction per page. SMS joins in M1.23 on
// these two lines, never in PluginChange: `PluginChange | SmsChange` and `...smsChanges`.
export type NormalizedChange = PluginChange;
export const NormalizedChange: z.ZodType<NormalizedChange> = z
	.discriminatedUnion("kind", [...pluginChanges])
	.meta({
		title: "NormalizedChange",
		description: "A change a channel reports and the hub applies; content in it is untrusted.",
	});
