import { isProxy } from "node:util/types";
import { wellFormedText } from "@draftyak/protocol/extension";
import {
	type ChatChannelType,
	type ChatConversationChange,
	PluginChange,
} from "@draftyak/protocol/normalized-change";

/** The documented maximum users.conversations page size; these are discovery data, not changes. */
export const MAX_SLACK_CONVERSATIONS_PER_PAGE = 999;

export interface SlackConversationSummary {
	readonly channelId: string;
	readonly type: ChatChannelType;
	readonly name?: string;
}

export interface SlackConversationListPage {
	readonly conversations: readonly SlackConversationSummary[];
	readonly nextCursor: string | undefined;
	readonly more: boolean;
}

const TYPE_KEYS = ["id", "name", "is_im", "is_mpim", "is_private", "is_channel", "is_group"];
const FACT_KEYS = [
	...TYPE_KEYS,
	"is_member",
	"is_archived",
	"is_shared",
	"is_ext_shared",
	"is_org_shared",
	"is_pending_ext_shared",
	"num_members",
];
const NAME = wellFormedText(256);

function invalid(): never {
	throw new Error("SLACK_CONVERSATIONS_INVALID");
}

// Fixed descriptor reads leave all unselected provider branches unread.
function record(
	raw: unknown,
	keys: readonly string[],
	unsupported: readonly string[] = [],
): Record<string, unknown> {
	if (raw === null || typeof raw !== "object" || isProxy(raw)) invalid();
	const prototype = Object.getPrototypeOf(raw);
	if (prototype !== null && prototype !== Object.prototype) invalid();
	for (const key of unsupported) {
		if (Object.getOwnPropertyDescriptor(raw, key) !== undefined) invalid();
	}
	const result: Record<string, unknown> = Object.create(null);
	for (const key of keys) {
		const descriptor = Object.getOwnPropertyDescriptor(raw, key);
		if (descriptor === undefined) continue;
		if (!descriptor.enumerable || !("value" in descriptor)) invalid();
		result[key] = descriptor.value;
	}
	return result;
}

function channels(raw: unknown): readonly unknown[] {
	if (raw === null || typeof raw !== "object" || isProxy(raw) || !Array.isArray(raw)) invalid();
	if (Object.getPrototypeOf(raw) !== Array.prototype) invalid();
	const length = Object.getOwnPropertyDescriptor(raw, "length")?.value;
	if (!Number.isSafeInteger(length) || length < 0 || length > MAX_SLACK_CONVERSATIONS_PER_PAGE)
		invalid();
	if (Reflect.ownKeys(raw).length !== length + 1) invalid();
	const result: unknown[] = [];
	for (let at = 0; at < length; at++) {
		const descriptor = Object.getOwnPropertyDescriptor(raw, String(at));
		if (!descriptor?.enumerable || !("value" in descriptor)) invalid();
		result.push(descriptor.value);
	}
	return result;
}

function boolean(raw: unknown): boolean {
	if (typeof raw !== "boolean") invalid();
	return raw;
}

function ascii(raw: unknown, maximum: number, empty = false): string {
	if (typeof raw !== "string" || raw.length > maximum || (!empty && raw.length === 0)) invalid();
	for (let at = 0; at < raw.length; at++) {
		const code = raw.charCodeAt(at);
		if (code < 33 || code > 126) invalid();
	}
	return raw;
}

