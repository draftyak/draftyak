import {
	HOST_MAX_ACTIVE_REQUESTS,
	HOST_MAX_WS_DATA_LENGTH,
	type HostMethod,
	type HostMethods,
} from "@draftyak/protocol/host-channel";
import { createPluginContext, type HostSocket, type PluginContext } from "@draftyak/sdk/context";
import { type HostRequestOptions, type MemoryHost, memoryHost } from "@draftyak/sdk/host";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createSlackSocketProcessor,
	MAX_SLACK_SOCKET_EVENT_IDS,
	type SlackSocketProcessor,
	type SlackSocketProcessorOptions,
	type SlackSocketResult,
} from "../src/socket-mode.ts";

const ENVELOPE = "00000000-0000-4000-8000-000000000001";
const OTHER_ENVELOPE = "00000000-0000-4000-8000-000000000002";
const deliveryId = (at: number): string =>
	`00000000-0000-4000-8000-${(at + 1).toString(16).padStart(12, "0")}`;
const turn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const wire = (eventId = "DYTEST-event", envelopeId = ENVELOPE): string =>
	JSON.stringify({
		envelope_id: envelopeId,
		type: "events_api",
		accepts_response_payload: false,
		retry_attempt: 0,
		retry_reason: "",
		payload: {
			event_id: eventId,
			event: { type: "message", text: "DYTEST content is not forwarded" },
		},
	});
const releases: (() => void)[] = [];
function gate() {
	const result = Promise.withResolvers<void>();
	releases.push(() => result.resolve());
	return result;
}
interface Hooks {
	ack?: () => void | Promise<void>;
	changed?: () => void | Promise<void>;
}
interface Trace {
	readonly method: HostMethod;
	readonly params: unknown;
}
interface SocketFixture {
	readonly context: PluginContext;
	readonly socket: HostSocket;
	readonly processor: SlackSocketProcessor;
	readonly shared: AbortController;
	readonly host: MemoryHost;
	readonly attempts: Trace[];
	readonly calls: Trace[];
	readonly unexpected: HostMethod[];
	readonly jobs: Promise<SlackSocketResult>[];
	readonly hostOperations: Promise<unknown>[];
	unsubscribe(): void;
	receive(data: unknown): Promise<SlackSocketResult>;
	emit(data: string, socketId?: string): Promise<SlackSocketResult> | undefined;
}
const fixtures: SocketFixture[] = [];
const network = vi.fn<typeof fetch>();

/** SDK requests and notifications only; no WebSocket, listener or network exists here. */
async function fixture(
	options?: SlackSocketProcessorOptions,
	hooks: Hooks = {},
): Promise<SocketFixture> {
	const shared = new AbortController();
	const attempts: Trace[] = [];
	const calls: Trace[] = [];
	const unexpected: HostMethod[] = [];
	const jobs: Promise<SlackSocketResult>[] = [];
	const hostOperations: Promise<unknown>[] = [];
	const host = memoryHost(async (method, params) => {
		calls.push({ method, params });
		switch (method) {
			case "host/ws.open":
				return { socketId: "dytest-socket" };
			case "host/ws.send":
				await hooks.ack?.();
				return null;
			case "host/changed":
				await hooks.changed?.();
				return null;
			default:
				unexpected.push(method);
				throw new Error("DYTEST unexpected host method");
		}
	});
	const request = host.request;
	host.request = function <M extends HostMethod>(
		method: M,
		params: HostMethods[M]["params"],
		requestOptions?: HostRequestOptions,
	): Promise<HostMethods[M]["result"]> {
		attempts.push({ method, params });
		const operation: Promise<HostMethods[M]["result"]> = Reflect.apply(request, this, [
			method,
			params,
			requestOptions,
		]);
		hostOperations.push(operation);
		void operation.catch(() => {});
		return operation;
	};
	const context = createPluginContext({ plugin: "channel-slack" }, host, shared.signal);
	// A protocol packet answered by memoryHost, not a connection to this synthetic URL.
	const socket = await context.ws.open("wss://slack.draftyak.example/dytest");
	const processor = createSlackSocketProcessor(context, socket, options);
	const track = (operation: Promise<SlackSocketResult>) => {
		jobs.push(operation);
		void operation.catch(() => {});
		return operation;
	};
	const unsubscribe = socket.subscribe((data) => {
		track(processor.receive(data));
	});
	const result = {
		context,
		socket,
		processor,
		shared,
		host,
		attempts,
		calls,
		unexpected,
		jobs,
		hostOperations,
		unsubscribe,
		receive: (data: unknown) => track(processor.receive(data)),
		emit(data: string, socketId = socket.id) {
			const before = jobs.length;
			host.notify({ jsonrpc: "2.0", method: "host/ws.message", params: { socketId, data } });
			return jobs[before];
		},
	};
	fixtures.push(result);
	return result;
}
const ofMethod = (rows: readonly Trace[], method: HostMethod): Trace[] =>
	rows.filter((entry) => entry.method === method);

