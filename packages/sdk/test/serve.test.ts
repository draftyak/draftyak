import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import {
	type McpServerFactory,
	parseJSONRPCMessage,
	type Transport,
} from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { build } from "tsdown";
import { describe, expect, it } from "vitest";
import * as z from "zod";
import { PluginError } from "../src/errors.ts";
import { memoryHost } from "../src/host.ts";
import { createPluginServer, type PluginEntry, serve } from "../src/serve.ts";
import { stdioHost } from "../src/stdio.ts";

const meta = {
	"io.modelcontextprotocol/protocolVersion": "2026-07-28",
	"io.modelcontextprotocol/clientCapabilities": {},
};
const toolExtension = "io.github.draftyak/tool";
type Reply = {
	readonly id: number;
	readonly result?: Record<string, unknown>;
	readonly error?: { readonly code: number; readonly message: string; readonly data?: unknown };
};

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}

function entry(
	tools: PluginEntry["tools"] = [],
	extensions: PluginEntry["extensions"] = { [toolExtension]: {} },
): PluginEntry {
	return { name: "serve-fixture", version: "1.0.0", plugin: "serve-fixture", extensions, tools };
}

function connection(factory: McpServerFactory) {
	let nextId = 1;
	let closed = false;
	const started = deferred<void>();
	const pending = new Map<number, ReturnType<typeof deferred<Reply>>>();
	const transport: Transport = {
		async start() {
			started.resolve();
		},
		async send(message) {
			if ("id" in message && typeof message.id === "number" && !("method" in message)) {
				pending.get(message.id)?.resolve(message as Reply);
				pending.delete(message.id);
			}
		},
		async close() {
			if (closed) return;
			closed = true;
			for (const reply of pending.values()) reply.reject(new Error("Connection closed"));
			pending.clear();
			transport.onclose?.();
		},
	};
	const handle = serveStdio(factory, { legacy: "reject", transport });
	const begin = (method: string, params: Record<string, unknown> = {}) => {
		const id = nextId++;
		const reply = deferred<Reply>();
		pending.set(id, reply);
		transport.onmessage?.(
			parseJSONRPCMessage({
				jsonrpc: "2.0",
				id,
				method,
				params: {
					...params,
					_meta: { ...(params._meta as Record<string, unknown> | undefined), ...meta },
				},
			}),
		);
		return { id, response: reply.promise };
	};
	return {
		ready: started.promise,
		begin,
		async ask(method: string, params: Record<string, unknown> = {}) {
			return begin(method, params).response;
		},
		notify(method: string, params: Record<string, unknown>) {
			transport.onmessage?.(
				parseJSONRPCMessage({ jsonrpc: "2.0", method, params: { ...params, _meta: meta } }),
			);
		},
		close: () => handle.close(),
	};
}

const noHost = () =>
	memoryHost(() => {
		throw new Error("Unexpected host request");
	});

async function withConnection(
	definition: PluginEntry,
	check: (peer: ReturnType<typeof connection>) => Promise<void>,
) {
	const host = noHost();
	const peer = connection(createPluginServer(definition, host));
	try {
		await peer.ready;
		await check(peer);
	} finally {
		await peer.close();
		host.close();
	}
}

