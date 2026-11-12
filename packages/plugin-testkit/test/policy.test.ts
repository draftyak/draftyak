import { createFake, createHelloFake, createToolUpstream } from "@draftyak/fakes";
import { afterEach, expect, it } from "vitest";
import { createMockHub, type MockHub, type MockPlugin } from "../src/index.ts";
import { channelFixture } from "./fixtures/channel/plugin.ts";
import { toolFixture } from "./fixtures/tool/plugin.ts";

const hubs: MockHub[] = [];
const track = (hub: MockHub): MockHub => {
	hubs.push(hub);
	return hub;
};
afterEach(async () => {
	await Promise.all(hubs.splice(0).map((hub) => hub.close()));
});

it("records host denials even when shared parameter validation refuses before the handler", async () => {
	const fake = createHelloFake();
	const hub = track(
		createMockHub({ mode: "in-memory", plugin: channelFixture(), upstreams: [fake] }),
	);
	await expect(
		hub.host.request("host/fetch", {
			url: "https://hello.draftyak.example/v1/conversations",
			method: "GET",
			headers: [],
			extra: true,
		} as never),
	).rejects.toThrow("BAD_REQUEST");
	expect(hub.host.denials).toEqual([
		{ sequence: 0, method: "host/fetch", reason: "BAD_REQUEST", lookup: null },
	]);
	expect(fake.recorder.takeRequests()).toEqual([]);
});
it.each([
	"http://hello.draftyak.example/v1/conversations",
	"https://hello.draftyak.example:443/v1/conversations",
	"https://user@hello.draftyak.example/v1/conversations",
	"https://hello.draftyak.example/v1/../v1/conversations",
	"https://hello.draftyak.example/v1/%63onversations",
	"https://hello.draftyak.example/v1/conversations?unknown=1",
	"https://hello.draftyak.example/v1/conversations?$alt=1",
	"https://other.example/v1/conversations",
	"https://hello.draftyak.example/v1/conversations#fragment",
])("denies noncanonical or unmatched channel URL %s before fake dispatch", async (url) => {
	const fake = createHelloFake();
	const hub = track(
		createMockHub({ mode: "in-memory", plugin: channelFixture(), upstreams: [fake] }),
	);
	await expect(hub.host.request("host/fetch", { url, method: "GET", headers: [] })).rejects.toThrow(
		"DENIED",
	);
	expect(hub.host.denials.at(-1)?.reason).toBe("OFF_RULE");
	expect(fake.recorder.takeRequests()).toEqual([]);
});
it("strips client authentication and method overrides from admitted channel reads", async () => {
	let received: Headers | undefined;
	const fake = createFake(
		{
			fetch: (request) => {
				received = new Headers(request.headers);
				return new Response("{}");
			},
		},
		{ host: "hello.draftyak.example" },
	);
	const hub = track(
		createMockHub({ mode: "in-memory", plugin: channelFixture(), upstreams: [fake] }),
	);
	await hub.host.request("host/fetch", {
		url: "https://hello.draftyak.example/v1/conversations?cursor=",
		method: "GET",
		headers: [
			["Authorization", "synthetic"],
			["X-HTTP-Method-Override", "POST"],
			["Accept", "application/json"],
		],
	});
	expect(received?.has("authorization")).toBe(false);
	expect(received?.has("x-http-method-override")).toBe(false);
	expect(received?.get("accept")).toBe("application/json");
});
it("requires account full mode for organize and retains the admitted positive control", async () => {
	const fake = createFake({ fetch: () => new Response("{}") }, { host: "hello.draftyak.example" });
	const account = "00000000000000000000000002";
	for (const mode of ["read_only", "full"] as const) {
		const hub = track(
			createMockHub({
				mode: "in-memory",
				plugin: channelFixture(undefined, account),
				account: { id: account, mode },
				upstreams: [fake],
			}),
		);
		const request = hub.host.request("host/fetch", {
			url: "https://hello.draftyak.example/v1/conversations/conv-1",
			method: "PATCH",
			headers: [],
		});
		if (mode === "read_only") {
			await expect(request).rejects.toThrow("DENIED");
			expect(hub.host.denials[0]?.reason).toBe("FULL_MODE_REQUIRED");
		} else expect((await request).status).toBe(200);
	}
	expect(fake.recorder.takeRequests()).toHaveLength(1);
});
it.each(["/extra", "?extra=1", "#extra", "/%40", "/%2540", "/.."])(
	"refuses added secret-reference syntax %s without reaching the fake",
	async (suffix) => {
		const fake = createToolUpstream();
		const plugin = toolFixture(async (_args, context) => {
			await context.fetch(`secret://calendarUrl${suffix}`);
			return { entries: [] };
		});
		const hub = track(
			createMockHub({
				mode: "in-memory",
				plugin,
				upstreams: [fake],
				secrets: { calendarUrl: fake.secretUrl },
			}),
		);
		expect((await hub.call("kb.lookup", { topic: "test" })).isError).toBe(true);
		expect(hub.host.denials.at(-1)?.reason).toBe("OFF_RULE");
		expect(fake.recorder.takeRequests()).toEqual([]);
	},
);
it.each(["POST", "saveAs", "ws", "changed", "progress"])(
	"refuses the tool host operation %s before upstream dispatch",
	async (operation) => {
		const fake = createToolUpstream();
		const plugin = toolFixture(async (_args, context) => {
			if (operation === "ws") await context.ws.open("wss://other.example/");
			else if (operation === "changed") await context.changed();
			else if (operation === "progress") await context.progress("token", 1);
			else
				await context.fetch(
					"secret://calendarUrl",
					operation === "POST" ? { method: "POST" } : { saveAs: "blob" },
				);
			return { entries: [] };
		});
		const hub = track(
			createMockHub({
				mode: "in-memory",
				plugin,
				upstreams: [fake],
				secrets: { calendarUrl: fake.secretUrl },
			}),
		);
		expect((await hub.call("kb.lookup", { topic: "test" })).isError).toBe(true);
		expect(hub.host.denials).toHaveLength(1);
		expect(fake.recorder.takeRequests()).toEqual([]);
	},
);
it("strips tool request headers and permits conditional GET/304 without a body", async () => {
	const fake = createToolUpstream();
	let etag: string | null = null;
	const received: Headers[] = [];
	const upstream = {
		...fake,
		fetch: (...args: Parameters<typeof fake.fetch>) => {
			received.push(new Headers(args[1]?.headers));
			return fake.fetch(...args);
		},
	};
	const plugin = toolFixture(async (_args, context) => {
		const first = await context.fetch("secret://calendarUrl", {
			headers: {
				Accept: "text/calendar",
				Authorization: "synthetic",
				"X-HTTP-Method-Override": "POST",
			},
		});
		etag = first.headers.get("etag");
		await first.arrayBuffer();
		const next = await context.fetch("secret://calendarUrl", {
			headers: { "If-None-Match": etag ?? "" },
		});
		return { entries: [{ label: String(next.status), text: await next.text() }] };
	});
	const hub = track(
		createMockHub({
			mode: "in-memory",
			plugin,
			upstreams: [upstream],
			secrets: { calendarUrl: fake.secretUrl },
		}),
	);
	expect((await hub.call("kb.lookup", { topic: "test" })).structuredContent).toEqual({
		entries: [{ label: "304", text: "" }],
	});
	const requests = fake.recorder.takeRequests();
	expect(requests).toHaveLength(2);
	expect(received[0]?.has("authorization")).toBe(false);
	expect(received[0]?.has("x-http-method-override")).toBe(false);
	expect(received[1]?.get("if-none-match")).toBe(etag);
});
it("denies undeclared storage objects and never dispatches them as ordinary raw blobs", async () => {
	const fake = createHelloFake();
	const hub = track(
		createMockHub({ mode: "in-memory", plugin: channelFixture(), upstreams: [fake] }),
	);
	await expect(
		hub.host.request("host/fetch", {
			url: "https://hello.draftyak.example/v1/conversations",
			method: "GET",
			headers: [],
			saveAs: { kind: "unavailable" },
		} as never),
	).rejects.toThrow("BAD_REQUEST");
	expect(fake.recorder.takeRequests()).toEqual([]);
});
function profiled(profile: "gmail-v1" | "gmail-readonly-v1" | "slack-v1"): MockPlugin {
	const plugin = channelFixture();
	const value = plugin.manifest as Record<string, unknown>;
	value.egress = { profile };
	value.dataClasses = [profile.startsWith("gmail") ? "gmail.content" : "slack.content"];
	if (profile === "gmail-readonly-v1") delete value.send;
	else value.send = { render: profile === "gmail-v1" ? "gmail-rfc5322" : "slack-postmessage" };
	return plugin;
}
it.each([
	["gmail-v1", "gmail.googleapis.com", "/gmail/v1/users/me/messages", "/batch/gmail/v1"],
	[
		"gmail-readonly-v1",
		"gmail.googleapis.com",
		"/gmail/v1/users/me/history",
		"/upload/gmail/v1/users/me/messages/send",
	],
	["slack-v1", "slack.com", "/api/conversations.history", "/api/chat.scheduledMessages.list"],
] as const)(
	"matches %s read allowlists and denies unlisted provider endpoints",
	async (profile, host, allowed, refused) => {
		const fake = createFake({ fetch: () => new Response("{}") }, { host });
		const hub = track(
			createMockHub({ mode: "in-memory", plugin: profiled(profile), upstreams: [fake] }),
		);
		expect(
			(
				await hub.host.request("host/fetch", {
					method: "GET",
					url: `https://${host}${allowed}`,
					headers: [],
				})
			).status,
		).toBe(200);
		await expect(
			hub.host.request("host/fetch", {
				method: "GET",
				url: `https://${host}${refused}`,
				headers: [],
			}),
		).rejects.toThrow("DENIED");
		await expect(
			hub.host.request("host/fetch", {
				method: "GET",
				url: `https://${host}:8443${allowed}`,
				headers: [],
			}),
		).rejects.toThrow("DENIED");
		expect(fake.recorder.takeRequests()).toHaveLength(1);
	},
);
