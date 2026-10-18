import { EventEmitter } from "node:events";
import type { RequestOptions } from "node:https";
import { mock } from "node:test";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { resolvePublic } from "../../src/mcp/client-metadata/addresses.ts";
import { MetadataCache } from "../../src/mcp/client-metadata/cache.ts";
import { getPinnedMetadata } from "../../src/mcp/client-metadata/https.ts";
import {
	ClientMetadataFetcher,
	type ClientMetadataOptions,
} from "../../src/mcp/client-metadata/index.ts";
import {
	CIMD_MAX_BYTES,
	CIMD_TIMEOUT_MS,
	JWKS_TIMEOUT_MS,
	METADATA_MAX_BYTES,
} from "../../src/mcp/client-metadata/limits.ts";
import { metadataUrl } from "../../src/mcp/client-metadata/policy.ts";

const fake = vi.hoisted(() => ({
	request: vi.fn(),
	resolve4: vi.fn(),
	resolve6: vi.fn(),
	cancel: vi.fn(),
	interfaces: vi.fn(),
}));
vi.mock("node:dns/promises", () => ({
	Resolver: class {
		resolve4 = fake.resolve4;
		resolve6 = fake.resolve6;
		cancel = fake.cancel;
	},
}));
vi.mock("node:os", () => ({ networkInterfaces: fake.interfaces }));
vi.mock("node:https", async (original) => ({
	...(await original<typeof import("node:https")>()),
	request: fake.request,
}));

const CLIENT = "https://client.example/client.json";
const options: ClientMetadataOptions = {
	destinations: [
		{
			kind: "cimd",
			host: "client.example",
			paths: [{ exact: "/client.json" }, { prefix: "/clients/" }],
		},
		{ kind: "jwks", host: "keys.example", paths: [{ exact: "/keys.json" }] },
	],
	deniedAddresses: [],
	maxBytes: 128,
	timeoutMs: 2000,
};
interface Shape {
	status: number;
	headers: string[];
	chunks: Buffer[];
	complete: boolean;
	remote: string;
	authorized: boolean;
	hold: boolean;
	holdTls: boolean;
}
let shape: Shape, fetcher: ClientMetadataFetcher;
const requests: { options: RequestOptions; req: MockRequest; socket: EventEmitter }[] = [];
class MockResponse extends EventEmitter {
	statusCode = shape.status;
	rawHeaders = shape.headers;
	complete = shape.complete;
	destroyed = false;
	destroy(): this {
		this.destroyed = true;
		return this;
	}
}
class MockRequest extends EventEmitter {
	ended = false;
	destroyed = false;
	response?: MockResponse;
	readonly callback: (response: MockResponse) => void;
	constructor(callback: (response: MockResponse) => void) {
		super();
		this.callback = callback;
	}
	end(): this {
		this.ended = true;
		this.response = new MockResponse();
		this.callback(this.response);
		if (!shape.hold)
			queueMicrotask(() => {
				if (this.destroyed || this.response?.destroyed) return;
				for (const chunk of shape.chunks) this.response?.emit("data", chunk);
				this.response?.emit("end");
				this.emit("close");
			});
		return this;
	}
	destroy(): this {
		if (!this.destroyed) {
			this.destroyed = true;
			this.response?.destroy();
			queueMicrotask(() => this.emit("close"));
		}
		return this;
	}
}
const signal = () => new AbortController().signal;
beforeEach(() => {
	vi.clearAllMocks();
	requests.length = 0;
	shape = {
		status: 200,
		headers: ["Content-Type", "application/json"],
		chunks: [Buffer.from('{"self_declared":true}')],
		complete: true,
		remote: "8.8.8.8",
		authorized: true,
		hold: false,
		holdTls: false,
	};
	fake.resolve4.mockResolvedValue(["8.8.8.8"]);
	fake.resolve6.mockResolvedValue(["2606:4700:4700::1111"]);
	fake.cancel.mockImplementation(() => {});
	fake.interfaces.mockReturnValue({ eth0: [{ address: "10.0.0.10" }, { address: "fe80::10" }] });
	fake.request.mockImplementation(
		(input: RequestOptions, callback: (response: MockResponse) => void) => {
			const req = new MockRequest(callback),
				socket = Object.assign(new EventEmitter(), {
					authorized: shape.authorized,
					remoteAddress: shape.remote,
				});
			requests.push({ options: input, req, socket });
			queueMicrotask(() => {
				req.emit("socket", socket);
				if (!shape.holdTls) socket.emit("secureConnect");
			});
			return req;
		},
	);
	fetcher = new ClientMetadataFetcher(options);
});
afterEach(() => {
	fetcher.close();
	vi.useRealTimers();
	vi.restoreAllMocks();
});

it("uses the validated DNS pin with original SNI/Host and no proxy, credentials, pool or second resolution", async () => {
	const result = await fetcher.fetch(CLIENT, "cimd", signal());
	expect(Buffer.from(result.body).toString()).toBe('{"self_declared":true}');
	expect(Object.keys(result).sort()).toEqual(["body", "contentType"]);
	expect(fake.resolve4).toHaveBeenCalledTimes(1);
	expect(fake.resolve6).toHaveBeenCalledTimes(1);
	expect(fake.request).toHaveBeenCalledTimes(1);
	const sent = requests[0]?.options;
	if (!sent) throw new Error("Expected a native request");
	expect(sent).toMatchObject({
		protocol: "https:",
		hostname: "client.example",
		port: 443,
		path: "/client.json",
		method: "GET",
		family: 4,
		autoSelectFamily: false,
		servername: "client.example",
		rejectUnauthorized: true,
		minVersion: "TLSv1.2",
		maxHeaderSize: 16384,
	});
	expect(sent?.headers).toEqual({
		Host: "client.example",
		Accept: "application/json, application/jwk-set+json",
		"Accept-Encoding": "identity",
		Connection: "close",
	});
	expect((sent.agent as import("node:https").Agent).options).toMatchObject({
		proxyEnv: {},
		keepAlive: false,
		maxSockets: 1,
		maxCachedSessions: 0,
	});
	const callback = vi.fn();
	sent?.lookup?.("rebinding-host-is-ignored", { all: true }, callback);
	expect(callback).toHaveBeenCalledWith(null, [{ address: "8.8.8.8", family: 4 }]);
	fake.resolve4.mockResolvedValue(["127.0.0.1"]);
	await expect(fetcher.fetch(CLIENT, "cimd", signal())).rejects.toThrow(
		/^Client metadata refused$/,
	);
	expect(fake.request).toHaveBeenCalledTimes(1);
});

