import { type ClientRequest, createServer, type IncomingMessage, request } from "node:http";
import { type AddressInfo, Socket } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createPinnedHttpConnection,
	type EgressPolicy,
	type PinnedAddress,
	type PinnedHttpConnection,
} from "../../../src/plugins/broker/network/index.ts";
import { withNetworkTestHooks } from "../../../src/plugins/broker/network/test-context.ts";

const policy: EgressPolicy = { deniedAddresses: [], deniedPorts: [], allowLocal: true };
const pin: PinnedAddress = { address: "127.0.0.1", family: 4 };
const cleanups: (() => Promise<void>)[] = [];
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
function deferred<T>() {
	let resolve: (value: T) => void = () => undefined;
	const promise = new Promise<T>((yes) => {
		resolve = yes;
	});
	return { promise, resolve };
}

afterEach(async () => {
	const outcomes = await Promise.allSettled(
		cleanups
			.splice(0)
			.reverse()
			.map((cleanup) => cleanup()),
	);
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	for (const outcome of outcomes) expect(outcome.status).toBe("fulfilled");
});

async function peer(
	reply: (response: import("node:http").ServerResponse) => void = (response) => {
		response.end("DYTEST-ok");
	},
	host = "127.0.0.1",
) {
	const sockets = new Set<Socket>();
	const closes: Promise<void>[] = [];
	const messages: Promise<void>[] = [];
	const seen = {
		connections: 0,
		bytes: 0,
		requests: 0,
		hosts: [] as string[],
		bodies: [] as string[],
	};
	const entered = deferred<void>();
	const closed = deferred<void>();
	const server = createServer((incoming, response) => {
		messages.push(new Promise<void>((resolve) => incoming.once("close", () => resolve())));
		messages.push(new Promise<void>((resolve) => response.once("close", () => resolve())));
		seen.requests++;
		seen.hosts.push(incoming.headers.host ?? "");
		const chunks: Buffer[] = [];
		incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
		incoming.once("end", () => {
			seen.bodies.push(Buffer.concat(chunks).toString("utf8"));
			entered.resolve();
			reply(response);
		});
	});
	server.once("close", () => closed.resolve());
	server.on("connection", (socket) => {
		seen.connections++;
		sockets.add(socket);
		closes.push(
			new Promise<void>((resolve) =>
				socket.once("close", () => {
					sockets.delete(socket);
					resolve();
				}),
			),
		);
		socket.on("data", (chunk: Buffer) => {
			seen.bytes += chunk.byteLength;
		});
		socket.on("error", () => undefined);
	});
	let listening = false;
	cleanups.push(async () => {
		if (server.listening) server.close();
		for (const socket of sockets) socket.destroy();
		if (listening) await closed.promise;
		await Promise.all(closes);
		await Promise.all(messages);
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, host, () => {
			listening = true;
			resolve();
		});
	});
	return { port: (server.address() as AddressInfo).port, seen, entered: entered.promise };
}

function captureDials(redirect?: { expected: string; actual: string; port: number }) {
	const originalConnect = Socket.prototype.connect;
	const records: {
		socket: Socket;
		connected: Promise<boolean>;
		closed: Promise<void>;
		peer?: string;
	}[] = [];
	vi.spyOn(Socket.prototype, "connect").mockImplementation(function (
		this: Socket,
		...args: unknown[]
	): Socket {
		const connected = deferred<boolean>();
		const closed = deferred<void>();
		const record = {
			socket: this,
			connected: connected.promise,
			closed: closed.promise,
			peer: undefined as string | undefined,
		};
		records.push(record);
		this.once("connect", () => {
			record.peer = this.remoteAddress;
			connected.resolve(true);
		});
		this.once("close", () => {
			connected.resolve(false);
			closed.resolve();
		});
		const options = args[0];
		if (
			redirect &&
			options !== null &&
			typeof options === "object" &&
			"host" in options &&
			"port" in options &&
			options.host === redirect.expected &&
			options.port === redirect.port
		) {
			// Route the original real socket to a different loopback peer; no socket events are fabricated.
			args = [{ ...options, host: redirect.actual }, ...args.slice(1)];
		}
		return Reflect.apply(originalConnect, this, args);
	});
	cleanups.push(async () => {
		for (const record of records) record.socket.destroy();
		await Promise.all(records.map((record) => record.closed));
	});
	return records;
}

