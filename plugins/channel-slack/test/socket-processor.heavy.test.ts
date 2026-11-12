import type { SlackSocketAck, SlackSocketEnvelope } from "@draftyak/fakes/slack";
import { createPluginContext } from "@draftyak/sdk/context";
import { HostError, memoryHost } from "@draftyak/sdk/host";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSlackSocketProcessor, type SlackSocketResult } from "../src/socket-mode.ts";
import { createSlackSocketBackend } from "./fixtures/socket-backend/adapter.ts";

type Backend = Awaited<ReturnType<typeof createSlackSocketBackend>>;
type BackendLease = Awaited<ReturnType<Backend["open"]>>;
type Outcome = { readonly result: SlackSocketResult } | { readonly error: string };
interface HeldAck {
	readonly entered: Promise<string>;
	release(): void;
}
interface ProcessorFixture {
	readonly backend: Backend;
	readonly lease: BackendLease;
	readonly outcomes: Outcome[];
	readonly changes: { readonly receipts: readonly SlackSocketAck[] }[];
	readonly cancel: AbortController;
	expectedCloseFailure: boolean;
	holdNextAck(): HeldAck;
	deliver(eventId: string): SlackSocketEnvelope;
	repeat(envelope: SlackSocketEnvelope): void;
	disposeProcessor(): void;
	close(): Promise<void>;
}

const fixtures: ProcessorFixture[] = [];
const releases: (() => void)[] = [];
const REFUSED = "Slack socket backend refused";

async function fixture(): Promise<ProcessorFixture> {
	const backend = await createSlackSocketBackend({ ackTimeoutMs: 60_000 });
	backend.fake.sendHello = false;
	const cancel = new AbortController();
	const changes: { readonly receipts: readonly SlackSocketAck[] }[] = [];
	const outcomes: Outcome[] = [];
	const parent = memoryHost((method) => {
		if (method !== "host/changed") throw new HostError("UNSUPPORTED");
		changes.push({ receipts: [...backend.fake.acks] });
		return null;
	});
	const context = createPluginContext({ plugin: "slack-dytest" }, parent, cancel.signal);
	let processor: ReturnType<typeof createSlackSocketProcessor> | undefined;
	let held:
		| {
				readonly entered: (envelopeId: string) => void;
				readonly wait: Promise<void>;
		  }
		| undefined;
	let lease: BackendLease;
	try {
		const response = await backend.httpFake.fetch("https://slack.com/api/apps.connections.open", {
			method: "POST",
			headers: { authorization: `Bearer ${backend.fake.appToken}` },
			body: "",
		});
		const ticket = (await response.json()) as { ok?: unknown; url?: unknown };
		if (!response.ok || ticket.ok !== true || ticket.url !== backend.logicalWss)
			throw new Error("DYTEST expected an owned provider ticket");
		lease = await backend.open({
			signal: cancel.signal,
			async onData(data) {
				if (!processor) throw new Error("DYTEST provider started before the receiver");
				try {
					outcomes.push({ result: await processor.receive(data) });
				} catch (error) {
					outcomes.push({ error: error instanceof Error ? error.message : "DYTEST non-error" });
					throw error;
				}
			},
		});
		processor = createSlackSocketProcessor(context, {
			async sendAck(envelopeId) {
				const gate = held;
				held = undefined;
				if (gate) {
					gate.entered(envelopeId);
					await gate.wait;
				}
				await lease.ack(envelopeId);
			},
		});
	} catch (error) {
		parent.close();
		await backend.close();
		throw error;
	}
	const readyProcessor = processor;
	const value: ProcessorFixture = {
		backend,
		lease,
		outcomes,
		changes,
		cancel,
		expectedCloseFailure: false,
		holdNextAck() {
			if (held) throw new Error("DYTEST acknowledgement already held");
			const entered = Promise.withResolvers<string>();
			const gate = Promise.withResolvers<void>();
			held = { entered: entered.resolve, wait: gate.promise };
			const release = (): void => gate.resolve();
			releases.push(release);
			return { entered: entered.promise, release };
		},
		deliver(eventId) {
			return backend.fake.deliver({
				event_id: eventId,
				event: { type: "message", text: "DYTEST provider body" },
			});
		},
		repeat(envelope) {
			const connections = backend.fake.live();
			if (connections.length !== 1 || !connections[0])
				throw new Error("DYTEST expected one real socket");
			backend.fake.frame(connections[0], {
				type: "events_api",
				envelope_id: envelope.envelopeId,
				payload: envelope.payload,
			});
		},
		disposeProcessor: () => readyProcessor.dispose(),
		close() {
			readyProcessor.dispose();
			parent.close();
			return backend.close();
		},
	};
	fixtures.push(value);
	return value;
}

afterEach(async () => {
	for (const release of releases.splice(0)) release();
	const current = fixtures.splice(0);
	const cleanup = await Promise.allSettled(current.map((value) => value.close()));
	for (const [index, value] of current.entries()) {
		const result = cleanup[index];
		expect(result?.status).toBe(value.expectedCloseFailure ? "rejected" : "fulfilled");
		if (result?.status === "rejected") expect(result.reason).toEqual(new Error(REFUSED));
		expect(await value.lease.closed).toBeUndefined();
		expect(value.backend.fake.stats()).toEqual({
			tickets: 0,
			connections: 0,
			pending: 0,
			timers: 0,
			http: 0,
		});
	}
});

