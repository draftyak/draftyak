import { createHash } from "node:crypto";
import { request as httpRequest } from "node:http";
import { connect as connectTCP } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type ClientOptions, WebSocket } from "ws";
import {
	createSlackReadFake,
	createSlackSocketFake,
	MAX_SLACK_SOCKET_BODY_BYTES,
	MAX_SLACK_SOCKET_CONNECTIONS,
	MAX_SLACK_SOCKET_EVENT_BYTES,
	MAX_SLACK_SOCKET_PENDING,
	MAX_SLACK_SOCKET_RECORDS,
	MAX_SLACK_SOCKET_TICKETS,
	type SlackSocketFake,
} from "../src/slack.ts";
import { withTarget } from "../src/target.ts";

const fakes: SlackSocketFake[] = [],
	clients: WebSocket[] = [];
function fixture(options: Parameters<typeof createSlackSocketFake>[0] = {}) {
	const fake = createSlackSocketFake(options);
	fakes.push(fake);
	return fake;
}
async function until(test: () => boolean, ms = 1000) {
	const end = Date.now() + ms;
	while (!test()) {
		if (Date.now() >= end) throw new Error("DYTEST condition timeout");
		await delay(2);
	}
}
async function api(
	fake: SlackSocketFake,
	method = "auth.test",
	token = fake.userToken,
	init: RequestInit = {},
) {
	const response = await fake.fetch(`/api/${method}`, {
		method: "POST",
		headers: { authorization: `Bearer ${token}` },
		...init,
	});
	return { response, body: (await response.json()) as Record<string, unknown> };
}
async function ticket(fake: SlackSocketFake) {
	const { body } = await api(fake, "apps.connections.open", fake.appToken);
	expect(body.ok).toBe(true);
	return body.url as string;
}
function opening(url: string, options: ClientOptions = {}) {
	const socket = new WebSocket(url, options);
	clients.push(socket);
	const frames: Record<string, unknown>[] = [];
	let closeCode: number | undefined;
	socket.on("message", (value) =>
		frames.push(JSON.parse(value.toString()) as Record<string, unknown>),
	);
	socket.on("error", () => {});
	socket.once("close", (code) => {
		closeCode = code;
	});
	const opened = new Promise<void>((resolve, reject) => {
		socket.once("open", resolve);
		socket.once("error", reject);
	});
	return {
		socket,
		frames,
		opened,
		get closeCode() {
			return closeCode;
		},
	};
}
function first(fake: SlackSocketFake) {
	const handle = fake.live()[0];
	if (!handle) throw new Error("DYTEST live handle missing");
	return handle;
}
async function connected(fake: SlackSocketFake) {
	const value = opening(await ticket(fake));
	await value.opened;
	if (fake.sendHello) await until(() => value.frames.length > 0);
	return value;
}
afterEach(async () => {
	for (const client of clients.splice(0)) client.terminate();
	await Promise.all(fakes.splice(0).map((fake) => fake.close()));
	if (vi.isFakeTimers()) {
		vi.clearAllTimers();
		vi.useRealTimers();
	}
	vi.restoreAllMocks();
});

