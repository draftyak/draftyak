import {
	CHAT_CHANNEL_TYPES,
	type ChatChannelType,
	type ChatConversationChange,
} from "@draftyak/protocol/normalized-change";
import type { SnapshotChat } from "@draftyak/protocol/snapshot";
import {
	boolean,
	channelId,
	data,
	hasControls,
	integer,
	invalid,
	keys,
	slackTimestamp,
	text,
	tsKey,
} from "./validation.ts";

export type SlackChannelType = ChatChannelType;

export interface SlackChatFacts extends Omit<ChatConversationChange, "kind" | "name"> {
	readonly name?: string | null;
	readonly pendingExternal?: boolean;
}

export type SlackPreflightResult =
	| { readonly state: "ALLOW" }
	| { readonly state: "NEEDS_REAPPROVAL"; readonly reason: "channel_changed" | "new_reply" };

export function slackChatFacts(input: unknown): SlackChatFacts {
	const value = data(input);
	keys(value, [
		"channelId",
		"type",
		"name",
		"archived",
		"external",
		"shared",
		"member",
		"memberCount",
		"pendingExternal",
	]);
	const type = value.type;
	if (!CHAT_CHANNEL_TYPES.some((candidate) => candidate === type)) invalid();
	const direct = type === "dm" || type === "group_dm";
	const name =
		direct && (value.name === null || !Object.hasOwn(value, "name")) ? null : text(value.name, 256);
	if (name !== null && ((!direct && !name) || hasControls(name))) invalid();
	const pendingExternal = Object.hasOwn(value, "pendingExternal")
		? boolean(value.pendingExternal)
		: undefined;
	return Object.freeze({
		channelId: channelId(value.channelId),
		type: type as ChatChannelType,
		name,
		archived: boolean(value.archived),
		external: boolean(value.external),
		shared: boolean(value.shared),
		member: boolean(value.member),
		memberCount: integer(value.memberCount, 1_000_000_000),
		...(pendingExternal === undefined ? {} : { pendingExternal }),
	});
}

function approvedChat(input: unknown): SnapshotChat & { readonly shared: boolean } {
	const value = data(input);
	keys(value, [
		"channelId",
		"channelName",
		"channelType",
		"external",
		"shared",
		"memberCount",
		"threadTs",
		"broadcast",
	]);
	const type = value.channelType;
	if (!CHAT_CHANNEL_TYPES.some((candidate) => candidate === type)) invalid();
	const channelName = text(value.channelName, 256);
	if ((type !== "dm" && type !== "group_dm" && !channelName) || hasControls(channelName)) invalid();
	const threadTs = Object.hasOwn(value, "threadTs") ? slackTimestamp(value.threadTs) : undefined;
	const broadcast = boolean(value.broadcast);
	if (broadcast && threadTs === undefined) invalid();
	return {
		channelId: channelId(value.channelId),
		channelName,
		channelType: type as ChatChannelType,
		external: boolean(value.external),
		shared: boolean(value.shared),
		memberCount: integer(value.memberCount, 1_000_000_000),
		...(threadTs === undefined ? {} : { threadTs }),
		broadcast,
	};
}

export function checkSlackPreflight(input: unknown): SlackPreflightResult {
	const value = data(input);
	keys(value, [
		"approved",
		"current",
		"holdIfReply",
		"approvedInboundWatermark",
		"currentInboundWatermark",
	]);
	const before = approvedChat(value.approved);
	const after = slackChatFacts(value.current);
	const hold = boolean(value.holdIfReply);
	const oldWatermark =
		value.approvedInboundWatermark === null ? null : slackTimestamp(value.approvedInboundWatermark);
	const newWatermark =
		value.currentInboundWatermark === null ? null : slackTimestamp(value.currentInboundWatermark);
	const growth = after.memberCount - before.memberCount;
	const channel = after.type === "public" || after.type === "private";
	if (
		before.channelId !== after.channelId ||
		before.channelType !== after.type ||
		(channel && before.channelName !== after.name) ||
		after.archived ||
		(!before.external && after.external) ||
		(!before.shared && after.shared) ||
		after.pendingExternal === true ||
		!after.member ||
		(channel && growth >= 3 && growth * 10 > before.memberCount)
	) {
		return { state: "NEEDS_REAPPROVAL", reason: "channel_changed" };
	}
	if (
		hold &&
		newWatermark !== null &&
		(oldWatermark === null || tsKey(newWatermark) > tsKey(oldWatermark))
	) {
		return { state: "NEEDS_REAPPROVAL", reason: "new_reply" };
	}
	return { state: "ALLOW" };
}
