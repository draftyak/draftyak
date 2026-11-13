import { HOST_MAX_FRAME_BYTES } from "@draftyak/protocol/host-channel";
import { afterEach, expect, it, vi } from "vitest";
import { createPluginContext, type HostSocket } from "../src/context.ts";
import { HostError, type HostHandler, type MemoryHost, memoryHost } from "../src/host.ts";

const URL = "wss://socket.draftyak.example/DYTEST";
const identity = { plugin: "@example/dytest-socket" };
const hosts: MemoryHost[] = [];
const releases: (() => void)[] = [];

function deferred<T>() {
	const { promise, resolve } = Promise.withResolvers<T>();
	return { promise, resolve };
}
function fixture(handler?: HostHandler) {
	const requests: { method: string; params: unknown }[] = [];
	let subscriptions = 0;
	const host = memoryHost((method, params, signal) => {
		requests.push({ method, params });
		if (handler) return handler(method, params, signal);
		if (method === "host/ws.open") return { socketId: "DYTEST-socket" };
		if (method === "host/ws.send" || method === "host/ws.close") return null;
		throw new HostError("UNSUPPORTED");
	});
	const dispatches = vi.spyOn(host, "request");
	const subscribe = host.subscribe.bind(host);
	vi.spyOn(host, "subscribe").mockImplementation((listener, onclose) => {
		subscriptions++;
		const remove = subscribe(listener, onclose);
		let active = true;
		return () => {
			if (active) {
				active = false;
				subscriptions--;
			}
			remove();
		};
	});
	hosts.push(host);
	return { host, requests, dispatches, subscriptions: () => subscriptions };
}
function notify(host: MemoryHost, socketId: string, data: string) {
	host.notify({ jsonrpc: "2.0", method: "host/ws.message", params: { socketId, data } });
}
afterEach(() => {
	for (const release of releases.splice(0)) release();
	for (const host of hosts.splice(0)) host.close();
	vi.restoreAllMocks();
});

it("delivers a message emitted during open before the socket id response", async () => {
	let host: MemoryHost;
	const sample = fixture((method) => {
		if (method === "host/ws.open") {
			notify(host, "DYTEST-socket", "DYTEST-before-response");
			return { socketId: "DYTEST-socket" };
		}
		return null;
	});
	host = sample.host;
	const socket = await createPluginContext(identity, host).ws.open(URL);
	const messages: string[] = [];
	socket.subscribe((data) => messages.push(data));
	expect(messages).toEqual(["DYTEST-before-response"]);
	await socket.close();
	expect(sample.subscriptions()).toBe(0);
});

it("queues messages between open completion and the first subscriber in order", async () => {
	const sample = fixture();
	const socket = await createPluginContext(identity, sample.host).ws.open(URL);
	notify(sample.host, socket.id, "DYTEST-one");
	notify(sample.host, socket.id, "DYTEST-two");
	const messages: string[] = [];
	socket.subscribe((data) => messages.push(data));
	expect(messages).toEqual(["DYTEST-one", "DYTEST-two"]);
	await socket.close();
});

it("keeps buffered order when a subscriber synchronously causes another message", async () => {
	const sample = fixture();
	const socket = await createPluginContext(identity, sample.host).ws.open(URL);
	notify(sample.host, socket.id, "DYTEST-one");
	notify(sample.host, socket.id, "DYTEST-two");
	const messages: string[] = [];
	socket.subscribe((data) => {
		messages.push(data);
		if (data === "DYTEST-one") notify(sample.host, socket.id, "DYTEST-three");
	});
	expect(messages).toEqual(["DYTEST-one", "DYTEST-two", "DYTEST-three"]);
	await socket.close();
});

it("drains early data once rather than replaying it to a later subscriber", async () => {
	const sample = fixture();
	const socket = await createPluginContext(identity, sample.host).ws.open(URL);
	notify(sample.host, socket.id, "DYTEST-buffered");
	const first: string[] = [],
		second: string[] = [];
	const remove = socket.subscribe((data) => first.push(data));
	remove();
	socket.subscribe((data) => second.push(data));
	notify(sample.host, socket.id, "DYTEST-live");
	expect(first).toEqual(["DYTEST-buffered"]);
	expect(second).toEqual(["DYTEST-live"]);
	await socket.close();
});

