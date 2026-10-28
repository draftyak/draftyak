import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { PassThrough, Writable } from "node:stream";
import { MCP_MAX_REQUEST_BYTES } from "@draftyak/protocol/mcp";
import { afterEach, test, vi } from "vitest";
import { main } from "../../src/main.ts";
import {
	CAPABILITIES as CLIENT_CAPABILITIES_META_KEY,
	CLIENT_INFO as CLIENT_INFO_META_KEY,
	VERSION as PROTOCOL_VERSION_META_KEY,
	startBridge,
} from "../../src/mcp/bridge.ts";
import { agentCredential, localEndpoint } from "../../src/mcp/credentials.ts";
import { LocalHttp } from "../../src/mcp/http.ts";
import { BoundedStdio } from "../../src/mcp/stdio.ts";

// biome-ignore lint/suspicious/noExplicitAny: synthetic JSON-RPC peers exercise invalid wire values too.
type Json = Record<string, any>;
const TOKEN = "DYTEST.mcp.transport";
const MODERN = "2026-07-28";
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
	vi.restoreAllMocks();
	for (const close of cleanup.splice(0).reverse()) await close();
});

async function listener(
	handler: (message: Json, req: IncomingMessage, res: ServerResponse) => unknown,
) {
	const seen: Json[] = [];
	const sockets = new Set<import("node:net").Socket>();
	const server = createServer((req, res) => {
		let body = "";
		req.on("data", (chunk) => {
			body += chunk;
		});
		req.on("end", () => {
			const message = JSON.parse(body);
			seen.push({ ...message, headers: req.headers });
			res.setHeader("content-type", "application/json");
			const value = handler(message, req, res);
			if (value !== undefined)
				res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, ...(value as object) }));
		});
	});
	server.on("connection", (socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	cleanup.push(async () => {
		for (const socket of sockets) socket.destroy();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});
	const address = server.address();
	assert.ok(address && typeof address === "object");
	return { seen, url: `http://127.0.0.1:${address.port}/mcp` };
}
const discover = {
	supportedVersions: [MODERN],
	capabilities: { tools: {}, prompts: {}, resources: {}, completions: {} },
};
const envelope = (capabilities: Json = {}) => ({
	[PROTOCOL_VERSION_META_KEY]: MODERN,
	[CLIENT_CAPABILITIES_META_KEY]: capabilities,
	[CLIENT_INFO_META_KEY]: { name: "DYTEST-client", version: "1" },
});

async function bridge(handler: (message: Json) => Json) {
	const hub = await listener((message) => ({
		result:
			message.method === "server/discover"
				? discover
				: message.method === "initialize"
					? {
							protocolVersion: message.params.protocolVersion,
							capabilities: discover.capabilities,
							serverInfo: { name: "DYTEST-service", version: "1" },
						}
					: handler(message),
	}));
	const input = new PassThrough(),
		output = new PassThrough();
	const transport = new BoundedStdio(input, output);
	const pending = new Map<number, (value: Json) => void>();
	let text = "",
		id = 0,
		dialogs = 0;
	const outputs: Json[] = [];
	output.on("data", (chunk) => {
		text += chunk.toString();
		let end = text.indexOf("\n");
		while (end >= 0) {
			const message: Json = JSON.parse(text.slice(0, end));
			text = text.slice(end + 1);
			outputs.push(message);
			if (message.method === "elicitation/create") {
				dialogs++;
				input.write(
					`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { action: "accept", content: { account: "DYTEST-account" } } })}\n`,
				);
			} else {
				pending.get(message.id)?.(message);
				pending.delete(message.id);
			}
			end = text.indexOf("\n");
		}
	});
	const server = await startBridge(transport, { hub: { url: hub.url, token: TOKEN } });
	cleanup.push(async () => {
		await server.close();
		input.destroy();
		output.destroy();
	});
	async function request(method: string, params: Json = {}) {
		const current = ++id;
		const promise = new Promise<Json>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("DYTEST response timeout")), 3000);
			pending.set(current, (value) => {
				clearTimeout(timer);
				resolve(value);
			});
		});
		input.write(`${JSON.stringify({ jsonrpc: "2.0", id: current, method, params })}\n`);
		return await promise;
	}
	async function initialize(revision = "2025-11-25", capabilities: Json = {}) {
		const reply = await request("initialize", {
			protocolVersion: revision,
			clientInfo: { name: "DYTEST-client", version: "1" },
			capabilities,
		});
		assert.equal(reply.result.protocolVersion, revision);
		input.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
	}
	return { ...hub, input, output, transport, outputs, request, initialize, dialogs: () => dialogs };
}

