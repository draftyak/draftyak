import { isProxy } from "node:util/types";
import { type SlackChatFacts, slackChatFacts } from "./preflight.ts";
import { boolean, channelId, invalid } from "./validation.ts";

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

/** Projects explicit conversations.info facts; it attests neither freshness nor posting authority. */
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
		const id = channelId(own(value, "id")),
			name = own(value, "name"),
			isChannel = boolean(own(value, "is_channel")),
			isGroup = boolean(own(value, "is_group")),
			isIm = boolean(own(value, "is_im")),
			isMpim = boolean(own(value, "is_mpim")),
			isPrivate = boolean(own(value, "is_private")),
			isArchived = boolean(own(value, "is_archived")),
			isShared = boolean(own(value, "is_shared")),
			isExternal = boolean(own(value, "is_ext_shared")),
			isOrgShared = boolean(own(value, "is_org_shared")),
			isPendingExternal = boolean(own(value, "is_pending_ext_shared")),
			isMember = boolean(own(value, "is_member")),
			memberCount = own(value, "num_members"),
			isExternalWorkspace = optionalFlag(value, "is_ext_ws_shared");
		if (
			id !== expected ||
			Number(isChannel) + Number(isGroup) + Number(isIm) + Number(isMpim) !== 1 ||
			(!isPrivate && (isGroup || isIm || isMpim)) ||
			((isExternal || isOrgShared) && !isShared) ||
			(isExternalWorkspace === true && (!isExternal || !isShared)) ||
			isPendingExternal
		)
			invalid();
		// These states cannot be represented by SlackChatFacts; never silently erase a restriction.
		for (const key of ["is_frozen", "is_read_only", "is_thread_only"])
			if (optionalFlag(value, key) === true) invalid();
		return slackChatFacts({
			id,
			type: isIm ? "dm" : isMpim ? "group_dm" : isPrivate ? "private" : "public",
			name,
			isArchived,
			isShared,
			isExternal,
			isMember,
			memberCount,
		});
	} catch {
		return invalid();
	}
}
