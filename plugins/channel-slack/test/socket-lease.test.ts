import type { HostMethod } from "@draftyak/protocol/host-channel";
import { MAX_INLINE_BYTES } from "@draftyak/protocol/normalized-change";
import { type HostChannel, memoryHost } from "@draftyak/sdk/host";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSlackSocketLease } from "../src/socket-lease.ts";

interface Gate {
	readonly promise: Promise<void>;
	release(): void;
}

function gate(): Gate {
	let release = (): void => {};
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release };
}

async function flush(): Promise<void> {
	for (let at = 0; at < 32; at++) await Promise.resolve();
}

async function until(condition: () => boolean): Promise<void> {
	for (let at = 0; at < 128; at++) {
		if (condition()) return;
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
	expect(condition()).toBe(true);
}

const CONNECTION_URL = "wss://wss-primary.slack.com/link?ticket=DYTEST%2F%2B%3D";

function reply(body: unknown, status = 200, contentType = "application/json"): unknown {
	return {
		status,
		headers: [["content-type", contentType]],
		body: { base64: Buffer.from(JSON.stringify(body)).toString("base64url") },
	};
}

function event(envelopeId: string, eventId: string): string {
	return JSON.stringify({
		type: "events_api",
		envelope_id: envelopeId,
		payload: { event_id: eventId, event: { type: "message" } },
	});
}

interface Call {
	readonly method: HostMethod;
	readonly params: Record<string, unknown>;
	readonly signal: AbortSignal;
}

interface Fixture {
	readonly lease: ReturnType<typeof createSlackSocketLease>;
	readonly parent: ReturnType<typeof memoryHost>;
	readonly process: AbortController;
	readonly calls: Call[];
	readonly clientSignals: { method: HostMethod; signal: AbortSignal | undefined }[];
	readonly trace: string[];
	readonly socketId: string;
	count(method: HostMethod): number;
	last(method: HostMethod): Call | undefined;
	setResponse(value: unknown): void;
	fail(method: HostMethod, times?: number): void;
	hold(method: HostMethod): { release(): void };
	notify(data: string, socketId?: string): void;
	dispose(): Promise<void>;
}

function fixture(): Fixture {
	const process = new AbortController();
	const calls: Call[] = [];
	const clientSignals: { method: HostMethod; signal: AbortSignal | undefined }[] = [];
	const trace: string[] = [];
	const held = new Map<HostMethod, Gate>();
	const ownedGates: Gate[] = [];
	const failures = new Map<HostMethod, number>();
	let response = reply({ ok: true, url: CONNECTION_URL });
	let socketNumber = 0;
	const parent = memoryHost(async (method, raw, signal) => {
		const params = raw as Record<string, unknown>;
		calls.push({ method, params, signal });
		trace.push(`${method}:start`);
		const pending = held.get(method);
		if (pending) await pending.promise;
		const remaining = failures.get(method) ?? 0;
		if (remaining > 0) {
			failures.set(method, remaining - 1);
			throw new Error("DYTEST host failure");
		}
		let result: unknown;
		switch (method) {
			case "host/fetch":
				result = response;
				break;
			case "host/ws.open":
				result = { socketId: `socket-${++socketNumber}` };
				break;
			case "host/ws.send":
			case "host/ws.close":
			case "host/changed":
				result = null;
				break;
			default:
				throw new Error("DYTEST unexpected host method");
		}
		trace.push(`${method}:end`);
		return result;
	});
	// Observe original request signals while delegating all behavior to the real SDK memoryHost.
	const host: HostChannel = {
		request(method, params, options) {
			clientSignals.push({ method, signal: options?.signal });
			return parent.request(method, params, options);
		},
		subscribe: parent.subscribe.bind(parent),
		close: parent.close.bind(parent),
	};
	const lease = createSlackSocketLease(host, { plugin: "slack-dytest" }, process.signal);
	const owned: Fixture = {
		lease,
		parent,
		process,
		calls,
		clientSignals,
		trace,
		get socketId() {
			return `socket-${socketNumber}`;
		},
		count(method: HostMethod) {
			return calls.filter((call) => call.method === method).length;
		},
		last(method: HostMethod) {
			return calls.filter((call) => call.method === method).at(-1);
		},
		setResponse(value: unknown) {
			response = value;
		},
		fail(method: HostMethod, times = 1) {
			failures.set(method, times);
		},
		hold(method: HostMethod) {
			const pending = gate();
			ownedGates.push(pending);
			held.set(method, pending);
			return {
				release() {
					if (held.get(method) === pending) held.delete(method);
					pending.release();
				},
			};
		},
		notify(data: string, socketId = `socket-${socketNumber}`) {
			parent.notify({ jsonrpc: "2.0", method: "host/ws.message", params: { socketId, data } });
		},
		async dispose() {
			for (const pending of ownedGates) pending.release();
			held.clear();
			try {
				await lease.close();
			} finally {
				parent.close();
			}
		},
	};
	fixtures.push(owned);
	return owned;
}

const fixtures: Fixture[] = [];

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
});

