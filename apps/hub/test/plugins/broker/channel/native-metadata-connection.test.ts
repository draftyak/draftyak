import { EventEmitter } from "node:events";
import type { ClientRequest } from "node:http";
import { Agent } from "node:https";
import { Socket } from "node:net";
import { TLSSocket } from "node:tls";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PinnedHttpsConnection } from "../../../../src/plugins/broker/network/index.ts";

const externalIo = vi.hoisted(() => {
	const refuse = vi.fn((): never => {
		throw new Error("External IO is unavailable in this test");
	});
	const block = (source: object, names: readonly string[]) => {
		const overrides = Object.fromEntries(names.map((name) => [name, refuse]));
		return { ...source, ...overrides, default: { ...source, ...overrides } };
	};
	vi.stubGlobal("fetch", refuse);
	return { refuse, block };
});
const pinned = vi.hoisted(() => ({ create: vi.fn() }));

vi.mock("node:child_process", async (original) =>
	externalIo.block(await original<typeof import("node:child_process")>(), [
		"spawn",
		"spawnSync",
		"exec",
		"execFile",
		"execSync",
		"execFileSync",
		"fork",
	]),
);
vi.mock("node:http", async (original) =>
	externalIo.block(await original<typeof import("node:http")>(), [
		"request",
		"get",
		"createServer",
	]),
);
vi.mock("node:https", async (original) =>
	externalIo.block(await original<typeof import("node:https")>(), [
		"request",
		"get",
		"createServer",
	]),
);
vi.mock("node:net", async (original) =>
	externalIo.block(await original<typeof import("node:net")>(), [
		"connect",
		"createConnection",
		"createServer",
	]),
);
vi.mock("node:tls", async (original) =>
	externalIo.block(await original<typeof import("node:tls")>(), ["connect", "createServer"]),
);
vi.mock("node:dns", async (original) =>
	externalIo.block(await original<typeof import("node:dns")>(), [
		"lookup",
		"resolve",
		"resolve4",
		"resolve6",
		"reverse",
	]),
);
vi.mock("node:dns/promises", async (original) =>
	externalIo.block(await original<typeof import("node:dns/promises")>(), [
		"lookup",
		"resolve",
		"resolve4",
		"resolve6",
		"reverse",
	]),
);
vi.mock("../../../../src/plugins/broker/network/index.ts", async (original) => ({
	...(await original<typeof import("../../../../src/plugins/broker/network/index.ts")>()),
	createPinnedHttpsConnection: pinned.create,
}));

import {
	createNativeMetadataConnection,
	NativeChannelHostError,
	type NativeMetadataConnection,
} from "../../../../src/plugins/broker/channel/native-connection.ts";

const policy = { deniedAddresses: [], deniedPorts: [] };
const pin = { address: "8.8.8.8", family: 4 as const };
const socketCleanups: (() => void)[] = [];

beforeEach(() => {
	// No native socket in this file is permitted to dial, including through an instance method.
	vi.spyOn(Socket.prototype, "connect").mockImplementation(externalIo.refuse);
});
afterEach(() => {
	try {
		expect(externalIo.refuse).not.toHaveBeenCalled();
	} finally {
		for (const cleanup of socketCleanups.splice(0)) cleanup();
		vi.restoreAllMocks();
		externalIo.refuse.mockClear();
		pinned.create.mockReset();
	}
});

/** An unconnected native instance with IO replaced by deterministic close events. */
function controlledSocket() {
	const socket = new TLSSocket(new Socket());
	const originalDestroy = socket.destroy;
	const destroy = vi.spyOn(socket, "destroy").mockImplementation(() => socket);
	socketCleanups.push(() => {
		destroy.mockRestore();
		Reflect.apply(originalDestroy, socket, []);
	});
	return { socket, destroy, close: () => socket.emit("close", false) };
}

function controlledRequest() {
	const events = new EventEmitter();
	const destroy = vi.fn(() => events);
	Object.defineProperty(events, "destroy", { value: destroy });
	return { request: events as unknown as ClientRequest, events, destroy };
}

