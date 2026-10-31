import { createFake, type Fake } from "@draftyak/fakes/server";
import { rawTarget } from "@draftyak/fakes/target";
import type { SnapshotChat } from "@draftyak/protocol/snapshot";
import type { SlackChatFacts } from "../../../src/channels/slack/index.ts";

/** Invented values in the documented sparse IM object shape. */
export function sparseIm(id: string): Record<string, unknown> {
	return { id, is_im: true, is_org_shared: false, user: "U0DYTEST1", is_open: true };
}

/** Invented MPIM: both legacy group and MPIM flags, without a member count. */
export function sparseMpim(id: string): Record<string, unknown> {
	return {
		id,
		name: "mpdm-dytest-team",
		is_group: true,
		is_mpim: true,
		is_private: true,
		is_open: true,
	};
}

/** A synthetic direct response with explicit sharing evidence for each selected flag. */
export function explicitSharing(value: Record<string, unknown>): Record<string, unknown> {
	return {
		is_shared: false,
		is_ext_shared: false,
		is_org_shared: false,
		is_pending_ext_shared: false,
		...value,
	};
}

/** A test-only frozen chat fixture using only fields that the snapshot actually carries. */
export function frozenChat(facts: SlackChatFacts): SnapshotChat {
	return Object.freeze({
		channelId: facts.channelId,
		channelName: facts.name ?? "",
		channelType: facts.type,
		external: facts.external,
		shared: facts.shared,
		memberCount: facts.memberCount,
		broadcast: false,
	});
}

export interface ChannelInfoFixture {
	/** Synthetic fixture label, never an authenticated native identity. */
	readonly account: string;
	readonly target: string;
	readonly fake: Fake;
	setChannel(channel: Readonly<Record<string, unknown>>): void;
}

/** A test-only conversations.info response fixture over the existing loopback fake server. */
export function createChannelInfoFixture(options: {
	readonly account: string;
	readonly expectedChannelId: string;
	readonly channel: Readonly<Record<string, unknown>>;
}): ChannelInfoFixture {
	const target = `/api/conversations.info?channel=${encodeURIComponent(options.expectedChannelId)}&include_num_members=true`;
	let body = JSON.stringify({ ok: true, channel: options.channel });
	const fake = createFake(
		{
			fetch(request) {
				if (request.method !== "GET" || new URL(request.url).pathname !== "/api/conversations.info")
					return Response.json({ ok: false, error: "unknown_method" }, { status: 404 });
				if (rawTarget(request) !== target)
					return Response.json({ ok: false, error: "invalid_arguments" }, { status: 400 });
				return new Response(body, { headers: { "content-type": "application/json" } });
			},
		},
		{ host: "slack.draftyak.example" },
	);
	return Object.freeze({
		account: options.account,
		target,
		fake,
		setChannel(channel: Readonly<Record<string, unknown>>): void {
			body = JSON.stringify({ ok: true, channel });
		},
	});
}
