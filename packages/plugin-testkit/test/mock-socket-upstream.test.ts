import { createFake, type Fake } from "@draftyak/fakes";
import { HOST_MAX_FRAME_BYTES } from "@draftyak/protocol/host-channel";
import { createPluginContext, HostError } from "@draftyak/sdk";
import { afterEach, expect, it, vi } from "vitest";
import { createMockHub } from "../src/mock-hub.ts";
import {
	createMockSocketUpstream,
	MOCK_SOCKET_EVENT_LIMIT,
	MOCK_SOCKET_LIMIT,
} from "../src/mock-socket-upstream.ts";
import type { MockHub, MockPlugin } from "../src/types.ts";
import { contractChannel } from "./fixtures/channel-contract/plugin.ts";
import { toolFixture } from "./fixtures/tool/plugin.ts";

const URL = "wss://wss-primary.slack.com/DYTEST";
const hubs: MockHub[] = [];
const releases: (() => void)[] = [];
const deferred = <T>() => Promise.withResolvers<T>();
type OpenInput = { readonly signal: AbortSignal; readonly onData: (data: string) => void };

function httpFake(): Fake {
	return createFake({ fetch: () => Response.json({ ok: true, url: URL }) }, { host: "slack.com" });
}
function channel(): MockPlugin {
	const plugin = contractChannel();
	if (!plugin.manifest || typeof plugin.manifest !== "object")
		throw new Error("DYTEST manifest missing");
	return {
		...plugin,
		manifest: {
			...plugin.manifest,
			dataClasses: ["slack.content"],
			egress: { profile: "slack-v1" },
			send: { render: "slack-postmessage" },
		},
	};
}
function backend(
	options: {
		readonly delayedOpen?: boolean;
		readonly delayedAck?: boolean;
		readonly delayedClose?: boolean;
		readonly independentClosed?: boolean;
		readonly early?: readonly string[];
	} = {},
) {
	const upstream = httpFake();
	const openGate = deferred<void>(),
		ackGate = deferred<void>(),
		closeGate = deferred<void>();
	const openStarted = deferred<void>(),
		ackStarted = deferred<void>();
	const connections: {
		input: OpenInput;
		closed: ReturnType<typeof deferred<void>>;
		closeStarted: ReturnType<typeof deferred<void>>;
	}[] = [];
	const ack = vi.fn(async (_envelopeId: string) => {
		ackStarted.resolve();
		if (options.delayedAck) await ackGate.promise;
	});
	const close = vi.fn();
	const open = vi.fn(async (input: OpenInput) => {
		const record = { input, closed: deferred<void>(), closeStarted: deferred<void>() };
		connections.push(record);
		openStarted.resolve();
		for (const data of options.early ?? []) input.onData(data);
		if (options.delayedOpen) await openGate.promise;
		return {
			ack,
			async close() {
				close();
				record.closeStarted.resolve();
				if (options.delayedClose) await closeGate.promise;
				if (!options.independentClosed) record.closed.resolve();
			},
			closed: record.closed.promise,
		};
	});
	releases.push(() => {
		openGate.resolve();
		ackGate.resolve();
		closeGate.resolve();
		for (const item of connections) item.closed.resolve();
	});
	return {
		upstream,
		peer: createMockSocketUpstream(upstream, { url: URL, open }),
		open,
		ack,
		close,
		connections,
		openGate,
		ackGate,
		closeGate,
		openStarted,
		ackStarted,
		emit(data: string, index = 0) {
			const record = connections[index];
			if (!record) throw new Error("DYTEST connection missing");
			record.input.onData(data);
		},
	};
}
function hubFor(sample: ReturnType<typeof backend>) {
	const plugin = channel();
	const hub = createMockHub({
		mode: "in-memory",
		plugin,
		upstreams: [sample.upstream],
		socketUpstreams: [sample.peer],
	});
	hubs.push(hub);
	return { hub, context: createPluginContext({ plugin: plugin.entry.plugin }, hub.host) };
}
afterEach(async () => {
	for (const release of releases.splice(0)) release();
	const results = await Promise.allSettled(hubs.splice(0).map((hub) => hub.close()));
	vi.restoreAllMocks();
	expect(results.filter((item) => item.status === "rejected")).toEqual([]);
});