it("binds reverse-resolving concurrent opens to their own socket ids", async () => {
	const one = deferred<{ socketId: string }>(),
		two = deferred<{ socketId: string }>();
	releases.push(() => {
		one.resolve({ socketId: "DYTEST-one" });
		two.resolve({ socketId: "DYTEST-two" });
	});
	const started = deferred<void>();
	let opens = 0;
	const sample = fixture((method) => {
		if (method !== "host/ws.open") return null;
		if (++opens === 2) started.resolve();
		return opens === 1 ? one.promise : two.promise;
	});
	const context = createPluginContext(identity, sample.host);
	const openingOne = context.ws.open(URL),
		openingTwo = context.ws.open(URL);
	await started.promise;
	notify(sample.host, "DYTEST-one", "DYTEST-first");
	notify(sample.host, "DYTEST-two", "DYTEST-second");
	two.resolve({ socketId: "DYTEST-two" });
	const socketTwo = await openingTwo;
	one.resolve({ socketId: "DYTEST-one" });
	const socketOne = await openingOne;
	const first: string[] = [],
		second: string[] = [];
	socketOne.subscribe((data) => first.push(data));
	socketTwo.subscribe((data) => second.push(data));
	expect(first).toEqual(["DYTEST-first"]);
	expect(second).toEqual(["DYTEST-second"]);
	await socketOne.close();
	await socketTwo.close();
	expect(sample.subscriptions()).toBe(0);
});

it("removes its early subscription when open is refused", async () => {
	const sample = fixture(() => {
		throw new HostError("DENIED");
	});
	await expect(createPluginContext(identity, sample.host).ws.open(URL)).rejects.toMatchObject({
		code: "DENIED",
	});
	expect(sample.subscriptions()).toBe(0);
});

it("does not dispatch an already-aborted open or retain a listener", async () => {
	const sample = fixture(),
		cancel = new AbortController();
	cancel.abort();
	await expect(
		createPluginContext(identity, sample.host, cancel.signal).ws.open(URL),
	).rejects.toMatchObject({ code: "DENIED" });
	expect(sample.requests).toEqual([]);
	expect(sample.dispatches).not.toHaveBeenCalled();
	expect(sample.subscriptions()).toBe(0);
});

it("uses native aborted state without reading caller-owned signal overrides", async () => {
	const sample = fixture(),
		cancel = new AbortController();
	cancel.abort();
	const touched = vi.fn(() => {
		throw new Error("DYTEST signal override read");
	});
	for (const name of ["aborted", "addEventListener", "removeEventListener"])
		Object.defineProperty(cancel.signal, name, { get: touched });
	await expect(
		createPluginContext(identity, sample.host, cancel.signal).ws.open(URL),
	).rejects.toMatchObject({ code: "DENIED" });
	expect(touched).not.toHaveBeenCalled();
	expect(sample.dispatches).not.toHaveBeenCalled();
	expect(sample.subscriptions()).toBe(0);
});

it("normalizes a live native signal before checks, listeners and later cancellation", async () => {
	const sample = fixture(),
		cancel = new AbortController();
	const touched = vi.fn(() => {
		throw new Error("DYTEST signal override read");
	});
	for (const name of ["aborted", "addEventListener", "removeEventListener"])
		Object.defineProperty(cancel.signal, name, { get: touched });
	const socket = await createPluginContext(identity, sample.host, cancel.signal).ws.open(URL);
	cancel.abort();
	await expect(socket.sendAck("DYTEST-after-abort")).rejects.toMatchObject({ code: "DENIED" });
	expect(touched).not.toHaveBeenCalled();
	expect(sample.subscriptions()).toBe(0);
});

