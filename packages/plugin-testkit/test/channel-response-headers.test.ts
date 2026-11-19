import { createFake } from "@draftyak/fakes";
import { expect, it } from "vitest";
import { createMockHub } from "../src/index.ts";
import { channelFixture } from "./fixtures/channel/plugin.ts";

const url = "https://hello.draftyak.example/v1/conversations";
const httpDate = "Wed, 21 Oct 2015 07:28:00 GMT";
const cases = [403, 429].flatMap((status) =>
	["0", "17", httpDate].map((retryAfter) => ({ status, retryAfter })),
);

it.each(cases)(
	"preserves Retry-After $retryAfter on served channel $status responses",
	async ({ status, retryAfter }) => {
		const fake = createFake(
			{
				fetch: () =>
					new Response("{}", {
						status,
						headers: {
							"Content-Type": "application/json",
							"Content-Length": "2",
							ETag: '"fixture"',
							"Last-Modified": httpDate,
							"Retry-After": retryAfter,
							Authorization: "fixture-only",
							"Set-Cookie": "fixture=1",
							"X-Private": "fixture-only",
						},
					}),
			},
			{ host: "hello.draftyak.example" },
		);
		const hub = createMockHub({
			mode: "in-memory",
			plugin: channelFixture(),
			upstreams: [fake],
		});
		let result: Record<string, unknown>;
		try {
			result = await hub.call("channel_fetch", { url });
		} finally {
			await hub.close();
		}
		expect(result.structuredContent).toEqual({
			status,
			headers: {
				"content-type": "application/json",
				"content-length": "2",
				etag: '"fixture"',
				"last-modified": httpDate,
				"retry-after": retryAfter,
			},
			text: "{}",
		});
	},
);