test("real stdio/HTTP fallback relays the native legacy response and shuts down on EOF", async () => {
	const wire = await bridge(() => ({
		tools: [],
	}));
	await wire.initialize();
	const reply = await wire.request("tools/list");
	assert.deepEqual(reply.result, { tools: [] });
	const sent = wire.seen.at(-1);
	assert.ok(sent);
	assert.equal(sent.headers.authorization, `Bearer ${TOKEN}`);
	assert.equal(sent.headers["mcp-method"], "tools/list");
	assert.equal(sent.headers["mcp-protocol-version"], "2025-11-25");
	assert.equal(sent.params._meta, undefined);
	wire.input.end();
	assert.equal(await wire.transport.completion, 0);
});

test("2026 per-request envelopes preserve results and isolate capability declarations", async () => {
	const wire = await bridge(() => ({ tools: [], ttlMs: 3, resultType: "complete" }));
	const probe = await wire.request("server/discover", { _meta: envelope() });
	assert.ok(probe.result, JSON.stringify(probe));
	const first = await wire.request("tools/list", {
		_meta: envelope({ elicitation: { form: {} }, sampling: {} }),
	});
	assert.equal(first.result.ttlMs, 3);
	await wire.request("tools/list", { _meta: envelope({ roots: {} }) });
	const requests = wire.seen.filter((row) => row.method === "tools/list");
	assert.deepEqual(requests[0]?.params._meta[CLIENT_CAPABILITIES_META_KEY], {
		elicitation: { form: {} },
		extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } },
	});
	assert.equal(requests[1]?.params._meta[CLIENT_CAPABILITIES_META_KEY].elicitation, undefined);
	assert.equal(
		Object.hasOwn(requests[0]?.params._meta[CLIENT_CAPABILITIES_META_KEY], "sampling"),
		false,
	);
});

const question = {
	resultType: "input_required",
	requestState: "DYTEST-hub-state",
	inputRequests: {
		account: {
			method: "elicitation/create",
			params: {
				mode: "form",
				message: "Choose account",
				requestedSchema: { type: "object", properties: { account: { type: "string" } } },
			},
		},
	},
};
test("legacy fallback preserves the native readable account/session response without a bridge dialog", async () => {
	const fallback = {
		messages: [
			{
				role: "user",
				content: { type: "text", text: "Approve the session on your paired desktop." },
			},
		],
	};
	const wire = await bridge(() => fallback);
	await wire.initialize("2025-11-25", { elicitation: { form: {} }, sampling: {} });
	const reply = await wire.request("prompts/get", {
		name: "triage_inbox",
		arguments: { window: "24h" },
	});
	assert.deepEqual(reply.result, fallback);
	assert.equal(wire.dialogs(), 0);
	assert.equal(wire.seen.filter((row) => row.method === "prompts/get").length, 1);
	assert.equal(
		wire.seen.find((row) => row.method === "initialize")?.params.capabilities.sampling,
		undefined,
	);
});

test("caller-invented retry state and malformed prompt params never reach HTTP", async () => {
	const wire = await bridge(() => ({ messages: [] }));
	await wire.initialize();
	for (const params of [{ name: "triage_inbox", requestState: "DYTEST-forged" }, { name: 99 }]) {
		const before = wire.seen.length;
		const reply = await wire.request("prompts/get", params);
		assert.ok(reply.error);
		assert.equal(wire.seen.length, before);
	}
});

test("legacy fallback refuses modern input-required instead of inventing a translator round", async () => {
	const wire = await bridge(() => question);
	await wire.initialize("2025-11-25", { elicitation: { form: {} } });
	assert.ok((await wire.request("prompts/get", { name: "triage_inbox" })).error);
	assert.equal(wire.dialogs(), 0);
	assert.equal(wire.seen.filter((row) => row.method === "prompts/get").length, 1);
});

test("URL approval requests are refused without a client dialog", async () => {
	const wire = await bridge(() => ({
		...question,
		inputRequests: {
			account: {
				method: "elicitation/create",
				params: { mode: "url", message: "DYTEST", url: "https://example.invalid" },
			},
		},
	}));
	await wire.initialize("2025-11-25", { elicitation: { form: {}, url: {} } });
	assert.ok((await wire.request("prompts/get", { name: "triage_inbox" })).error);
	assert.equal(wire.dialogs(), 0);
});

