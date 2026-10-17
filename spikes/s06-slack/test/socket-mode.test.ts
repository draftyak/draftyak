import { afterEach, describe, expect, it } from "vitest";
import { type Clock, MAX_RETRY_AFTER_MS } from "../src/api.ts";
import type { SlackEvent } from "../src/reduce.ts";
import {
	runSocketMode,
	type SocketModeOptions,
	type SocketState,
	type StopReason,
	slackSocketUrl,
} from "../src/socket-mode.ts";
import { type Envelope, FakeSlack, fakeToken, messageEvent, OWNER, until } from "./fake-slack.ts";

const CANARY = "canary-text-51c9";

// Backoff and Retry-After waits run on this clock: recorded, then over at once.
function recordingClock(): Clock & { readonly waits: number[] } {
	const waits: number[] = [];
	let now = Date.UTC(2026, 9, 17, 12);
	return {
		waits,
		now: () => now,
		delay: async (ms, signal) => {
			signal?.throwIfAborted();
			waits.push(ms);
			now += ms;
			await new Promise((resolve) => setImmediate(resolve));
		},
	};
}

const loopback = (url: URL): boolean => url.protocol === "ws:" && url.hostname === "127.0.0.1";

interface Running {
	readonly events: SlackEvent[];
	readonly states: SocketState[];
	readonly clock: ReturnType<typeof recordingClock>;
	readonly done: Promise<StopReason>;
	stop(): Promise<StopReason>;
}

let fake: FakeSlack;
let running: Running | undefined;

afterEach(async () => {
	await running?.stop();
	running = undefined;
	await fake?.close();
});

async function start(overrides: Partial<SocketModeOptions> = {}): Promise<Running> {
	fake ??= await new FakeSlack().start();
	const events: SlackEvent[] = [];
	const states: SocketState[] = [];
	const clock = recordingClock();
	const controller = new AbortController();
	const done = runSocketMode({
		appToken: fake.appToken,
		apiBase: fake.apiBase,
		allowSocketUrl: loopback,
		clock,
		random: () => 1,
		helloTimeoutMs: 5000,
		onEvent: (event) => events.push(event),
		onState: (state) => states.push(state),
		signal: controller.signal,
		...overrides,
	});
	running = {
		events,
		states,
		clock,
		done,
		stop: () => {
			controller.abort();
			return done;
		},
	};
	return running;
}

const ready = (run: Running): number => run.states.filter((state) => state.kind === "ready").length;

async function connected(run: Running, count = 1): Promise<void> {
	await until(() => ready(run) >= count && fake.live().length > 0, `${count} ready connection(s)`);
}

function newest() {
	const connection = fake.live().at(-1);
	if (connection === undefined) throw new Error("no live connection");
	return connection;
}

// Each envelope gets exactly one ack from the client, carrying its envelope_id and nothing else.
function ackedOnce(envelope: Envelope): void {
	const acks = fake.acksFor(envelope.envelopeId);
	expect(acks).toHaveLength(1);
	expect(acks[0]?.raw).toBe(JSON.stringify({ envelope_id: envelope.envelopeId }));
}

const dm = (ts: string, eventId: string): object =>
	messageEvent(
		{ channel: "D0DM00001", channel_type: "im", user: "U0OTHER01", ts, text: CANARY },
		eventId,
	);