it("preserves unsupported sockets when no companion was supplied", async () => {
	const plugin = channel(),
		upstream = httpFake();
	const hub = createMockHub({ mode: "in-memory", plugin, upstreams: [upstream] });
	hubs.push(hub);
	await expect(
		createPluginContext({ plugin: plugin.entry.plugin }, hub.host).ws.open(URL),
	).rejects.toMatchObject({ code: "UNSUPPORTED" });
});

it("treats an empty companion list like omission for an ordinary tool", async () => {
	const hub = createMockHub({
		mode: "in-memory",
		plugin: toolFixture(),
		upstreams: [],
		socketUpstreams: [],
	});
	hubs.push(hub);
	await hub.close();
});

it("refuses cloned and proxied HTTP sources before invoking a backend", () => {
	const upstream = httpFake(),
		open = vi.fn();
	const touched = vi.fn(() => {
		throw new Error("DYTEST proxy touched");
	});
	expect(() => createMockSocketUpstream({ ...upstream }, { url: URL, open })).toThrow();
	expect(() =>
		createMockSocketUpstream(new Proxy(upstream, { get: touched }), { url: URL, open }),
	).toThrow();
	expect(open).not.toHaveBeenCalled();
	expect(touched).not.toHaveBeenCalled();
});

it("refuses cloned and proxied companion handles before backend dispatch", () => {
	const sample = backend(),
		plugin = channel();
	const touched = vi.fn(() => {
		throw new Error("DYTEST companion proxy touched");
	});
	for (const peer of [{ ...sample.peer }, new Proxy(sample.peer, { get: touched })]) {
		expect(() =>
			createMockHub({
				mode: "in-memory",
				plugin,
				upstreams: [sample.upstream],
				socketUpstreams: [peer],
			}),
		).toThrow();
	}
	expect(sample.open).not.toHaveBeenCalled();
	expect(touched).not.toHaveBeenCalled();
});

it("requires the identical HTTP provider and refuses duplicate endpoint bindings", () => {
	const sample = backend(),
		plugin = channel();
	expect(() =>
		createMockHub({
			mode: "in-memory",
			plugin,
			upstreams: [httpFake()],
			socketUpstreams: [sample.peer],
		}),
	).toThrow();
	expect(() =>
		createMockHub({
			mode: "in-memory",
			plugin,
			upstreams: [sample.upstream],
			socketUpstreams: [sample.peer, sample.peer],
		}),
	).toThrow();
	expect(sample.open).not.toHaveBeenCalled();
});

it("captures constructor callbacks and the endpoint once without later option reads", async () => {
	const sample = backend(),
		replacement = vi.fn(() => {
			throw new Error("DYTEST changed callback");
		});
	const options = { url: URL, open: (input: OpenInput) => sample.open(input) };
	const peer = createMockSocketUpstream(sample.upstream, options);
	options.open = replacement;
	options.url = "wss://wss-secondary.slack.com/DYTEST-changed";
	const { context } = hubFor({ ...sample, peer });
	const socket = await context.ws.open(URL);
	expect(sample.open).toHaveBeenCalledTimes(1);
	expect(replacement).not.toHaveBeenCalled();
	await expect(context.ws.open(options.url)).rejects.toMatchObject({ code: "DENIED" });
	await socket.close();
});

it("refuses a constructor callback accessor without invoking it", () => {
	const upstream = httpFake(),
		touched = vi.fn();
	const options = {
		url: URL,
		get open() {
			touched();
			return vi.fn();
		},
	};
	expect(() => createMockSocketUpstream(upstream, options)).toThrow();
	expect(touched).not.toHaveBeenCalled();
});