function begin(
	connection: PinnedHttpConnection,
	options: {
		queued?: boolean;
		guard?: boolean;
		expired?: () => boolean;
		signal?: AbortSignal;
	} = {},
) {
	let state: "pending" | "ok" | "refused" = "pending";
	let ready = 0;
	let response: IncomingMessage | undefined;
	let responseClosed: Promise<void> | undefined;
	const outcome = deferred<"ok" | "refused">();
	const closed = deferred<void>();
	const assignedCloses: Promise<void>[] = [];
	let original: ClientRequest | undefined;
	const settle = (value: "ok" | "refused") => {
		if (state !== "pending") return;
		state = value;
		outcome.resolve(value);
	};
	cleanups.push(async () => {
		connection.destroy();
		original?.destroy();
		response?.destroy();
		if (original) {
			await closed.promise;
			await outcome.promise;
		}
		await Promise.all(assignedCloses);
		await responseClosed;
	});
	original = request(
		{ ...connection.options, method: "POST", path: "/draft", signal: options.signal },
		(incoming) => {
			response = incoming;
			responseClosed = new Promise<void>((resolve) => incoming.once("close", () => resolve()));
			incoming.once("end", () => settle("ok"));
			incoming.once("error", () => settle("refused"));
			incoming.once("close", () => settle("refused"));
			incoming.resume();
		},
	);
	original.once("error", () => settle("refused"));
	original.once("socket", (socket) => {
		assignedCloses.push(new Promise<void>((resolve) => socket.once("close", () => resolve())));
	});
	original.once("close", () => {
		closed.resolve();
		if (!response) settle("refused");
	});
	const installGuard = () => {
		if (!original) throw new Error("DYTEST missing original request");
		connection.guard(
			original,
			options.expired ?? (() => false),
			() => {
				ready++;
				if (!options.queued) original?.end("DYTEST-body");
			},
			() => settle("refused"),
		);
	};
	if (options.queued) original.end("DYTEST-body");
	if (options.guard !== false) installGuard();
	return {
		result: outcome.promise,
		closed: closed.promise,
		state: () => state,
		ready: () => ready,
		installGuard,
	};
}