it("denies any private or hub-owned answer before making an HTTPS request", async () => {
	for (const answer of [
		"169.254.169.254",
		"100.100.100.200",
		"168.63.129.16",
		"127.0.0.1",
		"10.0.0.10",
	]) {
		fake.resolve4.mockResolvedValue(["8.8.8.8", answer]);
		await expect(resolvePublic("client.example", [], signal())).rejects.toThrow(
			/^Client metadata refused$/,
		);
	}
	fake.resolve4.mockResolvedValue(["8.8.8.8"]);
	await expect(resolvePublic("client.example", ["8.8.8.8"], signal())).rejects.toThrow();
	fake.interfaces.mockReturnValue({ eth0: [{ address: "8.8.8.8" }] });
	await expect(resolvePublic("client.example", [], signal())).rejects.toThrow();
	expect(fake.request).not.toHaveBeenCalled();
});

it.each(["different", "private", "unauthorized"] as const)(
	"rejects a %s TLS peer before writing HTTP bytes",
	async (test) => {
		if (test === "different") shape.remote = "1.1.1.1";
		if (test === "private") shape.remote = "127.0.0.1";
		if (test === "unauthorized") shape.authorized = false;
		await expect(fetcher.fetch(CLIENT, "cimd", signal())).rejects.toThrow(
			/^Client metadata refused$/,
		);
		expect(requests[0]?.req.ended).toBe(false);
		expect(requests[0]?.req.destroyed).toBe(true);
	},
);

it.each([301, 302, 303, 307, 308, 401, 404, 500])(
	"never follows or exposes status %s responses",
	async (status) => {
		shape.status = status;
		shape.headers.push(
			"Location",
			"https://127.0.0.1/SECRET_REDIRECT_CANARY",
			"Set-Cookie",
			"SECRET_COOKIE_CANARY",
		);
		shape.chunks = [Buffer.from("SECRET_RESPONSE_CANARY")];
		await expect(fetcher.fetch(CLIENT, "cimd", signal())).rejects.toThrow(
			/^Client metadata refused$/,
		);
		expect(fake.request).toHaveBeenCalledTimes(1);
		expect(requests[0]?.req.destroyed).toBe(true);
	},
);

it("caps declared and streamed bytes, and rejects truncation, ambiguous headers and compression", async () => {
	for (const headers of [
		["Content-Type", "application/json", "Content-Length", "129"],
		["Content-Type", "application/json", "Content-Length", "021"],
		["Content-Type", "application/json", "Content-Length", "21", "content-length", "21"],
		["Content-Type", "application/json", "content-type", "application/json"],
		["Content-Type", "application/json", "Content-Encoding", "gzip"],
		["Content-Type", "text/html"],
		["Content-Type", "application/json; charset=iso-8859-1"],
	]) {
		const instance = new ClientMetadataFetcher(options);
		shape.headers = headers;
		await expect(instance.fetch(CLIENT, "cimd", signal())).rejects.toThrow(
			/^Client metadata refused$/,
		);
		instance.close();
	}
	shape.headers = ["Content-Type", "application/json"];
	shape.chunks = [Buffer.alloc(100), Buffer.alloc(29)];
	await expect(fetcher.fetch(CLIENT, "cimd", signal())).rejects.toThrow();
	const truncated = new ClientMetadataFetcher(options);
	shape.chunks = [Buffer.from("{}")];
	shape.headers.push("Content-Length", "3");
	await expect(truncated.fetch(CLIENT, "cimd", signal())).rejects.toThrow();
	truncated.close();
	const incomplete = new ClientMetadataFetcher(options);
	shape.headers = ["Content-Type", "application/json"];
	shape.complete = false;
	await expect(incomplete.fetch(CLIENT, "cimd", signal())).rejects.toThrow();
	incomplete.close();
});

it("accepts a bounded JWKS media type only on its separately allowed destination", async () => {
	shape.headers = ["Content-Type", "application/jwk-set+json; charset=utf-8"];
	await expect(
		fetcher.fetch("https://keys.example/keys.json", "jwks", signal()),
	).resolves.toHaveProperty("contentType", "application/jwk-set+json; charset=utf-8");
	await expect(fetcher.fetch(CLIENT, "cimd", signal())).rejects.toThrow();
});

it("retains failed lookup hashes for exactly thirty seconds without retrying fresh paths implicitly", async () => {
	let now = 100;
	vi.spyOn(performance, "now").mockImplementation(() => now);
	fake.resolve4.mockRejectedValue(new Error("DNS_SECRET_CANARY"));
	fake.resolve6.mockRejectedValue(new Error("DNS_SECRET_CANARY"));
	await expect(fetcher.fetch(CLIENT, "cimd", signal())).rejects.toThrow(
		/^Client metadata refused$/,
	);
	await expect(fetcher.fetch(CLIENT, "cimd", signal())).rejects.toThrow();
	expect(fake.resolve4).toHaveBeenCalledTimes(1);
	now += 29999;
	await expect(fetcher.fetch(CLIENT, "cimd", signal())).rejects.toThrow();
	expect(fake.resolve4).toHaveBeenCalledTimes(1);
	now++;
	await expect(fetcher.fetch(CLIENT, "cimd", signal())).rejects.toThrow();
	expect(fake.resolve4).toHaveBeenCalledTimes(2);
	await expect(
		fetcher.fetch("https://client.example/not-approved.json", "cimd", signal()),
	).rejects.toThrow();
	expect(fake.resolve4).toHaveBeenCalledTimes(2);
});