it("does not activate Socket companions for tool plugins or an unselected channel profile", () => {
	const sample = backend();
	for (const plugin of [toolFixture(), contractChannel()]) {
		expect(() =>
			createMockHub({
				mode: "in-memory",
				plugin,
				upstreams: [sample.upstream],
				socketUpstreams: [sample.peer],
			}),
		).toThrow();
	}
	expect(sample.open).not.toHaveBeenCalled();
});

it("delivers early and live backend events through the actual SDK and sends ACK ids only", async () => {
	const sample = backend({ early: ["DYTEST-early"] });
	const { hub, context } = hubFor(sample);
	const socket = await context.ws.open(URL),
		messages: string[] = [];
	socket.subscribe((data) => messages.push(data));
	sample.emit("DYTEST-live");
	await vi.waitFor(() => expect(messages).toEqual(["DYTEST-early", "DYTEST-live"]));
	await socket.sendAck("DYTEST-envelope");
	expect(sample.ack).toHaveBeenCalledExactlyOnceWith("DYTEST-envelope");
	await socket.close();
	expect(sample.close).toHaveBeenCalledTimes(1);
	await hub.close();
	sample.emit("DYTEST-late");
	expect(messages).toEqual(["DYTEST-early", "DYTEST-live"]);
});

it("does not let a second host ACK or close the first host's socket id", async () => {
	const sample = backend();
	const first = hubFor(sample),
		second = hubFor(sample);
	const socket = await first.context.ws.open(URL);
	await expect(
		second.hub.host.request("host/ws.send", { socketId: socket.id, envelopeId: "DYTEST-foreign" }),
	).rejects.toMatchObject({ code: "DENIED" });
	await expect(
		second.hub.host.request("host/ws.close", { socketId: socket.id }),
	).rejects.toMatchObject({ code: "DENIED" });
	expect(sample.ack).not.toHaveBeenCalled();
	expect(sample.close).not.toHaveBeenCalled();
	await socket.close();
});

it("retains strict ACK-only params before a backend callback", async () => {
	const sample = backend(),
		{ hub, context } = hubFor(sample);
	const socket = await context.ws.open(URL);
	await expect(
		hub.host.request("host/ws.send", {
			socketId: socket.id,
			envelopeId: "DYTEST-id",
			data: "DYTEST-not-an-ACK",
		} as { socketId: string; envelopeId: string }),
	).rejects.toMatchObject({ code: "BAD_REQUEST" });
	expect(sample.ack).not.toHaveBeenCalled();
	await socket.close();
});

it("normalizes the original host signal and retains its lifetime after open returns", async () => {
	const sample = backend(),
		{ hub } = hubFor(sample),
		owner = new AbortController();
	const touched = vi.fn(() => {
		throw new Error("DYTEST signal override read");
	});
	for (const name of ["aborted", "addEventListener", "removeEventListener"])
		Object.defineProperty(owner.signal, name, { get: touched });
	await hub.host.request("host/ws.open", { url: URL }, { signal: owner.signal });
	owner.abort();
	await Promise.all(sample.connections.map((item) => item.closeStarted.promise));
	await hub.close();
	expect(touched).not.toHaveBeenCalled();
	expect(sample.close).toHaveBeenCalledTimes(1);
	expect(sample.connections.every((item) => item.input.signal.aborted)).toBe(true);
});

it("rejects an opening backend queue overflow before returning a socket", async () => {
	const sample = backend({
		early: Array.from({ length: MOCK_SOCKET_EVENT_LIMIT + 1 }, (_, at) => `DYTEST-${at}`),
	});
	await expect(hubFor(sample).context.ws.open(URL)).rejects.toBeInstanceOf(HostError);
	await Promise.all(sample.connections.map((item) => item.closed.promise));
	expect(sample.close).toHaveBeenCalledTimes(1);
});