describe("synthetic Slack auth and private Socket Mode companion", () => {
	it("authenticates synthetic identities in memory and over its owned loopback listener", async () => {
		const fake = fixture();
		expect((await api(fake)).body).toMatchObject({
			ok: true,
			user_id: "UDYTEST01",
			team_id: "TDYTEST01",
		});
		await fake.start();
		const response = await fetch(`${fake.apiBase}auth.test`, {
			method: "POST",
			headers: { authorization: `Bearer ${fake.userToken}` },
		});
		expect(await response.json()).toMatchObject({ ok: true, user: "dytest-owner" });
		expect(new URL(fake.apiBase).hostname).toBe("127.0.0.1");
		expect((await fake.listen()).origin).toBe(new URL(fake.apiBase).origin);
	});
	it.each([
		["GET", "user", "", "method_not_allowed", 405],
		["POST", "missing", "", "not_authed", 200],
		["POST", "malformed", "", "not_authed", 200],
		["POST", "app", "", "not_allowed_token_type", 200],
		["POST", "other", "", "invalid_auth", 200],
		["POST", "user", "?token=DYTEST", "invalid_arg_name", 200],
		["POST", "user", "?unknown=", "invalid_arg_name", 200],
	])("auth guard %s/%s/%s", async (method, kind, query, error, status) => {
		const fake = fixture();
		const headers: Record<string, string> =
			kind === "missing"
				? {}
				: {
						authorization:
							kind === "malformed"
								? "Basic DYTEST"
								: "Bearer " +
									(kind === "user"
										? fake.userToken
										: kind === "app"
											? fake.appToken
											: "DYTEST-other"),
					};
		const response = await fake.fetch(`/api/auth.test${query}`, {
			method: method as string,
			headers,
		});
		expect(response.status).toBe(status);
		expect(await response.json()).toMatchObject({ ok: false, error });
		expect((await api(fake)).body.ok).toBe(true);
	});
	it("requires the app token for connections.open and rejects all request arguments", async () => {
		const fake = fixture();
		expect((await api(fake, "apps.connections.open", fake.userToken)).body.error).toBe(
			"not_allowed_token_type",
		);
		expect((await api(fake, "apps.connections.open", "DYTEST-other")).body.error).toBe(
			"invalid_auth",
		);
		expect(
			(await api(fake, "auth.test", fake.userToken, { body: "token=DYTEST" })).body.error,
		).toBe("invalid_arg_name");
		expect(fake.stats().tickets).toBe(0);
		await ticket(fake);
		expect(fake.stats().tickets).toBe(1);
	});
	it.each([
		"/api/../api/auth.test",
		"/api/%61uth.test",
		"/api/auth.test#DYTEST",
		"//api/auth.test",
		"/api/auth.test/",
	])("refuses raw-target aliases %s", async (target) => {
		const fake = fixture();
		const request = withTarget(
			new Request(`https://${fake.host}/api/auth.test`, {
				method: "POST",
				headers: { authorization: `Bearer ${fake.userToken}` },
			}),
			target,
		);
		expect((await fake.fetch(request)).status).toBe(404);
		expect((await fake.fetch(`https://${fake.host}${target}`, { method: "POST" })).status).toBe(
			404,
		);
	});
	it("denies read/write/provider-schedule routes instead of forwarding or using native fetch", async () => {
		const fake = fixture(),
			native = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("DYTEST native fallback"));
		for (const method of ["users.conversations", "chat.postMessage", "chat.scheduleMessage"])
			expect((await api(fake, method)).response.status).toBe(404);
		expect(native).not.toHaveBeenCalled();
		const read = createSlackReadFake({ conversations: [] });
		expect((await read.fetch("/api/auth.test", { method: "POST" })).status).toBe(405);
	});
	it("admits exactly16KiB, refuses +1 with received-byte evidence and retains no token/body/query values", async () => {
		const fake = fixture();
		expect(
			(
				await api(fake, "auth.test", fake.userToken, {
					body: "x".repeat(16 * 1024),
				})
			).body.error,
		).toBe("invalid_arg_name");
		const over = "x".repeat(16 * 1024 + 1);
		expect((await api(fake, "auth.test", fake.userToken, { body: over })).response.status).toBe(
			413,
		);
		await fake.fetch(`/api/auth.test?token=${fake.userToken}`, {
			method: "POST",
			headers: { authorization: `Bearer ${fake.userToken}` },
		});
		const rows = fake.recorder.takeRequests();
		expect(rows[0]?.bodyLength).toBe(16 * 1024);
		expect(rows[1]).toMatchObject({
			refused: "request_body_too_large",
			bodyLength: over.length,
			bodySha256: createHash("sha256").update(over).digest("hex"),
		});
		expect(
			rows.every(
				(row) =>
					row.body.length === 0 && row.query === "" && Object.values(row.headers).length === 0,
			),
		).toBe(true);
		expect(JSON.stringify(rows)).not.toContain(fake.userToken);
		const url = await ticket(fake);
		expect(JSON.stringify(fake.recorder.takeRequests())).not.toContain(url);
	});
	it("keeps shared fault/date semantics without consuming an auth ticket before a pre-handler fault", async () => {
		const fake = fixture({ nowMs: 1_760_000_000_000 });
		fake.faults.add({ kind: "rate-limit", retryAfter: 7, path: "/api/apps.connections.open" });
		const refused = await api(fake, "apps.connections.open", fake.appToken);
		expect(refused.response.status).toBe(429);
		expect(refused.response.headers.get("retry-after")).toBe("7");
		expect(refused.response.headers.get("date")).toBe(new Date(fake.clock.now()).toUTCString());
		expect(fake.stats().tickets).toBe(0);
		expect(fake.recorder.takeRequests()).toHaveLength(1);
		await ticket(fake);
		expect(fake.stats().tickets).toBe(1);
		fake.faults.add({
			kind: "server-error",
			status: 500,
			after: true,
			path: "/api/apps.connections.open",
		});
		expect((await api(fake, "apps.connections.open", fake.appToken)).response.status).toBe(500);
		expect(fake.stats().tickets).toBe(2);
	});
	it("applies the same capped admission over loopback and rejects a foreign Host header", async () => {
		const fake = fixture();
		await fake.start();
		const over = "x".repeat(MAX_SLACK_SOCKET_BODY_BYTES + 1);
		const response = await fetch(`${fake.apiBase}auth.test`, {
			method: "POST",
			headers: { authorization: `Bearer ${fake.userToken}` },
			body: over,
		});
		expect(response.status).toBe(413);
		expect(fake.recorder.takeRequests()[0]).toMatchObject({
			refused: "request_body_too_large",
			bodyLength: over.length,
		});
		const foreign = await new Promise<number>((resolve, reject) => {
			const request = httpRequest(
				`${fake.apiBase}auth.test`,
				{
					method: "POST",
					headers: { host: "dytest.invalid" },
				},
				(response) => {
					response.resume();
					response.once("end", () => resolve(response.statusCode ?? 0));
				},
			);
			request.once("error", reject);
			request.end();
		});
		expect(foreign).toBe(421);
		expect(fake.recorder.takeRequests()).toHaveLength(0);
	});
	it("uses single-use instance-local tickets; a wrong path does not consume a legitimate ticket", async () => {
		const a = fixture(),
			b = fixture();
		const url = await ticket(a);
		await b.start();
		await expect(opening(url.replace("/link/", "/wrong/")).opened).rejects.toThrow();
		const foreign = new URL(url);
		foreign.host = new URL(b.apiBase).host;
		await expect(opening(foreign.href).opened).rejects.toThrow();
		const first = opening(url);
		await first.opened;
		await expect(opening(url).opened).rejects.toThrow();
		expect(a.live()).toHaveLength(1);
		expect(b.live()).toHaveLength(0);
		expect(first.socket.readyState).toBe(WebSocket.OPEN);
	});
	it("refuses a foreign WebSocket Host without consuming its ticket", async () => {
		const fake = fixture(),
			url = await ticket(fake);
		await expect(opening(url, { headers: { host: "dytest.invalid" } }).opened).rejects.toThrow();
		expect(fake.live()).toHaveLength(0);
		expect(fake.stats().tickets).toBe(1);
		const valid = opening(url);
		await valid.opened;
		expect(fake.live()).toHaveLength(1);
		expect(fake.stats().tickets).toBe(0);
	});
	it("expires tickets with the controlled clock, bounds outstanding tickets and recovers", async () => {
		const fake = fixture();
		const first = await ticket(fake);
		for (let at = 1; at < MAX_SLACK_SOCKET_TICKETS; at++) await ticket(fake);
		expect((await api(fake, "apps.connections.open", fake.appToken)).response.status).toBe(503);
		fake.clock.advance(60_000);
		await expect(opening(first).opened).rejects.toThrow();
		expect(fake.stats().tickets).toBe(0);
		await connected(fake);
	});
	it("refuses query/Origin upgrades, preserves ticket use and bounds simultaneous connections", async () => {
		const fake = fixture();
		const url = await ticket(fake);
		await expect(opening(`${url}?DYTEST=1`).opened).rejects.toThrow();
		await expect(opening(url, { origin: "https://dytest.invalid" }).opened).rejects.toThrow();
		const one = opening(url);
		await one.opened;
		for (let at = 1; at < MAX_SLACK_SOCKET_CONNECTIONS; at++) await connected(fake);
		const refused = opening(await ticket(fake));
		await expect(refused.opened).rejects.toThrow();
		expect(fake.live()).toHaveLength(MAX_SLACK_SOCKET_CONNECTIONS);
		one.socket.terminate();
		await until(() => fake.live().length === MAX_SLACK_SOCKET_CONNECTIONS - 1);
		await connected(fake);
		expect(fake.live()).toHaveLength(MAX_SLACK_SOCKET_CONNECTIONS);
	});
	it("can suppress hello while delivering exact detached event wire and observing an ack", async () => {
		const fake = fixture({ ackTimeoutMs: 100 });
		fake.sendHello = false;
		const client = await connected(fake);
		await delay(10);
		expect(client.frames).toEqual([]);
		const payload = { event_id: "DYTEST-event", event: { type: "message", text: "DYTEST hello" } };
		const envelope = fake.deliver(payload, { acceptsResponsePayload: true });
		payload.event.text = "DYTEST changed";
		await until(() => client.frames.length === 1);
		expect(client.frames[0]).toEqual({
			envelope_id: envelope.envelopeId,
			payload: { event_id: "DYTEST-event", event: { type: "message", text: "DYTEST hello" } },
			type: "events_api",
			accepts_response_payload: true,
			retry_attempt: 0,
			retry_reason: "",
		});
		client.socket.send(JSON.stringify({ envelope_id: envelope.envelopeId }));
		await until(() => envelope.acknowledged);
		expect(fake.stats().pending).toBe(0);
		expect(fake.acksFor(envelope.envelopeId)).toEqual([
			{
				connection: fake.live()[0]?.id,
				envelopeId: envelope.envelopeId,
				accepted: true,
				dropped: false,
			},
		]);
	});
	it("drops one valid ack, retries with fresh identity and same payload/type, then stops on the new ack", async () => {
		const fake = fixture({ ackTimeoutMs: 40 }),
			client = await connected(fake);
		fake.dropAcks = 1;
		const envelope = fake.deliver(
			{ text: "DYTEST" },
			{ type: "interactive", acceptsResponsePayload: true },
		);
		await until(() => client.frames.length === 2);
		client.socket.send(JSON.stringify({ envelope_id: envelope.envelopeId }));
		await until(() => fake.acks.length === 1);
		expect(envelope.acknowledged).toBe(false);
		expect(fake.acks[0]?.dropped).toBe(true);
		await until(() => client.frames.length >= 3);
		const retry = client.frames[2];
		expect(retry).toMatchObject({
			type: "interactive",
			retry_attempt: 1,
			retry_reason: "timeout",
			payload: { text: "DYTEST" },
			accepts_response_payload: false,
		});
		expect(retry?.envelope_id).not.toBe(envelope.envelopeId);
		expect(envelope.redelivered).toBe(true);
		client.socket.send(JSON.stringify({ envelope_id: retry?.envelope_id }));
		await until(() => fake.stats().pending === 0);
		const count = client.frames.length;
		await delay(100);
		expect(client.frames).toHaveLength(count);
	});
	it("limits redelivery to attempts0..3 and old-ID acknowledgements cannot cancel a newer retry", async () => {
		const fake = fixture({ ackTimeoutMs: 20 }),
			client = await connected(fake);
		const initial = fake.deliver({ text: "DYTEST retry" });
		await until(() => client.frames.length >= 3);
		client.socket.send(JSON.stringify({ envelope_id: initial.envelopeId }));
		await until(() => fake.stats().pending === 0);
		const events = client.frames.filter((value) => value.envelope_id);
		expect(events.map((value) => value.retry_attempt)).toEqual([0, 1, 2, 3]);
		expect(new Set(events.map((value) => value.envelope_id)).size).toBe(4);
		await delay(50);
		expect(client.frames.filter((value) => value.envelope_id)).toHaveLength(4);
	});
	it("binds acknowledgements to the delivery socket and moves a retry to the newest live socket", async () => {
		const fake = fixture({ ackTimeoutMs: 60 }),
			a = await connected(fake);
		const initial = fake.deliver({ text: "DYTEST bound" });
		const b = await connected(fake);
		b.socket.send(JSON.stringify({ envelope_id: initial.envelopeId }));
		await until(() => fake.acks.length > 0);
		expect(initial.acknowledged).toBe(false);
		expect(fake.acks[0]?.accepted).toBe(false);
		a.socket.terminate();
		await until(() => b.frames.some((value) => value.retry_attempt === 1));
		const retry = b.frames.find((value) => value.retry_attempt === 1);
		b.socket.send(JSON.stringify({ envelope_id: retry?.envelope_id }));
		await until(() => fake.stats().pending === 0);
	});
	it.each([
		["malformed", "{", false, 1008],
		["primitive", "null", false, 1008],
		["missing", "{}", false, 1008],
		[
			"extra",
			JSON.stringify({ envelope_id: "00000000-0000-0000-0000-000000000000", token: "DYTEST" }),
			false,
			1008,
		],
		["binary", JSON.stringify({ envelope_id: "00000000-0000-0000-0000-000000000000" }), true, 1003],
		["oversized", "x".repeat(1025), false, 1009],
	])("refuses %s ACK frames", async (_kind, value, binary, code) => {
		const fake = fixture({ ackTimeoutMs: 50 }),
			client = await connected(fake);
		const envelope = fake.deliver({ text: "DYTEST pending" });
		fake.dropAcks = 1;
		client.socket.send(value as string, { binary: binary as boolean });
		await until(() => client.closeCode !== undefined);
		expect(client.closeCode).toBe(code);
		expect(envelope.acknowledged).toBe(false);
		expect(fake.dropAcks).toBe(1);
		expect(fake.acks).toHaveLength(0);
	});
	it.each(["ping", "pong"] as const)(
		"counts exact-limit and excess %s control messages",
		async (kind) => {
			const fake = fixture(),
				client = await connected(fake);
			for (let at = 0; at < MAX_SLACK_SOCKET_RECORDS; at++) client.socket[kind]("DYTEST");
			await delay(10);
			expect(client.socket.readyState).toBe(WebSocket.OPEN);
			client.socket[kind]("DYTEST excess");
			await Promise.race([until(() => client.closeCode !== undefined), delay(100)]);
			expect(client.closeCode).toBe(1008);
		},
	);
	it("acknowledges current pending work after its diagnostic envelope history was evicted", async () => {
		const fake = fixture({ ackTimeoutMs: 60_000 }),
			a = await connected(fake),
			ah = first(fake);
		const control = fake.deliver({ text: "DYTEST A positive" }, { connection: ah });
		a.socket.send(JSON.stringify({ envelope_id: control.envelopeId }));
		await until(() => control.acknowledged);
		const held = fake.deliver({ text: "DYTEST A held" }, { connection: ah });
		for (let connection = 0; connection < 2; connection++) {
			const client = await connected(fake),
				handle = fake.live().at(-1);
			if (!handle) throw new Error("DYTEST live handle missing");
			for (let batch = 0; batch < 4; batch++) {
				const events = Array.from({ length: 32 }, () =>
					fake.deliver({ text: "DYTEST bounded history" }, { connection: handle }),
				);
				for (const event of events)
					client.socket.send(JSON.stringify({ envelope_id: event.envelopeId }));
				await until(() => events.every((event) => event.acknowledged));
			}
		}
		expect(fake.envelopes).toHaveLength(MAX_SLACK_SOCKET_RECORDS);
		expect(fake.envelopes.some((value) => value.envelopeId === held.envelopeId)).toBe(false);
		expect(fake.stats().pending).toBe(1);
		a.socket.send(JSON.stringify({ envelope_id: held.envelopeId }));
		await until(() => fake.acks.at(-1)?.connection === ah.id);
		expect(held.acknowledged).toBe(true);
		expect(fake.stats().pending).toBe(0);
	});
	it("accepts the exact ACK byte boundary, bounds messages and retains only bounded diagnostics", async () => {
		const fake = fixture({ ackTimeoutMs: 1000 }),
			client = await connected(fake);
		const envelope = fake.deliver({ text: "DYTEST" }),
			base = JSON.stringify({ envelope_id: envelope.envelopeId });
		client.socket.send(base + " ".repeat(1024 - Buffer.byteLength(base)));
		await until(() => envelope.acknowledged);
		for (let at = 1; at < MAX_SLACK_SOCKET_RECORDS; at++) client.socket.send(base);
		await until(() => fake.acks.length === MAX_SLACK_SOCKET_RECORDS);
		client.socket.send(base);
		await until(() => fake.connections[0]?.closedCode !== null);
		expect(fake.connections[0]?.closedCode).toBe(1008);
		expect(fake.acks).toHaveLength(MAX_SLACK_SOCKET_RECORDS);
	});
	it("bounds pending deliveries before mutation and permits exact maximum wire bytes", async () => {
		const fake = fixture({ ackTimeoutMs: 60_000 }),
			client = await connected(fake);
		const empty = {
			envelope_id: "00000000-0000-0000-0000-000000000000",
			payload: { text: "" },
			type: "events_api",
			accepts_response_payload: false,
			retry_attempt: 0,
			retry_reason: "",
		};
		const text = "x".repeat(16 * 1024 - Buffer.byteLength(JSON.stringify(empty)));
		const exact = fake.deliver({ text });
		await until(() => client.frames.length === 2);
		expect(Buffer.byteLength(JSON.stringify(client.frames[1]))).toBe(16 * 1024);
		expect(() => fake.deliver({ text: `${text}x` })).toThrow("fixture refused");
		expect(fake.envelopes).toHaveLength(1);
		for (let at = 1; at < MAX_SLACK_SOCKET_PENDING; at++) fake.deliver({ text: "DYTEST" });
		expect(() => fake.deliver({ text: "DYTEST overflow" })).toThrow("fixture refused");
		expect(fake.stats().pending).toBe(MAX_SLACK_SOCKET_PENDING);
		client.socket.send(JSON.stringify({ envelope_id: exact.envelopeId }));
		await until(() => fake.stats().pending === MAX_SLACK_SOCKET_PENDING - 1);
		fake.deliver({ text: "DYTEST recovered" });
		expect(fake.stats().pending).toBe(MAX_SLACK_SOCKET_PENDING);
	});
	it("refuses inert-data violations and invalid configuration without calling accessors", async () => {
		const getter = vi.fn(() => "DYTEST");
		for (const options of [
			{ ackTimeoutMs: 0 },
			{ ackTimeoutMs: Infinity },
			{ nowMs: -1 },
			{ unknown: true },
		])
			expect(() => createSlackSocketFake(options)).toThrow();
		const fake = fixture(),
			client = await connected(fake);
		const bad = Object.defineProperty({}, "text", { enumerable: true, get: getter });
		for (const payload of [
			bad,
			new Proxy({}, {}),
			{ toJSON: getter },
			{ value: NaN },
			{ text: "x".repeat(MAX_SLACK_SOCKET_EVENT_BYTES + 1) },
		])
			expect(() => fake.deliver(payload)).toThrow();
		expect(getter).not.toHaveBeenCalled();
		expect(fake.envelopes).toHaveLength(0);
		expect(() => {
			fake.dropAcks = -1;
		}).toThrow();
		expect(() => fake.disconnect(first(fake), "DYTEST", Infinity)).toThrow();
		expect(client.socket.readyState).toBe(WebSocket.OPEN);
	});
	it("drains bounded HTTP recording slots and cancels/forgets an incomplete upload on close", async () => {
		const fake = fixture();
		for (let at = 0; at < MAX_SLACK_SOCKET_RECORDS; at++)
			expect((await api(fake)).body.ok).toBe(true);
		await expect(api(fake)).rejects.toThrow("fixture refused");
		expect(fake.recorder.takeRequests()).toHaveLength(MAX_SLACK_SOCKET_RECORDS);
		expect((await api(fake)).body.ok).toBe(true);
		fake.recorder.takeRequests();
		const cancelled = vi.fn();
		let producer: ReadableStreamDefaultController<Uint8Array> | undefined;
		const upload = fake.fetch("/api/auth.test", {
			method: "POST",
			body: new ReadableStream({
				start(c) {
					producer = c;
					c.enqueue(new Uint8Array([1]));
				},
				cancel: cancelled,
			}),
			duplex: "half",
		} as RequestInit);
		const rejected = expect(upload).rejects.toThrow();
		await until(() => fake.stats().http === 1);
		const closed = fake.close();
		try {
			const prompt = await Promise.race([closed.then(() => true), delay(100).then(() => false)]);
			expect(prompt).toBe(true);
			expect(cancelled).toHaveBeenCalled();
		} finally {
			producer?.error(new Error("DYTEST fallback producer cleanup"));
			await closed;
			await rejected;
		}
		expect(fake.stats().http).toBe(0);
		expect(fake.recorder.takeRequests()).toHaveLength(0);
	});
	it("bounds in-flight uploads, cancels overflow and rejects source errors without retaining incomplete slots", async () => {
		const fake = fixture(),
			cancellations = vi.fn();
		const uploads = Array.from({ length: 16 }, () =>
			fake.fetch("/api/auth.test", {
				method: "POST",
				body: new ReadableStream({ cancel: cancellations }),
				duplex: "half",
			} as RequestInit),
		);
		const settled = Promise.allSettled(uploads);
		await until(() => fake.stats().http === 16);
		const overflow = vi.fn();
		expect(() =>
			fake.fetch("/api/auth.test", {
				method: "POST",
				body: new ReadableStream({ cancel: overflow }),
				duplex: "half",
			} as RequestInit),
		).toThrow();
		await until(() => overflow.mock.calls.length > 0);
		await fake.close();
		expect((await settled).every((value) => value.status === "rejected")).toBe(true);
		expect(cancellations).toHaveBeenCalledTimes(16);
		expect(fake.stats().http).toBe(0);
		const next = fixture();
		next.faults.add({ kind: "server-error" });
		await expect(
			next.fetch("/api/auth.test", {
				method: "POST",
				body: new ReadableStream({
					start(c) {
						c.error(new Error("DYTEST source failed"));
					},
				}),
				duplex: "half",
			} as RequestInit),
		).rejects.toThrow();
		expect(next.recorder.takeRequests()).toHaveLength(0);
		expect(next.faults.pending()).toHaveLength(0);
		expect((await api(next)).body.ok).toBe(true);
	});
	it("cancels a stalled producer at the local upload deadline without producer closure", async () => {
		const fake = fixture(),
			cancelled = vi.fn();
		const upload = fake.fetch("/api/auth.test", {
			method: "POST",
			body: new ReadableStream({ cancel: cancelled }),
			duplex: "half",
		} as RequestInit);
		await expect(upload).rejects.toThrow("upload timeout");
		expect(cancelled).toHaveBeenCalled();
		expect(fake.stats().http).toBe(0);
		expect(fake.recorder.takeRequests()).toHaveLength(0);
	});
	it("cleans up constructor failures and refuses uncapped manual recorder uploads", async () => {
		const fake = fixture();
		const used = new Request(`https://${fake.host}/api/auth.test`, {
			method: "POST",
			body: "DYTEST",
		});
		await used.text();
		await expect(fake.fetch(used)).rejects.toThrow();
		expect(fake.stats()).toMatchObject({ http: 0, timers: 0 });
		const cancel = vi.fn();
		const manual = new Request(`https://${fake.host}/api/auth.test`, {
			method: "POST",
			body: new ReadableStream({ cancel }),
			duplex: "half",
		} as RequestInit);
		await expect(fake.recorder.record(manual)).rejects.toThrow();
		expect(cancel).toHaveBeenCalled();
		expect(fake.recorder.takeRequests()).toHaveLength(0);
	});
	it("omits unknown ACK identifiers, including a synthetic ticket, from retained diagnostics", async () => {
		const fake = fixture(),
			client = await connected(fake);
		const url = await ticket(fake),
			id = new URL(url).pathname.slice(6);
		client.socket.send(JSON.stringify({ envelope_id: id }));
		await until(() => fake.acks.length === 1);
		expect(fake.acks[0]).toEqual({
			connection: fake.live()[0]?.id,
			accepted: false,
			dropped: false,
		});
		expect(JSON.stringify(fake.acks)).not.toContain(id);
	});
	it("redacts synthetic credentials even when placed in method or unknown header-name metadata", async () => {
		const fake = fixture(),
			url = await ticket(fake),
			id = new URL(url).pathname.slice(6);
		const response = await fake.fetch("/api/auth.test", {
			method: fake.userToken,
			headers: { [id]: "DYTEST" },
		});
		expect(response.status).toBe(405);
		const rows = fake.recorder.takeRequests(),
			captured = JSON.stringify(rows);
		expect(rows.at(-1)?.method).toBe("OTHER");
		expect(captured).not.toContain(fake.userToken);
		expect(captured).not.toContain(id);
	});
	it("bounds outbound frame work before send and accepts only this instance's live handles", async () => {
		const fake = fixture(),
			other = fixture(),
			client = await connected(fake);
		await connected(other);
		for (let at = 1; at < MAX_SLACK_SOCKET_RECORDS; at++)
			fake.frame(first(fake), { type: "DYTEST" });
		await until(() => client.frames.length === MAX_SLACK_SOCKET_RECORDS);
		expect(() => fake.frame(first(fake), { type: "DYTEST overflow" })).toThrow();
		expect(() => fake.frame(first(other), { type: "DYTEST" })).toThrow();
		expect(() => fake.deliver({ type: "DYTEST" }, { connection: other.live()[0] })).toThrow();
		await delay(10);
		expect(client.frames).toHaveLength(MAX_SLACK_SOCKET_RECORDS);
	});
	it("bounds scheduled disconnect work and shared faults before adding more work", async () => {
		const fake = fixture(),
			client = await connected(fake);
		// One lifetime timer is already owned by the live connection.
		for (let at = 1; at < 128; at++) fake.disconnect(first(fake), "DYTEST", 60_000);
		expect(fake.stats().timers).toBe(128);
		const frameCount = client.frames.length;
		expect(() => fake.disconnect(first(fake), "DYTEST overflow", 60_000)).toThrow();
		expect(fake.stats().timers).toBe(128);
		expect(() => fake.faults.add({ kind: "latency", ms: Infinity })).toThrow();
		expect(() => fake.faults.add({ kind: "latency", ms: 1001 })).toThrow();
		expect(() => fake.faults.add({ kind: "drop", times: 1025 })).toThrow();
		fake.faults.add({ kind: "latency", ms: 1000, times: 1024 });
		for (let at = 1; at < 32; at++) fake.faults.add({ kind: "drop" });
		expect(() => fake.faults.add({ kind: "drop" })).toThrow();
		expect(fake.faults.pending()).toHaveLength(32);
		await fake.close();
		expect(fake.stats().timers).toBe(0);
		expect(client.frames.length).toBeGreaterThanOrEqual(frameCount);
	});
	it("sends disconnect, closes only its own resources and refuses later use", async () => {
		const fake = fixture({ ackTimeoutMs: 15 }),
			other = fixture();
		const client = await connected(fake),
			otherClient = await connected(other);
		const listening = await fake.listen();
		fake.deliver({ text: "DYTEST pending" });
		fake.disconnect(first(fake), "DYTEST refresh", 0);
		await until(() => client.frames.some((value) => value.type === "disconnect"));
		await until(() => fake.connections[0]?.closedCode === 1000);
		await until(() => fake.stats().pending === 0);
		await fake.close();
		await fake.close();
		expect(fake.stats()).toEqual({ tickets: 0, connections: 0, pending: 0, timers: 0, http: 0 });
		const reachable = await new Promise<boolean>((resolve) => {
			const socket = connectTCP(listening.port, "127.0.0.1");
			socket.once("connect", () => {
				socket.destroy();
				resolve(true);
			});
			socket.once("error", () => resolve(false));
		});
		expect(reachable).toBe(false);
		expect(otherClient.socket.readyState).toBe(WebSocket.OPEN);
		expect(() => fake.deliver({ text: "DYTEST" })).toThrow();
		expect(() => fake.fetch("/api/auth.test")).toThrow();
		await expect(fake.listen()).rejects.toThrow();
	});
	it("preserves original locked-body requests for fault apps and refuses fault actions after close", async () => {
		const fake = fixture();
		const input = new Request(`https://${fake.host}/api/auth.test`, {
			method: "POST",
			body: "DYTEST locked",
		});
		if (!input.body) throw new Error("DYTEST body missing");
		const reader = input.body.getReader();
		const response = await fake.faults.run(input, async (original) => {
			expect(original).toBe(input);
			expect(original.body?.locked).toBe(true);
			return new Response("DYTEST original body preserved");
		});
		expect(await response.text()).toBe("DYTEST original body preserved");
		await reader.cancel();
		await fake.close();
		const app = vi.fn(async () => new Response());
		expect(() => fake.faults.add({ kind: "drop" })).toThrow();
		expect(() => fake.faults.run(new Request(`https://${fake.host}`), app)).toThrow();
		expect(app).not.toHaveBeenCalled();
		expect(fake.faults.pending()).toEqual([]);
		expect(() => fake.faults.clear()).not.toThrow();
	});
	it("closes owned waiting without waiting for a caller-controlled pending fault callback", async () => {
		const fake = fixture();
		let release: ((value: Response) => void) | undefined;
		const controlled = new Promise<Response>((resolve) => {
			release = resolve;
		});
		const app = vi.fn(() => controlled);
		const result = fake.faults.run(new Request(`https://${fake.host}`), app).then(
			() => "resolved",
			() => "aborted",
		);
		expect(app).toHaveBeenCalledTimes(1);
		const closed = fake.close();
		try {
			expect(await Promise.race([closed.then(() => true), delay(100).then(() => false)])).toBe(
				true,
			);
			expect(await result).toBe("aborted");
		} finally {
			release?.(new Response());
			await closed;
			await result;
		}
	});
	it("aborts an already-selected shared latency wait before its app can start after close", async () => {
		const fake = fixture(),
			app = vi.fn(async () => new Response());
		fake.faults.add({ kind: "latency", ms: 30 });
		const result = fake.faults.run(new Request(`https://${fake.host}`), app).then(
			() => "resolved",
			() => "aborted",
		);
		await fake.close();
		expect(await result).toBe("aborted");
		await delay(60);
		expect(app).not.toHaveBeenCalled();
	});
	it("cancels its owned lifetime/retry timers rather than merely clearing their counters", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const fake = fixture(),
			client = await connected(fake);
		const envelope = fake.deliver({ text: "DYTEST timer cleanup" });
		await until(() =>
			client.frames.some(
				(frame) => frame.envelope_id === envelope.envelopeId && frame.retry_attempt === 0,
			),
		);
		expect(vi.getTimerCount()).toBeGreaterThanOrEqual(2);
		await fake.close();
		expect(vi.getTimerCount()).toBe(0);
		const count = client.frames.length;
		await vi.advanceTimersByTimeAsync(180_000);
		expect(client.frames).toHaveLength(count);
	});
});
