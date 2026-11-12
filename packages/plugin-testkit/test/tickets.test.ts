import { readFileSync } from "node:fs";
import { createFake, createHelloFake } from "@draftyak/fakes";
import type { HeaderList } from "@draftyak/protocol/hash";
import { HostFetchParams, HostHeaders } from "@draftyak/protocol/host-channel";
import { Ulid } from "@draftyak/protocol/scalars";
import { SEND_TICKET_META, type SendTicket, ticketMismatch } from "@draftyak/protocol/send-ticket";
import { afterEach, expect, it, vi } from "vitest";
import { createMockHub, type MockHub } from "../src/index.ts";
import { channelFixture } from "./fixtures/channel/plugin.ts";

const outboxId = "00000000000000000000000003";
const url = `https://hello.draftyak.example/v1/conversations/conv-1/messages?idempotency_key=${outboxId}`;
const body = new TextEncoder().encode('{"text":"DYTEST approved"}');
const headers = [
	["Content-Type", "application/json"],
	["Accept", "application/json"],
] as const;
const hubs: MockHub[] = [];
const track = (hub: MockHub): MockHub => {
	hubs.push(hub);
	return hub;
};
afterEach(async () => {
	vi.useRealTimers();
	await Promise.all(hubs.splice(0).map((hub) => hub.close()));
});

