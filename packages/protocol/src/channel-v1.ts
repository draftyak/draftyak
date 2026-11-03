import * as z from "zod";
import {
	type ExtensionContract,
	PluginError,
	ProbeResult,
	type ToolContract,
	wellFormedText,
} from "./extension.ts";
import {
	BlobRef,
	Bytes,
	ChatChannelType,
	ChatConversationChange,
	ChatMessageChange,
	MAX_CHANGES,
	MediaType,
	MessageBody,
	PluginChange,
	ProviderId,
} from "./normalized-change.ts";
import { UtcMs } from "./scalars.ts";
import { ContentType, SEND_TICKET_META, SendMethod, SendTicket, SendUrl } from "./send-ticket.ts";

export const CHANNEL_V1 = "io.github.draftyak/channel";
// channel_listen leases last at most 10 minutes and are renewed by calling again (§4 Health).
export const MAX_LEASE_MS = 600_000;

export const Cursor: z.ZodString = z
	.string()
	.min(1)
	.max(4_096)
	.regex(/^[!-~]+$/)
	.meta({ description: "A plugin's sync position, opaque to the hub." });

export type MessageRef =
	| { readonly kind: "email"; readonly providerId: string }
	| { readonly kind: "chat"; readonly channelId: string; readonly ts: string };
export const MessageRef: z.ZodType<MessageRef> = z.discriminatedUnion("kind", [
	z.strictObject({ kind: z.literal("email"), providerId: ProviderId }),
	z.strictObject({ kind: z.literal("chat"), channelId: ProviderId, ts: ProviderId }),
]);

// Organize actions done at the provider; a channel that lists none keeps them hub-local (§3).
export const MUTATIONS = ["archive", "unarchive", "read", "unread", "label", "unlabel"] as const;
export type Mutation = (typeof MUTATIONS)[number];

export type Empty = Readonly<Record<string, never>>;
export interface ChannelDescription {
	readonly channel: "email" | "chat";
	readonly mutations: readonly Mutation[];
	readonly attachments: boolean;
	readonly listen: boolean;
}
export type SyncRequest =
	| { readonly mode: "initial" | "resync"; readonly since: number; readonly cursor?: string }
	| { readonly mode: "delta"; readonly cursor: string };
export interface SyncPage {
	readonly changes: readonly PluginChange[];
	readonly cursor: string;
	readonly more: boolean;
}

/** Exact provider boundary DATA; the provider reader validates its timestamp semantics. */
export interface SelectedSlackWindow {
	readonly oldest: string;
	readonly latest: string;
	readonly inclusive: boolean;
}
export type SelectedSlackWork =
	| {
			readonly kind: "slack.history";
			readonly channelId: string;
			readonly window: SelectedSlackWindow;
	  }
	| {
			readonly kind: "slack.replies";
			readonly channelId: string;
			readonly threadTs: string;
			readonly window: SelectedSlackWindow;
	  };
export type SelectedContinuation =
	| { readonly state: "more"; readonly cursor: string }
	| { readonly state: "complete" }
	| { readonly state: "truncated"; readonly cursor?: string };
export interface SelectedSyncRequest {
	readonly mode: "selected";
	readonly work: SelectedSlackWork;
	readonly cursor?: string;
}
export interface SelectedSyncPage {
	readonly work: SelectedSlackWork;
	readonly changes: readonly ChatMessageChange[];
	readonly replyCounts: readonly { readonly ts: string; readonly count: number }[];
	readonly continuation: SelectedContinuation;
}
/** Conversation discovery DATA, without membership or other hydrated facts. */
export interface SlackConversationSummary {
	readonly channelId: string;
	readonly type: ChatChannelType;
	readonly name?: string;
}
export const MAX_SLACK_CATALOG_CONVERSATIONS = 999;
export type SelectedSlackCatalogWork =
	| { readonly kind: "slack.catalog" }
	| { readonly kind: "slack.info"; readonly channelId: string };
export type SelectedCatalogSyncRequest =
	| {
			readonly mode: "selected";
			readonly work: Extract<SelectedSlackCatalogWork, { readonly kind: "slack.catalog" }>;
			readonly cursor?: string;
	  }
	| {
			readonly mode: "selected";
			readonly work: Extract<SelectedSlackCatalogWork, { readonly kind: "slack.info" }>;
	  };
