import { createServer, type IncomingHttpHeaders, type RequestListener } from "node:http";
import { createServer as createSecureServer } from "node:https";
import { type AddressInfo, createConnection, type Socket } from "node:net";
import { connect as connectTls, TLSSocket } from "node:tls";
import { describe, expect, it } from "vitest";
import {
	createPublicRequestFactsPolicy,
	MAX_PUBLIC_HEADER_BYTES,
	type PublicRequestFacts,
	PublicRequestFactsError,
} from "../src/listeners/l3/proxy-facts.ts";
import { createMetadataTlsFixture } from "./helpers/metadata-tls.ts";

const origin = "https://hub.example:8443";
const host = "hub.example:8443";
const clientIP = "198.51.100.8";
const reservedPorts = new Set([9229, 47613, 47614, 47615]);
const forwarded = (): string[] => [
	`Host: ${host}`,
	`X-Forwarded-For: ${clientIP}`,
	"X-Forwarded-Proto: https",
];
interface Observation {
	readonly url: string | undefined;
	readonly socketIP: string | undefined;
	readonly encrypted: boolean;
	readonly rawHeaders: readonly string[];
	readonly headers: IncomingHttpHeaders;
	readonly bodyBytes: number;
	readonly facts?: PublicRequestFacts;
	readonly refusal?: { readonly code: string; readonly message: string };
}

/** Synthetic loopback HTTP/TLS observations, never a product listener or external TLS deployment. */
async function observe(
	lines: readonly string[],
	trustedProxyCidrs: readonly string[] = ["127.0.0.1/32"],
	target = "/mcp",
	tls?: Awaited<ReturnType<typeof createMetadataTlsFixture>>,
): Promise<Observation> {
	const policy = createPublicRequestFactsPolicy({ publicOrigin: origin, trustedProxyCidrs });
	const seen = Promise.withResolvers<Observation>();
	const sockets = new Set<Socket>();
	const serverOptions = {
		maxHeaderSize: MAX_PUBLIC_HEADER_BYTES,
		headersTimeout: 1000,
		requestTimeout: 1000,
		keepAliveTimeout: 100,
		connectionsCheckingInterval: 100,
	};
	const receive: RequestListener = (request, response) => {
		let bodyBytes = 0;
		request.on("data", (chunk: Buffer) => {
			bodyBytes += chunk.byteLength;
			if (bodyBytes > 0) request.destroy(new Error("Socket fixture body refused"));
		});
		request.on("error", () => seen.reject(new Error("Socket fixture request failed")));
		request.on("end", () => {
			const socketIP = request.socket.remoteAddress;
			const encrypted = request.socket instanceof TLSSocket && request.socket.encrypted === true;
			const native = {
				url: request.url,
				socketIP,
				encrypted,
				rawHeaders: [...request.rawHeaders],
				headers: { ...request.headers },
				bodyBytes,
			};
			try {
				const facts = policy.inspect({
					url: request.url,
					remoteAddress: socketIP,
					encrypted,
					rawHeaders: request.rawHeaders,
				});
				seen.resolve({ ...native, facts });
				response.writeHead(200, { "content-length": "0", connection: "close" }).end();
			} catch (error) {
				if (!(error instanceof PublicRequestFactsError)) {
					seen.reject(new Error("Socket fixture checker failed"));
					response.destroy();
					return;
				}
				seen.resolve({ ...native, refusal: { code: error.code, message: error.message } });
				response.writeHead(400, { "content-length": "0", connection: "close" }).end();
			}
		});
	};
	const server = tls
		? createSecureServer(
				{ ...serverOptions, cert: tls.cert, key: tls.key, handshakeTimeout: 1000 },
				receive,
			)
		: createServer(serverOptions, receive);
	server.maxConnections = 1;
	server.maxRequestsPerSocket = 1;
	server.on("connection", (socket) => {
		sockets.add(socket);
		socket.setTimeout(1500, () => socket.destroy());
		socket.once("close", () => sockets.delete(socket));
	});
	let client: Socket | undefined;
	const deadline = setTimeout(() => {
		client?.destroy(new Error("Socket fixture timed out"));
		seen.reject(new Error("Socket fixture timed out"));
	}, 2500);
	try {
		let port = 0;
		for (let attempt = 0; attempt < 10; attempt++) {
			await new Promise<void>((resolve, reject) => {
				server.once("error", reject);
				server.listen({ port: 0, host: "127.0.0.1", exclusive: true }, () => {
					server.off("error", reject);
					resolve();
				});
			});
			port = (server.address() as AddressInfo).port;
			if (!reservedPorts.has(port)) break;
			await new Promise<void>((resolve) => server.close(() => resolve()));
			port = 0;
		}
		if (port === 0) throw new Error("Socket fixture received only reserved ports");
		client = tls
			? connectTls({
					host: "127.0.0.1",
					port,
					servername: "hub.example",
					ca: tls.ca,
					rejectUnauthorized: true,
					ALPNProtocols: ["http/1.1"],
				})
			: createConnection({ host: "127.0.0.1", port });
		const response = new Promise<string>((resolve, reject) => {
			let wire = "",
				ended = false;
			client?.setEncoding("ascii");
			client?.on("error", () => reject(new Error("Socket fixture connection failed")));
			client?.on("data", (chunk: string) => {
				if (wire.length + chunk.length > 4096) {
					reject(new Error("Socket fixture response exceeded bounds"));
					client?.destroy();
				} else wire += chunk;
			});
			client?.on("end", () => {
				ended = true;
				resolve(wire);
			});
			client?.on("close", () => {
				if (!ended) reject(new Error("Socket fixture response ended early"));
			});
			client?.once(tls ? "secureConnect" : "connect", () => {
				if (tls && (!(client instanceof TLSSocket) || !client.authorized)) {
					reject(new Error("Socket fixture TLS authentication failed"));
					client?.destroy();
					return;
				}
				const wire = [`GET ${target} HTTP/1.1`, ...lines, "Connection: close", "", ""].join("\r\n");
				if (tls) client?.write(wire);
				else client?.end(wire);
			});
		});
		const [observation, wire] = await Promise.all([seen.promise, response]);
		expect(wire).toMatch(observation.facts ? /^HTTP\/1\.1 200 / : /^HTTP\/1\.1 400 /);
		expect(observation.socketIP).toBe("127.0.0.1");
		expect(observation.encrypted).toBe(Boolean(tls));
		expect(observation.bodyBytes).toBe(0);
		return observation;
	} finally {
		clearTimeout(deadline);
		client?.destroy();
		for (const socket of sockets) socket.destroy();
		server.closeAllConnections();
		if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
	}
}

