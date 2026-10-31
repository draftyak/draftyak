import { isProxy } from "node:util/types";
import { type SlackChatFacts, slackChatFacts } from "./preflight.ts";
import { boolean, channelId, integer, invalid } from "./validation.ts";

function object(value: unknown): object {
	if (!value || typeof value !== "object" || isProxy(value) || Array.isArray(value)) invalid();
	const prototype: unknown = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) invalid();
	return value;
}

function own(value: object, key: string): unknown {
	const descriptor = Object.getOwnPropertyDescriptor(value, key);
	if (!descriptor?.enumerable || !("value" in descriptor)) invalid();
	return descriptor.value;
}

function optionalFlag(value: object, key: string): boolean | undefined {
	if (!Object.hasOwn(value, key)) return undefined;
	return boolean(own(value, key));
}

function optionalValue(value: object, key: string): unknown {
	return Object.hasOwn(value, key) ? own(value, key) : undefined;
}

/**
 * Projects a successful bounded owner's-token conversations.info read supplied by the caller.
 * That caller precondition supplies omitted direct-conversation membership; this helper
 * requires explicit sharing flags even for direct conversations. It performs no
 * authentication and attests neither freshness nor posting authority.
 */
export function decodeSlackChannelFacts(
	expectedChannelId: unknown,
	response: unknown,
): SlackChatFacts {
	try {
		const expected = channelId(expectedChannelId),
			envelope = object(response);
		if (own(envelope, "ok") !== true) invalid();
		const value = object(own(envelope, "channel"));
		// Fixed descriptor reads bound the projection and leave message/topic/identity branches unread.
		optionalFlag(value, "is_channel");
		const id = channelId(own(value, "id")),
			isGroup = optionalFlag(value, "is_group"),
			isIm = optionalFlag(value, "is_im"),
			isMpim = optionalFlag(value, "is_mpim"),
			isPrivate = optionalFlag(value, "is_private"),
			type = isIm ? "dm" : isMpim ? "group_dm" : isPrivate || isGroup ? "private" : "public",
			direct = type === "dm" || type === "group_dm",
			isArchived = direct
				? (optionalFlag(value, "is_archived") ?? false)
				: boolean(own(value, "is_archived")),
			isShared = boolean(own(value, "is_shared")),
			isExternal = boolean(own(value, "is_ext_shared")),
			isOrgShared = boolean(own(value, "is_org_shared")),
			isPendingExternal = boolean(own(value, "is_pending_ext_shared")),
			isMember = direct
				? (optionalFlag(value, "is_member") ?? true)
				: boolean(own(value, "is_member")),
			name = direct && !Object.hasOwn(value, "name") ? null : own(value, "name"),
			rawCount = direct ? optionalValue(value, "num_members") : own(value, "num_members"),
			isExternalWorkspace = optionalFlag(value, "is_ext_ws_shared");
		if (
			id !== expected ||
			((isExternal || isOrgShared) && !isShared) ||
			(isExternalWorkspace === true && (!isExternal || !isShared))
		)
			invalid();
		// Validate a supplied count even though an IM always has exactly two participants.
		if (rawCount !== undefined) integer(rawCount, 1_000_000_000);
		else if (Object.hasOwn(value, "num_members")) invalid();
		// These states cannot be represented by SlackChatFacts; never silently erase a restriction.
		for (const key of ["is_frozen", "is_read_only", "is_thread_only"])
			if (optionalFlag(value, key) === true) invalid();
		return slackChatFacts({
			channelId: id,
			type,
			name,
			archived: isArchived,
			external: isExternal,
			shared: isShared,
			member: isMember,
			memberCount: type === "dm" ? 2 : (rawCount ?? 0),
			pendingExternal: isPendingExternal,
		});
	} catch {
		return invalid();
	}
}