describe("plugin MCP serving", () => {
	it("passes detached call metadata to an explicit send handler without implicitly forwarding tickets", async () => {
		const key = "io.github.draftyak/send-ticket";
		const ticket = { proof: "DYTEST-ticket", nested: { nonce: 1 } };
		const requests: Record<string, unknown>[] = [];
		const host = memoryHost((method, params) => {
			expect(method).toBe("host/fetch");
			requests.push(params as Record<string, unknown>);
			return { status: 200, headers: [], body: { base64: "" } };
		});
		let received: Readonly<Record<string, unknown>> | undefined;
		const peer = connection(
			createPluginServer(
				entry(
					[
						{
							name: "channel_send",
							handler: async (_args, context, metadata) => {
								received = metadata;
								expect(Object.isFrozen(metadata)).toBe(true);
								await context.fetch("https://example.invalid/send", {
									method: "POST",
									body: "payload",
									sendTicket: metadata[key],
								});
								return { sent: true };
							},
						},
						{
							name: "fixture_read",
							handler: async (_args, context) => {
								await context.fetch("https://example.invalid/read");
								return { read: true };
							},
						},
					],
					{ "io.github.draftyak/channel": {} },
				),
				host,
			),
		);
		try {
			await peer.ready;
			const params = { arguments: {}, _meta: { [key]: ticket } };
			expect(
				(await peer.ask("tools/call", { name: "channel_send", ...params })).result
					?.structuredContent,
			).toEqual({ sent: true });
			expect(received).toEqual({ [key]: ticket });
			expect(received?.[key]).not.toBe(ticket);
			expect(requests[0]?.sendTicket).toEqual(ticket);
			expect(
				(await peer.ask("tools/call", { name: "fixture_read", ...params })).result
					?.structuredContent,
			).toEqual({ read: true });
			expect(requests[1]).not.toHaveProperty("sendTicket");
		} finally {
			await peer.close();
			host.close();
		}
	});
	it.each(["io.github.draftyak/channel", "io.github.draftyak/ai-provider", toolExtension])(
		"discovers only the declared %s extension and fixed tools capability",
		async (extension) => {
			await withConnection(entry([], { [extension]: { version: 1 } }), async (peer) => {
				const reply = await peer.ask("server/discover");
				expect(reply.error).toBeUndefined();
				expect(reply.result?.capabilities).toEqual({
					tools: { listChanged: false },
					extensions: { [extension]: { version: 1 } },
				});
			});
		},
	);

	it.each([
		{},
		{ "io.modelcontextprotocol/ui": {} },
		{ [toolExtension]: {}, "io.modelcontextprotocol/ui": {} },
		{ [toolExtension]: {}, "io.github.draftyak/channel": {} },
	])("refuses an extension map outside the single plugin contract: %j", (extensions) => {
		const host = noHost();
		try {
			expect(() => createPluginServer(entry([], extensions), host)).toThrow();
		} finally {
			host.close();
		}
	});

	it("lists only registered tools and exposes no prompt, resource or completion API", async () => {
		await withConnection(
			entry([
				{
					name: "fixture_echo",
					description: "Echo a test number",
					inputSchema: z.object({ count: z.int() }),
					handler: (args) => args,
				},
			]),
			async (peer) => {
				const listed = await peer.ask("tools/list");
				expect(listed.error).toBeUndefined();
				expect(listed.result?.tools).toEqual([
					expect.objectContaining({ name: "fixture_echo", description: "Echo a test number" }),
				]);
				for (const [method, params] of [
					["prompts/list", {}],
					["resources/list", {}],
					["resources/templates/list", {}],
					[
						"completion/complete",
						{
							ref: { type: "ref/prompt", name: "fixture" },
							argument: { name: "value", value: "" },
						},
					],
				] as const) {
					const reply = await peer.ask(method, params);
					expect(reply.error?.code).toBe(-32601);
					expect(reply.result).toBeUndefined();
				}
			},
		);
	});

	it("returns an ordinary handler record as matching structured and text content", async () => {
		await withConnection(
			entry([
				{
					name: "fixture_echo",
					inputSchema: z.object({ count: z.int() }),
					handler: (args) => ({ echoed: args, complete: true }),
				},
			]),
			async (peer) => {
				const reply = await peer.ask("tools/call", {
					name: "fixture_echo",
					arguments: { count: 7 },
				});
				expect(reply.error).toBeUndefined();
				expect(reply.result).toMatchObject({
					structuredContent: { echoed: { count: 7 }, complete: true },
				});
				const content = reply.result?.content as { type: string; text: string }[];
				expect(content).toHaveLength(1);
				expect(content[0]?.type).toBe("text");
				expect(JSON.parse(content[0]?.text ?? "")).toEqual(reply.result?.structuredContent);
				expect(reply.result?.isError).not.toBe(true);
			},
		);
	});

	it("rejects off-schema arguments before the handler and still accepts a valid call", async () => {
		let calls = 0;
		await withConnection(
			entry([
				{
					name: "fixture_count",
					inputSchema: z.object({ count: z.int() }),
					handler: () => {
						calls++;
						return { calls };
					},
				},
			]),
			async (peer) => {
				const invalid = await peer.ask("tools/call", {
					name: "fixture_count",
					arguments: { count: "7" },
				});
				expect(invalid.error !== undefined || invalid.result?.isError === true).toBe(true);
				expect(calls).toBe(0);
				const valid = await peer.ask("tools/call", {
					name: "fixture_count",
					arguments: { count: 7 },
				});
				expect(valid.result?.structuredContent).toEqual({ calls: 1 });
			},
		);
	});

	it("preserves a declared PluginError code, retry delay and bounded detail", async () => {
		await withConnection(
			entry([
				{
					name: "fixture_error",
					handler: () => {
						throw new PluginError("RATE_LIMITED", { retryAfterMs: 250, detail: "Try later" });
					},
				},
			]),
			async (peer) => {
				const reply = await peer.ask("tools/call", { name: "fixture_error", arguments: {} });
				expect(reply.error).toBeUndefined();
				expect(reply.result).toMatchObject({
					isError: true,
					_meta: {
						"io.github.draftyak/error": {
							code: "RATE_LIMITED",
							retryAfterMs: 250,
							detail: "Try later",
						},
					},
					content: [
						{
							type: "text",
							text: JSON.stringify({
								code: "RATE_LIMITED",
								retryAfterMs: 250,
								detail: "Try later",
							}),
						},
					],
				});
			},
		);
	});

	it.each([new Error("DYTEST-exception-canary"), "DYTEST-thrown-string"])(
		"sanitizes unknown thrown values",
		async (error) => {
			await withConnection(
				entry([
					{
						name: "fixture_error",
						handler: () => {
							throw error;
						},
					},
				]),
				async (peer) => {
					const reply = await peer.ask("tools/call", { name: "fixture_error", arguments: {} });
					expect(reply.error).toBeUndefined();
					expect(reply.result).toMatchObject({
						isError: true,
						_meta: { "io.github.draftyak/error": { code: "TRANSIENT" } },
						content: [{ type: "text", text: '{"code":"TRANSIENT"}' }],
					});
					expect(JSON.stringify(reply)).not.toContain("DYTEST-");
					expect(JSON.stringify(reply)).not.toContain("stack");
				},
			);
		},
	);

	it("creates distinct server instances and keeps one connection usable after another closes", async () => {
		const host = noHost();
		const factory = createPluginServer(
			entry([{ name: "fixture_echo", handler: () => ({ live: true }) }]),
			host,
		);
		const first = await factory({ era: "modern" });
		const second = await factory({ era: "modern" });
		expect(first).not.toBe(second);
		await first.close();
		await second.close();
		const a = connection(factory);
		const b = connection(factory);
		try {
			await Promise.all([a.ready, b.ready]);
			expect(
				(await a.ask("tools/call", { name: "fixture_echo", arguments: {} })).result
					?.structuredContent,
			).toEqual({ live: true });
			await a.close();
			expect(
				(await b.ask("tools/call", { name: "fixture_echo", arguments: {} })).result
					?.structuredContent,
			).toEqual({ live: true });
		} finally {
			await a.close();
			await b.close();
			host.close();
		}
	});

	it.each(["cancellation", "timeout"] as const)(
		"aborts a handler on %s before any later host request",
		async (cause) => {
			const entered = deferred<void>();
			const finished = deferred<{ aborted: boolean; denied: boolean }>();
			const calls: string[] = [];
			const host = memoryHost((method) => {
				calls.push(method);
				return null;
			});
			const peer = connection(
				createPluginServer(
					entry([
						{
							name: "fixture_live",
							handler: async (_args, context) => {
								await context.log("info", "DYTEST-live-control");
								return { live: true };
							},
						},
						{
							name: "fixture_wait",
							timeoutMs: cause === "timeout" ? 25 : 120_000,
							handler: async (_args, context) => {
								entered.resolve();
								await new Promise<void>((resolve) => {
									if (context.signal.aborted) resolve();
									else context.signal.addEventListener("abort", () => resolve(), { once: true });
								});
								let denied = false;
								try {
									await context.log("info", "DYTEST-after-abort");
								} catch {
									denied = true;
								}
								finished.resolve({ aborted: context.signal.aborted, denied });
								return { completed: true };
							},
						},
					]),
					host,
				),
			);
			try {
				await peer.ready;
				expect(
					(await peer.ask("tools/call", { name: "fixture_live", arguments: {} })).result
						?.structuredContent,
				).toEqual({ live: true });
				expect(calls).toEqual(["host/log"]);
				const active = peer.begin("tools/call", { name: "fixture_wait", arguments: {} });
				void active.response.catch(() => undefined);
				await entered.promise;
				if (cause === "cancellation")
					peer.notify("notifications/cancelled", {
						requestId: active.id,
						reason: "Test cancellation",
					});
				expect(await finished.promise).toEqual({ aborted: true, denied: true });
				expect(calls).toEqual(["host/log"]);
			} finally {
				await peer.close();
				host.close();
			}
		},
	);

	it("rejects legacy initialization readably and then serves modern discovery on the same stdio connection", async () => {
		const input = new PassThrough();
		const output = new PassThrough();
		const lines = createInterface({ input: output });
		const replies = lines[Symbol.asyncIterator]();
		const host = stdioHost({ input, output });
		const handle = serve(entry(), { host });
		const ask = async (message: object): Promise<Reply> => {
			input.write(`${JSON.stringify(message)}\n`);
			const next = await replies.next();
			expect(next.done).not.toBe(true);
			return JSON.parse(String(next.value)) as Reply;
		};
		try {
			const rejected = await ask({
				jsonrpc: "2.0",
				id: 1,
				method: "initialize",
				params: {
					protocolVersion: "2025-11-25",
					capabilities: {},
					clientInfo: { name: "legacy-fixture", version: "1" },
				},
			});
			expect(rejected).toMatchObject({
				id: 1,
				error: {
					code: -32022,
					message: "Unsupported protocol version: 2025-11-25",
					data: { supported: ["2026-07-28"], requested: "2025-11-25" },
				},
			});
			const modern = await ask({
				jsonrpc: "2.0",
				id: 2,
				method: "server/discover",
				params: { _meta: meta },
			});
			expect(modern.error).toBeUndefined();
			expect(modern.result?.capabilities).toEqual({
				tools: { listChanged: false },
				extensions: { [toolExtension]: {} },
			});
		} finally {
			await handle.close();
			host.close();
			lines.close();
			input.destroy();
			output.destroy();
		}
	});

	it("serves a tsdown fixture with string code generation disabled", async () => {
		const directory = await mkdtemp(path.join(os.tmpdir(), "draftyak-sdk-serve-"));
		let child: ReturnType<typeof spawn> | undefined;
		try {
			await build({
				entry: [fileURLToPath(new URL("./fixtures/serve-plugin.ts", import.meta.url))],
				outDir: directory,
				format: "esm",
				platform: "node",
				deps: { alwaysBundle: [/./], onlyBundle: false },
				dts: false,
				sourcemap: false,
				clean: false,
				config: false,
			});
			const outputs = (await readdir(directory)).filter(
				(name) => name.endsWith(".mjs") || name.endsWith(".js"),
			);
			expect(outputs).toHaveLength(1);
			child = spawn(
				process.execPath,
				["--disallow-code-generation-from-strings", path.join(directory, outputs[0] ?? "")],
				{ stdio: ["pipe", "pipe", "pipe"], windowsHide: true, cwd: directory },
			);
			const stopped = once(child, "exit");
			const errors: Buffer[] = [];
			child.stderr?.on("data", (chunk: Buffer) => errors.push(chunk));
			if (!child.stdin || !child.stdout) throw new Error("Fixture pipes missing");
			const lines = createInterface({ input: child.stdout });
			try {
				const replies = lines[Symbol.asyncIterator]();
				child.stdin.write(
					`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "fixture_echo", arguments: { count: 9 }, _meta: meta } })}\n`,
				);
				const next = await replies.next();
				expect(next.done).not.toBe(true);
				const reply = JSON.parse(String(next.value)) as Reply;
				expect(reply.error).toBeUndefined();
				expect(reply.result?.structuredContent).toEqual({ count: 9 });
				child.stdin.end();
				const [code, signal] = await stopped;
				expect({ code, signal, stderr: Buffer.concat(errors).toString() }).toEqual({
					code: 0,
					signal: null,
					stderr: "",
				});
			} finally {
				lines.close();
			}
		} finally {
			if (child && child.exitCode === null && child.signalCode === null) {
				child.kill();
				await once(child, "exit");
			}
			await rm(directory, { recursive: true, force: true });
		}
	});
});
