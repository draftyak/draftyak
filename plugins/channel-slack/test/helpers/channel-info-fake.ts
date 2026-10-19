import { createFake, type Fake } from "@draftyak/fakes/server";
import { rawTarget } from "@draftyak/fakes/target";

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
