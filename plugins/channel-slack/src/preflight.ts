import { CHAT_CHANNEL_TYPES, type ChatChannelType } from "@draftyak/protocol/normalized-change";
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

export interface SlackChatFacts {
	readonly id: string;
	readonly type: SlackChannelType;
	readonly name: string;
	readonly isArchived: boolean;
	readonly isShared: boolean;
	readonly isExternal: boolean;
	readonly isMember: boolean;
	readonly memberCount: number;
}

export type SlackPreflightResult =
	| { readonly state: "ALLOW" }
	| { readonly state: "NEEDS_REAPPROVAL"; readonly reason: "channel_changed" | "new_reply" };

export function slackChatFacts(input: unknown): SlackChatFacts {
	const value = data(input);
	keys(value, [
		"id",
		"type",
		"name",
		"isArchived",
		"isShared",
		"isExternal",
		"isMember",
		"memberCount",
	]);
	const type = value.type;
	if (!CHAT_CHANNEL_TYPES.some((candidate) => candidate === type)) invalid();
	const name = text(value.name, 256);
	if (!name || hasControls(name)) invalid();
	return Object.freeze({
		id: channelId(value.id),
		type: type as ChatChannelType,
		name,
		isArchived: boolean(value.isArchived),
		isShared: boolean(value.isShared),
		isExternal: boolean(value.isExternal),
		isMember: boolean(value.isMember),
		memberCount: integer(value.memberCount, 1_000_000_000),
	});
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
	const before = slackChatFacts(value.approved);
	const after = slackChatFacts(value.current);
	const hold = boolean(value.holdIfReply);
	const oldWatermark =
		value.approvedInboundWatermark === null ? null : slackTimestamp(value.approvedInboundWatermark);
	const newWatermark =
		value.currentInboundWatermark === null ? null : slackTimestamp(value.currentInboundWatermark);
	const growth = after.memberCount - before.memberCount;
	if (
		before.id !== after.id ||
		before.type !== after.type ||
		before.name !== after.name ||
		after.isArchived ||
		(!before.isShared && after.isShared) ||
		(!before.isExternal && after.isExternal) ||
		!after.isMember ||
		(growth >= 3 && growth * 10 > before.memberCount)
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