it("bounds the failed-lookup cache and stores neither response bodies nor URL strings", async () => {
	vi.spyOn(performance, "now").mockReturnValue(100);
	fake.resolve4.mockRejectedValue(new Error("DNS_SECRET_CANARY"));
	fake.resolve6.mockRejectedValue(new Error("DNS_SECRET_CANARY"));
	for (let i = 0; i < 1025; i++)
		await expect(
			fetcher.fetch(`https://client.example/clients/${i}`, "cimd", signal()),
		).rejects.toThrow();
	expect(fake.resolve4).toHaveBeenCalledTimes(1025);
	await expect(
		fetcher.fetch("https://client.example/clients/0", "cimd", signal()),
	).rejects.toThrow();
	expect(fake.resolve4).toHaveBeenCalledTimes(1026);
	expect(JSON.stringify(fetcher)).toBe("{}");
});

it("shares duplicate DNS work, cancels abandoned callers and bounds distinct requests", async () => {
	const rejectors: ((reason: unknown) => void)[] = [];
	fake.resolve4.mockImplementation(() => new Promise((_, reject) => rejectors.push(reject)));
	fake.resolve6.mockResolvedValue([]);
	fake.cancel.mockImplementation(() => {
		for (const reject of rejectors) reject(new Error("DNS cancelled"));
	});
	const controller = new AbortController();
	const pending = Array.from({ length: 8 }, (_, i) =>
		fetcher.fetch(`https://client.example/clients/${i}`, "cimd", controller.signal),
	);
	pending.push(fetcher.fetch("https://client.example/clients/0", "cimd", controller.signal));
	await expect(
		fetcher.fetch("https://client.example/clients/8", "cimd", signal()),
	).rejects.toThrow();
	await vi.waitFor(() => expect(fake.resolve4).toHaveBeenCalledTimes(8));
	controller.abort();
	expect((await Promise.allSettled(pending)).every((result) => result.status === "rejected")).toBe(
		true,
	);
	expect(fake.cancel).toHaveBeenCalled();
	expect(fake.request).not.toHaveBeenCalled();
});

it.each(["before response", "during response"] as const)(
	"settles a bare request close %s and releases every concurrency slot",
	async (phase) => {
		shape.holdTls = phase === "before response";
		shape.hold = true;
		const pending = Array.from({ length: 8 }, (_, i) =>
			fetcher.fetch(`https://client.example/clients/${i}`, "cimd", signal()),
		);
		await vi.waitFor(() => {
			expect(requests).toHaveLength(8);
			expect(requests.every(({ req }) => req.ended === (phase === "during response"))).toBe(true);
		});
		for (const { req } of requests) req.emit("close");
		const outcome = await Promise.race([
			Promise.allSettled(pending),
			new Promise<"unsettled">((resolve) => setImmediate(() => resolve("unsettled"))),
		]);
		expect(outcome).not.toBe("unsettled");
		if (outcome === "unsettled") throw new Error("Request close left a fetch unsettled");
		for (const result of outcome) {
			expect(result.status).toBe("rejected");
			if (result.status === "rejected")
				expect(result.reason.message).toBe("Client metadata refused");
		}
		shape.holdTls = false;
		shape.hold = false;
		await expect(
			Promise.all(
				Array.from({ length: 8 }, (_, i) =>
					fetcher.fetch(`https://client.example/clients/${i + 8}`, "cimd", signal()),
				),
			),
		).resolves.toHaveLength(8);
		expect(fake.request).toHaveBeenCalledTimes(16);
	},
);

it.each(["cancel", "timeout", "close"] as const)(
	"stops a held HTTPS response after %s",
	async (reason) => {
		shape.hold = true;
		if (reason === "timeout") {
			fetcher.close();
			fetcher = new ClientMetadataFetcher({ ...options, timeoutMs: 10 });
		}
		const controller = new AbortController(),
			pending = fetcher.fetch(CLIENT, "cimd", controller.signal);
		while (!requests[0]?.req.ended) await new Promise((resolve) => setImmediate(resolve));
		if (reason === "cancel") controller.abort();
		if (reason === "close") fetcher.close();
		await expect(pending).rejects.toThrow(/^Client metadata refused$/);
		expect(requests[0]?.req.destroyed).toBe(true);
	},
);

it("permanently closes on monotonic rollback and does not perform new lookups", async () => {
	let now = 100;
	vi.spyOn(performance, "now").mockImplementation(() => now);
	await fetcher.fetch(CLIENT, "cimd", signal());
	now = 99;
	await expect(fetcher.fetch(CLIENT, "cimd", signal())).rejects.toThrow();
	now = 101;
	await expect(fetcher.fetch(CLIENT, "cimd", signal())).rejects.toThrow();
	expect(fake.resolve4).toHaveBeenCalledTimes(1);
});