export type SelectedCatalogSyncPage =
	| {
			readonly work: Extract<SelectedSlackCatalogWork, { readonly kind: "slack.catalog" }>;
			readonly conversations: readonly SlackConversationSummary[];
			readonly continuation: SelectedContinuation;
	  }
	| {
			readonly work: Extract<SelectedSlackCatalogWork, { readonly kind: "slack.info" }>;
			readonly conversation: ChatConversationChange;
			readonly continuation: { readonly state: "complete" };
	  };
export type ChannelSyncRequest = SyncRequest | SelectedSyncRequest | SelectedCatalogSyncRequest;
export type ChannelSyncPage = SyncPage | SelectedSyncPage | SelectedCatalogSyncPage;

/** Compare validated selectors only; discovery DATA never grants permission to hydrate or read. */
export function selectedSlackCatalogWorkEqual(
	expected: SelectedSlackCatalogWork,
	received: SelectedSlackCatalogWork,
): boolean {
	return (
		expected.kind === received.kind &&
		(expected.kind === "slack.catalog" ||
			(received.kind === "slack.info" && expected.channelId === received.channelId))
	);
}

/** Relate validated result DATA to its work; this establishes no native authority. */
export function selectedSlackCatalogPageMatches(page: SelectedCatalogSyncPage): boolean {
	if ("conversation" in page) return page.conversation.channelId === page.work.channelId;
	return new Set(page.conversations.map((row) => row.channelId)).size === page.conversations.length;
}

/** Compare validated routing DATA only; this establishes neither cursor binding nor authority. */
export function selectedSlackWorkEqual(
	expected: SelectedSlackWork,
	received: SelectedSlackWork,
): boolean {
	return (
		expected.kind === received.kind &&
		expected.channelId === received.channelId &&
		expected.window.oldest === received.window.oldest &&
		expected.window.latest === received.window.latest &&
		expected.window.inclusive === received.window.inclusive &&
		(expected.kind === "slack.history" ||
			(received.kind === "slack.replies" && expected.threadTs === received.threadTs))
	);
}

/** Relate validated count observations to returned roots; this grants no read authority. */
export function selectedSlackReplyCountsMatch(page: SelectedSyncPage): boolean {
	const roots = new Map<string, ChatMessageChange>();
	const duplicates = new Set<string>();
	for (const row of page.changes) {
		if (roots.has(row.ts)) duplicates.add(row.ts);
		else roots.set(row.ts, row);
	}
	const observed = new Set<string>();
	for (const observation of page.replyCounts) {
		if (observed.has(observation.ts) || duplicates.has(observation.ts)) return false;
		observed.add(observation.ts);
		const root = roots.get(observation.ts);
		if (
			root === undefined ||
			root.channelId !== page.work.channelId ||
			(root.threadTs !== undefined && root.threadTs !== root.ts) ||
			(page.work.kind === "slack.replies" && observation.ts !== page.work.threadTs)
		)
			return false;
	}
	return true;
}
export interface Attachment {
	readonly contentType: string;
	readonly size: number;
	readonly content: Bytes;
}
export type MutateRequest =
	| {
			readonly op: "archive" | "unarchive" | "read" | "unread";
			readonly messages: readonly MessageRef[];
	  }
	| {
			readonly op: "label" | "unlabel";
			readonly messages: readonly MessageRef[];
			readonly labelIds: readonly string[];
	  };
export interface SendRequest {
	readonly method: SendMethod;
	readonly url: string;
	readonly contentType: string;
	readonly body: BlobRef;
}
export type ReconcileTarget =
	| { readonly kind: "email"; readonly threadId?: string; readonly rfc822MessageId?: string }
	| { readonly kind: "chat"; readonly channelId: string; readonly threadTs?: string };
export interface ReconcileResult {
	readonly candidates: readonly MessageBody[];
	readonly complete: boolean;
}

export type ChannelV1Tools = {
	readonly channel_describe: ToolContract<Empty, ChannelDescription>;
	readonly channel_probe: ToolContract<Empty, ProbeResult>;
	readonly channel_sync: ToolContract<ChannelSyncRequest, ChannelSyncPage>;
	readonly channel_body_fetch: ToolContract<
		{ readonly message: MessageRef },
		{ readonly message: MessageBody }
	>;
	readonly channel_attachment_fetch: ToolContract<
		{ readonly message: MessageRef; readonly attachmentId: string },
		Attachment
	>;
	readonly channel_mutate: ToolContract<MutateRequest, Empty>;
	readonly channel_send: ToolContract<SendRequest, { readonly message?: MessageRef }>;
	readonly channel_send_reconcile: ToolContract<
		{ readonly attemptAt: number; readonly target: ReconcileTarget },
		ReconcileResult
	>;
	readonly channel_listen: ToolContract<{ readonly leaseMs: number }, { readonly leaseMs: number }>;
};