it("accepts one byte-identical send and burns a ticket before a replay can dispatch", async () => {
	const fake = createHelloFake();
	const hub = track(
		createMockHub({ mode: "in-memory", plugin: channelFixture(), upstreams: [fake] }),
	);
	const mintedAt = Date.now();
	const ticket = hub.host.mintTicket({
		outboxId,
		method: "POST",
		url,
		headers,
		body,
		mintedAt,
		deliverBy: mintedAt + 120_000,
	});
	const result = await hub.call(
		"channel_fetch",
		{
			method: "POST",
			url,
			headers: {
				"Content-Type": "application/json",
				Authorization: "synthetic-forbidden",
				"X-HTTP-Method-Override": "DELETE",
			},
			body: new TextDecoder().decode(body),
		},
		{ [SEND_TICKET_META]: ticket, instanceId: "forged-untrusted-metadata" },
	);
	expect(result.structuredContent).toMatchObject({ status: 201 });
	expect(hub.host.hasTicket(ticket.id)).toBe(false);
	await expect(
		hub.host.request("host/fetch", {
			method: "POST",
			url,
			headers,
			body: { base64: Buffer.from(body).toString("base64url") },
			sendTicket: ticket,
		}),
	).rejects.toThrow("DENIED");
	expect(hub.host.denials.at(-1)?.reason).toBe("TICKET_UNKNOWN");
	expect(hub.host.disabled).toBe(true);
	expect(hub.host.alerts).toEqual([{ reason: "TICKET_UNKNOWN" }]);
	expect(fake.recorder.takeRequests()).toHaveLength(1);
	expect(fake.messages("conv-1").at(-1)?.text).toBe("DYTEST approved");
});
it("sends only the saved rendered headers, preserving their Content-Type exactly once", async () => {
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
	const now = Date.now();
	const ticket = hub.host.mintTicket({
		outboxId,
		method: "POST",
		url,
		headers,
		body,
		mintedAt: now,
		deliverBy: now + 1000,
	});
	await hub.host.request("host/fetch", {
		method: "POST",
		url,
		headers: [
			["Content-Type", "application/json"],
			["Authorization", "synthetic"],
			["X-HTTP-Method-Override", "DELETE"],
			["Accept", "text/plain"],
		],
		body: { base64: Buffer.from(body).toString("base64url") },
		sendTicket: ticket,
	});
	expect(received?.get("content-type")).toBe("application/json");
	expect(received?.get("accept")).toBe("application/json");
	expect(received?.has("authorization")).toBe(false);
	expect(received?.has("x-http-method-override")).toBe(false);
});
it("refuses an unticketed send, disables the instance and records the refusal", async () => {
	const fake = createHelloFake();
	const hub = track(
		createMockHub({ mode: "in-memory", plugin: channelFixture(), upstreams: [fake] }),
	);
	await expect(
		hub.host.request("host/fetch", {
			method: "POST",
			url,
			headers,
			body: { base64: Buffer.from(body).toString("base64url") },
		}),
	).rejects.toThrow("DENIED");
	expect(hub.host.denials[0]?.reason).toBe("TICKET_UNKNOWN");
	expect(hub.host.disabled).toBe(true);
	expect(hub.host.alerts).toEqual([{ reason: "TICKET_UNKNOWN" }]);
	expect(fake.recorder.takeRequests()).toEqual([]);
});
it("burns found tickets even when body mutation refuses before dispatch", async () => {
	const fake = createHelloFake();
	const hub = track(
		createMockHub({ mode: "in-memory", plugin: channelFixture(), upstreams: [fake] }),
	);
	const now = Date.now();
	const ticket = hub.host.mintTicket({
		outboxId,
		method: "POST",
		url,
		headers,
		body,
		mintedAt: now,
		deliverBy: now + 1000,
	});
	const changed = Uint8Array.from(body);
	changed[10] = (changed[10] ?? 0) ^ 1;
	await expect(
		hub.host.request("host/fetch", {
			method: "POST",
			url,
			headers,
			body: { base64: Buffer.from(changed).toString("base64url") },
			sendTicket: ticket,
		}),
	).rejects.toThrow("DENIED");
	expect(hub.host.denials[0]?.reason).toBe("TICKET_BODY_MISMATCH");
	expect(hub.host.hasTicket(ticket.id)).toBe(false);
	expect(fake.recorder.takeRequests()).toEqual([]);
});
it("uses the lesser expiry and burns expired tickets without disabling an otherwise usable instance", async () => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(1_800_000_000_000);
	const fake = createHelloFake();
	const hub = track(
		createMockHub({ mode: "in-memory", plugin: channelFixture(), upstreams: [fake] }),
	);
	const now = Date.now();
	const ttl = hub.host.mintTicket({
		outboxId,
		method: "POST",
		url,
		headers,
		body,
		mintedAt: now,
		deliverBy: now + 120_000,
	});
	expect(ttl.exp).toBe(now + 60_000);
	const ticket = hub.host.mintTicket({
		outboxId,
		method: "POST",
		url,
		headers,
		body,
		mintedAt: now,
		deliverBy: now + 50,
	});
	expect(ticket.exp).toBe(now + 50);
	vi.setSystemTime(now + 51);
	await expect(
		hub.host.request("host/fetch", {
			method: "POST",
			url,
			headers,
			body: { base64: Buffer.from(body).toString("base64url") },
			sendTicket: ticket,
		}),
	).rejects.toThrow("DENIED");
	expect(hub.host.denials[0]?.reason).toBe("TICKET_EXPIRED");
	expect(hub.host.disabled).toBe(false);
	expect(hub.host.hasTicket(ticket.id)).toBe(false);
	expect(
		(
			await hub.host.request("host/fetch", {
				method: "GET",
				url: "https://hello.draftyak.example/v1/conversations",
				headers: [],
			})
		).status,
	).toBe(200);
});
it("retains Bytes/ref body semantics with detached in-memory blob state", async () => {
	const fake = createHelloFake();
	const hub = track(
		createMockHub({ mode: "in-memory", plugin: channelFixture(), upstreams: [fake] }),
	);
	const now = Date.now();
	const ticket = hub.host.mintTicket({
		outboxId,
		method: "POST",
		url,
		headers,
		body,
		mintedAt: now,
		deliverBy: now + 1000,
	});
	const original = Uint8Array.from(body);
	const ref = hub.host.putBlob(original);
	original.fill(0);
	const result = await hub.call(
		"channel_fetch",
		{ method: "POST", url, headers: { "Content-Type": "application/json" }, body: ref },
		{ [SEND_TICKET_META]: ticket },
	);
	expect(result.structuredContent).toMatchObject({ status: 201 });
	expect(hub.host.readBlob(ref.ref)).toEqual(body);
	await hub.close();
	expect(hub.host.readBlob(ref.ref)).toBeUndefined();
});

