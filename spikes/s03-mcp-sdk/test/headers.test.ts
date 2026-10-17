import { createMcpHandler } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import * as z from "zod";
import { createApp, createMcpServer } from "../src/server.ts";
import { initialize, legacy, MCP_URL, modern, raw, type Served, serve } from "./harness.ts";

// The prompt name isn't header-safe, so it must travel in the Base64 sentinel. The SDK finds a
// static resource only by its normalized URL (new URL(uri).href), so the URI is kept normalized.
const PROMPT = "grüße prompt";
const URI = "test://header/r%C3%A4source";
const sentinel = (value: string | Uint8Array): string =>
	`=?base64?${Buffer.from(value).toString("base64")}?=`;

// Counts the McpServers built, so a test can show a refused request never reached the SDK.
let built = 0;

function factory() {
	built += 1;
	const server = createMcpServer();
	server.registerPrompt(PROMPT, { description: "header test prompt" }, () => ({
		messages: [{ role: "user", content: { type: "text", text: "hello" } }],
	}));
	server.registerResource("unicode", URI, { description: "header test resource" }, (uri) => ({
		contents: [{ uri: uri.href, mimeType: "text/plain", text: "hello" }],
	}));
	server.registerTool(
		"whoami",
		{ description: "echoes the principal", inputSchema: z.object({}) },
		(_args, ctx) => ({ content: [{ type: "text", text: ctx.http?.authInfo?.clientId ?? "none" }] }),
	);
	server.registerTool("progress", { description: "reports progress first" }, async (ctx) => {
		const progressToken = ctx.mcpReq._meta?.progressToken;
		if (progressToken !== undefined) {
			const params = { progressToken, progress: 1, total: 2 };
			await ctx.mcpReq.notify({ method: "notifications/progress", params });
		}
		return { content: [{ type: "text", text: "done" }] };
	});
	return server;
}

const app = createApp({ factory });
const send = (request: Request): Promise<Served> => serve(app, request);
const expectError = (response: Served, status: number, code: number, id: unknown = 1) => {
	expect([response.status, response.body.error?.code, response.body.id]).toEqual([
		status,
		code,
		id,
	]);
	expect(response.headers.get("content-type")).toBe("application/json");
};

// The hub's -32020 names the header in data; the SDK's own copy of the check doesn't.
async function refusedByHub(request: Request, header: string): Promise<void> {
	const before = built;
	const response = await send(request);
	expectError(response, 400, -32020);
	expect(response.body.error.data).toEqual({ header });
	expect(built).toBe(before);
}

describe("Mcp-Method and Mcp-Name match the body (2026 era)", () => {
	const named = [
		["tools/call", { name: "accounts_list", arguments: {} }],
		["prompts/get", { name: PROMPT }],
		["resources/read", { uri: URI }],
	] as const;

	it.each(named)(
		"accepts %s when Mcp-Name matches, plain or in the Base64 sentinel",
		async (method, params) => {
			const value = "name" in params ? params.name : params.uri;
			for (const name of [undefined, sentinel(value)]) {
				const response = await send(
					modern(method, params, name ? { headers: { "mcp-name": name } } : {}),
				);
				expect([response.status, response.body.error]).toEqual([200, undefined]);
			}
		},
	);

	it.each(named)(
		"has the hub refuse %s with a missing, empty, mismatched or badly encoded Mcp-Name",
		async (method, params) => {
			for (const name of [
				undefined,
				"",
				"other",
				sentinel("other"),
				"=?base64?SGVsbG8?=",
				"=?base64?SGVs!!!bG8=?=",
				sentinel(new Uint8Array([0xff, 0xfe, 0x41])),
			]) {
				await refusedByHub(modern(method, params, { headers: { "mcp-name": name } }), "Mcp-Name");
			}
		},
	);

	it("compares the decoded value, not the raw header", async () => {
		const undecoded = await send(
			modern("prompts/get", { name: PROMPT }, { headers: { "mcp-name": PROMPT } }),
		);
		expect(undecoded.status).toBe(200);
		const swapped = modern(
			"resources/read",
			{ uri: URI },
			{ headers: { "mcp-name": sentinel(PROMPT) } },
		);
		await refusedByHub(swapped, "Mcp-Name");
	});

	it("has the hub refuse a missing, empty, different or case-changed Mcp-Method or MCP-Protocol-Version", async () => {
		for (const method of [undefined, "", "prompts/list", "TOOLS/LIST"]) {
			await refusedByHub(
				modern("tools/list", {}, { headers: { "mcp-method": method } }),
				"Mcp-Method",
			);
		}
		const noVersion = modern("tools/list", {}, { headers: { "mcp-protocol-version": undefined } });
		await refusedByHub(noVersion, "MCP-Protocol-Version");
		const otherVersion = modern("tools/list", {
			_meta: { "io.modelcontextprotocol/protocolVersion": "2099-01-01" },
		});
		await refusedByHub(otherVersion, "MCP-Protocol-Version");
	});

	it("leaves 2025-era requests to their own rules: no Mcp-Method or Mcp-Name needed", async () => {
		expect((await send(initialize())).body.result.protocolVersion).toBe("2025-11-25");
		const call = await send(legacy("tools/call", { name: "accounts_list", arguments: {} }));
		expect([call.status, call.body.result.structuredContent.accounts.length]).toEqual([200, 1]);
	});
});

