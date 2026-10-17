// Slack payloads reduced to ids, timestamps and Slack's own enum values before anything leaves the
// spike's modules: no text, names, blocks, files or attachments (guardrail 6). Every field is
// rebuilt from an allowlist and checked against its documented shape; anything else is dropped.

export type ChannelType = "im" | "mpim" | "channel" | "group";
export type Change = "new" | "edited" | "deleted" | "replied";

export interface MessageRef {
	readonly channel: string;
	readonly channelType: ChannelType | null;
	readonly ts: string;
	readonly threadTs: string | null;
	readonly user: string | null;
	readonly subtype: string | null;
	readonly change: Change;
}

export interface EventMeta {
	readonly eventId: string | null;
	readonly eventTime: number | null;
	readonly team: string | null;
}

export type SlackEvent =
	| (EventMeta & MessageRef & { readonly kind: "message" })
	| (EventMeta & { readonly kind: "app_uninstalled" })
	| (EventMeta & {
			readonly kind: "tokens_revoked";
			readonly userTokens: readonly string[];
			readonly botTokens: readonly string[];
	  });

// The message subtypes Slack documents (https://docs.slack.dev/reference/events/message, read
// 2026-10-17); any other value is dropped.
const SUBTYPES: ReadonlySet<string> = new Set(
	[
		"assistant_app_thread bot_message channel_archive channel_convert_to_private",
		"channel_convert_to_public channel_join channel_leave channel_name channel_posting_permissions",
		"channel_purpose channel_topic channel_unarchive document_mention ekm_access_denied",
		"file_comment file_mention file_share group_archive group_join group_leave group_name",
		"group_purpose group_topic group_unarchive me_message message_changed message_deleted",
		"message_replied pinned_item reminder_add reply_broadcast thread_broadcast unpinned_item",
	]
		.join(" ")
		.split(" "),
);

export type Json = Readonly<Record<string, unknown>>;

const ID = /^[A-Z][A-Z0-9]{2,31}$/;
const EVENT_ID = /^Ev[A-Z0-9]{2,30}$/;
const TS = /^\d{1,12}\.\d{1,9}$/;

export function obj(value: unknown): Json | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Json)
		: null;
}

// Slack ids: channels (C, D, G), users (U, W), teams (T), enterprises (E), bots (B).
export function id(value: unknown): string | null {
	return typeof value === "string" && ID.test(value) ? value : null;
}

export function ids(value: unknown): string[] {
	return (Array.isArray(value) ? value.slice(0, 1000) : []).flatMap((item) => id(item) ?? []);
}

const ts = (value: unknown): string | null =>
	typeof value === "string" && TS.test(value) ? value : null;

// Slack timestamps ("1355517523.000005") as exact integers, for ordering.
export function tsKey(value: string): bigint {
	const [seconds = "0", fraction = ""] = value.split(".");
	return BigInt(seconds) * 1_000_000_000n + BigInt(fraction.padEnd(9, "0").slice(0, 9));
}

export function channelType(value: unknown): ChannelType | null {
	return value === "im" || value === "mpim" || value === "channel" || value === "group"
		? value
		: null;
}

// One message from conversations.history or conversations.replies, or inside a message event.
export function messageRef(
	channel: string,
	type: ChannelType | null,
	raw: unknown,
	change: Change = "new",
): MessageRef | null {
	const message = obj(raw);
	const at = ts(message?.ts);
	if (message === null || at === null || id(channel) === null) return null;
	const thread = ts(message.thread_ts);
	const subtype = typeof message.subtype === "string" ? message.subtype : "";
	return {
		channel,
		channelType: type,
		ts: at,
		threadTs: thread !== null && thread !== at ? thread : null,
		user: id(message.user),
		subtype: SUBTYPES.has(subtype) ? subtype : null,
		change,
	};
}

function messageEvent(event: Json): MessageRef | null {
	const channel = id(event.channel);
	if (channel === null) return null;
	const type = channelType(event.channel_type);
	const inner = obj(event.message);
	if (event.subtype === "message_changed") return messageRef(channel, type, inner, "edited");
	if (event.subtype === "message_deleted") {
		const previous = obj(event.previous_message);
		const removed = {
			ts: event.deleted_ts,
			thread_ts: previous?.thread_ts,
			user: previous?.user,
			subtype: previous?.subtype,
		};
		return messageRef(channel, type, removed, "deleted");
	}
	// Over the Events API message_replied arrives without its subtype; its parent is `message`.
	if (event.subtype === "message_replied" || (event.subtype === undefined && inner !== null)) {
		return messageRef(channel, type, inner, "replied");
	}
	return messageRef(channel, type, event, "new");
}

// An Events API payload (the event_callback inside a Socket Mode envelope).
export function reduceEvent(payload: unknown): SlackEvent | null {
	const outer = obj(payload);
	const event = obj(outer?.event);
	if (outer === null || event === null) return null;
	const time = outer.event_time;
	const meta: EventMeta = {
		eventId:
			typeof outer.event_id === "string" && EVENT_ID.test(outer.event_id) ? outer.event_id : null,
		eventTime: typeof time === "number" && Number.isSafeInteger(time) && time >= 0 ? time : null,
		team: id(outer.team_id),
	};
	if (event.type === "app_uninstalled") return { kind: "app_uninstalled", ...meta };
	if (event.type === "tokens_revoked") {
		const tokens = obj(event.tokens);
		return {
			kind: "tokens_revoked",
			...meta,
			userTokens: ids(tokens?.oauth),
			botTokens: ids(tokens?.bot),
		};
	}
	if (event.type !== "message") return null;
	const ref = messageEvent(event);
	return ref === null ? null : { kind: "message", ...meta, ...ref };
}