const refused = (observation: Observation): void => {
	expect(observation.facts).toBeUndefined();
	expect(observation.refusal).toEqual({
		code: "PUBLIC_REQUEST_FACTS_REFUSED",
		message: "Public request facts refused",
	});
};

describe("proxy facts from actual native HTTP socket observations", () => {
	it.each([
		"https://other.example/oauth/token",
		`${origin}/oauth/token`,
		"//other.example/oauth/token",
		"/\\other.example/oauth/token",
	])("refuses absolute-form authority despite correct trusted-proxy Host: %s", async (target) => {
		const result = await observe(forwarded(), ["127.0.0.1/32"], target);
		expect(result.url).toBe(target);
		expect(result.headers.host).toBe(host);
		refused(result);
	});
	it("retains positive origin-form controls on authenticated direct TLS before refusing absolute authority", async () => {
		const tls = await createMetadataTlsFixture();
		for (const target of [
			"/mcp",
			"/oauth/token?client=synthetic",
			"/%5cother.example/oauth/token",
		]) {
			const result = await observe([`Host: ${host}`], [], target, tls);
			expect(result.url).toBe(target);
			expect(result.facts).toEqual({
				publicOrigin: origin,
				socketIP: "127.0.0.1",
				clientIP: "127.0.0.1",
				via: "direct",
			});
		}
		for (const target of [
			"https://other.example/oauth/token",
			`${origin}/oauth/token`,
			"//other.example/oauth/token",
			"/\\other.example/oauth/token",
		]) {
			const result = await observe([`Host: ${host}`], [], target, tls);
			expect(result.url).toBe(target);
			expect(result.headers.host).toBe(host);
			refused(result);
		}
	});
	it("keeps the actual plaintext loopback peer distinct from the proxy's asserted HTTPS client", async () => {
		const result = await observe([...forwarded(), "X-Remote-Address: 203.0.113.9"]);
		expect(result.facts).toEqual({
			publicOrigin: origin,
			socketIP: "127.0.0.1",
			clientIP,
			via: "trusted-proxy",
		});
		expect(Object.isFrozen(result.facts)).toBe(true);
	});
	it("canonicalizes a mapped client IP while retaining the actual socket peer and exact forwarded host", async () => {
		const result = await observe([
			`Host: ${host}`,
			"X-Forwarded-For: ::ffff:c633:6408",
			"X-Forwarded-Proto: https",
			`X-Forwarded-Host: ${host}`,
		]);
		expect(result.facts).toMatchObject({ socketIP: "127.0.0.1", clientIP, via: "trusted-proxy" });
	});
	it.each([false, true])(
		"does not infer direct TLS from headers without a configured proxy (claims=%s)",
		async (claims) => {
			refused(await observe(claims ? forwarded() : [`Host: ${host}`], []));
		},
	);
	it("refuses a Host which does not bind the configured public origin", async () => {
		refused(await observe(["Host: other.example:8443", ...forwarded().slice(1)]));
	});
	it("refuses a forwarding chain even though it arrived over the configured proxy socket", async () => {
		refused(
			await observe([
				`Host: ${host}`,
				`X-Forwarded-For: ${clientIP}, 203.0.113.9`,
				"X-Forwarded-Proto: https",
			]),
		);
	});
	it.each([host, "other.example:8443"])(
		"uses raw duplicate Host fields instead of Node's collapsed first Host (%s)",
		async (second) => {
			const result = await observe([...forwarded(), `hOsT: ${second}`]);
			expect(result.headers.host).toBe(host);
			expect(
				result.rawHeaders.filter(
					(value, index) => index % 2 === 0 && value.toLowerCase() === "host",
				),
			).toHaveLength(2);
			refused(result);
		},
	);
	it("uses raw duplicate XFF fields rather than accepting Node's joined convenience value", async () => {
		const result = await observe([...forwarded(), "x-forwarded-for: 203.0.113.9"]);
		expect(result.headers["x-forwarded-for"]).toBe(`${clientIP}, 203.0.113.9`);
		expect(
			result.rawHeaders.filter(
				(value, index) => index % 2 === 0 && value.toLowerCase() === "x-forwarded-for",
			),
		).toHaveLength(2);
		refused(result);
	});
	it("refuses duplicate XFP even when each field independently asserts https", async () => {
		const result = await observe([...forwarded(), "x-forwarded-proto: https"]);
		expect(result.headers["x-forwarded-proto"]).toBe("https, https");
		refused(result);
	});
	it.each(["Forwarded: for=198.51.100.8;proto=https", "X-Forwarded-Port: 8443"])(
		"refuses unsupported forwarding claims alongside valid single-hop fields (%s)",
		async (line) => {
			refused(await observe([...forwarded(), line]));
		},
	);
});