describe("protocol-version allowlist", () => {
	it("has the hub refuse versions outside each era's list with -32022 naming the supported ones", async () => {
		const future = "2099-01-01";
		const claim = { _meta: { "io.modelcontextprotocol/protocolVersion": future } };
		const modernOne = await send(
			modern("server/discover", claim, { headers: { "mcp-protocol-version": future } }),
		);
		expectError(modernOne, 400, -32022);
		expect(modernOne.body.error).toEqual({
			code: -32022,
			message: "Unsupported protocol version 2099-01-01; supported: 2026-07-28",
			data: { supported: ["2026-07-28"], requested: future },
		});

		const old = await send(legacy("tools/list", {}, { "mcp-protocol-version": "2024-11-05" }));
		expectError(old, 400, -32022);
		expect(old.body.error.message).toBe(
			"Unsupported protocol version 2024-11-05; supported: 2025-11-25, 2025-06-18, 2025-03-26",
		);
		expect(old.body.error.data.supported).toEqual(["2025-11-25", "2025-06-18", "2025-03-26"]);
	});

	it("negotiates 2025 handshakes down to an allowlisted version", async () => {
		expect((await send(initialize("2024-11-05"))).body.result.protocolVersion).toBe("2025-11-25");
		expect((await send(initialize("2025-06-18"))).body.result.protocolVersion).toBe("2025-06-18");
	});
});

describe("Host/Origin, body cap and the middleware order", () => {
	it("refuses a non-loopback Host or Origin, and accepts loopback ones", async () => {
		for (const headers of [
			{ host: "evil.example.com" },
			{ origin: "http://evil.example.com" },
			{ host: undefined },
		]) {
			const response = await send(modern("server/discover", {}, { headers }));
			expect([response.status, response.body.error.code]).toEqual([403, -32000]);
		}
		for (const headers of [
			{ host: "localhost:47999" },
			{ host: "[::1]:8080", origin: "http://127.0.0.1:5173" },
		]) {
			expect((await send(modern("server/discover", {}, { headers }))).status).toBe(200);
		}
	});

	it("caps the body at exactly 1 MiB, by Content-Length and while streaming", async () => {
		const padded = (length: number) => modern("tools/list", { padding: "x".repeat(length) });
		const sized = async (bytes: number) => padded(bytes - (await padded(0).text()).length);
		expect((await send(await sized(1_048_576))).status).toBe(200);
		expectError(await send(await sized(1_048_577)), 413, -32000, null);
		expectError(await send(raw("{}", { "content-length": "1048577" })), 413, -32000, null);
		const understated = raw(JSON.stringify({ padding: "x".repeat(1_048_577) }), {
			"content-length": "2",
		});
		expectError(await send(understated), 413, -32000, null);
	});

	it("refuses non-JSON bodies", async () => {
		expectError(await send(raw("{", {})), 400, -32700, null);
		expectError(await send(raw("{}", { "content-type": "text/plain" })), 415, -32000, null);
	});

	it("answers a request that fails several checks from the earliest one (§6 order)", async () => {
		const big = { padding: "x".repeat(1_048_576) };
		const everything = modern("tools/call", big, {
			headers: {
				host: "evil.example.com",
				"mcp-name": "wrong",
				"mcp-protocol-version": "2099-01-01",
			},
		});
		expect((await send(everything)).status).toBe(403);
		const tooBig = modern("tools/call", big, { headers: { "mcp-name": "wrong" } });
		expect((await send(tooBig)).status).toBe(413);
		const claim = { _meta: { "io.modelcontextprotocol/protocolVersion": "2099-01-01" } };
		const both = modern(
			"tools/call",
			{ name: "accounts_list", ...claim },
			{
				headers: { "mcp-name": "wrong", "mcp-protocol-version": "2099-01-01" },
			},
		);
		await refusedByHub(both, "Mcp-Name");
	});

	it("checks header values of any length in linear time, before any McpServer exists", async () => {
		const long = `1${" \t".repeat(32_768)}x`;
		const call = { name: "accounts_list", arguments: {} };
		const before = built;
		const started = performance.now();
		const answers = [
			await send(modern("tools/call", call, { headers: { "mcp-name": long } })),
			await send(modern("tools/list", {}, { headers: { "mcp-method": long } })),
			await send(modern("tools/list", {}, { headers: { "mcp-protocol-version": long } })),
			await send(legacy("tools/list", {}, { "mcp-protocol-version": long })),
		];
		expect(performance.now() - started).toBeLessThan(500);
		expect(answers.map((answer) => [answer.status, answer.body.error.code])).toEqual([
			[400, -32020],
			[400, -32020],
			[400, -32020],
			[400, -32022],
		]);
		expect(built).toBe(before);
	});
});