const empty = z.strictObject({});
const messages = z.array(MessageRef).min(1).max(100);
const leaseMs = z.int().min(1_000).max(MAX_LEASE_MS);

// MCP's tools/list requires an input schema whose root is an object, so unions say so too.
const objectRoot = { type: "object" } as const;

const initialSyncRequest = z.strictObject({
	mode: z.enum(["initial", "resync"]),
	since: UtcMs,
	cursor: Cursor.optional(),
});
const deltaSyncRequest = z.strictObject({ mode: z.literal("delta"), cursor: Cursor });
export const SyncRequest: z.ZodType<SyncRequest> = z
	.discriminatedUnion("mode", [initialSyncRequest, deltaSyncRequest])
	.meta(objectRoot);
export const SyncPage: z.ZodType<SyncPage> = z.strictObject({
	changes: z.array(PluginChange).max(MAX_CHANGES),
	cursor: Cursor,
	more: z.boolean(),
});
export const SelectedSlackWindow: z.ZodType<SelectedSlackWindow> = z.strictObject({
	oldest: ProviderId,
	latest: ProviderId,
	inclusive: z.boolean(),
});
export const SelectedSlackWork: z.ZodType<SelectedSlackWork> = z.discriminatedUnion("kind", [
	z.strictObject({
		kind: z.literal("slack.history"),
		channelId: ProviderId,
		window: SelectedSlackWindow,
	}),
	z.strictObject({
		kind: z.literal("slack.replies"),
		channelId: ProviderId,
		threadTs: ProviderId,
		window: SelectedSlackWindow,
	}),
]);
export const SelectedContinuation: z.ZodType<SelectedContinuation> = z.discriminatedUnion("state", [
	z.strictObject({ state: z.literal("more"), cursor: Cursor }),
	z.strictObject({ state: z.literal("complete") }),
	z.strictObject({ state: z.literal("truncated"), cursor: Cursor.optional() }),
]);
const selectedSyncRequest = z.strictObject({
	mode: z.literal("selected"),
	work: SelectedSlackWork,
	cursor: Cursor.optional(),
});
export const SelectedSyncRequest: z.ZodType<SelectedSyncRequest> = selectedSyncRequest;
export const SelectedSyncPage: z.ZodType<SelectedSyncPage> = z.strictObject({
	work: SelectedSlackWork,
	changes: z.array(ChatMessageChange).max(MAX_CHANGES),
	replyCounts: z
		.array(z.strictObject({ ts: ProviderId, count: z.int().min(0).max(Number.MAX_SAFE_INTEGER) }))
		.max(MAX_CHANGES),
	continuation: SelectedContinuation,
});
export const SlackConversationSummary: z.ZodType<SlackConversationSummary> = z.strictObject({
	channelId: ProviderId,
	type: ChatChannelType,
	name: wellFormedText(256).optional(),
});
const selectedCatalogWork = z.strictObject({ kind: z.literal("slack.catalog") });
const selectedInfoWork = z.strictObject({ kind: z.literal("slack.info"), channelId: ProviderId });
export const SelectedSlackCatalogWork: z.ZodType<SelectedSlackCatalogWork> = z.discriminatedUnion(
	"kind",
	[selectedCatalogWork, selectedInfoWork],
);
export const SelectedCatalogSyncRequest: z.ZodType<SelectedCatalogSyncRequest> = z
	.union([
		z.strictObject({
			mode: z.literal("selected"),
			work: selectedCatalogWork,
			cursor: Cursor.optional(),
		}),
		z.strictObject({ mode: z.literal("selected"), work: selectedInfoWork }),
	])
	.meta(objectRoot);