function cacheHeaders(control = "public,max-age=60", extra: string[] = []): void {
	const wall = Date.UTC(2026, 9, 18, 12);
	vi.spyOn(Date, "now").mockReturnValue(wall);
	shape.headers = [
		"Content-Type",
		"application/json",
		"Date",
		new Date(wall).toUTCString(),
		"Cache-Control",
		control,
		...extra,
	];
}
it("reuses eligible bytes only within one fetcher and returns isolated copies", async () => {
	cacheHeaders();
	const first = await fetcher.fetch(CLIENT, "cimd", signal());
	first.body.fill(0);
	const second = await fetcher.fetch(CLIENT, "cimd", signal());
	expect(Buffer.from(second.body).toString()).toBe('{"self_declared":true}');
	second.body.fill(0);
	expect(Buffer.from((await fetcher.fetch(CLIENT, "cimd", signal())).body).toString()).toBe(
		'{"self_declared":true}',
	);
	expect(fake.request).toHaveBeenCalledTimes(1);
	expect(Object.keys(second).sort()).toEqual(["body", "contentType"]);
	expect(Object.isFrozen(second)).toBe(true);
	const other = new ClientMetadataFetcher(options);
	try {
		await other.fetch(CLIENT, "cimd", signal());
		expect(fake.request).toHaveBeenCalledTimes(2);
	} finally {
		other.close();
	}
});
it("rechecks original URL policy and cancellation before a cache hit", async () => {
	cacheHeaders();
	await fetcher.fetch(CLIENT, "cimd", signal());
	for (const url of [
		"HTTPS://client.example/client.json",
		`${CLIENT}?private=CANARY`,
		`${CLIENT}/`,
	])
		await expect(fetcher.fetch(url, "cimd", signal())).rejects.toThrow(/^Client metadata refused$/);
	const cancelled = new AbortController();
	cancelled.abort();
	await expect(fetcher.fetch(CLIENT, "cimd", cancelled.signal)).rejects.toThrow(
		/^Client metadata refused$/,
	);
	expect(fake.request).toHaveBeenCalledTimes(1);
	await fetcher.fetch(CLIENT, "cimd", signal());
	expect(fake.request).toHaveBeenCalledTimes(1);
});
it("separates the same exact URL by requested metadata purpose", async () => {
	cacheHeaders();
	fetcher.close();
	fetcher = new ClientMetadataFetcher({
		...options,
		destinations: [
			{ kind: "cimd", host: "client.example", paths: [{ exact: "/client.json" }] },
			{ kind: "jwks", host: "client.example", paths: [{ exact: "/client.json" }] },
		],
	});
	await fetcher.fetch(CLIENT, "cimd", signal());
	await fetcher.fetch(CLIENT, "jwks", signal());
	await fetcher.fetch(CLIENT, "cimd", signal());
	await fetcher.fetch(CLIENT, "jwks", signal());
	expect(fake.request).toHaveBeenCalledTimes(2);
});
it("expires exactly without sliding or falling back to stale bytes after a failed refresh", async () => {
	cacheHeaders();
	let now = 100;
	vi.spyOn(performance, "now").mockImplementation(() => now);
	await fetcher.fetch(CLIENT, "cimd", signal());
	now = 60_099;
	await fetcher.fetch(CLIENT, "cimd", signal());
	expect(fake.request).toHaveBeenCalledTimes(1);
	now = 60_100;
	shape.status = 503;
	await expect(fetcher.fetch(CLIENT, "cimd", signal())).rejects.toThrow(
		/^Client metadata refused$/,
	);
	await expect(fetcher.fetch(CLIENT, "cimd", signal())).rejects.toThrow(
		/^Client metadata refused$/,
	);
	expect(fake.request).toHaveBeenCalledTimes(2);
});
it.each([
	["private,max-age=60", []],
	["public,no-store,max-age=60", []],
	["public,max-age=60", ["Set-Cookie", "PRIVATE_CANARY=value"]],
	["public,max-age=60", ["Authentication-Info", "PRIVATE_CANARY"]],
	["public,max-age=60", ["WWW-Authenticate", "PRIVATE_CANARY"]],
	["public,max-age=60", ["X-Private-Token", "PRIVATE_CANARY"]],
	["public,max-age=60", ["Vary", "Accept-Encoding"]],
] as const)("does not cache private or secret-bearing HTTP metadata %j", async (control, extra) => {
	cacheHeaders(control, [...extra]);
	await fetcher.fetch(CLIENT, "cimd", signal());
	await fetcher.fetch(CLIENT, "cimd", signal());
	expect(fake.request).toHaveBeenCalledTimes(2);
});
it("does not cache malformed or non-object JSON and accepts no metadata document as authority", async () => {
	cacheHeaders();
	shape.chunks = [Buffer.from("NOT_A_JSON_DOCUMENT_CANARY")];
	const first = await fetcher.fetch(CLIENT, "cimd", signal());
	expect(Buffer.from(first.body).toString()).toBe("NOT_A_JSON_DOCUMENT_CANARY");
	await fetcher.fetch(CLIENT, "cimd", signal());
	expect(fake.request).toHaveBeenCalledTimes(2);
});
it("close aborts an eligible fill and prevents late responses from repopulating or cross-instance reuse", async () => {
	cacheHeaders();
	shape.hold = true;
	const pending = fetcher.fetch(CLIENT, "cimd", signal());
	while (!requests[0]?.req.ended) await new Promise((resolve) => setImmediate(resolve));
	fetcher.close();
	requests[0]?.req.response?.emit("data", Buffer.from('{"self_declared":true}'));
	requests[0]?.req.response?.emit("end");
	await expect(pending).rejects.toThrow(/^Client metadata refused$/);
	await expect(fetcher.fetch(CLIENT, "cimd", signal())).rejects.toThrow(
		/^Client metadata refused$/,
	);
	shape.hold = false;
	fetcher = new ClientMetadataFetcher(options);
	await fetcher.fetch(CLIENT, "cimd", signal());
	expect(fake.request).toHaveBeenCalledTimes(2);
});
it("anchors freshness to response completion rather than later processing of an awaited response", async () => {
	cacheHeaders("public,max-age=1");
	let now = 100;
	vi.spyOn(performance, "now").mockImplementation(() => now);
	shape.hold = true;
	const pending = fetcher.fetch(CLIENT, "cimd", signal());
	while (!requests[0]?.req.ended) await new Promise((resolve) => setImmediate(resolve));
	const response = requests[0]?.req.response;
	response?.once("end", () => {
		now = 1500;
	});
	response?.emit("data", Buffer.from('{"self_declared":true}'));
	response?.emit("end");
	await pending;
	shape.hold = false;
	await fetcher.fetch(CLIENT, "cimd", signal());
	expect(fake.request).toHaveBeenCalledTimes(2);
});