describe("pinned loopback HTTP", () => {
	it("uses the captured loopback pin and original DNS authority without another lookup", async () => {
		const target = await peer();
		const dials = captureDials();
		const connection = createPinnedHttpConnection("provider.test", target.port, pin, policy);
		const job = begin(connection);
		expect(await job.result).toBe("ok");
		await job.closed;
		expect(job.ready()).toBe(1);
		expect(dials).toHaveLength(1);
		expect(dials[0]?.peer).toBe("127.0.0.1");
		expect(target.seen.hosts).toEqual([`provider.test:${target.port}`]);
		expect(target.seen.bodies).toEqual(["DYTEST-body"]);
		expect(connection.options.autoSelectFamily).toBe(false);
	});

	it("retains bracketed IPv6 authority for an actual IPv6 loopback peer", async () => {
		const target = await peer(undefined, "::1");
		const connection = createPinnedHttpConnection(
			"::1",
			target.port,
			{ address: "::1", family: 6 },
			policy,
		);
		const job = begin(connection);
		expect(await job.result).toBe("ok");
		await job.closed;
		expect(target.seen.hosts).toEqual([`[::1]:${target.port}`]);
	});

	it.each([
		{
			label: "public",
			host: "provider.test",
			pin: { address: "8.8.8.8", family: 4 },
			port: 80,
			policy,
		},
		{
			label: "private",
			host: "provider.test",
			pin: { address: "10.0.0.1", family: 4 },
			port: 80,
			policy,
		},
		{
			label: "metadata",
			host: "provider.test",
			pin: { address: "169.254.169.254", family: 4 },
			port: 80,
			policy,
		},
		{
			label: "mapped",
			host: "provider.test",
			pin: { address: "::ffff:127.0.0.1", family: 6 },
			port: 80,
			policy,
		},
		{
			label: "locality permission",
			host: "provider.test",
			pin,
			port: 80,
			policy: { ...policy, allowLocal: false },
		},
		{
			label: "denied address",
			host: "provider.test",
			pin,
			port: 80,
			policy: { ...policy, deniedAddresses: ["127.0.0.1"] },
		},
		{ label: "reserved port", host: "provider.test", pin, port: 47613, policy },
		{
			label: "denied port",
			host: "provider.test",
			pin,
			port: 80,
			policy: { ...policy, deniedPorts: [80] },
		},
		{ label: "literal mismatch", host: "127.0.0.2", pin, port: 80, policy },
		{ label: "host alias", host: "127.1", pin, port: 80, policy },
		{ label: "userinfo", host: "provider.test@127.0.0.1", pin, port: 80, policy },
	] as const)("refuses $label before opening a socket", ({ host, port, pin, policy }) => {
		const dials = captureDials();
		expect(() => createPinnedHttpConnection(host, port, pin, policy)).toThrowError(
			"Network request refused",
		);
		expect(dials).toHaveLength(0);
	});

	it("withholds an already queued body until the connected socket is guarded", async () => {
		const target = await peer();
		const dials = captureDials();
		const connection = createPinnedHttpConnection("provider.test", target.port, pin, policy);
		const job = begin(connection, { queued: true, guard: false });
		expect(dials).toHaveLength(1);
		expect(await dials[0]?.connected).toBe(true);
		await turn();
		expect(job.state()).toBe("pending");
		expect(target.seen.bytes).toBe(0);
		job.installGuard();
		expect(await job.result).toBe("ok");
		await job.closed;
		expect(target.seen.bodies).toEqual(["DYTEST-body"]);
	});

	it("refuses a different actual loopback peer before handing over queued bytes", async () => {
		const target = await peer();
		const dials = captureDials({ expected: "127.0.0.2", actual: "127.0.0.1", port: target.port });
		const connection = createPinnedHttpConnection(
			"provider.test",
			target.port,
			{ address: "127.0.0.2", family: 4 },
			policy,
		);
		const job = begin(connection, { queued: true });
		expect(await job.result).toBe("refused");
		await job.closed;
		await turn();
		expect(dials).toHaveLength(1);
		expect(dials[0]?.peer).toBe("127.0.0.1");
		expect(job.ready()).toBe(0);
		expect(target.seen.bytes).toBe(0);
	});

	it("refuses an expired connected request before its queued body is written", async () => {
		const target = await peer();
		const dials = captureDials();
		const connection = createPinnedHttpConnection("provider.test", target.port, pin, policy);
		const job = begin(connection, { queued: true, guard: false, expired: () => true });
		expect(dials).toHaveLength(1);
		expect(await dials[0]?.connected).toBe(true);
		expect(dials[0]?.peer).toBe("127.0.0.1");
		job.installGuard();
		expect(await job.result).toBe("refused");
		await job.closed;
		await turn();
		expect(job.ready()).toBe(0);
		expect(target.seen.bytes).toBe(0);
	});

	it("closes the real pending socket when its owner destroys a guarded-late request", async () => {
		const target = await peer();
		const dials = captureDials();
		const connection = createPinnedHttpConnection("provider.test", target.port, pin, policy);
		const job = begin(connection, { queued: true, guard: false });
		expect(dials).toHaveLength(1);
		expect(await dials[0]?.connected).toBe(true);
		connection.destroy();
		expect(await job.result).toBe("refused");
		await job.closed;
		await dials[0]?.closed;
		expect(target.seen.bytes).toBe(0);
	});

	it("retains request cancellation for an actual unfinished HTTP response", async () => {
		const target = await peer((response) => {
			response.writeHead(200);
			response.flushHeaders();
		});
		const dials = captureDials();
		const controller = new AbortController();
		const connection = createPinnedHttpConnection("provider.test", target.port, pin, policy);
		const job = begin(connection, { signal: controller.signal });
		expect(
			await Promise.race([target.entered.then(() => true), job.result.then(() => false)]),
		).toBe(true);
		controller.abort();
		expect(await job.result).toBe("refused");
		await job.closed;
		await dials[0]?.closed;
		expect(controller.signal.aborted).toBe(true);
	});

	it("refuses a real redirect without opening its destination", async () => {
		const destination = await peer();
		const target = await peer((response) => {
			response.writeHead(302, { Location: `http://127.0.0.1:${destination.port}/next` });
			response.end();
		});
		const connection = createPinnedHttpConnection("provider.test", target.port, pin, policy);
		const job = begin(connection);
		expect(await job.result).toBe("refused");
		await job.closed;
		expect(target.seen.requests).toBe(1);
		expect(destination.seen.connections).toBe(0);
	});

	it("ignores proxy environment destinations and keeps the original default-port authority", async () => {
		const target = await peer();
		const proxy = await peer();
		vi.stubEnv("HTTP_PROXY", `http://127.0.0.1:${proxy.port}`);
		vi.stubEnv("http_proxy", `http://127.0.0.1:${proxy.port}`);
		vi.stubEnv("ALL_PROXY", `http://127.0.0.1:${proxy.port}`);
		await withNetworkTestHooks({ dial: (pin) => ({ ...pin, port: target.port }) }, async () => {
			const connection = createPinnedHttpConnection("provider.test", 80, pin, policy);
			const job = begin(connection);
			expect(await job.result).toBe("ok");
			await job.closed;
		});
		expect(target.seen.hosts).toEqual(["provider.test"]);
		expect(proxy.seen.connections).toBe(0);
	});
});