interface Vector {
	readonly id: string;
	readonly ticket: Record<string, unknown> | null;
	readonly request: {
		readonly ticket: unknown;
		readonly instanceId: string;
		readonly method: string;
		readonly url: string;
		readonly contentType: string;
		readonly headers: HeaderList;
		readonly bodyHex: string;
	};
	readonly now: number;
	readonly reason: string | null;
	readonly computed: { readonly presentedId: string | null };
}
const vectors = JSON.parse(
	readFileSync(new URL("../../../spec/vectors/send-ticket/broker.json", import.meta.url), "utf8"),
) as {
	readonly cases: readonly Vector[];
	readonly disablesPlugin: readonly string[];
	readonly expiry: readonly { id: string; mintedAt: number; deliverBy: number; exp: number }[];
};
const params = (item: Vector) => ({
	method: item.request.method,
	url: item.request.url,
	headers: [["Content-Type", item.request.contentType]],
	body: { base64: Buffer.from(item.request.bodyHex, "hex").toString("base64url") },
	...(item.request.ticket === undefined ? {} : { sendTicket: item.request.ticket }),
});
const applicable = vectors.cases.filter(
	(item) =>
		HostFetchParams.safeParse(params(item)).success &&
		HostHeaders.safeParse(item.request.headers).success &&
		Ulid.safeParse(item.request.instanceId).success &&
		Number.isSafeInteger(item.now) &&
		(item.ticket === null || typeof item.ticket.id === "string"),
);
it.each(vectors.cases)("retains the full literal shared ticket matcher vector $id", (item) => {
	expect(
		ticketMismatch(
			(item.ticket ?? undefined) as SendTicket | undefined,
			{
				...item.request,
				body: Buffer.from(item.request.bodyHex, "hex"),
			},
			item.now,
		) ?? null,
	).toBe(item.reason);
});
it("retains the complete normative vector file and explicitly limits host cases to representable host frames", () => {
	expect(vectors.cases).toHaveLength(66);
	expect(applicable).toHaveLength(61);
	expect(vectors.cases.filter((item) => !applicable.includes(item)).map((item) => item.id)).toEqual(
		[
			"clock-not-an-integer",
			"minted-url-trailing-line-feed",
			"method-byte-changed",
			"unknown-before-invalid",
			"invalid-before-altered",
		],
	);
});
// Date.now() supplies integer UTC milliseconds. Fractional clocks remain literal matcher tests.
// Malformed host frames are refused before the host handler can consume a ticket.
it.each(
	vectors.cases.filter((item) =>
		["minted-url-trailing-line-feed", "method-byte-changed"].includes(item.id),
	),
)("refuses the unrepresentable host frame $id without dispatch", async (item) => {
	const fake = createHelloFake();
	const hub = track(
		createMockHub({ mode: "in-memory", plugin: channelFixture(), upstreams: [fake] }),
	);
	await expect(hub.host.request("host/fetch", params(item) as never)).rejects.toThrow(
		"BAD_REQUEST",
	);
	expect(hub.host.denials).toHaveLength(1);
	expect(fake.recorder.takeRequests()).toEqual([]);
});
it.each(vectors.expiry)("mints the literal normative expiry $id", (item) => {
	const hub = track(createMockHub({ mode: "in-memory", plugin: channelFixture(), upstreams: [] }));
	expect(
		hub.host.mintTicket({
			outboxId,
			method: "POST",
			url,
			headers,
			body,
			mintedAt: item.mintedAt,
			deliverBy: item.deliverBy,
		}).exp,
	).toBe(item.exp);
});
it.each(applicable)("enforces ticket state and refusal from normative $id", async (item) => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(item.now);
	const fake = createFake({ fetch: () => new Response("{}") }, { host: "hello.draftyak.example" });
	const hub = track(
		createMockHub({
			mode: "in-memory",
			plugin: channelFixture(),
			instance: item.request.instanceId,
			upstreams: [fake],
		}),
	);
	if (item.ticket) hub.host.seedTicket(item.ticket, item.request.headers);
	const request = hub.host.request("host/fetch", HostFetchParams.parse(params(item)));
	const hostPolicyRefuses = item.id === "match-with-port-and-encoded-reserved";
	if (item.reason === null && !hostPolicyRefuses) expect((await request).status).toBe(200);
	else {
		await expect(request).rejects.toThrow("DENIED");
		expect(hub.host.denials[0]?.reason).toBe(hostPolicyRefuses ? "OFF_RULE" : item.reason);
	}
	expect(hub.host.disabled).toBe(
		item.reason !== null && vectors.disablesPlugin.includes(item.reason),
	);
	expect(hub.host.alerts).toEqual(
		item.reason !== null && vectors.disablesPlugin.includes(item.reason)
			? [{ reason: item.reason }]
			: [],
	);
	if (typeof item.ticket?.id === "string")
		expect(hub.host.hasTicket(item.ticket.id)).toBe(item.ticket.id !== item.computed.presentedId);
	expect(fake.recorder.takeRequests()).toHaveLength(
		item.reason === null && !hostPolicyRefuses ? 1 : 0,
	);
});