function metadataBody(size: number): Buffer {
	return Buffer.from(JSON.stringify({ text: "x".repeat(size - 11) }));
}
it("aggregates tiny native response chunks into bounded owned storage and clears collector references", async () => {
	const body = metadataBody(8200),
		concat = Buffer.concat,
		counts: number[] = [],
		retained: (readonly Uint8Array[])[] = [];
	shape.chunks = Array.from(body, (byte) => Buffer.from([byte]));
	vi.spyOn(Buffer, "concat").mockImplementation((blocks, length) => {
		if (length === body.byteLength) {
			counts.push(blocks.length);
			retained.push(blocks);
		}
		return concat(blocks, length);
	});
	const result = await getPinnedMetadata({
		destination: metadataUrl("https://keys.example/keys.json", "jwks"),
		address: { address: "8.8.8.8", family: 4 },
		maxBytes: METADATA_MAX_BYTES,
		signal: signal(),
	});
	expect(Buffer.compare(result.body, body)).toBe(0);
	expect(counts).toEqual([1]);
	expect(retained[0]).toHaveLength(0);
});
it.each([
	["cimd", CIMD_MAX_BYTES, 1],
	["jwks", METADATA_MAX_BYTES, 16],
	["jwks", 65_537, 2],
] as const)(
	"preserves exact %s bytes at %s with %s bounded collector blocks",
	async (kind, cap, count) => {
		const body = metadataBody(cap),
			concat = Buffer.concat,
			capacities: number[][] = [],
			retained: (readonly Uint8Array[])[] = [];
		shape.chunks = [body.subarray(0, 1), body.subarray(1, 65_537), body.subarray(65_537)];
		shape.headers.push("Content-Length", String(cap));
		vi.spyOn(Buffer, "concat").mockImplementation((blocks, length) => {
			if (length === cap) {
				capacities.push(blocks.map((block) => block.byteLength));
				retained.push(blocks);
			}
			return concat(blocks, length);
		});
		const result = await getPinnedMetadata({
			destination: metadataUrl(CLIENT, kind),
			address: { address: "8.8.8.8", family: 4 },
			maxBytes: cap,
			signal: signal(),
		});
		expect(Buffer.compare(result.body, body)).toBe(0);
		expect(capacities).toHaveLength(1);
		expect(capacities[0]).toHaveLength(count);
		expect(capacities[0]?.every((size) => size > 0 && size <= 65_536)).toBe(true);
		expect(capacities[0]?.reduce((total, size) => total + size, 0)).toBe(cap);
		expect(retained[0]).toHaveLength(0);
	},
);
it.each(["cimd", "jwks"] as const)(
	"refuses the byte after the %s cap before extra block allocation",
	async (kind) => {
		const cap = kind === "cimd" ? CIMD_MAX_BYTES : METADATA_MAX_BYTES;
		shape.hold = true;
		const allocate = vi.spyOn(Buffer, "allocUnsafe"),
			pending = getPinnedMetadata({
				destination: metadataUrl(CLIENT, kind),
				address: { address: "8.8.8.8", family: 4 },
				maxBytes: METADATA_MAX_BYTES,
				signal: signal(),
			}).catch((error: Error) => error.message);
		while (!requests[0]?.req.ended) await new Promise(setImmediate);
		const response = requests[0]?.req.response;
		response?.emit("data", metadataBody(cap));
		const before = allocate.mock.calls.length;
		response?.emit("data", Buffer.from("x"));
		expect(await pending).toBe("Client metadata refused");
		expect(allocate.mock.calls.length).toBe(before);
		expect(requests[0]?.req.destroyed).toBe(true);
		expect(response?.destroyed).toBe(true);
	},
);
it.each(["cancellation", "response error", "request close"])(
	"ignores late data after partial collector %s",
	async (phase) => {
		shape.hold = true;
		const controller = new AbortController(),
			allocate = vi.spyOn(Buffer, "allocUnsafe"),
			pending = getPinnedMetadata({
				destination: metadataUrl(CLIENT, "cimd"),
				address: { address: "8.8.8.8", family: 4 },
				maxBytes: METADATA_MAX_BYTES,
				signal: controller.signal,
			}).catch((error: Error) => error.message);
		while (!requests[0]?.req.ended) await new Promise(setImmediate);
		const req = requests[0]?.req,
			response = req?.response;
		response?.emit("data", Buffer.from('{"partial":'));
		if (phase === "cancellation") controller.abort();
		else if (phase === "response error")
			response?.emit("error", new Error("PRIVATE_NETWORK_CANARY"));
		else req?.emit("close");
		expect(await pending).toBe("Client metadata refused");
		const before = allocate.mock.calls.length;
		let reads = 0;
		const late = Object.defineProperty(Buffer.alloc(1), "byteLength", {
			get() {
				reads++;
				throw new Error("PRIVATE_LATE_CANARY");
			},
		});
		expect(() => {
			response?.emit("data", late);
			response?.emit("end");
		}).not.toThrow();
		expect(reads).toBe(0);
		expect(allocate.mock.calls.length).toBe(before);
	},
);
it("clears collector references and returns a fixed error if final body assembly fails", async () => {
	let retained: readonly Uint8Array[] | undefined;
	vi.spyOn(Buffer, "concat").mockImplementation((blocks) => {
		retained = blocks;
		throw new Error("PRIVATE_ASSEMBLY_CANARY");
	});
	await expect(
		getPinnedMetadata({
			destination: metadataUrl(CLIENT, "cimd"),
			address: { address: "8.8.8.8", family: 4 },
			maxBytes: METADATA_MAX_BYTES,
			signal: signal(),
		}),
	).rejects.toThrow(/^Client metadata refused$/);
	expect(retained).toHaveLength(0);
	expect(requests[0]?.req.destroyed).toBe(true);
	expect(requests[0]?.req.response?.destroyed).toBe(true);
});
it.each(["assembly", "freshness"] as const)(
	"refuses pinned publication after final %s reaches the CIMD deadline",
	async (phase) => {
		let now = 100,
			assembled = false,
			advanced = false;
		vi.spyOn(performance, "now").mockImplementation(() => now);
		const concat = Buffer.concat,
			wall = Date.now;
		vi.spyOn(Buffer, "concat").mockImplementation((blocks, length) => {
			const bytes = concat(blocks, length);
			assembled = true;
			if (phase === "assembly") {
				now += CIMD_TIMEOUT_MS;
				advanced = true;
			}
			return bytes;
		});
		if (phase === "freshness")
			vi.spyOn(Date, "now").mockImplementation(() => {
				if (assembled) {
					now += CIMD_TIMEOUT_MS;
					advanced = true;
				}
				return wall();
			});
		await expect(
			getPinnedMetadata({
				destination: metadataUrl(CLIENT, "cimd"),
				address: { address: "8.8.8.8", family: 4 },
				maxBytes: METADATA_MAX_BYTES,
				signal: signal(),
			}),
		).rejects.toThrow(/^Client metadata refused$/);
		expect(advanced).toBe(true);
		expect(requests[0]?.req.destroyed).toBe(true);
		expect(requests[0]?.req.response?.destroyed).toBe(true);
	},
);
it.each(["declared", "streamed"] as const)(
	"caps %s CIMD bytes at 5 KiB even with the largest configuration",
	async (mode) => {
		fetcher.close();
		fetcher = new ClientMetadataFetcher({
			...options,
			maxBytes: METADATA_MAX_BYTES,
			timeoutMs: 10000,
		});
		const body = metadataBody(CIMD_MAX_BYTES + 1);
		shape.chunks = [body.subarray(0, CIMD_MAX_BYTES), body.subarray(CIMD_MAX_BYTES)];
		if (mode === "declared") shape.headers.push("Content-Length", String(body.byteLength));
		await expect(fetcher.fetch(CLIENT, "cimd", signal())).rejects.toThrow(
			/^Client metadata refused$/,
		);
		expect(requests[0]?.req.destroyed).toBe(true);
		expect(requests[0]?.req.response?.destroyed).toBe(true);
	},
);