test("modern retry state binds method and params, expires, and is consumed once", async () => {
	const wire = await bridge((message) =>
		message.params.inputResponses ? { messages: [] } : question,
	);
	await wire.request("server/discover", { _meta: envelope() });
	const original = {
		name: "triage_inbox",
		arguments: { window: "24h" },
		_meta: envelope({ elicitation: { form: {} } }),
	};
	const asked = await wire.request("prompts/get", original);
	assert.equal(asked.result.requestState, "DYTEST-hub-state");
	const before = wire.seen.length;
	const swapped = await wire.request("prompts/get", {
		...original,
		arguments: { window: "72h" },
		requestState: "DYTEST-hub-state",
		inputResponses: { account: { action: "accept", content: { account: "DYTEST-account" } } },
	});
	assert.ok(swapped.error);
	assert.equal(wire.seen.length, before);
	assert.ok(
		(await wire.request("prompts/get", { ...original, requestState: "DYTEST-hub-state" })).error,
	);
	await wire.request("prompts/get", original);
	const now = performance.now();
	vi.spyOn(performance, "now").mockReturnValue(now + 600_001);
	assert.ok(
		(await wire.request("prompts/get", { ...original, requestState: "DYTEST-hub-state" })).error,
	);
	assert.equal(wire.seen.length, before + 1);
});

test("modern account answers relay once with the exact original params and hub state", async () => {
	const wire = await bridge((message) =>
		message.params.inputResponses ? { messages: [] } : question,
	);
	await wire.request("server/discover", { _meta: envelope() });
	const params = {
		name: "triage_inbox",
		arguments: { window: "24h" },
		_meta: envelope({ elicitation: { form: {} } }),
	};
	const asked = await wire.request("prompts/get", params);
	const answer = {
		...params,
		requestState: asked.result.requestState,
		inputResponses: { account: { action: "accept", content: { account: "DYTEST-account" } } },
	};
	assert.deepEqual((await wire.request("prompts/get", answer)).result, { messages: [] });
	const calls = wire.seen.filter((row) => row.method === "prompts/get");
	assert.equal(calls.length, 2);
	assert.equal(calls[1]?.params.requestState, "DYTEST-hub-state");
	assert.deepEqual(calls[0]?.params.arguments, calls[1]?.params.arguments);
	const before = wire.seen.length;
	assert.ok((await wire.request("prompts/get", answer)).error);
	assert.equal(wire.seen.length, before);
});

test.each(["expired", "consumed", "unknown"] as const)(
	"unavailable modern question gives fixed restart guidance for %s state without HTTP",
	async (kind) => {
		const wire = await bridge((message) =>
			message.params.inputResponses ? { messages: [] } : question,
		);
		await wire.request("server/discover", { _meta: envelope() });
		const original = {
			name: "triage_inbox",
			arguments: { window: "24h" },
			_meta: envelope({ elicitation: { form: {} } }),
		};
		const asked = await wire.request("prompts/get", original);
		const answer = {
			...original,
			requestState: kind === "unknown" ? "DYTEST-UNKNOWN-STATE-CANARY" : asked.result.requestState,
			inputResponses: {
				account: { action: "accept", content: { account: "DYTEST-ACCOUNT-CANARY" } },
			},
		};
		if (kind === "consumed")
			assert.deepEqual((await wire.request("prompts/get", answer)).result, { messages: [] });
		if (kind === "expired") {
			const now = performance.now();
			vi.spyOn(performance, "now").mockReturnValue(now + 600_001);
		}
		const before = wire.seen.length;
		const reply = await wire.request("prompts/get", answer);
		assert.equal(wire.seen.length, before);
		assert.deepEqual(reply.error, {
			code: -32602,
			message:
				"The previous question is no longer available. This answer was not relayed. Run the original request again.",
		});
		for (const value of [
			TOKEN,
			answer.requestState,
			"DYTEST-ACCOUNT-CANARY",
			"triage_inbox",
			"24h",
		])
			assert.equal(JSON.stringify(reply.error).includes(value), false);
	},
);

test("strict JSON params retain own special keys for native validation without prototype mutation", async () => {
	const wire = await bridge(() => ({ messages: [] }));
	await wire.initialize();
	const args = JSON.parse('{"__proto__":"DYTEST","window":"24h"}');
	await wire.request("prompts/get", { name: "triage_inbox", arguments: args });
	assert.equal(Object.hasOwn(wire.seen.at(-1)?.params.arguments, "__proto__"), true);
	assert.equal(
		Object.getOwnPropertyDescriptor(wire.seen.at(-1)?.params.arguments, "__proto__")?.value,
		"DYTEST",
	);
	assert.equal(Object.hasOwn({}, "DYTEST"), false);
});