export const SelectedCatalogSyncPage: z.ZodType<SelectedCatalogSyncPage> = z
	.union([
		z.strictObject({
			work: selectedCatalogWork,
			conversations: z.array(SlackConversationSummary).max(MAX_SLACK_CATALOG_CONVERSATIONS),
			continuation: SelectedContinuation,
		}),
		z.strictObject({
			work: selectedInfoWork,
			conversation: ChatConversationChange,
			continuation: z.strictObject({ state: z.literal("complete") }),
		}),
	])
	.meta(objectRoot);
export const ChannelSyncRequest: z.ZodType<ChannelSyncRequest> = z
	.union([SyncRequest, SelectedSyncRequest, SelectedCatalogSyncRequest])
	.meta(objectRoot);
export const ChannelSyncPage: z.ZodType<ChannelSyncPage> = z
	.union([SyncPage, SelectedSyncPage, SelectedCatalogSyncPage])
	.meta(objectRoot);

export const channelV1: ExtensionContract<ChannelV1Tools> = {
	id: CHANNEL_V1,
	version: 1,
	title: "io.github.draftyak/channel v1",
	path: "schemas/channel-v1.schema.json",
	error: PluginError,
	tools: {
		channel_describe: {
			description: "Which change kinds the channel reports and which optional tools it serves.",
			input: empty,
			output: z.strictObject({
				channel: z.enum(["email", "chat"]),
				mutations: z.array(z.enum(MUTATIONS)).max(MUTATIONS.length),
				attachments: z.boolean(),
				listen: z.boolean(),
			}),
		},
		channel_probe: {
			description: "Checks the account's credentials and reach; returns status, never data.",
			input: empty,
			output: ProbeResult,
		},
		channel_sync: {
			description:
				"One page of changes. initial and resync start at `since`; delta continues from a " +
				"cursor. While `more` is true, call again with the returned cursor and the same mode. " +
				"selected reads one explicit work unit and reports its continuation state.",
			input: ChannelSyncRequest,
			output: ChannelSyncPage,
		},
		channel_body_fetch: {
			description: "One message with its body: an email's RFC 5322 bytes, a chat message's text.",
			input: z.strictObject({ message: MessageRef }),
			output: z.strictObject({ message: MessageBody }),
		},
		channel_attachment_fetch: {
			description: "An attachment's bytes, by the id its message listed.",
			input: z.strictObject({ message: MessageRef, attachmentId: ProviderId }),
			output: z.strictObject({ contentType: MediaType, size: z.int().min(0), content: Bytes }),
			optional: true,
		},
		channel_mutate: {
			description: "Organizes messages at the provider, only as channel_describe lists.",
			input: z
				.discriminatedUnion("op", [
					z.strictObject({ op: z.enum(["archive", "unarchive", "read", "unread"]), messages }),
					z.strictObject({
						op: z.enum(["label", "unlabel"]),
						messages,
						labelIds: z.array(ProviderId).min(1).max(20),
					}),
				])
				.meta(objectRoot),
			output: empty,
			optional: true,
		},
		channel_send: {
			description:
				"Executor only. Transports the hub-rendered request once, through ctx.fetch with its " +
				"Content-Type, the body ref and the ticket from _meta, and returns the provider's id " +
				"for the message.",
			input: z.strictObject({
				method: SendMethod,
				url: SendUrl,
				contentType: ContentType,
				body: BlobRef,
			}),
			output: z.strictObject({ message: MessageRef.optional() }),
			meta: z.looseObject({ [SEND_TICKET_META]: SendTicket }),
		},
		channel_send_reconcile: {
			description:
				"Messages the account sent since the attempt, with their bodies, for the hub to " +
				"match; `complete` is false when the scan stopped early.",
			input: z.strictObject({
				attemptAt: UtcMs,
				target: z.discriminatedUnion("kind", [
					z.strictObject({
						kind: z.literal("email"),
						threadId: ProviderId.optional(),
						rfc822MessageId: z
							.string()
							.max(256)
							.regex(/^<[!-;=?-~]+>$/)
							.optional(),
					}),
					z.strictObject({
						kind: z.literal("chat"),
						channelId: ProviderId,
						threadTs: ProviderId.optional(),
					}),
				]),
			}),
			output: z.strictObject({ candidates: z.array(MessageBody).max(50), complete: z.boolean() }),
		},
		channel_listen: {
			description: "Holds the provider's event connection for the lease and signals host/changed.",
			input: z.strictObject({ leaseMs }),
			output: z.strictObject({ leaseMs }),
			optional: true,
		},
	},
};