it("accepts exactly 5 KiB CIMD and preserves larger JWKS bytes without cross-purpose cache reuse", async () => {
	cacheHeaders();
	fetcher.close();
	fetcher = new ClientMetadataFetcher({
		...options,
		maxBytes: METADATA_MAX_BYTES,
		timeoutMs: 10000,
		destinations: [
			{ kind: "cimd", host: "client.example", paths: [{ exact: "/client.json" }] },
			{ kind: "jwks", host: "client.example", paths: [{ exact: "/client.json" }] },
		],
	});
	shape.chunks = [metadataBody(CIMD_MAX_BYTES)];
	expect((await fetcher.fetch(CLIENT, "cimd", signal())).body.byteLength).toBe(CIMD_MAX_BYTES);
	await fetcher.fetch(CLIENT, "cimd", signal());
	expect(fake.request).toHaveBeenCalledTimes(1);
	shape.chunks = [metadataBody(CIMD_MAX_BYTES + 1)];
	expect((await fetcher.fetch(CLIENT, "jwks", signal())).body.byteLength).toBe(CIMD_MAX_BYTES + 1);
	await fetcher.fetch(CLIENT, "jwks", signal());
	expect(fake.request).toHaveBeenCalledTimes(2);
	fetcher.close();
	fetcher = new ClientMetadataFetcher({ ...options, maxBytes: 64 });
	shape.chunks = [metadataBody(65)];
	await expect(fetcher.fetch(CLIENT, "cimd", signal())).rejects.toThrow();
});

it.each([10000, 125])(
	"never relaxes the effective CIMD deadline with configured %s ms",
	async (configured) => {
		vi.useFakeTimers();
		shape.hold = true;
		fetcher.close();
		fetcher = new ClientMetadataFetcher({ ...options, timeoutMs: configured });
		let settled = false;
		const result = fetcher.fetch(CLIENT, "cimd", signal()).then(
			() => "success",
			(error: Error) => {
				settled = true;
				return error.message;
			},
		);
		await vi.advanceTimersByTimeAsync(0);
		expect(requests[0]?.req.ended).toBe(true);
		await vi.advanceTimersByTimeAsync(Math.min(configured, CIMD_TIMEOUT_MS) - 1);
		expect(settled).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		expect(await result).toBe("Client metadata refused");
		expect(requests[0]?.req.destroyed).toBe(true);
	},
);

it.each([10000, 125])(
	"caps the whole JWKS fetch at 5 seconds with configured %s ms",
	async (configured) => {
		vi.useFakeTimers();
		shape.hold = true;
		fetcher.close();
		fetcher = new ClientMetadataFetcher({ ...options, timeoutMs: configured });
		let settled = false;
		const result = fetcher.fetch("https://keys.example/keys.json", "jwks", signal()).then(
			() => "success",
			(error: Error) => {
				settled = true;
				return error.message;
			},
		);
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(Math.min(configured, JWKS_TIMEOUT_MS) - 1);
		expect(settled).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		expect(await result).toBe("Client metadata refused");
		expect(requests[0]?.req.destroyed).toBe(true);
	},
);

it("shares one uncached native response with independently mutable caller bodies", async () => {
	shape.hold = true;
	const first = fetcher.fetch(CLIENT, "cimd", signal());
	const second = fetcher.fetch(CLIENT, "cimd", signal());
	await vi.waitFor(() => expect(requests[0]?.req.ended).toBe(true));
	expect(fake.resolve4).toHaveBeenCalledTimes(1);
	expect(requests).toHaveLength(1);
	requests[0]?.req.response?.emit("data", shape.chunks[0]);
	requests[0]?.req.response?.emit("end");
	const [left, right] = await Promise.all([first, second]);
	expect(left).not.toBe(right);
	expect(left.body).not.toBe(right.body);
	left.body.fill(0);
	expect(Buffer.from(right.body).toString()).toBe('{"self_declared":true}');
	expect(right.contentType).toBe("application/json");
	expect(Object.keys(right).sort()).toEqual(["body", "contentType"]);
	shape.hold = false;
	await fetcher.fetch(CLIENT, "cimd", signal());
	expect(requests).toHaveLength(2);
});

it("one caller abort neither cancels another waiter nor poisons its cache fill", async () => {
	cacheHeaders("public,max-age=60", ["cf-ray", "DYTEST-ray", "cf-cache-status", "DYNAMIC"]);
	shape.hold = true;
	const controller = new AbortController();
	const first = fetcher
		.fetch(CLIENT, "cimd", controller.signal)
		.catch((error: Error) => error.message);
	const second = fetcher.fetch(CLIENT, "cimd", signal());
	await vi.waitFor(() => expect(requests[0]?.req.ended).toBe(true));
	controller.abort();
	expect(await first).toBe("Client metadata refused");
	expect(requests[0]?.req.destroyed).toBe(false);
	requests[0]?.req.response?.emit("data", shape.chunks[0]);
	requests[0]?.req.response?.emit("end");
	expect(Buffer.from((await second).body).toString()).toBe('{"self_declared":true}');
	await fetcher.fetch(CLIENT, "cimd", signal());
	expect(requests).toHaveLength(1);
});