describe("Slack Socket processor over a real fake connection", () => {
	it("waits for the genuine acknowledgement before publishing a changed invalidation", async () => {
		const value = await fixture();
		const gate = value.holdNextAck();
		const envelope = value.deliver("DYTEST-ack-before-changed");
		expect(await gate.entered).toBe(envelope.envelopeId);
		expect(value.backend.fake.acksFor(envelope.envelopeId)).toEqual([]);
		expect(envelope.acknowledged).toBe(false);
		expect(value.outcomes).toEqual([]);
		expect(value.changes).toEqual([]);
		gate.release();
		await vi.waitFor(() => expect(value.outcomes).toEqual([{ result: "notified" }]));
		const receipts = value.backend.fake.acksFor(envelope.envelopeId);
		expect(receipts).toHaveLength(1);
		expect(receipts[0]).toMatchObject({
			envelopeId: envelope.envelopeId,
			accepted: true,
			dropped: false,
		});
		expect(value.changes).toEqual([{ receipts }]);
		expect(envelope.acknowledged).toBe(true);
	});

	it("acknowledges repeated envelopes and distinct envelopes while deduplicating the event id", async () => {
		const value = await fixture();
		const first = value.deliver("DYTEST-same-event");
		await vi.waitFor(() => expect(value.outcomes).toEqual([{ result: "notified" }]));
		value.repeat(first);
		await vi.waitFor(() =>
			expect(value.outcomes).toEqual([{ result: "notified" }, { result: "duplicate" }]),
		);
		const second = value.deliver("DYTEST-same-event");
		expect(second.envelopeId).not.toBe(first.envelopeId);
		await vi.waitFor(() => expect(value.outcomes).toHaveLength(3));
		expect(value.outcomes[2]).toEqual({ result: "duplicate" });
		expect(value.backend.fake.acksFor(first.envelopeId)).toHaveLength(2);
		expect(value.backend.fake.acksFor(second.envelopeId)).toHaveLength(1);
		expect(value.backend.fake.acks).toHaveLength(3);
		expect(value.backend.fake.acks.every((row) => row.accepted && !row.dropped)).toBe(true);
		expect(value.changes).toHaveLength(1);
		const distinct = value.deliver("DYTEST-next-event");
		await vi.waitFor(() => expect(value.outcomes).toHaveLength(4));
		expect(value.outcomes[3]).toEqual({ result: "notified" });
		expect(value.backend.fake.acksFor(distinct.envelopeId)).toHaveLength(1);
		expect(distinct.acknowledged).toBe(true);
		expect(value.changes).toHaveLength(2);
	});

	it("rejects a dropped acknowledgement without publishing changed and joins its failed callback", async () => {
		const value = await fixture();
		value.expectedCloseFailure = true;
		value.backend.fake.dropAcks = 1;
		const envelope = value.deliver("DYTEST-dropped-ack");
		await vi.waitFor(() => expect(value.outcomes).toEqual([{ error: "SLACK_SOCKET_INVALID" }]));
		expect(value.backend.fake.acksFor(envelope.envelopeId)).toEqual([
			expect.objectContaining({ envelopeId: envelope.envelopeId, accepted: true, dropped: true }),
		]);
		expect(envelope.acknowledged).toBe(false);
		expect(value.changes).toEqual([]);
		expect(await value.lease.closed).toBeUndefined();
		await expect(value.close()).rejects.toThrow(REFUSED);
		expect(value.backend.fake.stats()).toEqual({
			tickets: 0,
			connections: 0,
			pending: 0,
			timers: 0,
			http: 0,
		});
	});

	it("aborts a pending acknowledgement without sending it or publishing late changed", async () => {
		const value = await fixture();
		value.expectedCloseFailure = true;
		const gate = value.holdNextAck();
		const envelope = value.deliver("DYTEST-aborted-ack");
		expect(await gate.entered).toBe(envelope.envelopeId);
		value.cancel.abort();
		expect(await value.lease.closed).toBeUndefined();
		expect(value.backend.fake.acksFor(envelope.envelopeId)).toEqual([]);
		expect(value.changes).toEqual([]);
		gate.release();
		await vi.waitFor(() => expect(value.outcomes).toEqual([{ error: "SLACK_SOCKET_ABORTED" }]));
		expect(value.backend.fake.acksFor(envelope.envelopeId)).toEqual([]);
		expect(value.changes).toEqual([]);
	});

	it("refuses a newly delivered event after processor disposal before acknowledging it", async () => {
		const value = await fixture();
		value.expectedCloseFailure = true;
		value.disposeProcessor();
		const envelope = value.deliver("DYTEST-after-dispose");
		await vi.waitFor(() => expect(value.outcomes).toEqual([{ error: "SLACK_SOCKET_ABORTED" }]));
		expect(value.backend.fake.acksFor(envelope.envelopeId)).toEqual([]);
		expect(envelope.acknowledged).toBe(false);
		expect(value.changes).toEqual([]);
		expect(await value.lease.closed).toBeUndefined();
	});
});
