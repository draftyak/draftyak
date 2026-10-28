import { EventEmitter } from "node:events";
import {
	type ClientRequest,
	createServer as createHttpServer,
	type ServerResponse,
} from "node:http";
import { createServer, request } from "node:https";
import type { AddressInfo, Socket } from "node:net";
import { createSecureContext } from "node:tls";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
	createPinnedHttpsConnection,
	type EgressPolicy,
	type PinnedAddress,
	resolveEgress,
	validateEgressAnswers,
} from "../../../src/plugins/broker/network/index.ts";
import {
	type NetworkTestHooks,
	withNetworkTestHooks,
} from "../../../src/plugins/broker/network/test-context.ts";
import { createTlsFixture } from "./tls-fixture.ts";

let tls: Awaited<ReturnType<typeof createTlsFixture>>;
beforeAll(async () => {
	tls = await createTlsFixture();
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});
const policy = { deniedAddresses: [], deniedPorts: [] };
const pin = { address: "8.8.8.8", family: 4 as const };

async function peer(
	reply: (response: ServerResponse) => void,
	certificate = tls.cert,
	bind = "127.0.0.1",
) {
	const sockets = new Set<Socket>();
	const seen = {
		connections: 0,
		requests: 0,
		httpBytes: 0,
		hosts: [] as string[],
		sni: [] as string[],
	};
	const server = createServer(
		{
			key: tls.key,
			cert: certificate,
			SNICallback(name, callback) {
				seen.sni.push(name);
				callback(null, createSecureContext({ key: tls.key, cert: certificate }));
			},
		},
		(req, res) => {
			seen.requests++;
			seen.hosts.push(req.headers.host ?? "");
			reply(res);
		},
	);
	server.on("connection", (socket) => {
		seen.connections++;
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
	});
	server.on("secureConnection", (socket) =>
		socket.on("data", (data: Buffer) => {
			seen.httpBytes += data.length;
		}),
	);
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, bind, resolve);
	});
	return {
		port: (server.address() as AddressInfo).port,
		seen,
		async close() {
			const stopped = new Promise<void>((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve())),
			);
			for (const socket of sockets) socket.destroy();
			await stopped;
		},
	};
}

function hooks(port: number, ca: string | undefined = tls.ca): NetworkTestHooks {
	return {
		ca,
		resolve: async () => [pin],
		dial: (checked, requestedPort) => {
			expect(checked).toEqual(pin);
			expect(requestedPort).toBe(443);
			return { address: "127.0.0.1", family: 4, port };
		},
	};
}

async function get(
	host = "guard.example",
	expired = () => false,
	native: EgressPolicy = policy,
	pinned?: PinnedAddress,
): Promise<string> {
	const pin = pinned ?? (await resolveEgress(host, 443, native, new AbortController().signal));
	const connection = createPinnedHttpsConnection(host, 443, pin, native);
	return new Promise<string>((resolve, reject) => {
		let settled = false;
		const req = request({ ...connection.options, path: "/DYTEST-document", method: "GET" });
		const timer = setTimeout(() => finish(new Error("Network request refused")), 2000);
		function finish(error?: Error, body = "") {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			req.destroy();
			connection.destroy();
			if (error) reject(new Error("Network request refused"));
			else resolve(body);
		}
		req.once("error", () => finish(new Error("Network request refused")));
		connection.guard(
			req,
			expired,
			() => req.end(),
			() => finish(new Error("Network request refused")),
		);
		req.once("response", (response) => {
			const chunks: Buffer[] = [];
			response.on("data", (chunk: Buffer) => chunks.push(chunk));
			response.once("error", () => finish(new Error("Network request refused")));
			response.once("end", () => finish(undefined, Buffer.concat(chunks).toString()));
		});
	});
}