beforeEach(() => {
	network.mockReset();
	network.mockRejectedValue(new Error("DYTEST network forbidden"));
	vi.stubGlobal("fetch", network);
});
afterEach(async () => {
	const owned = fixtures.splice(0);
	try {
		for (const release of releases.splice(0)) release();
		await Promise.allSettled(owned.flatMap((f) => f.hostOperations));
		for (const f of owned) {
			f.processor.dispose();
			f.unsubscribe();
			f.shared.abort();
			f.host.close();
		}
		await Promise.allSettled(owned.flatMap((f) => f.jobs));
		for (const f of owned) expect(f.unexpected).toEqual([]);
		expect(network).not.toHaveBeenCalled();
	} finally {
		vi.unstubAllGlobals();
	}
});

describe("Slack Socket Mode hints", () => {
	it("waits for the actual SDK acknowledgement before notifying", async () => {
		const acknowledgement = gate();
		const f = await fixture(undefined, { ack: () => acknowledgement.promise });
		const pending = f.emit(wire());
		expect(pending).toBeDefined();
		let settled = false;
		void pending?.then(
			() => {
				settled = true;
			},
			() => {
				settled = true;
			},
		);
		await turn();
		expect(ofMethod(f.calls, "host/ws.send")).toEqual([
			{
				method: "host/ws.send",
				params: { socketId: f.socket.id, envelopeId: ENVELOPE },
			},
		]);
		expect(ofMethod(f.attempts, "host/changed")).toHaveLength(0);
		expect(settled).toBe(false);
		acknowledgement.resolve();
		await expect(pending).resolves.toBe("notified");
		expect(ofMethod(f.calls, "host/changed")).toEqual([{ method: "host/changed", params: {} }]);
		expect(JSON.stringify(f.attempts)).not.toContain("DYTEST content is not forwarded");
		await turn();
		expect(ofMethod(f.calls, "host/changed")).toHaveLength(1);
	});

	it("acknowledges before refusing a malformed payload", async () => {
		const acknowledgement = gate();
		const f = await fixture(undefined, { ack: () => acknowledgement.promise });
		const pending = f.emit(
			JSON.stringify({ type: "events_api", envelope_id: ENVELOPE, payload: null }),
		);
		let settled = false;
		void pending?.then(
			() => {
				settled = true;
			},
			() => {
				settled = true;
			},
		);
		await turn();
		expect(ofMethod(f.calls, "host/ws.send")).toHaveLength(1);
		expect(settled).toBe(false);
		acknowledgement.resolve();
		await expect(pending).rejects.toEqual(new Error("SLACK_SOCKET_INVALID"));
		expect(ofMethod(f.calls, "host/changed")).toHaveLength(0);
	});

	it("acknowledges repeat envelopes and deduplicates across envelope identities", async () => {
		const f = await fixture();
		await expect(f.emit(wire())).resolves.toBe("notified");
		await expect(f.emit(wire())).resolves.toBe("duplicate");
		await expect(f.emit(wire("DYTEST-event", OTHER_ENVELOPE))).resolves.toBe("duplicate");
		expect(ofMethod(f.calls, "host/ws.send").map((entry) => entry.params)).toEqual([
			{ socketId: f.socket.id, envelopeId: ENVELOPE },
			{ socketId: f.socket.id, envelopeId: ENVELOPE },
			{ socketId: f.socket.id, envelopeId: OTHER_ENVELOPE },
		]);
		expect(ofMethod(f.calls, "host/changed")).toHaveLength(1);
	});

	it("coalesces concurrent event identities while acknowledging both deliveries", async () => {
		const notification = gate();
		const f = await fixture(undefined, { changed: () => notification.promise });
		const first = f.emit(wire());
		await turn();
		const second = f.emit(wire("DYTEST-event", OTHER_ENVELOPE));
		await turn();
		expect(ofMethod(f.calls, "host/ws.send")).toHaveLength(2);
		expect(ofMethod(f.calls, "host/changed")).toHaveLength(1);
		notification.resolve();
		await expect(first).resolves.toBe("notified");
		await expect(second).resolves.toBe("duplicate");
	});

	it("does not remember failed acknowledgements", async () => {
		let fail = true;
		const f = await fixture(undefined, {
			ack: () => {
				if (fail) throw new Error("DYTEST raw failure");
			},
		});
		await expect(f.emit(wire())).rejects.toEqual(new Error("SLACK_SOCKET_INVALID"));
		fail = false;
		await expect(f.emit(wire())).resolves.toBe("notified");
		expect(ofMethod(f.calls, "host/ws.send")).toHaveLength(2);
		expect(ofMethod(f.calls, "host/changed")).toHaveLength(1);
	});

	it("commits event identity only after a successful notification", async () => {
		let fail = true;
		const f = await fixture(undefined, {
			changed: () => {
				if (fail) throw new Error("DYTEST notify failure");
			},
		});
		await expect(f.emit(wire())).rejects.toEqual(new Error("SLACK_SOCKET_INVALID"));
		fail = false;
		await expect(f.emit(wire("DYTEST-event", OTHER_ENVELOPE))).resolves.toBe("notified");
		await expect(f.emit(wire())).resolves.toBe("duplicate");
		expect(ofMethod(f.calls, "host/ws.send")).toHaveLength(3);
		expect(ofMethod(f.calls, "host/changed")).toHaveLength(2);
	});

	it("uses a bounded insertion window and does not refresh old duplicates", async () => {
		expect(MAX_SLACK_SOCKET_EVENT_IDS).toBe(4096);
		const options = { maxRememberedEvents: 2 };
		const f = await fixture(options);
		options.maxRememberedEvents = 1;
		const results = [];
		const identities = ["DYTEST-a", "DYTEST-b", "DYTEST-a", "DYTEST-c", "DYTEST-a"];
		for (const [at, identity] of identities.entries())
			results.push(await f.emit(wire(identity, deliveryId(at))));
		expect(results).toEqual(["notified", "notified", "duplicate", "notified", "notified"]);
		expect(ofMethod(f.calls, "host/changed")).toHaveLength(4);
		expect(ofMethod(f.calls, "host/ws.send")).toHaveLength(5);
	});

	it("bounds outstanding receives before attempting a seventeenth acknowledgement", async () => {
		const acknowledgement = gate();
		const f = await fixture(undefined, { ack: () => acknowledgement.promise });
		const pending = Array.from({ length: HOST_MAX_ACTIVE_REQUESTS }, (_, at) =>
			f.emit(wire(`DYTEST-${at}`, deliveryId(at))),
		);
		await turn();
		await expect(f.emit(wire("DYTEST-excess"))).rejects.toEqual(new Error("SLACK_SOCKET_INVALID"));
		// Attempts are observed before memoryHost's independent request limit.
		expect(ofMethod(f.attempts, "host/ws.send")).toHaveLength(16);
		acknowledgement.resolve();
		await expect(Promise.all(pending)).resolves.toEqual(Array(16).fill("notified"));
		await expect(f.emit(wire("DYTEST-after"))).resolves.toBe("notified");
	});

	it("retains receive accounting while the notification is pending", async () => {
		const notification = gate();
		const f = await fixture(undefined, { changed: () => notification.promise });
		const pending = Array.from({ length: 16 }, (_, at) =>
			f.emit(wire(`DYTEST-${at}`, deliveryId(at))),
		);
		await turn();
		await expect(f.emit(wire("DYTEST-excess"))).rejects.toEqual(new Error("SLACK_SOCKET_INVALID"));
		expect(ofMethod(f.attempts, "host/ws.send")).toHaveLength(16);
		notification.resolve();
		await Promise.all(pending);
	});

	it("cannot invent a missing stable identity from the envelope", async () => {
		const f = await fixture();
		await expect(
			f.emit(
				JSON.stringify({
					type: "events_api",
					envelope_id: ENVELOPE,
					payload: { event: { type: "message" } },
				}),
			),
		).rejects.toEqual(new Error("SLACK_SOCKET_INVALID"));
		expect(ofMethod(f.calls, "host/ws.send")).toHaveLength(1);
		expect(ofMethod(f.calls, "host/changed")).toHaveLength(0);
		await expect(f.emit(wire())).resolves.toBe("notified");
	});

	it("ignores control frames and acknowledges unsupported envelope types", async () => {
		const f = await fixture();
		await expect(
			f.emit(JSON.stringify({ type: "hello", debug_info: { ignored: "DYTEST" } })),
		).resolves.toBe("ignored");
		await expect(
			f.emit(JSON.stringify({ type: "disconnect", reason: "refresh_requested" })),
		).resolves.toBe("ignored");
		expect(ofMethod(f.calls, "host/ws.send")).toHaveLength(0);
		await expect(
			f.emit(JSON.stringify({ type: "interactive", envelope_id: ENVELOPE, payload: null })),
		).resolves.toBe("ignored");
		expect(ofMethod(f.calls, "host/ws.send")).toHaveLength(1);
		expect(ofMethod(f.calls, "host/changed")).toHaveLength(0);
	});

	it("keeps actual SDK socket correlation", async () => {
		const f = await fixture();
		expect(f.emit(wire(), "dytest-other-socket")).toBeUndefined();
		await turn();
		expect(ofMethod(f.calls, "host/ws.send")).toHaveLength(0);
		await expect(f.emit(wire())).resolves.toBe("notified");
	});
});