it("refuses a non-native signal before dispatch or subscription", async () => {
	const sample = fixture();
	await expect(
		createPluginContext(identity, sample.host, {} as AbortSignal).ws.open(URL),
	).rejects.toMatchObject({ code: "BAD_REQUEST" });
	expect(sample.dispatches).not.toHaveBeenCalled();
	expect(sample.subscriptions()).toBe(0);
});

it("drops queued and late messages after abort while open is pending", async () => {
	const answer = deferred<{ socketId: string }>(),
		started = deferred<void>();
	releases.push(() => answer.resolve({ socketId: "DYTEST-late" }));
	const sample = fixture((method) => {
		if (method !== "host/ws.open") return null;
		started.resolve();
		return answer.promise;
	});
	const cancel = new AbortController();
	const opening = createPluginContext(identity, sample.host, cancel.signal).ws.open(URL);
	await started.promise;
	notify(sample.host, "DYTEST-late", "DYTEST-queued");
	cancel.abort();
	await expect(opening).rejects.toMatchObject({ code: "DENIED" });
	answer.resolve({ socketId: "DYTEST-late" });
	await Promise.resolve();
	notify(sample.host, "DYTEST-late", "DYTEST-after-abort");
	expect(sample.subscriptions()).toBe(0);
});

it("drops buffered and future messages after explicit close", async () => {
	const sample = fixture();
	const socket = await createPluginContext(identity, sample.host).ws.open(URL);
	notify(sample.host, socket.id, "DYTEST-buffered");
	await socket.close();
	const messages: string[] = [];
	expect(() => socket.subscribe((data) => messages.push(data))).toThrow(HostError);
	notify(sample.host, socket.id, "DYTEST-late");
	expect(messages).toEqual([]);
	expect(sample.subscriptions()).toBe(0);
});

it("cleans up the subscription and buffer when the host closes", async () => {
	const sample = fixture();
	const socket = await createPluginContext(identity, sample.host).ws.open(URL);
	notify(sample.host, socket.id, "DYTEST-buffered");
	sample.host.close();
	const messages: string[] = [];
	expect(() => socket.subscribe((data) => messages.push(data))).toThrow(HostError);
	expect(messages).toEqual([]);
	expect(sample.subscriptions()).toBe(0);
});

it("refuses the sixty-fifth early message before publishing an open handle", async () => {
	let host: MemoryHost;
	const sample = fixture((method) => {
		if (method === "host/ws.open") {
			for (let at = 0; at < 65; at++) notify(host, "DYTEST-overflow", `DYTEST-${at}`);
			return { socketId: "DYTEST-overflow" };
		}
		return null;
	});
	host = sample.host;
	await expect(createPluginContext(identity, host).ws.open(URL)).rejects.toMatchObject({
		code: "TOO_LARGE",
	});
	expect(sample.subscriptions()).toBe(0);
});

it("bounds buffered UTF8 frame bytes rather than only string length", async () => {
	const sample = fixture();
	const socket = await createPluginContext(identity, sample.host).ws.open(URL);
	const data = "😀".repeat(140_000);
	const frame = {
		jsonrpc: "2.0",
		method: "host/ws.message",
		params: { socketId: socket.id, data },
	};
	expect(data.length * 2).toBeLessThan(HOST_MAX_FRAME_BYTES);
	expect(Buffer.byteLength(JSON.stringify(frame))).toBeLessThan(HOST_MAX_FRAME_BYTES);
	expect(Buffer.byteLength(JSON.stringify(frame)) * 2).toBeGreaterThan(HOST_MAX_FRAME_BYTES);
	notify(sample.host, socket.id, data);
	notify(sample.host, socket.id, data);
	await expect(socket.sendAck("DYTEST-ack")).rejects.toMatchObject({ code: "TOO_LARGE" });
	expect(() => socket.subscribe(() => {})).toThrow(HostError);
	expect(sample.subscriptions()).toBe(0);
});

