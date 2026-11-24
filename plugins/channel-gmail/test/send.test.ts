import { createFake } from "@draftyak/fakes";
import { createMockHub, type MockHub } from "@draftyak/plugin-testkit";
import { CHANNEL_V1, type SendRequest } from "@draftyak/protocol/channel-v1";
import { MAX_INLINE_BYTES } from "@draftyak/protocol/normalized-change";
import { SEND_TICKET_META, type SendTicket } from "@draftyak/protocol/send-ticket";
import { defineChannelPlugin, HostError, PluginError } from "@draftyak/sdk";
import { afterEach, describe, expect, it } from "vitest";
import { gmailSend } from "../src/send.ts";

const url =
	"https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send?uploadType=multipart";
const contentType = "multipart/related; boundary=DYTEST_unchanged";
const providerId = "DYTEST-sent-1";
const hubs: MockHub[] = [];

afterEach(async () => {
	await Promise.all(hubs.splice(0).map((hub) => hub.close()));
});

function field(value: unknown, name: string): unknown {
	return value !== null && typeof value === "object"
		? Object.getOwnPropertyDescriptor(value, name)?.value
		: undefined;
}

function errorCode(result: unknown): unknown {
	return field(field(result, "structuredContent"), "code");
}

function isUncertain(result: unknown): boolean {
	return field(result, "isError") === true && errorCode(result) === "SEND_UNCERTAIN";
}

function sameBytes(actual: Uint8Array | undefined, expected: Uint8Array): boolean {
	if (actual === undefined || actual.length !== expected.length) return false;
	return expected.every((value, index) => actual[index] === value);
}

interface SendFixture {
	readonly hub: MockHub;
	readonly request: SendRequest;
	readonly ticket: SendTicket;
	readonly observed: {
		calls: number;
		method: string | undefined;
		url: string | undefined;
		contentType: string | null | undefined;
		approvedHeader: string | null | undefined;
		body: Uint8Array | undefined;
	};
	call(): Promise<Record<string, unknown>>;
}

function fixture(
	body: Uint8Array = Uint8Array.of(0, 255, 13, 10, 128, 1, 0),
	response: () => Response | Promise<Response> = () => Response.json({ id: providerId }),
): SendFixture {
	const observed: SendFixture["observed"] = {
		calls: 0,
		method: undefined,
		url: undefined,
		contentType: undefined,
		approvedHeader: undefined,
		body: undefined,
	};
	const fake = createFake(
		{
			async fetch(request) {
				observed.calls++;
				observed.method = request.method;
				observed.url = request.url;
				observed.contentType = request.headers.get("content-type");
				observed.approvedHeader = request.headers.get("x-approved");
				observed.body = new Uint8Array(await request.arrayBuffer());
				return response();
			},
		},
		{ host: "gmail.googleapis.com" },
	);
	// Only the send handler is the subject; these other SDK-required handlers are inert fixtures.
	const manifest = {
		id: "@example/gmail-send-test",
		version: "1.0.0",
		kind: "channel",
		sdk: "1.0.0",
		runtime: "node",
		isolation: "standard",
		contract: { extension: CHANNEL_V1, version: 1 },
		auth: { kind: "none", scopes: [], requiredGrantedScopes: [] },
		credentials: { mode: "brokered", urlSecrets: [] },
		permissions: {},
		dataClasses: ["gmail.content"],
		license: "Apache-2.0",
		egress: { profile: "gmail-v1" },
		send: { render: "gmail-rfc5322" },
	};
	const entry = defineChannelPlugin({
		manifest,
		describe: () => ({ channel: "email", mutations: [], attachments: false, listen: false }),
		probe: () => ({ status: "ok" }),
		sync: () => ({ changes: [], cursor: "DYTEST-unused", more: false }),
		fetchBody: () => {
			throw new PluginError("UNSUPPORTED");
		},
		send: gmailSend,
		reconcileSend: () => {
			throw new PluginError("UNSUPPORTED");
		},
	});
	const hub = createMockHub({
		mode: "in-memory",
		plugin: { manifest, entry },
		instance: "00000000000000000000000001",
		upstreams: [fake],
	});
	hubs.push(hub);
	const now = Date.now();
	const ticket = hub.host.mintTicket({
		outboxId: "00000000000000000000000003",
		method: "POST",
		url,
		headers: [
			["Content-Type", contentType],
			["X-Approved", "DYTEST-original"],
		],
		body,
		mintedAt: now,
		deliverBy: now + 120_000,
	});
	const request: SendRequest = { method: "POST", url, contentType, body: hub.host.putBlob(body) };
	return {
		hub,
		request,
		ticket,
		observed,
		call: () => hub.call("channel_send", { ...request }, { [SEND_TICKET_META]: ticket }),
	};
}