test("header sentinel binds exact name while overlong names refuse before HTTP", async () => {
	const wire = await bridge(() => ({ messages: [] }));
	await wire.initialize();
	const name = "DYTEST-\u03bb";
	await wire.request("prompts/get", { name });
	assert.equal(
		wire.seen.at(-1)?.headers["mcp-name"],
		`=?base64?${Buffer.from(name).toString("base64")}?=`,
	);
	const before = wire.seen.length;
	assert.ok(
		(await wire.request("resources/read", { uri: `draftyak://${"x".repeat(8193)}` })).error,
	);
	assert.equal(wire.seen.length, before);
});

test("credential/endpoint/public argv refusals do not disclose or contact a remote hub", async () => {
	for (const token of [
		undefined,
		"",
		"DYTEST token",
		"DYTEST\ninside",
		"DYTEST\rinside",
		"x".repeat(4097),
	])
		assert.throws(() => agentCredential(token));
	for (const url of [
		"https://127.0.0.1:47613/mcp",
		"http://localhost:47613/mcp",
		"http://127.1:47613/mcp",
		"http://127.0.0.1:47613/mcp?q=1",
		"http://u@127.0.0.1:47613/mcp",
		"http://192.0.2.1/mcp",
	])
		assert.throws(() => localEndpoint(url));
	const previous = process.env.DRAFTYAK_TOKEN;
	delete process.env.DRAFTYAK_TOKEN;
	const original = process.stderr.write;
	let text = "";
	process.stderr.write = (chunk) => {
		text += String(chunk);
		return true;
	};
	try {
		assert.equal(await main(["mcp", "--client", "claude-desktop", "--hub-url", "DYTEST"]), 2);
		assert.equal(await main(["mcp", "--client", "claude-desktop"]), 2);
		assert.equal(text.includes("DYTEST"), false);
	} finally {
		process.stderr.write = original;
		if (previous === undefined) delete process.env.DRAFTYAK_TOKEN;
		else process.env.DRAFTYAK_TOKEN = previous;
	}
});

test("HTTP bound refuses oversize, mismatched result ids, redirects and SSE", async () => {
	for (const kind of ["oversize", "redirect", "sse", "wrong-id"]) {
		const hub = await listener((message, _req, res) => {
			if (kind === "oversize") {
				res.end("x".repeat(MCP_MAX_REQUEST_BYTES + 1));
				return;
			}
			if (kind === "redirect") {
				res.writeHead(302, { location: "http://192.0.2.1/mcp" });
				res.end("{}");
				return;
			}
			if (kind === "sse") {
				res.setHeader("content-type", "text/event-stream");
				res.end("DYTEST");
				return;
			}
			res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id + 1, result: discover }));
		});
		const input = new PassThrough(),
			output = new PassThrough();
		await assert.rejects(
			startBridge(new BoundedStdio(input, output), { hub: { url: hub.url, token: TOKEN } }),
		);
		assert.equal(hub.seen.length, 1);
		input.destroy();
		output.destroy();
	}
});