it("releases first-subscriber buffer quota after its actual ordered drain", async () => {
	const sample = fixture();
	const socket = await createPluginContext(identity, sample.host).ws.open(URL);
	for (let at = 0; at < 64; at++) notify(sample.host, socket.id, `DYTEST-first-${at}`);
	const first: string[] = [],
		second: string[] = [];
	const remove = socket.subscribe((data) => first.push(data));
	remove();
	for (let at = 0; at < 64; at++) notify(sample.host, socket.id, `DYTEST-second-${at}`);
	socket.subscribe((data) => second.push(data));
	expect(first).toEqual(Array.from({ length: 64 }, (_, at) => `DYTEST-first-${at}`));
	expect(second).toEqual(Array.from({ length: 64 }, (_, at) => `DYTEST-second-${at}`));
	await socket.sendAck("DYTEST-ack");
	await socket.close();
});

it("preserves close refusal while dropping late data and closing only once", async () => {
	const sample = fixture((method) => {
		if (method === "host/ws.open") return { socketId: "DYTEST-socket" };
		if (method === "host/ws.close") throw new HostError("DENIED");
		return null;
	});
	const socket = await createPluginContext(identity, sample.host).ws.open(URL);
	const messages: string[] = [];
	socket.subscribe((data) => messages.push(data));
	await expect(socket.close()).rejects.toMatchObject({ code: "DENIED" });
	await expect(socket.close()).rejects.toMatchObject({ code: "DENIED" });
	notify(sample.host, socket.id, "DYTEST-late");
	expect(messages).toEqual([]);
	expect(sample.requests.filter((item) => item.method === "host/ws.close")).toHaveLength(1);
	expect(sample.subscriptions()).toBe(0);
});

it("bounds the shared early buffer across reverse-resolving concurrent opens", async () => {
	const one = deferred<{ socketId: string }>(),
		two = deferred<{ socketId: string }>(),
		started = deferred<void>();
	releases.push(() => {
		one.resolve({ socketId: "DYTEST-one" });
		two.resolve({ socketId: "DYTEST-two" });
	});
	let opens = 0;
	const sample = fixture((method) => {
		if (method !== "host/ws.open") return null;
		if (++opens === 2) started.resolve();
		return opens === 1 ? one.promise : two.promise;
	});
	const context = createPluginContext(identity, sample.host);
	const results = Promise.allSettled([context.ws.open(URL), context.ws.open(URL)]);
	await started.promise;
	for (let at = 0; at < 65; at++)
		notify(sample.host, at % 2 ? "DYTEST-one" : "DYTEST-two", `DYTEST-${at}`);
	two.resolve({ socketId: "DYTEST-two" });
	one.resolve({ socketId: "DYTEST-one" });
	expect(await results).toEqual([
		{ status: "rejected", reason: expect.objectContaining({ code: "TOO_LARGE" }) },
		{ status: "rejected", reason: expect.objectContaining({ code: "TOO_LARGE" }) },
	]);
	expect(sample.subscriptions()).toBe(0);
});

it("reserves the close promise before abort listeners can reenter close", async () => {
	const held = deferred<void>(),
		started = deferred<void>();
	releases.push(() => held.resolve());
	let socket: HostSocket, reentered: Promise<void> | undefined;
	const sample = fixture((method, _params, signal) => {
		if (method === "host/ws.open") return { socketId: "DYTEST-reentrant" };
		if (method === "host/ws.send") {
			signal.addEventListener(
				"abort",
				() => {
					reentered = socket.close();
				},
				{ once: true },
			);
			started.resolve();
			return held.promise.then(() => null);
		}
		return null;
	});
	socket = await createPluginContext(identity, sample.host).ws.open(URL);
	const ackResult = Promise.allSettled([socket.sendAck("DYTEST-held")]);
	await started.promise;
	const closing = socket.close();
	expect(reentered).toBe(closing);
	await closing;
	expect(socket.close()).toBe(closing);
	expect(sample.requests.filter((item) => item.method === "host/ws.close")).toHaveLength(1);
	held.resolve();
	expect((await ackResult)[0]).toMatchObject({ status: "rejected", reason: { code: "DENIED" } });
});