describe("stub principal", () => {
	const guarded = createApp({ factory, token: "stub-token-for-tests" });

	it("hands every request the stub principal", async () => {
		const response = await send(modern("tools/call", { name: "whoami", arguments: {} }));
		expect(response.body.result.content[0].text).toBe("stub-agent");
	});

	it("refuses a missing or wrong bearer when a token is configured", async () => {
		for (const authorization of [undefined, "Bearer wrong", "stub-token-for-tests"]) {
			const request = modern(
				"tools/call",
				{ name: "whoami", arguments: {} },
				{ headers: { authorization } },
			);
			const response = await serve(guarded, request);
			expect([response.status, response.headers.get("www-authenticate")]).toEqual([
				401,
				'Bearer error="invalid_token"',
			]);
		}
		const allowed = modern(
			"tools/call",
			{ name: "whoami", arguments: {} },
			{
				headers: { authorization: "Bearer stub-token-for-tests" },
			},
		);
		expect((await serve(guarded, allowed)).body.result.content[0].text).toBe("stub-agent");
	});
});

describe("JSON only, never a stream", () => {
	it("answers GET and DELETE on /mcp with 405 and no event stream", async () => {
		for (const method of ["GET", "DELETE"]) {
			const response = await app.fetch(
				new Request(MCP_URL, {
					method,
					headers: { host: "127.0.0.1", accept: "text/event-stream" },
				}),
			);
			expect([response.status, response.headers.get("allow")]).toEqual([405, "POST"]);
			expect(response.headers.get("content-type")).toBe("application/json");
			expect((await response.json()).error.code).toBe(-32000);
		}
	});

	it("refuses subscriptions/listen, the one method the SDK always streams", async () => {
		const listen = await send(
			modern("subscriptions/listen", { notifications: { toolsListChanged: true } }),
		);
		expectError(listen, 404, -32601);
	});

	it("keeps every answer application/json, both eras, errors included", async () => {
		const requests = [
			modern("server/discover"),
			modern("tools/list"),
			modern("tools/call", { name: "progress", arguments: {}, _meta: { progressToken: "p1" } }),
			modern("tools/call", { name: "message_get", arguments: { messageId: "not-a-ulid" } }),
			modern("prompts/get", { name: PROMPT }),
			modern("resources/read", { uri: URI }),
			modern("initialize", {}),
			modern("no/such/method"),
			initialize(),
			legacy("tools/list"),
			legacy("tools/call", { name: "progress", arguments: {}, _meta: { progressToken: "p2" } }),
			legacy("prompts/get", { name: PROMPT }),
			legacy("ping"),
		];
		for (const request of requests) {
			const response = await app.fetch(request);
			expect(response.headers.get("content-type")).toBe("application/json");
			await response.text();
		}
		const accepted = await app.fetch(legacy("notifications/initialized", {}, {}, null));
		expect([accepted.status, await accepted.text(), accepted.headers.get("content-type")]).toEqual([
			202,
			"",
			null,
		]);
	});

	it("needs its own 2025 transport: createMcpHandler's legacy leg answers with an event stream", async () => {
		const sdkDefault = createMcpHandler(factory);
		const response = await sdkDefault.fetch(legacy("tools/list"));
		expect(response.headers.get("content-type")).toBe("text/event-stream");
		await response.body?.cancel();
	});
});

describe("2025-era serving", () => {
	it("tears the exchange down when the client goes away mid-call", async () => {
		const { promise: running, resolve: started } = Promise.withResolvers<AbortSignal>();
		let closed = 0;
		const leaving = createApp({
			factory: () => {
				const server = createMcpServer();
				server.registerTool(
					"hold",
					{ description: "waits until the exchange closes" },
					async (ctx) => {
						started(ctx.mcpReq.signal);
						await new Promise((done) => ctx.mcpReq.signal.addEventListener("abort", done));
						return { content: [{ type: "text", text: "too late" }] };
					},
				);
				server.server.onclose = () => {
					closed += 1;
				};
				return server;
			},
		});
		const client = new AbortController();
		const request = legacy("tools/call", { name: "hold", arguments: {} });
		const pending = leaving.fetch(new Request(request, { signal: client.signal }));
		const signal = await running;
		client.abort();
		expect((await pending).status).toBe(499);
		expect([signal.aborted, closed]).toEqual([true, 1]);
	});

	it("reports the 2025 transport's errors through onerror", async () => {
		const errors: Error[] = [];
		const reporting = createApp({ factory, onerror: (error) => errors.push(error) });
		const jsonOnly = legacy("tools/list", {}, { accept: "application/json" });
		expectError(await serve(reporting, jsonOnly), 406, -32000, null);
		expect(errors.map((error) => error.message)).toEqual([
			"Not Acceptable: Client must accept both application/json and text/event-stream",
		]);
	});
});