test("private HTTP agent ignores environment proxies on real loopback sockets", async () => {
	let proxyCalls = 0;
	const proxy = await listener(() => {
		proxyCalls++;
		return { result: {} };
	});
	const previous = {
		HTTP_PROXY: process.env.HTTP_PROXY,
		NODE_USE_ENV_PROXY: process.env.NODE_USE_ENV_PROXY,
	};
	process.env.HTTP_PROXY = proxy.url;
	process.env.NODE_USE_ENV_PROXY = "1";
	try {
		const wire = await bridge(() => ({ tools: [] }));
		await wire.initialize();
		await wire.request("tools/list");
		assert.equal(proxyCalls, 0);
	} finally {
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
});

test("stdio bounds, duplicate ids, malformed UTF-8 and unterminated EOF close safely", async () => {
	for (const bytes of [
		Buffer.alloc(MCP_MAX_REQUEST_BYTES + 1, 32),
		Buffer.from([0xff, 10]),
		Buffer.from('{"jsonrpc":"2.0","id":1'),
		Buffer.from(
			'{"jsonrpc":"2.0","id":1,"method":"ping"}\n{"jsonrpc":"2.0","id":1,"method":"ping"}\n',
		),
	]) {
		const input = new PassThrough(),
			output = new PassThrough();
		const transport = new BoundedStdio(input, output);
		await transport.start();
		input.end(bytes);
		assert.equal(await transport.completion, 1);
		input.destroy();
		output.destroy();
	}
});

test("a valid oversized stdio request is refused before dispatch, with an exact-bound positive", async () => {
	const prefix = '{"jsonrpc":"2.0","id":1,"method":"ping","params":{"value":"',
		suffix = '"}}';
	for (const size of [MCP_MAX_REQUEST_BYTES, MCP_MAX_REQUEST_BYTES + 1]) {
		const input = new PassThrough(),
			output = new PassThrough(),
			transport = new BoundedStdio(input, output);
		let calls = 0;
		transport.onmessage = () => {
			calls++;
		};
		await transport.start();
		input.end(`${prefix}${"x".repeat(size - prefix.length - suffix.length)}${suffix}\n`);
		assert.equal(await transport.completion, size === MCP_MAX_REQUEST_BYTES ? 0 : 1);
		assert.equal(calls, size === MCP_MAX_REQUEST_BYTES ? 1 : 0);
		input.destroy();
		output.destroy();
	}
});

test("HTTP byte limit refuses a complete valid response before any JSON parsing", async () => {
	const hub = await listener(() => ({ result: { text: "x".repeat(MCP_MAX_REQUEST_BYTES) } }));
	const http = new LocalHttp(hub.url);
	cleanup.push(async () => http.close());
	await assert.rejects(
		http.post(
			{ "content-type": "application/json" },
			Buffer.from('{"jsonrpc":"2.0","id":1,"method":"ping"}'),
		),
	);
});

test("closing HTTP transport aborts an in-flight request instead of hanging EOF", async () => {
	const hub = await listener(() => undefined);
	const http = new LocalHttp(hub.url);
	const request = http.post({ "content-type": "application/json" }, Buffer.from('{"id":1}'));
	http.close();
	await assert.rejects(request);
});

test("401 and 202 refuse continuing response bodies instead of draining unbounded network data", async () => {
	for (const status of [401, 202]) {
		const closed = Promise.withResolvers<void>();
		const hub = await listener((_message, _request, response) => {
			response.statusCode = status;
			response.write("DYTEST");
			const timer = setInterval(() => response.write("DYTEST"), 5);
			response.on("close", () => {
				clearInterval(timer);
				closed.resolve();
			});
		});
		const http = new LocalHttp(hub.url);
		cleanup.push(async () => http.close());
		const reply = await http.post({ "content-type": "application/json" }, Buffer.from('{"id":1}'));
		assert.equal(reply.status, status);
		assert.equal(reply.body.length, 0);
		const timeout = setTimeout(() => closed.reject(new Error("DYTEST response stayed open")), 1000);
		try {
			await closed.promise;
		} finally {
			clearTimeout(timeout);
		}
	}
});

test("EOF settles an outstanding backpressured output write and closes its stream", async () => {
	const input = new PassThrough();
	const output = new Writable({ write(_chunk, _encoding, _callback) {} });
	const transport = new BoundedStdio(input, output);
	await transport.start();
	const sent = transport.send({ jsonrpc: "2.0", id: 1, result: {} });
	const refused = assert.rejects(sent);
	input.end();
	assert.equal(await transport.completion, 0);
	await refused;
	assert.equal(output.destroyed, true);
	input.destroy();
});

test("a stalled output has an absolute finite write deadline", async () => {
	vi.useFakeTimers();
	try {
		const input = new PassThrough();
		const output = new Writable({ write(_chunk, _encoding, _callback) {} });
		const transport = new BoundedStdio(input, output);
		await transport.start();
		const refused = assert.rejects(transport.send({ jsonrpc: "2.0", id: 1, result: {} }));
		await vi.advanceTimersByTimeAsync(10_001);
		await refused;
		assert.equal(await transport.completion, 1);
		assert.equal(output.destroyed, true);
		input.destroy();
	} finally {
		vi.useRealTimers();
	}
});

test("a write callback arriving after its absolute deadline is refused before timer dispatch", async () => {
	const input = new PassThrough();
	let finish: (() => void) | undefined;
	const output = new Writable({
		write(_chunk, _encoding, callback) {
			finish = callback;
		},
	});
	const transport = new BoundedStdio(input, output);
	await transport.start();
	const now = performance.now();
	const refused = assert.rejects(transport.send({ jsonrpc: "2.0", id: 1, result: {} }));
	vi.spyOn(performance, "now").mockReturnValue(now + 10_001);
	assert.ok(finish);
	finish();
	await refused;
	assert.equal(await transport.completion, 1);
	input.destroy();
});