describe("Socket hint lifetime and admission", () => {
	it("retires only the processor, leaving the caller's context and socket alone", async () => {
		const f = await fixture();
		f.processor.dispose();
		f.processor.dispose();
		await expect(f.receive(wire())).rejects.toEqual(new Error("SLACK_SOCKET_ABORTED"));
		expect(ofMethod(f.calls, "host/ws.send")).toHaveLength(0);
		expect(f.shared.signal.aborted).toBe(false);
		await f.socket.sendAck(ENVELOPE);
		await f.context.changed();
		expect(ofMethod(f.calls, "host/ws.send")).toHaveLength(1);
		expect(ofMethod(f.calls, "host/changed")).toHaveLength(1);
		expect(ofMethod(f.attempts, "host/ws.close")).toHaveLength(0);
	});

	it("does not acknowledge on a retired context", async () => {
		const f = await fixture();
		f.shared.abort();
		await expect(f.receive(wire())).rejects.toEqual(new Error("SLACK_SOCKET_ABORTED"));
		expect(ofMethod(f.attempts, "host/ws.send")).toHaveLength(0);
		expect(() => createSlackSocketProcessor(f.context, f.socket)).toThrow("SLACK_SOCKET_ABORTED");
	});

	it.each(["ack", "changed"] as const)(
		"suppresses later work when aborted during %s",
		async (phase) => {
			const held = gate();
			const f = await fixture(undefined, { [phase]: () => held.promise });
			const pending = f.emit(wire());
			await turn();
			f.shared.abort();
			await expect(pending).rejects.toEqual(new Error("SLACK_SOCKET_ABORTED"));
			held.resolve();
			await turn();
			expect(ofMethod(f.calls, "host/ws.send")).toHaveLength(1);
			expect(ofMethod(f.calls, "host/changed")).toHaveLength(phase === "ack" ? 0 : 1);
		},
	);

	it.each([
		"not JSON",
		"[]",
		"null",
		JSON.stringify({ type: "other" }),
		JSON.stringify({ type: "events_api", envelope_id: "" }),
		JSON.stringify({ type: "events_api", envelope_id: "bad\nid" }),
		JSON.stringify({ type: "events_api", envelope_id: "x".repeat(129) }),
	])("refuses invalid outer wire without acknowledging (%s)", async (input) => {
		const f = await fixture();
		await expect(f.receive(input)).rejects.toEqual(new Error("SLACK_SOCKET_INVALID"));
		expect(ofMethod(f.calls, "host/ws.send")).toHaveLength(0);
	});

	it("bounds wire before parsing and does not call object hooks", async () => {
		const f = await fixture();
		await expect(f.receive("x".repeat(HOST_MAX_WS_DATA_LENGTH + 1))).rejects.toEqual(
			new Error("SLACK_SOCKET_INVALID"),
		);
		let calls = 0;
		const proxy = new Proxy(
			{},
			{
				get() {
					calls++;
					throw new Error("DYTEST hook");
				},
			},
		);
		await expect(f.receive(proxy)).rejects.toEqual(new Error("SLACK_SOCKET_INVALID"));
		expect(calls).toBe(0);
		expect(ofMethod(f.calls, "host/ws.send")).toHaveLength(0);
	});

	it.each([0, 4097, 1.5, Number.NaN, null])(
		"refuses invalid memory bounds %s without host work",
		async (maximum) => {
			const f = await fixture();
			expect(() =>
				createSlackSocketProcessor(f.context, f.socket, {
					maxRememberedEvents: maximum,
				} as SlackSocketProcessorOptions),
			).toThrow("SLACK_SOCKET_INVALID");
			expect(ofMethod(f.calls, "host/ws.send")).toHaveLength(0);
		},
	);

	it("captures selected capability fields without invoking getters or proxies", async () => {
		const f = await fixture();
		let calls = 0;
		const context = Object.defineProperty({ signal: f.context.signal }, "changed", {
			enumerable: true,
			get() {
				calls++;
				throw new Error("DYTEST getter");
			},
		});
		expect(() => createSlackSocketProcessor(context as typeof f.context, f.socket)).toThrow(
			"SLACK_SOCKET_INVALID",
		);
		const socket = new Proxy(f.socket, {
			getPrototypeOf() {
				calls++;
				throw new Error("DYTEST proxy");
			},
			getOwnPropertyDescriptor() {
				calls++;
				throw new Error("DYTEST descriptor");
			},
		});
		expect(() => createSlackSocketProcessor(f.context, socket)).toThrow("SLACK_SOCKET_INVALID");
		expect(calls).toBe(0);
		expect(ofMethod(f.calls, "host/ws.send")).toHaveLength(0);
	});
});