describe("real pinned HTTPS", () => {
	it.each([true, false])(
		"verifies a literal IP against its IP SAN without SNI: matching=%s",
		async (matching) => {
			const remote = await peer(
				(response) => response.end("DYTEST-IP"),
				matching ? tls.ipCert : tls.cert,
				"127.0.0.2",
			);
			const localPin = { address: "127.0.0.2", family: 4 as const };
			const fixture: NetworkTestHooks = {
				ca: tls.ca,
				dial: (checked) => {
					expect(checked).toEqual(localPin);
					return { address: "127.0.0.2", family: 4, port: remote.port };
				},
			};
			try {
				const result = withNetworkTestHooks(fixture, () =>
					get("127.0.0.2", () => false, { ...policy, allowLocal: true }),
				);
				if (matching) {
					await expect(result).resolves.toBe("DYTEST-IP");
					expect(remote.seen.hosts).toEqual(["127.0.0.2"]);
				} else {
					await expect(result).rejects.toThrow("Network request refused");
					expect(remote.seen.requests).toBe(0);
					expect(remote.seen.httpBytes).toBe(0);
				}
				expect(remote.seen.sni).toEqual([]);
			} finally {
				await remote.close();
			}
		},
	);
	it.each([
		["127.0.0.1", { address: "127.0.0.2", family: 4 }, "127.0.0.1"],
		["127.0.0.1", { address: "::1", family: 6 }, "127.0.0.1"],
		["::1", { address: "2606:4700:4700::1111", family: 6 }, "::1"],
		["0:0:0:0:0:0:0:1", { address: "2606:4700:4700::1111", family: 6 }, "::1"],
		["0:0:0:0:0:0:0:1", { address: "127.0.0.1", family: 4 }, "::1"],
		["::ffff:127.0.0.1", { address: "127.0.0.1", family: 4 }, "127.0.0.1"],
	] as const)(
		"refuses literal host %s under accepted pin %j of another address or family before connecting",
		async (host, other, bind) => {
			const local = { ...policy, allowLocal: true };
			expect(validateEgressAnswers([other], local)).toEqual(other);
			const remote = await peer((response) => response.end("DYTEST-unexpected"), tls.cert, bind);
			const dial = vi.fn((checked: PinnedAddress) => ({ ...checked, port: remote.port }));
			try {
				await expect(
					withNetworkTestHooks({ ca: tls.ca, dial }, () => get(host, () => false, local, other)),
				).rejects.toThrow("Network request refused");
				expect(remote.seen.connections).toBe(0);
				expect(dial).not.toHaveBeenCalled();
				expect(() => createPinnedHttpsConnection(host, 443, other, local)).toThrow(
					"Network request refused",
				);
			} finally {
				await remote.close();
			}
		},
	);
	it.each([
		["127.0.0.2", { address: "127.0.0.2", family: 4 }, "127.0.0.2", undefined],
		["::1", { address: "::1", family: 6 }, "[::1]", undefined],
		["0:0:0:0:0:0:0:1", { address: "::1", family: 6 }, "[0:0:0:0:0:0:0:1]", undefined],
		["0::1", { address: "::1", family: 6 }, "[0::1]", { address: "0:0:0:0:0:0:0:1", family: 6 }],
	] as const)(
		"connects literal host %s through its equal canonical pin %j",
		async (host, equal, authority, given) => {
			const remote = await peer(
				(response) => response.end("DYTEST-literal"),
				tls.ipCert,
				equal.address,
			);
			const dial = vi.fn((checked: PinnedAddress) => ({ ...checked, port: remote.port }));
			try {
				await expect(
					withNetworkTestHooks({ ca: tls.ca, dial }, () =>
						get(host, () => false, { ...policy, allowLocal: true }, given),
					),
				).resolves.toBe("DYTEST-literal");
				expect(dial).toHaveBeenCalledExactlyOnceWith(equal, 443);
				expect(remote.seen).toMatchObject({
					connections: 1,
					requests: 1,
					hosts: [authority],
					sni: [],
				});
			} finally {
				await remote.close();
			}
		},
	);
	it("pins one DNS resolution and checks the original TLS name and Host before sending", async () => {
		const remote = await peer((response) => response.end("DYTEST-body"));
		let calls = 0;
		const resolve = vi.fn(async () =>
			++calls === 1 ? [pin] : [{ address: "127.0.0.1", family: 4 as const }],
		);
		const lookup = vi.fn();
		const nativeFetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(Error("Unexpected fetch"));
		try {
			await expect(
				withNetworkTestHooks({ ...hooks(remote.port), resolve, lookupObserved: lookup }, () =>
					get(),
				),
			).resolves.toBe("DYTEST-body");
			expect(resolve).toHaveBeenCalledOnce();
			expect(lookup).toHaveBeenCalledExactlyOnceWith({ family: 4, hints: 0 });
			expect(remote.seen).toMatchObject({
				connections: 1,
				requests: 1,
				hosts: ["guard.example"],
				sni: ["guard.example"],
			});
			expect(remote.seen.httpBytes).toBeGreaterThan(0);
			expect(nativeFetch).not.toHaveBeenCalled();
		} finally {
			await remote.close();
		}
	});
	it.each(["wrong-name", "untrusted"])(
		"refuses %s certificates before any HTTP bytes",
		async (mode) => {
			const remote = await peer((response) => response.end("DYTEST-unexpected"));
			try {
				const fixture = hooks(remote.port);
				await expect(
					withNetworkTestHooks(
						{ ...fixture, ...(mode === "untrusted" ? { ca: undefined } : {}) },
						() => get(mode === "wrong-name" ? "other.example" : "guard.example"),
					),
				).rejects.toThrow("Network request refused");
				expect(remote.seen.connections).toBe(1);
				expect(remote.seen.requests).toBe(0);
				expect(remote.seen.httpBytes).toBe(0);
			} finally {
				await remote.close();
			}
		},
	);
	it("refuses an expired connection before the first HTTP byte", async () => {
		const remote = await peer((response) => response.end("DYTEST-unexpected"));
		try {
			await expect(
				withNetworkTestHooks(hooks(remote.port), () => get("guard.example", () => true)),
			).rejects.toThrow();
			expect(remote.seen.requests).toBe(0);
			expect(remote.seen.httpBytes).toBe(0);
		} finally {
			await remote.close();
		}
	});
	it("refuses a real redirect without opening its destination", async () => {
		const target = await peer((response) => response.end("DYTEST-unexpected"));
		const remote = await peer((response) =>
			response
				.writeHead(302, { location: `https://guard.example:${target.port}/DYTEST-hop` })
				.end(),
		);
		try {
			await expect(withNetworkTestHooks(hooks(remote.port), () => get())).rejects.toThrow();
			expect(remote.seen.requests).toBe(1);
			expect(target.seen.connections).toBe(0);
		} finally {
			await remote.close();
			await target.close();
		}
	});
	it("ignores proxy environment variables while retaining the pinned TLS peer", async () => {
		let connections = 0;
		const proxy = createHttpServer((_request, response) => response.end("DYTEST-proxy"));
		proxy.on("connection", () => {
			connections++;
		});
		await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
		const remote = await peer((response) => response.end("DYTEST-direct"));
		const origin = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
		for (const name of [
			"HTTP_PROXY",
			"HTTPS_PROXY",
			"ALL_PROXY",
			"http_proxy",
			"https_proxy",
			"all_proxy",
		])
			vi.stubEnv(name, origin);
		vi.stubEnv("NODE_USE_ENV_PROXY", "1");
		try {
			await expect(withNetworkTestHooks(hooks(remote.port), () => get())).resolves.toBe(
				"DYTEST-direct",
			);
			expect(remote.seen.requests).toBe(1);
			expect(connections).toBe(0);
		} finally {
			await remote.close();
			await new Promise<void>((resolve, reject) =>
				proxy.close((error) => (error ? reject(error) : resolve())),
			);
		}
	});
	it.each(["pin", "authorization"])(
		"independently refuses a %s mismatch at secure-connect",
		(mode) => {
			const connection = createPinnedHttpsConnection("guard.example", 443, pin, policy);
			const req = new EventEmitter();
			const socket = new EventEmitter();
			Object.assign(socket, {
				authorized: mode !== "authorization",
				remoteAddress: mode === "pin" ? "8.8.4.4" : "8.8.8.8",
			});
			const ready = vi.fn(),
				fail = vi.fn();
			connection.guard(req as ClientRequest, () => false, ready, fail);
			req.emit("socket", socket);
			socket.emit("secureConnect");
			expect(ready).not.toHaveBeenCalled();
			expect(fail).toHaveBeenCalledOnce();
			connection.destroy();
		},
	);
});
