import dns from "node:dns";
import { createRequire } from "node:module";
import net from "node:net";
import tls from "node:tls";
import { expect, it } from "vitest";
import { requireLoopbackNetworkGuard } from "./loopback-network.ts";

it("refuses non-loopback native destinations before the underlying operation", () => {
	const guard = requireLoopbackNetworkGuard();
	let calls = 0;
	const connect = guard.restrictConnect(() => ++calls);
	for (const address of [
		"192.0.2.1",
		"2001:db8::1",
		"localhost",
		undefined,
		1,
		"127.0.0.256",
		"127.00.0.1",
		"126.255.255.255",
		"::2",
		"::",
		"::1%1",
		"0::1::",
	])
		expect(connect({}, address, 9)).toBe(guard.denialCode);
	expect(calls).toBe(0);
	expect(connect({}, "127.0.0.1", 9)).toBe(1);
	expect(connect({}, "::1", 9)).toBe(2);
	for (const address of ["127.0.0.2", "127.255.255.255", "0:0:0:0:0:0:0:1", "0::1", "::0001"])
		expect(guard.loopbackAddress(address)).toBe(true);
});

it("refuses frozen fake exports and replaced cache entries without trusting their checks", () => {
	const guard = requireLoopbackNetworkGuard(),
		require = createRequire(import.meta.url);
	const path = require.resolve("./loopback-preload.cjs"),
		original = Object.getOwnPropertyDescriptor(require.cache, path);
	if (!original || !("value" in original)) throw new Error("Startup module missing");
	const module = original.value,
		exports = Object.getOwnPropertyDescriptor(module, "exports");
	if (!exports) throw new Error("Startup exports missing");
	let calls = 0;
	try {
		Object.defineProperty(module, "exports", {
			...exports,
			value: Object.freeze({
				assertActive: () => {
					calls++;
				},
			}),
		});
		expect(() => requireLoopbackNetworkGuard()).toThrow("startup network guard cache");
		expect(calls).toBe(0);
		Object.defineProperty(module, "exports", exports);
		Object.defineProperty(require.cache, path, {
			...original,
			value: Object.freeze({ exports: guard }),
		});
		expect(() => requireLoopbackNetworkGuard()).toThrow("startup network guard cache");
	} finally {
		Object.defineProperty(module, "exports", exports);
		Object.defineProperty(require.cache, path, original);
	}
	guard.assertActive();
});

it("refuses genuine late installation while retaining the restrictive startup guard", () => {
	const guard = requireLoopbackNetworkGuard(),
		require = createRequire(import.meta.url);
	const path = require.resolve("./loopback-preload.cjs"),
		original = Object.getOwnPropertyDescriptor(require.cache, path);
	if (!original) throw new Error("Startup module missing");
	try {
		Reflect.deleteProperty(require.cache, path);
		expect(() => require(path)).toThrow("requires startup preloading");
	} finally {
		Object.defineProperty(require.cache, path, original);
	}
	expect(requireLoopbackNetworkGuard()).toBe(guard);
});

it("denies all native DNS paths including retained resolver functions", async () => {
	requireLoopbackNetworkGuard();
	await new Promise<void>((resolve) =>
		dns.lookup("example.invalid", (error) => {
			expect(error?.code).toBe("EACCES");
			resolve();
		}),
	);
	await expect(dns.promises.lookup("example.invalid")).rejects.toMatchObject({ code: "EACCES" });
	await expect(dns.promises.resolve4("example.invalid")).rejects.toMatchObject({ code: "EACCES" });
	const resolver = new dns.promises.Resolver();
	await expect(resolver.resolve6("example.invalid")).rejects.toMatchObject({ code: "EACCES" });
});

it("refuses a replaced native entry point even when its replacement also denies networking", () => {
	const guard = requireLoopbackNetworkGuard();
	const tcp = (
		process as unknown as { binding(name: string): { TCP: { prototype: object } } }
	).binding("tcp_wrap");
	const prototype = tcp.TCP.prototype;
	const original = Object.getOwnPropertyDescriptor(prototype, "connect");
	if (!original) throw new Error("Native TCP descriptor missing");
	try {
		Object.defineProperty(prototype, "connect", { ...original, value: () => guard.denialCode });
		expect(() => guard.assertActive()).toThrow("native guard is not installed");
	} finally {
		Object.defineProperty(prototype, "connect", original);
	}
	guard.assertActive();
});

it("allows loopback TCP with the original authority and custom pinned lookup", async () => {
	const guard = requireLoopbackNetworkGuard();
	const server = net.createServer((socket) => socket.end("DYTEST"));
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	try {
		const port = (server.address() as net.AddressInfo).port;
		const data = await new Promise<string>((resolve, reject) => {
			const socket = net.connect({
				host: "example.invalid",
				port,
				lookup: (_host, _options, callback) => callback(null, "127.0.0.1", 4),
				autoSelectFamily: false,
			});
			let value = "";
			socket.on("data", (bytes) => {
				value += bytes.toString();
			});
			socket.once("error", reject);
			socket.once("end", () => resolve(value));
		});
		expect(data).toBe("DYTEST");
		guard.assertActive();
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});

it("retains cached TCP/TLS functions behind native destination denial", async () => {
	const guard = requireLoopbackNetworkGuard();
	const connectors: Array<(options: net.TcpNetConnectOpts) => net.Socket> = [
		net.createConnection,
		tls.connect,
	];
	for (const connect of connectors) {
		await new Promise<void>((resolve, reject) => {
			const socket = connect({ host: "192.0.2.1", port: 9, autoSelectFamily: false });
			socket.once("connect", () => {
				socket.destroy();
				reject(new Error("Native denial bypassed"));
			});
			socket.once("error", (error) => {
				expect(error).toMatchObject({ code: "EACCES" });
				socket.destroy();
				resolve();
			});
		});
	}
	guard.assertActive();
});