it("checks the whole UTF8 notification frame rather than only data characters", async () => {
	const data = "😀".repeat(HOST_MAX_FRAME_BYTES / 4);
	expect(data.length).toBeLessThan(HOST_MAX_FRAME_BYTES - 80);
	const sample = backend({ early: [data] });
	await expect(hubFor(sample).context.ws.open(URL)).rejects.toBeInstanceOf(HostError);
	await Promise.all(sample.connections.map((item) => item.closed.promise));
	expect(sample.close).toHaveBeenCalledTimes(1);
});

it("bounds aggregate queued bytes even when each frame and event count fits", async () => {
	const data = "😀".repeat(140_000);
	const sample = backend({ early: [data, data] });
	expect(Buffer.byteLength(data) * 2).toBeGreaterThan(HOST_MAX_FRAME_BYTES);
	expect(Buffer.byteLength(data)).toBeLessThan(HOST_MAX_FRAME_BYTES - 128);
	await expect(hubFor(sample).context.ws.open(URL)).rejects.toBeInstanceOf(HostError);
	await Promise.all(sample.connections.map((item) => item.closed.promise));
	expect(sample.close).toHaveBeenCalledTimes(1);
});

it.each([
	["nonstring", 42],
	["ill-formed Unicode", "\ud800"],
] as const)(
	"refuses %s backend data before publishing an opening socket",
	async (_label, value) => {
		const sample = backend({ early: [value as string] });
		await expect(hubFor(sample).context.ws.open(URL)).rejects.toBeInstanceOf(HostError);
		await Promise.all(sample.connections.map((item) => item.closed.promise));
		expect(sample.close).toHaveBeenCalledTimes(1);
	},
);

it("keeps aborted retiring sockets in capacity without pending close RPCs masking the limit", async () => {
	const sample = backend({ delayedClose: true }),
		{ hub, context } = hubFor(sample);
	const owners: AbortController[] = [],
		ids: string[] = [];
	for (let at = 0; at < MOCK_SOCKET_LIMIT; at++) {
		const owner = new AbortController();
		owners.push(owner);
		ids.push(
			(
				await createPluginContext(
					{ plugin: "@example/contract-channel" },
					hub.host,
					owner.signal,
				).ws.open(URL)
			).id,
		);
	}
	for (const owner of owners) owner.abort();
	await Promise.all(sample.connections.map((item) => item.closeStarted.promise));
	await expect(context.ws.open(URL)).rejects.toMatchObject({ code: "TOO_LARGE" });
	expect(sample.open).toHaveBeenCalledTimes(MOCK_SOCKET_LIMIT);
	// Only after the unmasked capacity assertion, observe retirement through close RPCs.
	const closing = ids.map((socketId) => hub.host.request("host/ws.close", { socketId }));
	const observed = Promise.allSettled(closing);
	sample.closeGate.resolve();
	expect((await observed).every((item) => item.status === "fulfilled")).toBe(true);
	const next = await context.ws.open(URL);
	await next.close();
});

it("joins a late connection after caller cancellation instead of abandoning its backend", async () => {
	const sample = backend({ delayedOpen: true, delayedClose: true });
	const { hub } = hubFor(sample),
		cancel = new AbortController();
	const opening = createPluginContext(
		{ plugin: "@example/contract-channel" },
		hub.host,
		cancel.signal,
	).ws.open(URL);
	await sample.openStarted.promise;
	cancel.abort();
	await expect(opening).rejects.toMatchObject({ code: "DENIED" });
	let joined = false;
	const closing = hub.close().then(() => {
		joined = true;
	});
	sample.openGate.resolve();
	await Promise.all(sample.connections.map((item) => item.closeStarted.promise));
	await Promise.resolve();
	expect(joined).toBe(false);
	sample.closeGate.resolve();
	await closing;
	expect(sample.close).toHaveBeenCalledTimes(1);
});

