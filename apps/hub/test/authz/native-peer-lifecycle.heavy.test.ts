import { Server } from "node:net";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { NativeDeviceTls as NativeDeviceTlsType } from "../../src/authz/native-peer.ts";
import { requireLoopbackNetworkGuard } from "../helpers/loopback-network.ts";
import type { NativeFixture } from "./native-fixture.ts";

requireLoopbackNetworkGuard();
const [{ AuthzError }, { NativeDeviceTls }, { closeFixture, fixture }] = await Promise.all([
	import("../../src/authz/errors.ts"),
	import("../../src/authz/native-peer.ts"),
	import("./native-fixture.ts"),
]);

// No connections: listener state comes from the real server and the native handle list.
const listeners = (): number =>
	process.getActiveResourcesInfo().filter((name) => name === "TCPServerWrap").length;

let f: NativeFixture | undefined;
let idle = 0;
let contexts: (() => readonly unknown[]) | undefined;
beforeEach(() => {
	idle = listeners();
});
afterEach(async () => {
	for (const server of contexts?.() ?? [])
		if (server instanceof Server && server.listening) server.close();
	contexts = undefined;
	vi.restoreAllMocks();
	const current = f;
	f = undefined;
	if (current) await closeFixture(current);
	await released(idle);
});

async function instance(): Promise<{ tls: NativeDeviceTlsType; before: number }> {
	const current = await fixture();
	f = current;
	return {
		tls: new NativeDeviceTls(current.registry, current.identity, () => {}),
		before: listeners(),
	};
}

function spyListen() {
	const listen = vi.spyOn(Server.prototype, "listen");
	contexts = () => listen.mock.contexts;
	return {
		listen,
		server(): Server {
			const server = listen.mock.contexts[0];
			if (!(server instanceof Server)) throw new Error("Native listener not started");
			return server;
		},
	};
}

async function bounded<T>(work: Promise<T>): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			work,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error("Native listener did not settle")), 5_000);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

async function refusal(work: Promise<unknown>): Promise<string> {
	try {
		await work;
		return "NO_REFUSAL";
	} catch (error) {
		return error instanceof AuthzError ? error.code : "UNEXPECTED_ERROR";
	}
}

// A closed listener's native handle leaves the list a few loop turns after its close event.
async function released(count: number): Promise<void> {
	const deadline = Date.now() + 2_000;
	while (listeners() !== count && Date.now() < deadline)
		await new Promise<void>((resolve) => setTimeout(resolve, 5));
	expect(listeners()).toBe(count);
}

async function closeWhilePending(schedule: (close: () => void) => void): Promise<void> {
	const { tls, before } = await instance();
	const { listen, server } = spyListen();
	const listening = refusal(tls.listen());
	const listener = server();
	let stopped = false;
	listener.once("close", () => {
		stopped = true;
	});
	const [first, later] = await new Promise<readonly [Promise<void>, Promise<void>]>((resolve) =>
		schedule(() => resolve([tls.close(), tls.close()])),
	);
	const stoppedWhenSettled = async (close: Promise<void>): Promise<boolean> => {
		await close;
		return stopped;
	};
	const [code, firstStopped, laterStopped] = await bounded(
		Promise.all([listening, stoppedWhenSettled(first), stoppedWhenSettled(later)]),
	);
	expect(listener.listening).toBe(false);
	expect([firstStopped, laterStopped]).toEqual([true, true]);
	expect(code).toBe("PEER_REFUSED");
	await bounded(tls.close());
	expect(await refusal(tls.listen())).toBe("PEER_REFUSED");
	expect(listen).toHaveBeenCalledTimes(1);
	await released(before);
}

it("closes a listener whose listen is still pending when close runs at once", () =>
	closeWhilePending((close) => close()));

it("settles listen and closes the listener when close runs between bind and listening", () =>
	closeWhilePending((close) => process.nextTick(close)));

it("refuses a second listen while the first is pending and closes the one listener", async () => {
	const { tls, before } = await instance();
	const { listen, server } = spyListen();
	const pending = Promise.all([tls.listen(), refusal(tls.listen())]);
	const listener = server();
	const [port, again] = await bounded(pending);
	expect(again).toBe("PEER_REFUSED");
	expect(await refusal(tls.listen())).toBe("PEER_REFUSED");
	expect(listen).toHaveBeenCalledTimes(1);
	expect(listener.address()).toEqual({ address: "127.0.0.1", family: "IPv4", port });
	await bounded(tls.close());
	expect(listener.listening).toBe(false);
	await released(before);
});

it("settles close while a failed listen is pending and starts nothing after it", async () => {
	const { tls, before } = await instance();
	const { listen } = spyListen();
	listen.mockImplementationOnce(function (this: Server) {
		process.nextTick(() => this.emit("error", new Error("DYTEST listen failure")));
		return this;
	});
	const [code] = await bounded(Promise.all([refusal(tls.listen()), tls.close()]));
	expect(code).toBe("UNAVAILABLE");
	expect(await refusal(tls.listen())).toBe("PEER_REFUSED");
	await bounded(tls.close());
	expect(listen).toHaveBeenCalledTimes(1);
	expect(listeners()).toBe(before);
});

it("refuses a listen after close without starting a listener", async () => {
	const { tls, before } = await instance();
	const { listen } = spyListen();
	await bounded(tls.close());
	expect(await refusal(tls.listen())).toBe("PEER_REFUSED");
	await bounded(tls.close());
	expect(listen).not.toHaveBeenCalled();
	expect(listeners()).toBe(before);
});