/** This fake supplies resource DATA only; it never constructs a Session or grants a request. */
function fixture() {
	const agent = new Agent({ keepAlive: false, maxSockets: 1, maxCachedSessions: 0 });
	let nextCreate: (...args: unknown[]) => unknown = () => undefined;
	let nextDestroy: () => void = () => {};
	let request: ClientRequest | undefined;
	const nativeCreate = vi.fn(function (this: Agent, ...args: unknown[]) {
		expect(this).toBe(agent);
		return nextCreate(...args);
	});
	const nativeDestroy = vi.fn(function (this: Agent) {
		expect(this).toBe(agent);
		nextDestroy();
	});
	Object.defineProperties(agent, {
		createConnection: { configurable: true, writable: true, value: nativeCreate },
		destroy: { configurable: true, writable: true, value: nativeDestroy },
	});
	let shared: PinnedHttpsConnection;
	const originalDestroy = vi.fn(function (this: PinnedHttpsConnection) {
		expect(this).toBe(shared);
		agent.destroy();
	});
	const originalGuard = vi.fn<PinnedHttpsConnection["guard"]>().mockImplementation((incoming) => {
		request = incoming;
	});
	shared = {
		options: Object.freeze({ agent, autoSelectFamily: false }),
		guard: originalGuard,
		destroy: originalDestroy,
	};
	pinned.create.mockReturnValue(shared);
	const connection = createNativeMetadataConnection("metadata.example", 443, pin, policy);
	return {
		agent,
		connection,
		shared,
		nativeCreate,
		nativeDestroy,
		originalDestroy,
		originalGuard,
		onCreate: (next: typeof nextCreate) => {
			nextCreate = next;
		},
		onDestroy: (next: typeof nextDestroy) => {
			nextDestroy = next;
		},
		create: (...args: unknown[]) => Reflect.apply(agent.createConnection, agent, args),
		// The shared pin path aborts by destroying its request and the same owned Agent.
		abort: () => {
			request?.destroy();
			agent.destroy();
		},
	};
}

function observe(promise: Promise<void>) {
	const state = { value: "pending" as "pending" | "resolved" | "rejected" };
	void promise.then(
		() => {
			state.value = "resolved";
		},
		() => {
			state.value = "rejected";
		},
	);
	return state;
}
async function remainsPending(state: ReturnType<typeof observe>) {
	for (let i = 0; i < 4; i++) await Promise.resolve();
	expect(state.value).toBe("pending");
}
async function refusesDrain(connection: NativeMetadataConnection) {
	const result = connection.destroyAndDrain();
	await expect(result).rejects.toBeInstanceOf(NativeChannelHostError);
	await expect(result).rejects.toMatchObject({
		code: "NATIVE_CHANNEL_HOST_REFUSED",
		message: "Native channel request unavailable",
	});
}