it("bounds pending shared callers at 128 and releases one caller's capacity independently", async () => {
	shape.hold = true;
	const cancelled = new AbortController();
	const first = fetcher
		.fetch(CLIENT, "cimd", cancelled.signal)
		.catch((error: Error) => error.message);
	const pending = Array.from({ length: 127 }, () => fetcher.fetch(CLIENT, "cimd", signal()));
	await vi.waitFor(() => expect(requests[0]?.req.ended).toBe(true));
	await expect(fetcher.fetch(CLIENT, "cimd", signal())).rejects.toThrow(
		/^Client metadata refused$/,
	);
	await expect(
		fetcher.fetch("https://client.example/clients/extra", "cimd", signal()),
	).rejects.toThrow();
	cancelled.abort();
	expect(await first).toBe("Client metadata refused");
	pending.push(fetcher.fetch(CLIENT, "cimd", signal()));
	expect(requests[0]?.req.destroyed).toBe(false);
	requests[0]?.req.response?.emit("data", shape.chunks[0]);
	requests[0]?.req.response?.emit("end");
	const results = await Promise.all(pending);
	expect(results).toHaveLength(128);
	expect(new Set(results.map((result) => result.body)).size).toBe(128);
	expect(fake.resolve4).toHaveBeenCalledTimes(1);
	shape.hold = false;
	await fetcher.fetch("https://client.example/clients/extra", "cimd", signal());
	expect(fake.resolve4).toHaveBeenCalledTimes(2);
});

it("keeps abandoned native DNS reservations until their actual callbacks settle", async () => {
	const complete: ((addresses: string[]) => void)[] = [];
	fake.resolve4.mockImplementation(() => new Promise((resolve) => complete.push(resolve)));
	fake.resolve6.mockResolvedValue([]);
	// A resolver that has not completed cancellation must still occupy its native slot.
	fake.cancel.mockImplementation(() => {});
	const controller = new AbortController();
	const pending = Array.from({ length: 8 }, (_, index) =>
		fetcher
			.fetch(`https://client.example/clients/${index}`, "cimd", controller.signal)
			.catch((error: Error) => error.message),
	);
	await vi.waitFor(() => expect(complete).toHaveLength(8));
	controller.abort();
	expect(await Promise.all(pending)).toEqual(Array(8).fill("Client metadata refused"));
	await expect(
		fetcher.fetch("https://client.example/clients/0", "cimd", signal()),
	).rejects.toThrow();
	await expect(
		fetcher.fetch("https://client.example/clients/next", "cimd", signal()),
	).rejects.toThrow();
	expect(fake.resolve4).toHaveBeenCalledTimes(8);
	for (const resolve of complete) resolve(["8.8.8.8"]);
	await new Promise((resolve) => setImmediate(resolve));
	expect(fake.request).not.toHaveBeenCalled();
	fake.resolve4.mockResolvedValue(["8.8.8.8"]);
	await fetcher.fetch("https://client.example/clients/next", "cimd", signal());
	expect(fake.resolve4).toHaveBeenCalledTimes(9);
});

it("removes cancelled shared waiters instead of retaining promise reactions behind one anchor", async () => {
	shape.hold = true;
	const anchor = fetcher.fetch(CLIENT, "cimd", signal());
	void anchor.catch(() => {});
	await vi.waitFor(() => expect(requests[0]?.req.ended).toBe(true));
	const original = Promise.prototype.then;
	const reactions = new Map<unknown, number>();
	const tracker = mock.method(
		Promise.prototype,
		"then",
		new Proxy(original, {
			apply(target, receiver, args) {
				reactions.set(receiver, (reactions.get(receiver) ?? 0) + 1);
				return Reflect.apply(target, receiver, args);
			},
		}),
	);
	try {
		for (let index = 0; index < 256; index++) {
			const controller = new AbortController();
			const pending = fetcher.fetch(CLIENT, "cimd", controller.signal);
			let settled = false;
			const outcome = pending.then(
				() => {
					settled = true;
					return "success";
				},
				(error: Error) => {
					settled = true;
					return error.message;
				},
			);
			await Promise.resolve();
			expect(settled).toBe(false);
			controller.abort();
			expect(await outcome).toBe("Client metadata refused");
		}
		// Reattaching to one pending promise retains each closure even after caller abort.
		expect(Math.max(0, ...reactions.values())).toBeLessThanOrEqual(1);
		expect(requests).toHaveLength(1);
		expect(requests[0]?.req.destroyed).toBe(false);
	} finally {
		tracker.mock.restore();
	}
	requests[0]?.req.response?.emit("data", shape.chunks[0]);
	requests[0]?.req.response?.emit("end");
	expect(Buffer.from((await anchor).body).toString()).toBe('{"self_declared":true}');
	shape.hold = false;
	await fetcher.fetch("https://client.example/clients/after", "cimd", signal());
	expect(requests).toHaveLength(2);
});

it("shares one native failure and applies failure backoff once for subsequent callers", async () => {
	shape.hold = true;
	const pending = [
		fetcher.fetch(CLIENT, "cimd", signal()),
		fetcher.fetch(CLIENT, "cimd", signal()),
	].map((promise) => promise.catch((error: Error) => error.message));
	await vi.waitFor(() => expect(requests[0]?.req.ended).toBe(true));
	requests[0]?.req.emit("error", new Error("PRIVATE_TRANSPORT_CANARY"));
	expect(await Promise.all(pending)).toEqual([
		"Client metadata refused",
		"Client metadata refused",
	]);
	await expect(fetcher.fetch(CLIENT, "cimd", signal())).rejects.toThrow(
		/^Client metadata refused$/,
	);
	expect(requests).toHaveLength(1);
});

