import { setImmediate as nextTurn } from "node:timers/promises";
import { resolveFakeTransport } from "@draftyak/fakes/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSlackSocketBackend } from "./fixtures/socket-backend/adapter.ts";

type Backend = Awaited<ReturnType<typeof createSlackSocketBackend>>;
type Lease = Awaited<ReturnType<Backend["open"]>>;
const OPEN = "https://slack.com/api/apps.connections.open";
const LOGICAL = "wss://wss-primary.slack.com/DYTEST-socket-backend";
const REFUSED = "Slack socket backend refused";
const backends: Backend[] = [];
const releases: (() => void)[] = [];

async function backend(): Promise<Backend> {
	const value = await createSlackSocketBackend({ ackTimeoutMs: 60_000 });
	value.fake.sendHello = false;
	backends.push(value);
	return value;
}
function connection(value: Backend) {
	const live = value.fake.live();
	if (live.length !== 1 || !live[0]) throw new Error("DYTEST expected one real connection");
	return live[0];
}
async function requestTicket(value: Backend, token = value.fake.appToken): Promise<Response> {
	return value.httpFake.fetch(OPEN, {
		method: "POST",
		headers: { authorization: `Bearer ${token}` },
		body: "",
	});
}
async function issue(value: Backend): Promise<string> {
	const response = await requestTicket(value);
	const body = (await response.json()) as { ok?: unknown; url?: unknown };
	if (!response.ok || body.ok !== true || typeof body.url !== "string")
		throw new Error("DYTEST expected a genuine provider ticket");
	return body.url;
}
async function open(
	value: Backend,
	messages: string[] = [],
	signal = new AbortController().signal,
): Promise<Lease> {
	expect(await issue(value)).toBe(LOGICAL);
	return value.open({
		signal,
		onData: (data) => {
			messages.push(data);
		},
	});
}
function hasEnvelope(messages: readonly string[], envelopeId: string): boolean {
	return messages.some(
		(text) => (JSON.parse(text) as { envelope_id?: unknown }).envelope_id === envelopeId,
	);
}
afterEach(async () => {
	for (const release of releases.splice(0)) release();
	const outcomes = await Promise.allSettled(backends.splice(0).map((value) => value.close()));
	expect(outcomes.filter((outcome) => outcome.status === "rejected")).toEqual([]);
});