describe("Gmail exact send transport", () => {
	it.each([0, 7, 70_003])(
		"forwards one ticketed request and preserves %i original bytes",
		async (length) => {
			const body = Uint8Array.from({ length }, (_, index) => (index * 193) % 256);
			const f = fixture(body);
			const result = await f.call();
			expect(field(result, "isError") === true).toBe(false);
			const message = field(field(result, "structuredContent"), "message");
			expect(field(message, "kind") === "email").toBe(true);
			expect(field(message, "providerId") === providerId).toBe(true);
			expect(f.observed.calls).toBe(1);
			expect(f.observed.method === f.request.method).toBe(true);
			expect(f.observed.url === f.request.url).toBe(true);
			expect(f.observed.contentType === f.request.contentType).toBe(true);
			expect(f.observed.approvedHeader === "DYTEST-original").toBe(true);
			expect(sameBytes(f.observed.body, body)).toBe(true);
			expect(f.hub.host.hasTicket(f.ticket.id)).toBe(false);
		},
	);

	it("requires SDK ticket metadata before the handler can dispatch", async () => {
		const f = fixture();
		const result = await f.hub.call("channel_send", { ...f.request });
		expect(field(result, "isError") === true).toBe(true);
		expect(errorCode(result) === "INVALID_INPUT").toBe(true);
		expect(f.observed.calls).toBe(0);
		expect(f.hub.host.hasTicket(f.ticket.id)).toBe(true);
	});

	it("cannot replay the ticket into a second upstream send", async () => {
		const f = fixture();
		expect(field(await f.call(), "isError") === true).toBe(false);
		let denied = false;
		try {
			await f.call();
		} catch (error) {
			denied = error instanceof HostError && error.code === "DENIED";
		}
		expect(denied).toBe(true);
		expect(f.hub.host.disabled).toBe(true);
		expect(f.hub.host.alerts.at(-1)?.reason === "TICKET_UNKNOWN").toBe(true);
		expect(f.observed.calls).toBe(1);
		expect(f.hub.host.hasTicket(f.ticket.id)).toBe(false);
	});

	it("does not dispatch a body ref that differs from the registered rendered bytes", async () => {
		const f = fixture();
		let denied = false;
		try {
			await f.hub.call(
				"channel_send",
				{
					...f.request,
					body: f.hub.host.putBlob(Uint8Array.of(1, 2, 3)),
				},
				{ [SEND_TICKET_META]: f.ticket },
			);
		} catch (error) {
			denied = error instanceof HostError && error.code === "DENIED";
		}
		expect(denied).toBe(true);
		expect(f.hub.host.disabled).toBe(true);
		expect(f.hub.host.alerts.at(-1)?.reason === "TICKET_BODY_MISMATCH").toBe(true);
		expect(f.hub.host.hasTicket(f.ticket.id)).toBe(false);
		expect(f.observed.calls).toBe(0);
	});

	it.each([400, 429, 503])(
		"does not claim a definite rejection or retry after HTTP %i",
		async (status) => {
			const f = fixture(undefined, () =>
				Response.json({ error: "DYTEST-provider-error" }, { status }),
			);
			expect(isUncertain(await f.call())).toBe(true);
			expect(f.observed.calls).toBe(1);
		},
	);

	it.each([
		["a missing id", "{}"],
		["a null root", "null"],
		["an array root", "[]"],
		["a numeric id", '{"id":1}'],
		["an empty id", '{"id":""}'],
		["an oversized id", `{"id":"${"x".repeat(257)}"}`],
		["incomplete JSON", '{"id":'],
		["duplicate id fields", '{"id":"one","id":"two"}'],
	])("does not publish a sent reference from %s", async (_label, body) => {
		const f = fixture(undefined, () => new Response(body));
		const result = await f.call();
		expect(isUncertain(result)).toBe(true);
		expect(field(field(result, "structuredContent"), "message") === undefined).toBe(true);
		expect(f.observed.calls).toBe(1);
	});

	it("refuses invalid UTF8 instead of replacing provider response bytes", async () => {
		const f = fixture(
			undefined,
			() => new Response(Uint8Array.of(123, 34, 105, 100, 34, 58, 34, 255, 34, 125)),
		);
		expect(isUncertain(await f.call())).toBe(true);
		expect(f.observed.calls).toBe(1);
	});

	it("accepts a valid result at the shared inline limit", async () => {
		const prefix = `{"id":"${providerId}","padding":"`;
		const suffix = '"}';
		const body = prefix + "x".repeat(MAX_INLINE_BYTES - prefix.length - suffix.length) + suffix;
		const f = fixture(undefined, () => new Response(body));
		const result = await f.call();
		expect(field(result, "isError") === true).toBe(false);
		expect(
			field(field(field(result, "structuredContent"), "message"), "providerId") === providerId,
		).toBe(true);
		expect(f.observed.calls).toBe(1);
	});

	it("retains uncertainty when the provider result exceeds the shared inline limit", async () => {
		const f = fixture(undefined, () => new Response("x".repeat(MAX_INLINE_BYTES + 1)));
		expect(isUncertain(await f.call())).toBe(true);
		expect(f.observed.calls).toBe(1);
	});

	it("retains uncertainty after an upstream failure without retrying", async () => {
		const f = fixture(undefined, () => {
			throw new Error("DYTEST-upstream-failure");
		});
		expect(isUncertain(await f.call())).toBe(true);
		expect(f.observed.calls).toBe(1);
	});
});