afterEach(async () => {
	try {
		for (const owned of fixtures) await owned.dispose();
	} finally {
		fixtures.length = 0;
		vi.useRealTimers();
	}
});

describe("Slack socket lease over the SDK memory host", () => {
	it("uses the fixed credential-free handshake and forwards the returned WSS URL", async () => {
		const owned = fixture();
		const caller = new AbortController();
		const result = await owned.lease.listen(10_000, caller.signal);
		expect(result).toEqual({ leaseMs: 10_000 });
		expect(Object.isFrozen(result)).toBe(true);
		expect(owned.count("host/fetch")).toBe(1);
		expect(owned.last("host/fetch")?.params).toMatchObject({
			method: "POST",
			url: "https://slack.com/api/apps.connections.open",
		});
		const fetch = owned.last("host/fetch")?.params;
		for (const key of ["body", "sendTicket", "saveAs", "lookupPermit"])
			expect(fetch).not.toHaveProperty(key);
		expect(fetch?.headers).toEqual([]);
		expect(owned.last("host/ws.open")?.params).toEqual({ url: CONNECTION_URL });
		expect(owned.count("host/changed")).toBe(0);
		expect(owned.process.signal.aborted).toBe(false);
	});

	it.each(["wss://slack.com/link", "wss://edge.slack.com:443/socket?ticket=DYTEST"])(
		"accepts the retained Slack WSS host/default-port tuple %s",
		async (url) => {
			const owned = fixture();
			owned.setResponse(reply({ ok: true, url, connection_info: { app_id: "DYTEST" } }));
			await expect(owned.lease.listen(1000, new AbortController().signal)).resolves.toEqual({
				leaseMs: 1000,
			});
			expect(owned.count("host/ws.open")).toBe(1);
		},
	);

	it("refuses a non-Slack WSS handshake before issuing ws.open", async () => {
		const owned = fixture();
		owned.setResponse(reply({ ok: true, url: "wss://example.invalid/link?ticket=DYTEST" }));
		await expect(owned.lease.listen(1000, new AbortController().signal)).rejects.toThrow(
			/^SLACK_LEASE_INVALID$/,
		);
		expect(owned.count("host/ws.open")).toBe(0);
		expect(owned.count("host/changed")).toBe(0);
	});

	it.each([
		"https://slack.com/link",
		"ws://slack.com/link",
		"wss://slack.com.example.invalid/link",
		"wss://notslack.com/link",
		"wss://DYTEST@slack.com/link",
		"wss://slack.com:444/link",
		"wss://slack.com/link#fragment",
		"",
		`wss://slack.com/link?${"x".repeat(8192)}`,
	])("refuses an unsupported returned socket URL %s", async (url) => {
		const owned = fixture();
		owned.setResponse(reply({ ok: true, url }));
		await expect(owned.lease.listen(1000, new AbortController().signal)).rejects.toThrow(
			/^SLACK_LEASE_INVALID$/,
		);
		expect(owned.count("host/ws.open")).toBe(0);
	});

	it.each([
		{ body: { ok: false, error: "DYTEST refused" }, status: 200, media: "application/json" },
		{ body: { ok: true }, status: 200, media: "application/json" },
		{ body: { ok: true, url: CONNECTION_URL }, status: 503, media: "application/json" },
		{ body: { ok: true, url: CONNECTION_URL }, status: 200, media: "text/plain" },
	])(
		"refuses malformed or unsuccessful handshake data without opening a socket",
		async ({ body, status, media }) => {
			const owned = fixture();
			owned.setResponse(reply(body, status, media));
			await expect(owned.lease.listen(1000, new AbortController().signal)).rejects.toThrow(
				/^SLACK_LEASE_INVALID$/,
			);
			expect(owned.count("host/ws.open")).toBe(0);
		},
	);

	it("does not mistake an opaque response body reference for handshake bytes", async () => {
		const owned = fixture();
		owned.setResponse({
			status: 200,
			headers: [["content-type", "application/json"]],
			body: { ref: "01ARZ3NDEKTSV4RRFFQ69G5FAV" },
		});
		await expect(owned.lease.listen(1000, new AbortController().signal)).rejects.toThrow(
			/^SLACK_LEASE_INVALID$/,
		);
		expect(owned.count("host/ws.open")).toBe(0);
	});

	it("refuses malformed JSON and UTF-8 through the real SDK response body", async () => {
		for (const bytes of [Buffer.from("{"), Buffer.from([0xc3, 0x28])]) {
			const owned = fixture();
			owned.setResponse({
				status: 200,
				headers: [["content-type", "application/json"]],
				body: { base64: bytes.toString("base64url") },
			});
			await expect(owned.lease.listen(1000, new AbortController().signal)).rejects.toThrow(
				/^SLACK_LEASE_INVALID$/,
			);
			expect(owned.count("host/ws.open")).toBe(0);
		}
	});

	it("bounds an unexpected streamed handshake by the existing inline byte ceiling", async () => {
		const owned = fixture();
		owned.setResponse({
			status: 200,
			headers: [["content-type", "application/json"]],
			streamId: "handshake-stream",
		});
		const opening = owned.lease.listen(1000, new AbortController().signal);
		const refused = expect(opening).rejects.toThrow(/^SLACK_LEASE_INVALID$/);
		await until(() => owned.count("host/fetch") === 1);
		await flush();
		const bytes = Buffer.from(
			`${" ".repeat(MAX_INLINE_BYTES)}{"ok":true,"url":"${CONNECTION_URL}"}`,
		);
		for (const [sequence, body] of [
			bytes.subarray(0, MAX_INLINE_BYTES),
			bytes.subarray(MAX_INLINE_BYTES),
		].entries()) {
			owned.parent.notify({
				jsonrpc: "2.0",
				method: "host/stream.chunk",
				params: {
					streamId: "handshake-stream",
					sequence,
					base64: body.toString("base64url"),
					done: sequence === 1,
				},
			});
		}
		await refused;
		expect(owned.count("host/ws.open")).toBe(0);
	});

	it.each([0, 999, 600_001, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
		"refuses invalid lease duration %s before host work",
		async (duration) => {
			const owned = fixture();
			await expect(owned.lease.listen(duration, new AbortController().signal)).rejects.toThrow(
				/^SLACK_LEASE_INVALID$/,
			);
			expect(owned.calls).toEqual([]);
		},
	);

	it("accepts the existing maximum lease without extending a request timeout", async () => {
		const owned = fixture();
		await expect(owned.lease.listen(600_000, new AbortController().signal)).resolves.toEqual({
			leaseMs: 600_000,
		});
		expect(owned.count("host/fetch")).toBe(1);
		expect(owned.count("host/ws.open")).toBe(1);
	});

	it("refuses a caller already cancelled without issuing the handshake", async () => {
		const owned = fixture();
		const caller = new AbortController();
		caller.abort(new Error("DYTEST private reason"));
		await expect(owned.lease.listen(1000, caller.signal)).rejects.toThrow(/^SLACK_LEASE_ABORTED$/);
		expect(owned.calls).toEqual([]);
	});

	it("rejects opening cancellation promptly and closes the late genuinely returned socket", async () => {
		const owned = fixture();
		const blocked = owned.hold("host/ws.open");
		const caller = new AbortController();
		const opening = owned.lease.listen(10_000, caller.signal);
		const refused = expect(opening).rejects.toThrow(/^SLACK_LEASE_ABORTED$/);
		await until(() => owned.count("host/ws.open") === 1);
		caller.abort();
		await refused;
		expect(owned.count("host/ws.close")).toBe(0);
		blocked.release();
		await until(() => owned.count("host/ws.close") === 1);
		expect(owned.last("host/ws.close")?.params).toEqual({ socketId: "socket-1" });
		expect(owned.count("host/changed")).toBe(0);
		expect(owned.process.signal.aborted).toBe(false);
		await flush();
		await expect(owned.lease.listen(1000, new AbortController().signal)).resolves.toEqual({
			leaseMs: 1000,
		});
	});

	it("keeps a cancelled opening tracked while its handshake settles, without adopting its URL", async () => {
		const owned = fixture();
		const blocked = owned.hold("host/fetch");
		const caller = new AbortController();
		const opening = owned.lease.listen(10_000, caller.signal);
		const refused = expect(opening).rejects.toThrow(/^SLACK_LEASE_ABORTED$/);
		await until(() => owned.count("host/fetch") === 1);
		caller.abort();
		await refused;
		blocked.release();
		await flush();
		expect(owned.count("host/ws.open")).toBe(0);
		expect(owned.count("host/changed")).toBe(0);
	});

	it("rejects a parallel opening and a new listen while owned close is pending", async () => {
		const owned = fixture();
		const openGate = owned.hold("host/ws.open");
		const first = owned.lease.listen(10_000, new AbortController().signal);
		await until(() => owned.count("host/ws.open") === 1);
		await expect(owned.lease.listen(1000, new AbortController().signal)).rejects.toThrow(
			/^SLACK_LEASE_FAILED$/,
		);
		openGate.release();
		await first;
		const closeGate = owned.hold("host/ws.close");
		await vi.advanceTimersByTimeAsync(10_000);
		await until(() => owned.count("host/ws.close") === 1);
		await expect(owned.lease.listen(1000, new AbortController().signal)).rejects.toThrow(
			/^SLACK_LEASE_FAILED$/,
		);
		closeGate.release();
		await flush();
		await expect(owned.lease.listen(1000, new AbortController().signal)).resolves.toEqual({
			leaseMs: 1000,
		});
	});

	it("detaches the opening caller signal at commit while the live lease still ACKs and notifies", async () => {
		const owned = fixture();
		const caller = new AbortController();
		await owned.lease.listen(10_000, caller.signal);
		caller.abort();
		owned.notify(event("envelope-1", "event-1"));
		await until(() => owned.count("host/changed") === 1);
		expect(owned.last("host/ws.send")?.params).toEqual({
			socketId: "socket-1",
			envelopeId: "envelope-1",
		});
		expect(owned.count("host/ws.close")).toBe(0);
		expect(owned.process.signal.aborted).toBe(false);
	});

	it("uses the delivered processor's ACK-before-notify and event-ID deduplication", async () => {
		const owned = fixture();
		await owned.lease.listen(10_000, new AbortController().signal);
		const blockedAck = owned.hold("host/ws.send");
		owned.notify(event("envelope-1", "event-1"));
		await until(() => owned.count("host/ws.send") === 1);
		expect(owned.count("host/changed")).toBe(0);
		blockedAck.release();
		await until(() => owned.count("host/changed") === 1);
		owned.notify(event("envelope-2", "event-1"));
		await until(() => owned.count("host/ws.send") === 2);
		await flush();
		expect(owned.count("host/changed")).toBe(1);
		expect(owned.trace.indexOf("host/ws.send:end")).toBeLessThan(
			owned.trace.indexOf("host/changed:start"),
		);
	});

	it("renews only on an explicit live listen without opening a second socket", async () => {
		const owned = fixture();
		await owned.lease.listen(1000, new AbortController().signal);
		await vi.advanceTimersByTimeAsync(500);
		const renewedCaller = new AbortController();
		await expect(owned.lease.listen(2000, renewedCaller.signal)).resolves.toEqual({
			leaseMs: 2000,
		});
		renewedCaller.abort();
		await vi.advanceTimersByTimeAsync(1999);
		expect(owned.count("host/ws.close")).toBe(0);
		await vi.advanceTimersByTimeAsync(1);
		await until(() => owned.count("host/ws.close") === 1);
		expect(owned.count("host/fetch")).toBe(1);
		expect(owned.count("host/ws.open")).toBe(1);
	});

	it("expires by monotonic elapsed time despite a wall-clock jump and can start a new lease", async () => {
		const owned = fixture();
		await owned.lease.listen(1000, new AbortController().signal);
		vi.setSystemTime(Date.now() + 86_400_000);
		await vi.advanceTimersByTimeAsync(999);
		expect(owned.count("host/ws.close")).toBe(0);
		await vi.advanceTimersByTimeAsync(1);
		await until(() => owned.count("host/ws.close") === 1);
		await flush();
		await expect(owned.lease.listen(1000, new AbortController().signal)).resolves.toEqual({
			leaseMs: 1000,
		});
		expect(owned.count("host/ws.open")).toBe(2);
	});

	it("fences callbacks and waits for owned close before aborting the connection context", async () => {
		const owned = fixture();
		await owned.lease.listen(10_000, new AbortController().signal);
		owned.notify(event("envelope-1", "event-1"));
		await until(() => owned.count("host/changed") === 1);
		const connectionSignal = owned.clientSignals.find(
			(call) => call.method === "host/ws.send",
		)?.signal;
		expect(connectionSignal?.aborted).toBe(false);
		const blocked = owned.hold("host/ws.close");
		const closing = owned.lease.close();
		await until(() => owned.count("host/ws.close") === 1);
		expect(connectionSignal?.aborted).toBe(false);
		owned.notify(event("late-envelope", "late-event"));
		await flush();
		expect(owned.count("host/ws.send")).toBe(1);
		expect(owned.count("host/changed")).toBe(1);
		blocked.release();
		await closing;
		expect(connectionSignal?.aborted).toBe(true);
		await owned.lease.close();
		expect(owned.count("host/ws.close")).toBe(1);
		await expect(owned.lease.listen(1000, new AbortController().signal)).rejects.toThrow(
			/^SLACK_LEASE_ABORTED$/,
		);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("close during opening waits for the known late socket and closes it once without commit", async () => {
		const owned = fixture();
		const blocked = owned.hold("host/ws.open");
		const listening = owned.lease.listen(10_000, new AbortController().signal);
		const refused = expect(listening).rejects.toThrow(/^SLACK_LEASE_ABORTED$/);
		await until(() => owned.count("host/ws.open") === 1);
		const closing = owned.lease.close();
		await refused;
		blocked.release();
		await closing;
		expect(owned.count("host/ws.close")).toBe(1);
		expect(owned.last("host/ws.close")?.params).toEqual({ socketId: "socket-1" });
		expect(owned.count("host/changed")).toBe(0);
		await expect(owned.lease.listen(1000, new AbortController().signal)).rejects.toThrow(
			/^SLACK_LEASE_ABORTED$/,
		);
	});

	it("ignores hello and reconnects only after disconnect with the fixed delay", async () => {
		const owned = fixture();
		await owned.lease.listen(10_000, new AbortController().signal);
		owned.notify(JSON.stringify({ type: "hello" }));
		await flush();
		expect(owned.count("host/ws.send")).toBe(0);
		expect(owned.count("host/ws.open")).toBe(1);
		owned.notify(JSON.stringify({ type: "disconnect" }));
		await until(() => owned.count("host/ws.close") === 1);
		await vi.advanceTimersByTimeAsync(999);
		expect(owned.count("host/ws.open")).toBe(1);
		await vi.advanceTimersByTimeAsync(1);
		await until(() => owned.count("host/ws.open") === 2);
		expect(owned.count("host/fetch")).toBe(2);
	});

	it("ACKs an enveloped disconnect before closing its socket", async () => {
		const owned = fixture();
		await owned.lease.listen(10_000, new AbortController().signal);
		const blockedAck = owned.hold("host/ws.send");
		owned.notify(JSON.stringify({ type: "disconnect", envelope_id: "disconnect-1" }));
		await until(() => owned.count("host/ws.send") === 1);
		expect(owned.count("host/ws.close")).toBe(0);
		blockedAck.release();
		await until(() => owned.count("host/ws.close") === 1);
		expect(owned.trace.indexOf("host/ws.send:end")).toBeLessThan(
			owned.trace.indexOf("host/ws.close:start"),
		);
		expect(owned.count("host/changed")).toBe(0);
	});

	it("limits reconnects per lease and requires an explicit listen after exhaustion", async () => {
		const owned = fixture();
		await owned.lease.listen(60_000, new AbortController().signal);
		for (let retry = 0; retry < 3; retry++) {
			owned.notify(JSON.stringify({ type: "disconnect" }));
			await until(() => owned.count("host/ws.close") === retry + 1);
			await vi.advanceTimersByTimeAsync(1000);
			await until(() => owned.count("host/ws.open") === retry + 2);
		}
		owned.notify(JSON.stringify({ type: "disconnect" }));
		await until(() => owned.count("host/ws.close") === 4);
		await vi.advanceTimersByTimeAsync(10_000);
		expect(owned.count("host/ws.open")).toBe(4);
		await expect(owned.lease.listen(1000, new AbortController().signal)).resolves.toEqual({
			leaseMs: 1000,
		});
		expect(owned.count("host/ws.open")).toBe(5);
	});

	it("does not extend the original lease deadline while reconnecting", async () => {
		const owned = fixture();
		await owned.lease.listen(1500, new AbortController().signal);
		await vi.advanceTimersByTimeAsync(1000);
		owned.notify(JSON.stringify({ type: "disconnect" }));
		await until(() => owned.count("host/ws.close") === 1);
		await vi.advanceTimersByTimeAsync(500);
		await vi.advanceTimersByTimeAsync(1000);
		expect(owned.count("host/ws.open")).toBe(1);
		expect(owned.count("host/fetch")).toBe(1);
		await expect(owned.lease.listen(1000, new AbortController().signal)).resolves.toEqual({
			leaseMs: 1000,
		});
	});

	it("accepts sixteen combined in-flight and queued messages without dropping their hints", async () => {
		const owned = fixture();
		await owned.lease.listen(60_000, new AbortController().signal);
		const blockedAck = owned.hold("host/ws.send");
		owned.notify(event("envelope-0", "event-0"));
		await until(() => owned.count("host/ws.send") === 1);
		for (let at = 1; at < 16; at++) owned.notify(event(`envelope-${at}`, `event-${at}`));
		blockedAck.release();
		await until(() => owned.count("host/changed") === 16);
		expect(owned.count("host/ws.send")).toBe(16);
		expect(owned.count("host/ws.close")).toBe(0);
	});

	it("bounds queued plus in-flight notifications and never notifies after disposal", async () => {
		const owned = fixture();
		await owned.lease.listen(60_000, new AbortController().signal);
		const blockedAck = owned.hold("host/ws.send");
		owned.notify(event("envelope-0", "event-0"));
		await until(() => owned.count("host/ws.send") === 1);
		for (let at = 1; at < 17; at++) owned.notify(event(`envelope-${at}`, `event-${at}`));
		await flush();
		blockedAck.release();
		await until(() => owned.count("host/ws.close") === 1);
		expect(owned.count("host/changed")).toBe(0);
		expect(owned.count("host/ws.send")).toBe(1);
		await owned.lease.close();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("bounds total pending notification bytes independently of the message-count ceiling", async () => {
		const owned = fixture();
		await owned.lease.listen(60_000, new AbortController().signal);
		const blockedAck = owned.hold("host/ws.send");
		const large = (at: number) =>
			JSON.stringify({
				type: "events_api",
				envelope_id: `envelope-${at}`,
				payload: {
					event_id: `event-${at}`,
					event: { type: "message" },
					ignored: "x".repeat(270_000),
				},
			});
		owned.notify(large(0));
		await until(() => owned.count("host/ws.send") === 1);
		for (let at = 1; at < 4; at++) owned.notify(large(at));
		await flush();
		blockedAck.release();
		await until(() => owned.count("host/ws.close") === 1);
		expect(owned.count("host/changed")).toBe(0);
		expect(owned.count("host/ws.send")).toBe(1);
	});

	it("maps a handshake host failure to the fixed safe error without passing through its cause", async () => {
		const owned = fixture();
		owned.fail("host/fetch");
		const result = owned.lease.listen(1000, new AbortController().signal);
		await expect(result).rejects.toThrow(/^SLACK_LEASE_FAILED$/);
		await expect(result).rejects.not.toHaveProperty("cause");
		expect(owned.count("host/ws.open")).toBe(0);
	});

	it("treats process cancellation as terminal without creating another lease", async () => {
		const owned = fixture();
		await owned.lease.listen(10_000, new AbortController().signal);
		owned.process.abort();
		await flush();
		owned.notify(event("late-envelope", "late-event"));
		await flush();
		expect(owned.count("host/changed")).toBe(0);
		expect(owned.count("host/ws.send")).toBe(0);
		await expect(owned.lease.listen(1000, new AbortController().signal)).rejects.toThrow(
			/^SLACK_LEASE_ABORTED$/,
		);
		await owned.lease.close();
		expect(owned.process.signal.aborted).toBe(true);
	});
});