describe("Slack Socket backend", () => {
	it("maps a genuine app ticket to a fixed WSS route and delivers the early hello", async () => {
		const value = await backend(),
			messages: string[] = [];
		value.fake.sendHello = true;
		expect(resolveFakeTransport(value.httpFake)?.host).toBe("slack.com");
		expect(value.httpFake).not.toBe(value.fake);
		expect(await issue(value)).toBe(LOGICAL);
		expect(value.logicalWss).toBe(LOGICAL);
		expect(value.fake.stats().tickets).toBe(1);
		const lease = await value.open({
			signal: new AbortController().signal,
			onData: (data) => {
				messages.push(data);
			},
		});
		await vi.waitFor(() =>
			expect(messages.map((text) => JSON.parse(text).type)).toContain("hello"),
		);
		expect(value.fake.stats().tickets).toBe(0);
		expect(value.fake.live()).toHaveLength(1);
		await lease.close();
	});

	it("refuses opening without a provider-issued ticket", async () => {
		const value = await backend(),
			received = vi.fn();
		await expect(
			value.open({ signal: new AbortController().signal, onData: received }),
		).rejects.toThrow(REFUSED);
		expect(value.fake.connections).toHaveLength(0);
		expect(value.fake.stats().tickets).toBe(0);
		expect(received).not.toHaveBeenCalled();
	});

	it("preserves genuine provider authentication refusals without issuing a ticket", async () => {
		const value = await backend();
		for (const token of [value.fake.userToken, "DYTEST-not-an-app-token"]) {
			const response = await requestTicket(value, token);
			expect(response.status).toBe(200);
			expect(await response.json()).toMatchObject({ ok: false });
		}
		expect(value.fake.stats().tickets).toBe(0);
		await expect(value.open({ signal: new AbortController().signal, onData() {} })).rejects.toThrow(
			REFUSED,
		);
		expect(value.fake.connections).toHaveLength(0);
	});

	it("refuses arbitrary HTTP destinations and methods without creating tickets", async () => {
		const value = await backend();
		for (const [url, method] of [
			["https://not-slack.invalid/api/apps.connections.open", "POST"],
			["https://slack.com/api/other", "POST"],
			[OPEN, "GET"],
		] as const) {
			const response = await value.httpFake.fetch(url, {
				method,
				headers: { authorization: `Bearer ${value.fake.appToken}` },
			});
			expect(response.ok).toBe(false);
		}
		expect(value.fake.stats().tickets).toBe(0);
		expect(value.fake.connections).toHaveLength(0);
	});

	it("serializes pending tickets and live leases and permits a fresh lease after close", async () => {
		const value = await backend();
		expect(await issue(value)).toBe(LOGICAL);
		const overlappingTicket = await requestTicket(value);
		expect(overlappingTicket.status).toBe(409);
		expect(await overlappingTicket.json()).toEqual({ ok: false, error: "fixture_refused" });
		expect(value.fake.stats().tickets).toBe(1);
		const first = await value.open({ signal: new AbortController().signal, onData() {} });
		const firstConnection = connection(value);
		expect((await requestTicket(value)).status).toBe(409);
		await expect(value.open({ signal: new AbortController().signal, onData() {} })).rejects.toThrow(
			REFUSED,
		);
		expect(value.fake.connections).toHaveLength(1);
		await first.close();
		await expect(value.open({ signal: new AbortController().signal, onData() {} })).rejects.toThrow(
			REFUSED,
		);
		const second = await open(value);
		expect(connection(value).id).not.toBe(firstConnection.id);
		expect(value.fake.stats().tickets).toBe(0);
		await second.close();
	});

	it("awaits a genuine matching acknowledgement receipt", async () => {
		const value = await backend(),
			messages: string[] = [];
		const lease = await open(value, messages),
			handle = connection(value);
		const envelope = value.fake.deliver({
			event_id: "DYTEST-accepted",
			event: { type: "message", text: "DYTEST body" },
		});
		await vi.waitFor(() => expect(hasEnvelope(messages, envelope.envelopeId)).toBe(true));
		expect(value.fake.acksFor(envelope.envelopeId)).toEqual([]);
		await lease.ack(envelope.envelopeId);
		expect(value.fake.acksFor(envelope.envelopeId)).toEqual([
			{
				connection: handle.id,
				envelopeId: envelope.envelopeId,
				accepted: true,
				dropped: false,
			},
		]);
		expect(envelope.acknowledged).toBe(true);
		expect(value.fake.stats().pending).toBe(0);
		await lease.close();
	});

	it("refuses a dropped acknowledgement instead of equating send completion with acceptance", async () => {
		const value = await backend(),
			messages: string[] = [];
		const lease = await open(value, messages);
		value.fake.dropAcks = 1;
		const envelope = value.fake.deliver({
			event_id: "DYTEST-dropped",
			event: { type: "message", text: "DYTEST body" },
		});
		await vi.waitFor(() => expect(hasEnvelope(messages, envelope.envelopeId)).toBe(true));
		await expect(lease.ack(envelope.envelopeId)).rejects.toThrow(REFUSED);
		expect(value.fake.acksFor(envelope.envelopeId)).toEqual([
			{
				connection: connection(value).id,
				envelopeId: envelope.envelopeId,
				accepted: true,
				dropped: true,
			},
		]);
		expect(envelope.acknowledged).toBe(false);
		await lease.close();
	});

	it("refuses an unknown envelope id before any wire acknowledgement", async () => {
		const value = await backend(),
			messages: string[] = [];
		const lease = await open(value, messages);
		const envelope = value.fake.deliver({
			event_id: "DYTEST-known",
			event: { type: "message", text: "DYTEST body" },
		});
		await vi.waitFor(() => expect(hasEnvelope(messages, envelope.envelopeId)).toBe(true));
		const unknown = (envelope.envelopeId[0] === "0" ? "1" : "0") + envelope.envelopeId.slice(1);
		await expect(lease.ack(unknown)).rejects.toThrow(REFUSED);
		expect(value.fake.acks).toEqual([]);
		await lease.ack(envelope.envelopeId);
		expect(envelope.acknowledged).toBe(true);
		await lease.close();
	});

	it("preserves the pending ticket when an already-aborted open is refused", async () => {
		const value = await backend(),
			cancel = new AbortController();
		await issue(value);
		cancel.abort();
		await expect(value.open({ signal: cancel.signal, onData() {} })).rejects.toThrow(REFUSED);
		expect(value.fake.stats().tickets).toBe(1);
		expect(value.fake.connections).toHaveLength(0);
		const lease = await value.open({ signal: new AbortController().signal, onData() {} });
		expect(value.fake.stats().tickets).toBe(0);
		await lease.close();
	});

	it("joins cancellation of an opening client without publishing a late lease", async () => {
		const value = await backend(),
			cancel = new AbortController(),
			received = vi.fn();
		await issue(value);
		const opening = value.open({ signal: cancel.signal, onData: received });
		const refusedOpening = expect(opening).rejects.toThrow(REFUSED);
		cancel.abort();
		await refusedOpening;
		await value.close();
		expect(value.fake.stats()).toEqual({
			tickets: 0,
			connections: 0,
			pending: 0,
			timers: 0,
			http: 0,
		});
		expect(received).not.toHaveBeenCalled();
	});

	it("memoizes close around actual termination and drops messages after caller abort", async () => {
		const value = await backend(),
			cancel = new AbortController(),
			messages: string[] = [];
		const lease = await open(value, messages, cancel.signal),
			handle = connection(value);
		value.fake.frame(handle, { type: "dytest_before_abort" });
		await vi.waitFor(() =>
			expect(messages.map((text) => JSON.parse(text).type)).toEqual(["dytest_before_abort"]),
		);
		cancel.abort();
		value.fake.frame(handle, { type: "dytest_after_abort" });
		const closing = lease.close();
		expect(lease.close()).toBe(closing);
		expect(closing).toBe(lease.closed);
		expect(await closing).toBeUndefined();
		await vi.waitFor(() => expect(handle.closedCode).not.toBeNull());
		expect(messages.map((text) => JSON.parse(text).type)).toEqual(["dytest_before_abort"]);
		const disposal = value.close();
		expect(value.close()).toBe(disposal);
		await disposal;
	});

	it("waits for an actual pending data callback after client termination", async () => {
		const value = await backend(),
			held = Promise.withResolvers<void>(),
			entered = Promise.withResolvers<void>();
		releases.push(() => held.resolve());
		const seen: string[] = [];
		await issue(value);
		const lease = await value.open({
			signal: new AbortController().signal,
			async onData(data) {
				const type = (JSON.parse(data) as { type: string }).type;
				seen.push(type);
				if (type === "dytest_held") {
					entered.resolve();
					await held.promise;
				}
			},
		});
		const handle = connection(value);
		value.fake.frame(handle, { type: "dytest_held" });
		value.fake.frame(handle, { type: "dytest_queued" });
		await entered.promise;
		expect(seen).toEqual(["dytest_held"]);
		let finished = false;
		const disposal = value.close().then(() => {
			finished = true;
		});
		await lease.closed;
		await value.fake.close();
		await nextTurn();
		expect(finished).toBe(false);
		held.resolve();
		await disposal;
		expect(seen).toEqual(["dytest_held"]);
	});
});