it("does not equate a close callback return with the backend closed promise", async () => {
	const sample = backend({ independentClosed: true }),
		{ hub, context } = hubFor(sample);
	await context.ws.open(URL);
	let joined = false;
	const closing = hub.close().then(() => {
		joined = true;
	});
	await Promise.all(sample.connections.map((item) => item.closeStarted.promise));
	await Promise.resolve();
	expect(joined).toBe(false);
	for (const item of sample.connections) item.closed.resolve();
	await closing;
});

it("joins pending ACK work and established caller cancellation before Hub cleanup completes", async () => {
	const sample = backend({ delayedAck: true }),
		{ hub } = hubFor(sample),
		cancel = new AbortController();
	const context = createPluginContext(
		{ plugin: "@example/contract-channel" },
		hub.host,
		cancel.signal,
	);
	const socket = await context.ws.open(URL);
	const acknowledgement = socket.sendAck("DYTEST-held-ACK");
	const ackResult = Promise.allSettled([acknowledgement]);
	await sample.ackStarted.promise;
	cancel.abort();
	let joined = false;
	const closing = hub.close().then(() => {
		joined = true;
	});
	await Promise.all(sample.connections.map((item) => item.closeStarted.promise));
	await Promise.resolve();
	expect(joined).toBe(false);
	sample.ackGate.resolve();
	await closing;
	expect((await ackResult)[0]).toMatchObject({ status: "rejected", reason: { code: "DENIED" } });
	expect(sample.close).toHaveBeenCalledTimes(1);
});

it.each(["rejected", "nonvoid"] as const)(
	"does not treat a %s closed witness as actual termination",
	async (kind) => {
		const sample = backend({ independentClosed: true }),
			{ hub, context } = hubFor(sample);
		await context.ws.open(URL);
		const record = sample.connections[0];
		if (!record) throw new Error("DYTEST connection missing");
		if (kind === "rejected") record.closed.reject(new Error("DYTEST termination unqualified"));
		else record.closed.resolve("DYTEST-not-void" as unknown as undefined);
		await record.closeStarted.promise;
		// No close RPC is pending: refusal must come from the failed termination qualification.
		await expect(context.ws.open(URL)).rejects.toBeInstanceOf(HostError);
		expect(sample.open).toHaveBeenCalledTimes(1);
		await expect(hub.close()).rejects.toMatchObject({ code: "SOCKET_TERMINATION_UNQUALIFIED" });
		expect(sample.close).toHaveBeenCalledTimes(1);
		// This fixture owns no real socket. Its intentionally failed witness remains unqualified.
		const at = hubs.indexOf(hub);
		if (at < 0) throw new Error("DYTEST hub missing");
		hubs.splice(at, 1);
	},
);

it("joins every owned backend before reporting one unqualified termination", async () => {
	const sample = backend({ independentClosed: true }),
		{ hub, context } = hubFor(sample);
	await context.ws.open(URL);
	await context.ws.open(URL);
	const first = sample.connections[0],
		second = sample.connections[1];
	if (!first || !second) throw new Error("DYTEST connections missing");
	first.closed.reject(new Error("DYTEST first termination unqualified"));
	await first.closeStarted.promise;
	let settled = false;
	const closing = hub.close();
	const observed = closing.then(
		() => {
			settled = true;
		},
		(error: unknown) => {
			settled = true;
			return error;
		},
	);
	await second.closeStarted.promise;
	await new Promise<void>((resolve) => setImmediate(resolve));
	expect(sample.close).toHaveBeenCalledTimes(2);
	expect(settled).toBe(false);
	second.closed.resolve();
	expect(await observed).toMatchObject({ code: "SOCKET_TERMINATION_UNQUALIFIED" });
	const at = hubs.indexOf(hub);
	if (at < 0) throw new Error("DYTEST hub missing");
	hubs.splice(at, 1);
});