describe("native metadata connection resource ownership", () => {
	it("captures the unique shared Agent without creating a request or socket", async () => {
		const f = fixture();
		expect(pinned.create).toHaveBeenCalledExactlyOnceWith("metadata.example", 443, pin, policy);
		expect(f.connection.options).toBe(f.shared.options);
		expect(f.nativeCreate).not.toHaveBeenCalled();
		expect(f.originalGuard).not.toHaveBeenCalled();
		await expect(f.connection.destroyAndDrain()).resolves.toBeUndefined();
		expect(f.originalDestroy).toHaveBeenCalledTimes(1);
		expect(f.nativeDestroy).toHaveBeenCalledTimes(1);
	});

	it("joins an aborted socket before the request receives its socket event", async () => {
		const f = fixture();
		const s = controlledSocket();
		const r = controlledRequest();
		const ready = vi.fn();
		const fail = vi.fn();
		f.onCreate(() => s.socket);
		f.connection.guard(r.request, () => false, ready, fail);
		const assigned = vi.fn();
		r.events.on("socket", assigned);
		expect(f.create({ host: "DYTEST-pin" })).toBe(s.socket);
		f.abort();
		expect(r.destroy).toHaveBeenCalledTimes(1);
		expect(s.destroy).toHaveBeenCalled();
		expect(assigned).not.toHaveBeenCalled();
		expect(() => f.create()).toThrow(NativeChannelHostError);
		const drained = f.connection.destroyAndDrain();
		const state = observe(drained);
		await remainsPending(state);
		s.close();
		await expect(drained).resolves.toBeUndefined();
		expect(ready).not.toHaveBeenCalled();
		expect(f.nativeCreate).toHaveBeenCalledTimes(1);
	});

	it("does not treat request close or destroy return as an owned socket close", async () => {
		const f = fixture();
		const s = controlledSocket();
		const r = controlledRequest();
		f.onCreate(() => s.socket);
		f.create();
		const drained = f.connection.destroyAndDrain();
		const state = observe(drained);
		r.destroy();
		r.events.emit("close");
		expect(s.destroy).toHaveBeenCalled();
		expect(f.nativeDestroy).toHaveBeenCalledTimes(1);
		await remainsPending(state);
		s.close();
		await expect(drained).resolves.toBeUndefined();
	});

	it("joins a socket returned after creation synchronously reenters drain", async () => {
		const f = fixture();
		const s = controlledSocket();
		let drained: Promise<void> | undefined;
		f.onCreate(() => {
			drained = f.connection.destroyAndDrain();
			return s.socket;
		});
		const options = { host: "DYTEST-pin" };
		const callback = vi.fn();
		expect(f.create(options, callback)).toBe(s.socket);
		expect(f.nativeCreate).toHaveBeenCalledExactlyOnceWith(options, callback);
		expect(drained).toBeDefined();
		expect(s.destroy).toHaveBeenCalled();
		const state = observe(drained as Promise<void>);
		await remainsPending(state);
		s.close();
		await expect(drained).resolves.toBeUndefined();
	});

	it("fences reentrant socket creation while native destruction closes the last socket", async () => {
		const f = fixture();
		const s = controlledSocket();
		f.onCreate(() => s.socket);
		f.create();
		f.onDestroy(() => {
			s.close();
			expect(() => f.create()).toThrow(NativeChannelHostError);
		});
		await expect(f.connection.destroyAndDrain()).resolves.toBeUndefined();
		expect(f.nativeDestroy).toHaveBeenCalledTimes(1);
		expect(f.nativeCreate).toHaveBeenCalledTimes(1);
	});

	it.each([undefined, {}, new EventEmitter()])(
		"refuses drain after an unknown socket return: %j",
		async (unknownSocket) => {
			const f = fixture();
			f.onCreate(() => unknownSocket);
			expect(f.create()).toBe(unknownSocket);
			expect(() => f.connection.destroy()).not.toThrow();
			await refusesDrain(f.connection);
			await refusesDrain(f.connection);
		},
	);

	it("refuses drain after socket creation throws without exposing the backend error", async () => {
		const f = fixture();
		f.onCreate(() => {
			throw new Error("DYTEST-backend-detail");
		});
		expect(() => f.create()).toThrow(NativeChannelHostError);
		expect(() => f.connection.destroy()).not.toThrow();
		await refusesDrain(f.connection);
	});

	it("rejects the original drain when teardown becomes uncertain after its close join", async () => {
		const f = fixture();
		const s = controlledSocket();
		f.onCreate(() => s.socket);
		f.create();
		const drained = f.connection.destroyAndDrain();
		await remainsPending(observe(drained));
		f.onDestroy(() => {
			throw new Error("DYTEST-late-teardown-detail");
		});
		s.socket.once("close", () => f.connection.destroy());
		s.close();
		await expect(drained).rejects.toBeInstanceOf(NativeChannelHostError);
		await expect(drained).rejects.toMatchObject({ code: "NATIVE_CHANNEL_HOST_REFUSED" });
	});

	it.each(["shared", "agent", "socket"] as const)(
		"latches %s teardown failure while destroy remains nonthrowing",
		async (phase) => {
			const f = fixture();
			const s = controlledSocket();
			f.onCreate(() => s.socket);
			f.create();
			const throwFailure = (): never => {
				throw new Error("DYTEST-teardown-detail");
			};
			if (phase === "shared") f.originalDestroy.mockImplementation(throwFailure);
			if (phase === "agent") f.onDestroy(throwFailure);
			if (phase === "socket") s.destroy.mockImplementation(throwFailure);
			expect(() => f.connection.destroy()).not.toThrow();
			await refusesDrain(f.connection);
			s.close();
			await refusesDrain(f.connection);
		},
	);

	it("refuses all socket creation and late requests after the close fence", async () => {
		const f = fixture();
		await f.connection.destroyAndDrain();
		const s = controlledSocket();
		f.onCreate(() => s.socket);
		expect(() => f.create()).toThrow(NativeChannelHostError);
		expect(f.nativeCreate).not.toHaveBeenCalled();
		const r = controlledRequest();
		const ready = vi.fn();
		const fail = vi.fn();
		f.connection.guard(r.request, () => false, ready, fail);
		expect(r.destroy).toHaveBeenCalledTimes(1);
		expect(f.originalGuard).not.toHaveBeenCalled();
		expect(ready).not.toHaveBeenCalled();
		expect(fail).toHaveBeenCalledTimes(1);
	});
});