function summary(data: Record<string, unknown>): SlackConversationSummary {
	const channelId = ascii(data.id, 256);
	for (const key of ["is_im", "is_mpim", "is_private", "is_channel", "is_group"]) {
		if (Object.hasOwn(data, key)) boolean(data[key]);
	}
	const im = data.is_im === true;
	const mpim = data.is_mpim === true;
	if (
		(im && mpim) ||
		((im || mpim) && data.is_channel === true) ||
		(im && data.is_group === true) ||
		(data.is_channel === true && data.is_group === true)
	) {
		invalid();
	}
	let type: ChatChannelType;
	if (im || mpim) {
		// Minimal DM list objects may omit the other flags, but explicit public contradicts a DM.
		if (data.is_private === false) invalid();
		type = im ? "dm" : "group_dm";
	} else {
		if (typeof data.is_private !== "boolean") invalid();
		if (data.is_channel !== true && data.is_group !== true) invalid();
		if (data.is_group === true && !data.is_private) invalid();
		// Both modern channels and legacy private groups carry usable type data.
		type = data.is_private ? "private" : "public";
	}
	let name: string | undefined;
	if (data.name !== undefined) {
		if (typeof data.name !== "string" || data.name.length > 512) invalid();
		const parsed = NAME.safeParse(data.name);
		if (!parsed.success) invalid();
		name = parsed.data;
	}
	return Object.freeze({ channelId, type, ...(name === undefined ? {} : { name }) });
}

function continuation(page: Record<string, unknown>): {
	nextCursor: string | undefined;
	more: boolean;
} {
	let observed = false;
	let hasMore = false;
	if (Object.hasOwn(page, "has_more")) {
		hasMore = boolean(page.has_more);
		observed = true;
	}
	let nextCursor: string | undefined;
	if (Object.hasOwn(page, "response_metadata")) {
		const metadata = record(page.response_metadata, ["next_cursor"]);
		if (Object.hasOwn(metadata, "next_cursor")) {
			const value = ascii(metadata.next_cursor, 4_096, true);
			nextCursor = value === "" ? undefined : value;
			observed = true;
		}
	}
	// Row count or omitted metadata never proves complete coverage.
	if (!observed) invalid();
	return { nextCursor, more: hasMore || nextCursor !== undefined };
}

/**
 * Decode users.conversations discovery data, which omits membership/count facts.
 * The result is not a normalized change or an authorization to read a conversation.
 */
export function reduceConversationListPage(input: unknown): SlackConversationListPage {
	try {
		const page = record(input, ["ok", "channels", "has_more", "response_metadata"], ["error"]);
		if (page.ok !== true) invalid();
		const position = continuation(page);
		const conversations: SlackConversationSummary[] = [];
		const ids = new Set<string>();
		for (const raw of channels(page.channels)) {
			const item = summary(record(raw, TYPE_KEYS));
			if (ids.has(item.channelId)) invalid();
			ids.add(item.channelId);
			conversations.push(item);
		}
		return Object.freeze({ conversations: Object.freeze(conversations), ...position });
	} catch {
		invalid();
	}
}

/** Decode a hydrated conversations.info response only when every normalized fact is observed. */
export function reduceConversationInfo(input: unknown): ChatConversationChange {
	try {
		const envelope = record(input, ["ok", "channel"], ["error"]);
		if (envelope.ok !== true) invalid();
		const data = record(envelope.channel, FACT_KEYS);
		const item = summary(data);
		const member = boolean(data.is_member);
		const archived = boolean(data.is_archived);
		const shared = boolean(data.is_shared);
		const external = boolean(data.is_ext_shared);
		if (external && !shared) invalid();
		if (Object.hasOwn(data, "is_org_shared") && boolean(data.is_org_shared) && !shared) invalid();
		// A pending external state cannot be represented as a confirmed normalized fact.
		if (Object.hasOwn(data, "is_pending_ext_shared") && boolean(data.is_pending_ext_shared))
			invalid();
		if (
			typeof data.num_members !== "number" ||
			!Number.isSafeInteger(data.num_members) ||
			data.num_members < 0
		)
			invalid();
		const parsed = PluginChange.safeParse({
			kind: "chat.conversation",
			...item,
			external,
			shared,
			memberCount: data.num_members,
			archived,
			member,
		});
		if (!parsed.success || parsed.data.kind !== "chat.conversation") invalid();
		return Object.freeze(parsed.data);
	} catch {
		invalid();
	}
}