it("does not restart the CIMD budget after DNS completes", async () => {
	vi.useFakeTimers();
	shape.hold = true;
	fetcher.close();
	fetcher = new ClientMetadataFetcher({ ...options, timeoutMs: 10000 });
	let completeDns: ((addresses: string[]) => void) | undefined,
		settled = false;
	fake.resolve4.mockImplementation(
		() =>
			new Promise((resolve) => {
				completeDns = resolve;
			}),
	);
	fake.resolve6.mockResolvedValue([]);
	const result = fetcher.fetch(CLIENT, "cimd", signal()).catch((error: Error) => {
		settled = true;
		return error.message;
	});
	await vi.advanceTimersByTimeAsync(1500);
	completeDns?.(["8.8.8.8"]);
	await vi.advanceTimersByTimeAsync(0);
	expect(requests[0]?.req.ended).toBe(true);
	await vi.advanceTimersByTimeAsync(999);
	expect(settled).toBe(false);
	await vi.advanceTimersByTimeAsync(1);
	expect(await result).toBe("Client metadata refused");
	expect(requests[0]?.req.destroyed).toBe(true);
});

it("retains the JWKS generic byte cap and a stricter configured JWKS byte limit", async () => {
	fetcher.close();
	fetcher = new ClientMetadataFetcher({ ...options, maxBytes: METADATA_MAX_BYTES });
	shape.chunks = [metadataBody(METADATA_MAX_BYTES)];
	expect(
		(await fetcher.fetch("https://keys.example/keys.json", "jwks", signal())).body.byteLength,
	).toBe(METADATA_MAX_BYTES);
	fetcher.close();
	fetcher = new ClientMetadataFetcher({ ...options, maxBytes: METADATA_MAX_BYTES });
	shape.chunks = [metadataBody(METADATA_MAX_BYTES + 1)];
	await expect(fetcher.fetch("https://keys.example/keys.json", "jwks", signal())).rejects.toThrow();
	fetcher.close();
	fetcher = new ClientMetadataFetcher({ ...options, maxBytes: 64 });
	shape.chunks = [metadataBody(65)];
	await expect(fetcher.fetch("https://keys.example/keys.json", "jwks", signal())).rejects.toThrow();
});

it("bounds the whole CIMD DNS/TLS/body operation and cancels native DNS at 2.5 seconds", async () => {
	vi.useFakeTimers();
	fetcher.close();
	fetcher = new ClientMetadataFetcher({ ...options, timeoutMs: 10000 });
	let rejectDns: ((error: Error) => void) | undefined;
	fake.resolve4.mockImplementation(
		() =>
			new Promise((_, reject) => {
				rejectDns = reject;
			}),
	);
	fake.resolve6.mockResolvedValue([]);
	fake.cancel.mockImplementation(() => rejectDns?.(new Error("DNS_PRIVATE_CANARY")));
	const result = fetcher.fetch(CLIENT, "cimd", signal()).catch((error: Error) => error.message);
	await vi.advanceTimersByTimeAsync(CIMD_TIMEOUT_MS);
	expect(await result).toBe("Client metadata refused");
	expect(fake.cancel).toHaveBeenCalled();
	expect(fake.request).not.toHaveBeenCalled();
});

it("independently caps the pinned helper's CIMD body and deadline without an outer fetcher", async () => {
	const input = {
		destination: metadataUrl(CLIENT, "cimd"),
		address: { address: "8.8.8.8", family: 4 as const },
		maxBytes: METADATA_MAX_BYTES,
		signal: signal(),
	};
	shape.chunks = [metadataBody(CIMD_MAX_BYTES + 1)];
	await expect(getPinnedMetadata(input)).rejects.toThrow(/^Client metadata refused$/);
	vi.useFakeTimers();
	shape.hold = true;
	const result = getPinnedMetadata(input).catch((error: Error) => error.message);
	await vi.advanceTimersByTimeAsync(0);
	await vi.advanceTimersByTimeAsync(CIMD_TIMEOUT_MS);
	expect(await result).toBe("Client metadata refused");
	expect(requests[1]?.req.destroyed).toBe(true);
});

it.each(["body", "await continuation"] as const)(
	"refuses a late CIMD %s even before its timeout callback runs",
	async (phase) => {
		let now = 100;
		vi.spyOn(performance, "now").mockImplementation(() => now);
		shape.hold = true;
		fetcher.close();
		fetcher = new ClientMetadataFetcher({ ...options, timeoutMs: 10000 });
		const result = fetcher.fetch(CLIENT, "cimd", signal()).catch((error: Error) => error.message);
		while (!requests[0]?.req.ended) await new Promise((resolve) => setImmediate(resolve));
		if (phase === "body") now += CIMD_TIMEOUT_MS;
		else
			requests[0]?.req.response?.once("end", () => {
				now += CIMD_TIMEOUT_MS;
			});
		requests[0]?.req.response?.emit("data", Buffer.from("{}"));
		requests[0]?.req.response?.emit("end");
		expect(await result).toBe("Client metadata refused");
		expect(requests[0]?.req.destroyed).toBe(true);
	},
);
it.each(["deadline", "cancellation"] as const)(
	"refuses CIMD after local cache processing crosses its %s boundary",
	async (phase) => {
		cacheHeaders();
		let now = 100;
		vi.spyOn(performance, "now").mockImplementation(() => now);
		fetcher.close();
		fetcher = new ClientMetadataFetcher({ ...options, timeoutMs: 10000 });
		const controller = new AbortController(),
			put = MetadataCache.prototype.put;
		const processed = vi.spyOn(MetadataCache.prototype, "put").mockImplementation(function (
			this: MetadataCache,
			...args
		) {
			put.call(this, ...args);
			if (phase === "deadline") now += CIMD_TIMEOUT_MS;
			else controller.abort();
		});
		await expect(fetcher.fetch(CLIENT, "cimd", controller.signal)).rejects.toThrow(
			/^Client metadata refused$/,
		);
		expect(processed).toHaveBeenCalledTimes(1);
		expect(fake.request).toHaveBeenCalledTimes(1);
	},
);
it("permanently closes cached data on a monotonic rollback", async () => {
	cacheHeaders();
	let now = 100;
	vi.spyOn(performance, "now").mockImplementation(() => now);
	await fetcher.fetch(CLIENT, "cimd", signal());
	now = 99;
	await expect(fetcher.fetch(CLIENT, "cimd", signal())).rejects.toThrow(
		/^Client metadata refused$/,
	);
	now = 101;
	await expect(fetcher.fetch(CLIENT, "cimd", signal())).rejects.toThrow(
		/^Client metadata refused$/,
	);
	expect(fake.request).toHaveBeenCalledTimes(1);
});
