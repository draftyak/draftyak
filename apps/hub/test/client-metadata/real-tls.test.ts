import dns from "node:dns";
import dnsPromises from "node:dns/promises";
import type { ServerResponse } from "node:http";
import { createServer, type Server } from "node:https";
import type { AddressInfo, Socket } from "node:net";
import { gzipSync } from "node:zlib";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import type { PinnedAddress } from "../../src/net/addresses.ts";
import { type NetworkTestHooks, withNetworkTestHooks } from "../../src/net/test-context.ts";
import { getPinnedMetadata } from "../../src/oauth-as/client-metadata/https.ts";
import { ClientMetadataFetcher } from "../../src/oauth-as/client-metadata/index.ts";
import { CIMD_MAX_BYTES, METADATA_MAX_BYTES } from "../../src/oauth-as/client-metadata/limits.ts";
import { type MetadataKind, metadataUrl } from "../../src/oauth-as/client-metadata/policy.ts";
import { createMetadataTlsFixture, type MetadataTlsFixture } from "../helpers/metadata-tls.ts";

let tls: MetadataTlsFixture;
beforeAll(async () => {
	tls = await createMetadataTlsFixture();
});
afterEach(() => vi.restoreAllMocks());
const pin = Object.freeze({ address: "8.8.8.8", family: 4 as const });
const reserved = new Set([9229, 47613, 47614, 47615]);
interface Peer {
	readonly port: number;
	readonly observed: {
		connections: number;
		requests: number;
		bytes: number;
		hosts: string[];
		paths: string[];
		methods: string[];
		authorization: (string | undefined)[];
		encodings: (string | undefined)[];
	};
	close(): Promise<void>;
}
async function peer(reply: (response: ServerResponse) => void): Promise<Peer> {
	const sockets = new Set<Socket>(),
		observed = {
			connections: 0,
			requests: 0,
			bytes: 0,
			hosts: [] as string[],
			paths: [] as string[],
			methods: [] as string[],
			authorization: [] as (string | undefined)[],
			encodings: [] as (string | undefined)[],
		};
	const server: Server = createServer({ key: tls.key, cert: tls.cert }, (request, response) => {
		observed.requests++;
		observed.hosts.push(request.headers.host ?? "");
		observed.paths.push(request.url ?? "");
		observed.methods.push(request.method ?? "");
		observed.authorization.push(request.headers.authorization);
		observed.encodings.push(request.headers["accept-encoding"]);
		reply(response);
	});
	server.maxConnections = 1;
	server.maxRequestsPerSocket = 1;
	server.headersTimeout = 1500;
	server.requestTimeout = 1500;
	server.keepAliveTimeout = 100;
	server.on("connection", (socket) => {
		observed.connections++;
		sockets.add(socket);
		socket.setTimeout(1500, () => socket.destroy());
		socket.once("close", () => sockets.delete(socket));
	});
	server.on("secureConnection", (socket) =>
		socket.on("data", (bytes: Buffer) => {
			observed.bytes += bytes.byteLength;
		}),
	);
	server.on("tlsClientError", () => {});
	try {
		for (let attempt = 0; attempt < 10; attempt++) {
			await new Promise<void>((resolve, reject) => {
				server.once("error", reject);
				server.listen(0, "127.0.0.1", () => {
					server.removeListener("error", reject);
					resolve();
				});
			});
			const port = (server.address() as AddressInfo).port;
			if (!reserved.has(port))
				return {
					port,
					observed,
					close: async () => {
						for (const socket of sockets) socket.destroy();
						server.closeAllConnections();
						await new Promise<void>((resolve, reject) =>
							server.close((error) => (error ? reject(error) : resolve())),
						);
					},
				};
			await new Promise<void>((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve())),
			);
		}
		throw new Error("TLS fixture port refused");
	} catch (error) {
		for (const socket of sockets) socket.destroy();
		server.close();
		throw error;
	}
}
function hooks(remote: Peer, ca = tls.ca): NetworkTestHooks {
	return {
		ca,
		dial: (checked, port) => {
			expect(checked).toEqual(pin);
			expect(port).toBe(443);
			return { address: "127.0.0.1", family: 4, port: remote.port };
		},
	};
}
function direct(
	kind: MetadataKind = "cimd",
	host = "metadata.example",
	signal = new AbortController().signal,
): ReturnType<typeof getPinnedMetadata> {
	return getPinnedMetadata({
		destination: metadataUrl(`https://${host}/document.json`, kind),
		address: pin,
		maxBytes: METADATA_MAX_BYTES,
		signal,
	});
}
function fetcher(host = "metadata.example", timeoutMs = 1000): ClientMetadataFetcher {
	return new ClientMetadataFetcher({
		destinations: [{ kind: "cimd", host, paths: [{ exact: "/document.json" }] }],
		deniedAddresses: [],
		maxBytes: METADATA_MAX_BYTES,
		timeoutMs,
	});
}
it("uses the actual Node single-family lookup branch and verified TLS before the first GET", async () => {
	const remote = await peer((response) =>
		response.writeHead(200, { "content-type": "application/json" }).end('{"fixture":true}'),
	);
	const lookup = vi.fn();
	const nativeFetch = vi
		.spyOn(globalThis, "fetch")
		.mockRejectedValue(new Error("Native fetch refused"));
	try {
		const result = await withNetworkTestHooks({ ...hooks(remote), lookupObserved: lookup }, () =>
			direct(),
		);
		expect(Buffer.from(result.body).toString()).toBe('{"fixture":true}');
		expect(lookup).toHaveBeenCalledExactlyOnceWith({ family: 4, hints: 0 });
		expect(remote.observed).toMatchObject({
			connections: 1,
			requests: 1,
			hosts: ["metadata.example"],
			paths: ["/document.json"],
			methods: ["GET"],
			authorization: [undefined],
			encodings: ["identity"],
		});
		expect(remote.observed.bytes).toBeGreaterThan(0);
		expect(nativeFetch).not.toHaveBeenCalled();
	} finally {
		await remote.close();
	}
});
it("ClientMetadataFetcher resolves once, then keeps that pin when later DNS answers change", async () => {
	const remote = await peer((response) =>
		response.writeHead(200, { "content-type": "application/json" }).end("{}"),
	);
	const client = fetcher();
	let answers: readonly PinnedAddress[] = [pin];
	const resolve = vi.fn(async () => {
		const first = answers;
		answers = [{ address: "127.0.0.1", family: 4 }];
		return first;
	});
	const system = vi.spyOn(dns, "lookup").mockImplementation(() => {
		throw new Error("System DNS refused");
	});
	const systemPromises = vi
		.spyOn(dnsPromises, "lookup")
		.mockRejectedValue(new Error("System DNS refused"));
	try {
		const result = await withNetworkTestHooks({ ...hooks(remote), resolve }, () =>
			client.fetch("https://metadata.example/document.json", "cimd", new AbortController().signal),
		);
		expect(Buffer.from(result.body).toString()).toBe("{}");
		expect(resolve).toHaveBeenCalledTimes(1);
		expect(remote.observed.connections).toBe(1);
		expect(remote.observed.requests).toBe(1);
		expect(system).not.toHaveBeenCalled();
		expect(systemPromises).not.toHaveBeenCalled();
	} finally {
		client.close();
		await remote.close();
	}
});
it.each(["wrong-name", "untrusted"] as const)(
	"refuses %s certificates before any HTTP bytes",
	async (mode) => {
		const remote = await peer((response) => response.end("UNEXPECTED_HTTP_CANARY"));
		try {
			const options = hooks(remote);
			const ca = mode === "untrusted" ? undefined : options.ca;
			await expect(
				withNetworkTestHooks({ ...options, ca }, () =>
					direct("cimd", mode === "wrong-name" ? "wrong.example" : "metadata.example"),
				),
			).rejects.toThrow(/^Client metadata refused$/);
			expect(remote.observed.connections).toBe(1);
			expect(remote.observed.requests).toBe(0);
			expect(remote.observed.bytes).toBe(0);
		} finally {
			await remote.close();
		}
	},
);
it.each(["redirect", "overflow", "gzip", "truncated"] as const)(
	"refuses actual TLS %s responses",
	async (mode) => {
		const remote = await peer((response) => {
			if (mode === "redirect")
				response
					.writeHead(302, { location: "https://other.example/PRIVATE_REDIRECT_CANARY" })
					.end();
			if (mode === "overflow") {
				response.writeHead(200, { "content-type": "application/json" });
				response.write(Buffer.alloc(CIMD_MAX_BYTES));
				response.end("x");
			}
			if (mode === "gzip")
				response
					.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip" })
					.end(gzipSync("PRIVATE_BODY_CANARY"));
			if (mode === "truncated") {
				response.writeHead(200, { "content-type": "application/json", "content-length": "100" });
				response.flushHeaders();
				response.write("{}");
				response.socket?.destroy();
			}
		});
		try {
			await expect(withNetworkTestHooks(hooks(remote), () => direct())).rejects.toThrow(
				/^Client metadata refused$/,
			);
			expect(remote.observed.requests).toBe(1);
		} finally {
			await remote.close();
		}
	},
);
it.each(["cimd", "jwks"] as const)(
	"accepts the exact %s native-byte cap over TLS",
	async (kind) => {
		const body = Buffer.alloc(kind === "cimd" ? CIMD_MAX_BYTES : METADATA_MAX_BYTES, 0x61);
		const remote = await peer((response) =>
			response
				.writeHead(200, {
					"content-type": "application/json",
					"content-length": String(body.byteLength),
				})
				.end(body),
		);
		try {
			const result = await withNetworkTestHooks(hooks(remote), () => direct(kind));
			expect(Buffer.compare(Buffer.from(result.body), body)).toBe(0);
		} finally {
			await remote.close();
		}
	},
);
it("times out an actual stalled TLS body through ClientMetadataFetcher and closes its socket", async () => {
	const remote = await peer((response) => {
		response.writeHead(200, { "content-type": "application/json" });
		response.flushHeaders();
		response.write("{");
	});
	const client = fetcher("metadata.example", 500);
	try {
		await expect(
			withNetworkTestHooks({ ...hooks(remote), resolve: async () => [pin] }, () =>
				client.fetch(
					"https://metadata.example/document.json",
					"cimd",
					new AbortController().signal,
				),
			),
		).rejects.toThrow(/^Client metadata refused$/);
		expect(remote.observed.requests).toBe(1);
	} finally {
		client.close();
		await remote.close();
	}
});
it("sends the captured canonical route/Host after caller destination fields change", async () => {
	const remote = await peer((response) =>
		response.writeHead(200, { "content-type": "application/json" }).end("{}"),
	);
	const destination = { ...metadataUrl("https://metadata.example/document.json", "cimd") };
	const options = hooks(remote);
	try {
		await withNetworkTestHooks(
			{
				...options,
				dial: (pin, port) => {
					destination.host = "other.example";
					destination.path = "/PRIVATE_ROUTE_CANARY";
					if (!options.dial) throw new Error("Fixture dial missing");
					return options.dial(pin, port);
				},
			},
			() =>
				getPinnedMetadata({
					destination,
					address: pin,
					maxBytes: 128,
					signal: new AbortController().signal,
				}),
		);
		expect(remote.observed.hosts).toEqual(["metadata.example"]);
		expect(remote.observed.paths).toEqual(["/document.json"]);
	} finally {
		await remote.close();
	}
});
it("keeps the captured CIMD content-type policy when caller kind changes during TLS setup", async () => {
	const remote = await peer((response) =>
		response.writeHead(200, { "content-type": "application/jwk-set+json" }).end("{}"),
	);
	const destination = { ...metadataUrl("https://metadata.example/document.json", "cimd") };
	const options = hooks(remote);
	try {
		await expect(
			withNetworkTestHooks(
				{
					...options,
					dial: (pin, port) => {
						destination.kind = "jwks";
						if (!options.dial) throw new Error("Fixture dial missing");
						return options.dial(pin, port);
					},
				},
				() =>
					getPinnedMetadata({
						destination,
						address: pin,
						maxBytes: 128,
						signal: new AbortController().signal,
					}),
			),
		).rejects.toThrow(/^Client metadata refused$/);
		expect(remote.observed.requests).toBe(1);
	} finally {
		await remote.close();
	}
});
