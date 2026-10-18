import { EventEmitter } from "node:events";
import type { RequestOptions } from "node:https";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { resolvePublic } from "../../src/mcp/client-metadata/addresses.ts";
import {
	ClientMetadataFetcher,
	type ClientMetadataOptions,
} from "../../src/mcp/client-metadata/index.ts";

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

it("cancels native DNS work and refuses parallel duplicate and excess requests", async () => {
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
	await expect(
		fetcher.fetch("https://client.example/clients/0", "cimd", signal()),
	).rejects.toThrow();
	await expect(
		fetcher.fetch("https://client.example/clients/8", "cimd", signal()),
	).rejects.toThrow();
	expect(fake.resolve4).toHaveBeenCalledTimes(8);
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
	cacheHeaders();
	let now = 100;
	vi.spyOn(performance, "now").mockImplementation(() => now);
	shape.hold = true;
	const pending = fetcher.fetch(CLIENT, "cimd", signal());
	while (!requests[0]?.req.ended) await new Promise((resolve) => setImmediate(resolve));
	const response = requests[0]?.req.response;
	response?.once("end", () => {
		now = 100_000;
	});
	response?.emit("data", Buffer.from('{"self_declared":true}'));
	response?.emit("end");
	await pending;
	shape.hold = false;
	await fetcher.fetch(CLIENT, "cimd", signal());
	expect(fake.request).toHaveBeenCalledTimes(2);
});
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