describe("Socket Mode", () => {
	it("opens with the app-level token and acks every envelope once, with its envelope_id alone", async () => {
		fake = await new FakeSlack().start();
		const run = await start();
		await connected(run);
		const [open] = fake.calls("apps.connections.open");
		expect(open).toMatchObject({ verb: "POST", params: {} });
		const sent = [
			fake.deliver(dm("1760000001.000100", "EvDM000001")),
			fake.deliver(
				messageEvent(
					{
						channel: "G0MPIM001",
						channel_type: "mpim",
						user: "U0OTHER01",
						ts: "1760000002.000200",
					},
					"EvMPIM0001",
				),
			),
			fake.deliver(
				messageEvent(
					{ channel: "C0CHAN001", channel_type: "channel", user: OWNER, ts: "1760000003.000300" },
					"EvCHAN0001",
				),
			),
		];
		await until(() => fake.acks.length >= 3 && run.events.length >= 3, "three acks and events");
		for (const envelope of sent) ackedOnce(envelope);
		expect(run.events.map((event) => event.kind === "message" && event.channelType)).toEqual([
			"im",
			"mpim",
			"channel",
		]);
		expect(JSON.stringify([run.events, run.states])).not.toContain(CANARY);
		expect(await run.stop()).toBe("aborted");
		await until(() => fake.connections[0]?.closedCode !== null, "the client's close");
		expect(fake.connections[0]?.closedCode).toBe(1000);
	});

	it("acks every envelope type but hands only Events API events on, as ids and timestamps", async () => {
		fake = await new FakeSlack().start();
		const run = await start();
		await connected(run);
		const command = fake.deliver(
			{ command: "/draft", text: CANARY, user_name: CANARY },
			{ type: "slash_commands", acceptsResponsePayload: true },
		);
		const action = fake.deliver(
			{ type: "block_actions", actions: [{ value: CANARY }], message: { text: CANARY } },
			{ type: "interactive", acceptsResponsePayload: true },
		);
		const reaction = fake.deliver({
			type: "event_callback",
			event_id: "EvREACT001",
			event: { type: "reaction_added", reaction: CANARY },
		});
		const event = fake.deliver(dm("1760000004.000400", "EvDM000002"));
		await until(() => fake.acks.length >= 4, "four acks");
		for (const envelope of [command, action, reaction, event]) ackedOnce(envelope);
		await until(() => run.events.length >= 1, "the event");
		expect(run.events).toEqual([
			expect.objectContaining({ kind: "message", eventId: "EvDM000002", channel: "D0DM00001" }),
		]);
		expect(JSON.stringify([run.events, run.states])).not.toContain(CANARY);
	});

	it("reconnects after a dropped connection, with backoff and a new single-use ticket", async () => {
		fake = await new FakeSlack().start();
		const run = await start();
		await connected(run);
		fake.terminate(newest());
		await connected(run, 2);
		expect(fake.calls("apps.connections.open")).toHaveLength(2);
		expect(new Set(fake.tickets).size).toBe(2);
		expect(run.clock.waits).toEqual([1000]);
		const envelope = fake.deliver(dm("1760000005.000500", "EvDM000003"));
		await until(
			() => run.events.length >= 1 && fake.acksFor(envelope.envelopeId).length > 0,
			"the event and its ack on the new connection",
		);
		ackedOnce(envelope);
		expect(envelope.connection).toBe(2);
	});

	it("doubles the backoff while apps.connections.open fails, and resets it after hello", async () => {
		fake = await new FakeSlack().start();
		fake.fail("apps.connections.open", 3, "internal_error");
		fake.fail("apps.connections.open", 1, "service_unavailable", 503);
		const run = await start({ backoffMs: { base: 1000, max: 5000 } });
		await connected(run);
		expect(run.clock.waits).toEqual([1000, 2000, 4000, 5000]);
		fake.terminate(newest());
		await connected(run, 2);
		expect(run.clock.waits).toEqual([1000, 2000, 4000, 5000, 1000]);
	});

	it("waits out Retry-After when apps.connections.open is rate limited", async () => {
		fake = await new FakeSlack().start();
		fake.rateLimit("apps.connections.open", 2, "7");
		fake.rateLimit("apps.connections.open", 1, null);
		const run = await start();
		await connected(run);
		expect(run.clock.waits).toEqual([7000, 7000, 60_000]);
		expect(run.states).toContainEqual({ kind: "waiting", reason: "rate_limited", ms: 7000 });
		expect(fake.calls("apps.connections.open")).toHaveLength(4);
	});

	it("waits at least the backoff step and at most 15 minutes, whatever Retry-After says", async () => {
		fake = await new FakeSlack().start();
		fake.rateLimit("apps.connections.open", 1, "0");
		fake.rateLimit("apps.connections.open", 1, "Thu, 01 Jan 2026 00:00:00 GMT");
		fake.rateLimit("apps.connections.open", 1, "999999999");
		const run = await start();
		await connected(run);
		expect(run.clock.waits).toEqual([1000, 2000, MAX_RETRY_AFTER_MS]);
		expect(MAX_RETRY_AFTER_MS).toBe(15 * 60_000);
		expect(fake.calls("apps.connections.open")).toHaveLength(4);
	});

	it("refresh_requested: opens the next connection first, then closes the old one", async () => {
		fake = await new FakeSlack().start();
		const run = await start();
		await connected(run);
		const first = newest();
		fake.disconnect(first, "refresh_requested", null);
		await until(() => first.closedCode !== null, "the old connection's close");
		expect(first.closedCode).toBe(1000);
		expect(fake.live()).toHaveLength(1);
		expect(newest().id).toBe(2);
		expect(run.clock.waits).toEqual([]);
		expect(run.states).toContainEqual({ kind: "refreshing", reason: "refresh_requested" });
		const envelope = fake.deliver(dm("1760000006.000600", "EvDM000004"));
		await until(
			() => run.events.length >= 1 && fake.acksFor(envelope.envelopeId).length > 0,
			"the event and its ack on the new connection",
		);
		ackedOnce(envelope);
	});

	it("answers warning and then refresh_requested with one replacement, even before its hello", async () => {
		fake = await new FakeSlack().start();
		fake.sendHello = false;
		const run = await start();
		await until(() => fake.live().length === 1, "the first connection");
		const first = newest();
		fake.frame(first, { type: "hello", num_connections: 1 });
		await connected(run);
		fake.disconnect(first, "warning", null);
		await until(() => fake.connections.length === 2, "the replacement connection");
		fake.disconnect(first, "refresh_requested", null);
		await until(
			() =>
				run.states.some(
					(state) => state.kind === "refreshing" && state.reason === "refresh_requested",
				),
			"the refresh_requested frame",
		);
		// A second replacement would have started connecting in the same step.
		expect(run.states.filter((state) => state.kind === "connecting")).toHaveLength(2);
		const second = fake.connections[1];
		if (second === undefined) throw new Error("no second connection");
		fake.frame(second, { type: "hello", num_connections: 2 });
		await until(() => first.closedCode !== null, "the old connection's close");
		expect(fake.calls("apps.connections.open")).toHaveLength(2);
		expect(fake.live().map((connection) => connection.id)).toEqual([second.id]);
	});

	it("warning: keeps acking on the old connection until the new one says hello", async () => {
		fake = await new FakeSlack().start();
		fake.sendHello = false;
		const run = await start();
		await until(() => fake.live().length === 1, "the first connection");
		const first = newest();
		fake.frame(first, { type: "hello", num_connections: 1 });
		await connected(run);
		fake.disconnect(first, "warning", 10_000);
		await until(() => fake.connections.length === 2, "the replacement connection");
		const late = fake.deliver(dm("1760000007.000700", "EvDM000005"), { connection: first });
		await until(() => fake.acksFor(late.envelopeId).length > 0, "the ack on the old connection");
		ackedOnce(late);
		expect(fake.acks.at(-1)?.connection).toBe(first.id);
		const second = fake.connections[1];
		if (second === undefined) throw new Error("no second connection");
		fake.frame(second, { type: "hello", num_connections: 2 });
		await until(() => first.closedCode !== null, "the old connection's close");
		expect(first.closedCode).toBe(1000);
		expect(run.events.map((event) => event.eventId)).toEqual(["EvDM000005"]);
		expect(run.states).toContainEqual({ kind: "refreshing", reason: "warning" });
	});

	it("link_disabled: stops without reconnecting", async () => {
		fake = await new FakeSlack().start();
		const run = await start();
		await connected(run);
		fake.disconnect(newest(), "link_disabled", 0);
		expect(await run.done).toBe("link_disabled");
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(fake.calls("apps.connections.open")).toHaveLength(1);
		expect(run.clock.waits).toEqual([]);
	});

	it("an unacked envelope comes again in a new envelope, is acked again, and reaches the consumer once", async () => {
		fake = await new FakeSlack().start();
		fake.ackTimeoutMs = 200;
		const run = await start();
		await connected(run);
		fake.dropAcks = 1;
		const first = fake.deliver(dm("1760000008.000800", "EvDM000006"));
		await until(() => fake.envelopes.some((each) => each.acknowledged), "an acked redelivery");
		await new Promise((resolve) => setTimeout(resolve, 300));
		const [, retry] = fake.envelopes;
		expect(retry).toMatchObject({ retryAttempt: 1, acknowledged: true });
		expect(fake.acksFor(first.envelopeId)[0]?.dropped).toBe(true);
		// However late the acks come, every envelope is acked exactly once and nothing follows the
		// first acknowledged one.
		for (const envelope of fake.envelopes) ackedOnce(envelope);
		expect(fake.envelopes.at(-1)?.acknowledged).toBe(true);
		expect(run.events.map((event) => event.eventId)).toEqual(["EvDM000006"]);
	});

	it("an envelope left unacked by a dropped connection arrives again on the next one", async () => {
		fake = await new FakeSlack().start();
		// Long enough for the drop and the reconnect to happen before Slack would redeliver.
		fake.ackTimeoutMs = 1000;
		const run = await start();
		await connected(run);
		fake.dropAcks = 1;
		const lost = fake.deliver(dm("1760000009.000900", "EvDM000007"));
		await until(() => fake.acksFor(lost.envelopeId).length > 0, "the lost ack");
		fake.terminate(newest());
		await connected(run, 2);
		await until(
			() => fake.envelopes.length >= 2 && fake.acks.length >= 2,
			"the redelivery and its ack",
		);
		const retry = fake.envelopes[1];
		if (retry === undefined) throw new Error("no redelivery");
		expect(retry).toMatchObject({ connection: 2, retryAttempt: 1 });
		ackedOnce(lost);
		ackedOnce(retry);
		expect(run.events.map((event) => event.eventId)).toEqual(["EvDM000007"]);
	});

	it("acks a repeated envelope_id on one connection once, and survives malformed frames", async () => {
		fake = await new FakeSlack().start();
		const run = await start();
		await connected(run);
		const connection = newest();
		const frame = {
			envelope_id: "a1b2c3",
			type: "events_api",
			payload: dm("1760000010.000100", "EvDM000008"),
		};
		fake.frame(connection, frame);
		fake.frame(connection, frame);
		for (const junk of ["not json", "[]", "null", JSON.stringify({ type: "events_api" })]) {
			connection.socket.send(junk);
		}
		fake.frame(connection, { envelope_id: `bad id ${CANARY}`, type: "events_api", payload: {} });
		const after = fake.deliver(dm("1760000011.000100", "EvDM000009"));
		// Acks arrive in order on one connection, so once the last one is in, every earlier one is.
		await until(
			() => run.events.length >= 2 && fake.acksFor(after.envelopeId).length > 0,
			"both events and the last ack",
		);
		ackedOnce(after);
		expect(fake.acks.filter((ack) => ack.envelopeId === "a1b2c3")).toHaveLength(1);
		expect(fake.acks).toHaveLength(2);
		expect(fake.live()).toHaveLength(1);
	});

	it("acks an envelope before it hands the event on", async () => {
		fake = await new FakeSlack().start();
		const order: string[] = [];
		class Recording extends WebSocket {
			send(data: Parameters<WebSocket["send"]>[0]): void {
				order.push(`ack ${JSON.parse(String(data)).envelope_id}`);
				super.send(data);
			}
		}
		const run = await start({
			WebSocket: Recording,
			onEvent: (event) => order.push(`event ${event.eventId}`),
		});
		await connected(run);
		const envelope = fake.deliver(dm("1760000014.000100", "EvDM000012"));
		await until(
			() => order.length >= 2 && fake.acksFor(envelope.envelopeId).length > 0,
			"the ack and the event",
		);
		expect(order).toEqual([`ack ${envelope.envelopeId}`, "event EvDM000012"]);
		ackedOnce(envelope);
	});

	it("keeps acking when the consumer throws", async () => {
		fake = await new FakeSlack().start();
		let calls = 0;
		const run = await start({
			onEvent: () => {
				calls++;
				throw new Error("consumer failed");
			},
		});
		await connected(run);
		const sent = [
			fake.deliver(dm("1760000012.000100", "EvDM000010")),
			fake.deliver(dm("1760000013.000100", "EvDM000011")),
		];
		await until(() => calls >= 2 && fake.acks.length >= 2, "both deliveries");
		for (const envelope of sent) ackedOnce(envelope);
	});

	it("closes a connection that never says hello and opens another", async () => {
		fake = await new FakeSlack().start();
		fake.sendHello = false;
		const run = await start({ helloTimeoutMs: 200 });
		await until(() => fake.connections.length === 1, "the first connection");
		const first = newest();
		fake.sendHello = true;
		await connected(run);
		expect(first.closedCode).toBe(4000);
		expect(run.clock.waits).toEqual([1000]);
	});

	it("refuses anything but an app-level token, before any request", async () => {
		fake = await new FakeSlack().start();
		for (const appToken of [fakeToken("xoxp"), fakeToken("xoxb"), ""]) {
			const options = { appToken, apiBase: fake.apiBase, onEvent: () => {} };
			await expect(runSocketMode(options)).rejects.toThrow("expected an app-level token");
		}
		expect(fake.requests).toHaveLength(0);
	});

	it("stops when the app-level token fails authentication", async () => {
		fake = await new FakeSlack().start();
		fake.fail("apps.connections.open", 1, "invalid_auth");
		const run = await start();
		expect(await run.done).toBe("auth");
		expect(fake.connections).toHaveLength(0);
	});

	it("connects only to wss: URLs on Slack's hosts", async () => {
		fake = await new FakeSlack().start();
		const run = await start({ allowSocketUrl: undefined });
		expect(await run.done).toBe("bad_url");
		expect(fake.connections).toHaveLength(0);
		const allowed = (href: string): boolean => slackSocketUrl(new URL(href));
		expect(allowed("wss://wss-primary.slack.com/link/?ticket=1&app_id=A1")).toBe(true);
		expect(allowed("wss://slack.com/link/")).toBe(true);
		expect(allowed("ws://wss-primary.slack.com/link/")).toBe(false);
		expect(allowed("wss://slack.com.example.net/link/")).toBe(false);
		expect(allowed("wss://evilslack.com/link/")).toBe(false);
		expect(allowed("wss://user:pass@wss-primary.slack.com/link/")).toBe(false);
		expect(allowed("wss://wss-primary.slack.com:8443/link/")).toBe(false);
		expect(allowed("https://wss-primary.slack.com/link/")).toBe(false);
	});
});
