import { createHash } from "node:crypto";
import { aiProviderV1 } from "@draftyak/protocol/ai-provider-v1";
import type { HostFetchParams, HostFetchResult } from "@draftyak/protocol/host-channel";
import { createPluginServer, HostError, type HostHandler, memoryHost } from "@draftyak/sdk";
import { parseJSONRPCMessage, type Transport } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type CompatibleFormat, createPlugin, MAX_RESPONSE_BYTES } from "../src/index.ts";
import { completion, core, MODEL, OUTPUT, REQUEST } from "./helpers.ts";

const PRIVATE_DETAIL = "DYTEST_UNTRUSTED_PROVIDER_DETAIL";
const metadata = {
	"io.modelcontextprotocol/protocolVersion": "2026-07-28",
	"io.modelcontextprotocol/clientCapabilities": {},
};
type Reply = { readonly result?: Record<string, unknown>; readonly error?: unknown };
type Pending = ReturnType<typeof Promise.withResolvers<Reply>> & {
	readonly timer: ReturnType<typeof setTimeout>;
};

// Any accidental bypass of the SDK broker fails locally, without opening a socket.
const directFetch = vi.fn(() => Promise.reject(new Error("Direct fetch refused")));
beforeEach(() => {
	directFetch.mockClear();
	vi.stubGlobal("fetch", directFetch);
});
afterEach(() => {
	vi.unstubAllGlobals();
	expect(directFetch).not.toHaveBeenCalled();
});

function configured(format: CompatibleFormat = "json_schema") {
	return {
		endpoint: `http://127.0.0.1:11434/${format === "ollama" ? "api/chat" : "v1/chat/completions"}`,
		model: MODEL,
		format,
	};
}
function inline(
	body: string | Uint8Array,
	status = 200,
	headers: [string, string][] = [],
): HostFetchResult {
	const content = typeof body === "string" ? Buffer.from(body, "utf8") : Buffer.from(body);
	return {
		status,
		headers: [["content-type", "application/json"], ...headers],
		body: { base64: content.toString("base64url") },
	};
}
function wireBody(request: HostFetchParams): string {
	if (!request.body || !("base64" in request.body)) throw new Error("Expected inline request");
	return Buffer.from(request.body.base64, "base64url").toString("utf8");
}

/** Public MCP serving and SDK host transport; no testkit or native authority is constructed. */
async function mounted(handler: HostHandler, format: CompatibleFormat = "json_schema") {
	const entry = createPlugin(configured(format), {
		hostname: "127.0.0.1",
		destination: "local",
	});
	const host = memoryHost(handler);
	const started = Promise.withResolvers<void>();
	const pending = new Map<number, Pending>();
	const notifications: unknown[] = [];
	let sequence = 0;
	const wire: Transport = {
		async start() {
			started.resolve();
		},
		async send(message) {
			if ("method" in message) notifications.push(message);
			else if (typeof message.id === "number") {
				const waiting = pending.get(message.id);
				if (!waiting) return;
				pending.delete(message.id);
				clearTimeout(waiting.timer);
				waiting.resolve(message as Reply);
			}
		},
		async close() {
			for (const waiting of pending.values()) {
				clearTimeout(waiting.timer);
				waiting.reject(new Error("MCP fixture closed"));
			}
			pending.clear();
			wire.onclose?.();
		},
	};
	const server = serveStdio(createPluginServer(entry, host), { legacy: "reject", transport: wire });
	await started.promise;
	const begin = (method: string, params: Record<string, unknown> = {}) => {
		const id = ++sequence;
		const reply = Promise.withResolvers<Reply>();
		void reply.promise.catch(() => {});
		const timer = setTimeout(() => {
			pending.delete(id);
			reply.reject(new Error("MCP fixture reply timeout"));
		}, 2000);
		pending.set(id, { ...reply, timer });
		wire.onmessage?.(
			parseJSONRPCMessage({
				jsonrpc: "2.0",
				id,
				method,
				params: { ...params, _meta: { ...metadata, ...(params._meta as object) } },
			}),
		);
		return { id, response: reply.promise };
	};
	return {
		host,
		notifications,
		begin,
		call(name: string, args: unknown = {}, extra: Record<string, unknown> = {}) {
			return begin("tools/call", { name, arguments: args, _meta: extra }).response;
		},
		cancel(id: number) {
			wire.onmessage?.(
				parseJSONRPCMessage({
					jsonrpc: "2.0",
					method: "notifications/cancelled",
					params: { requestId: id, _meta: metadata },
				}),
			);
		},
		async close() {
			try {
				await server.close();
			} finally {
				host.close();
			}
		},
	};
}

function success(reply: Reply): unknown {
	expect(reply.error).toBeUndefined();
	expect(reply.result?.isError).not.toBe(true);
	return reply.result?.structuredContent;
}
function failure(reply: Reply, code: string, retryAfterMs?: number): void {
	expect(reply.error).toBeUndefined();
	expect(reply.result?.isError).toBe(true);
	expect(reply.result?.structuredContent).toEqual({
		code,
		...(retryAfterMs === undefined ? {} : { retryAfterMs }),
	});
	expect(JSON.stringify(reply)).not.toContain(PRIVATE_DETAIL);
}

describe("compatible provider SDK mount", () => {
	it("serves exactly four provider tools and describes without fetching", async () => {
		const fetch = vi.fn(() => {
			throw new Error("Unexpected broker call");
		});
		const io = await mounted(fetch);
		try {
			const listed = (await io.begin("tools/list").response).result?.tools as { name: string }[];
			expect(listed.map((tool) => tool.name).sort()).toEqual(
				Object.keys(aiProviderV1.tools).sort(),
			);
			expect(success(await io.call("ai_describe"))).toEqual(core().describe());
			expect(fetch).not.toHaveBeenCalled();
		} finally {
			await io.close();
		}
	});

	it.each(["json_schema", "json_object", "ollama"] as const)(
		"mounts %s models, exact prompt bytes and normalized completed outcomes through the broker",
		async (format) => {
			const provider = core(format);
			const seen: HostFetchParams[] = [];
			const io = await mounted((method, params, signal) => {
				expect(method).toBe("host/fetch");
				expect(signal.aborted).toBe(false);
				const request = params as HostFetchParams;
				seen.push(request);
				return request.method === "GET"
					? inline(
							JSON.stringify(
								format === "ollama" ? { models: [{ name: MODEL }] } : { data: [{ id: MODEL }] },
							),
						)
					: inline(completion(provider).body);
			}, format);
			try {
				expect(success(await io.call("ai_models_list"))).toEqual({
					models: [{ id: MODEL, fallbacks: false }],
				});
				expect(seen[0]).toEqual({
					method: "GET",
					url: provider.config.modelsEndpoint,
					headers: [],
					stream: true,
				});
				const expected = provider.build(REQUEST);
				expect(
					success(
						await io.call("ai_draft_generate", REQUEST, {
							progressToken: "completed",
							config: { endpoint: "https://ignored.example.invalid/v1/chat/completions" },
							destination: "cloud",
						}),
					),
				).toEqual(provider.parse(REQUEST, completion(provider)));
				const sent = seen[1];
				expect(sent).toMatchObject({
					method: "POST",
					url: expected.url,
					headers: [["content-type", "application/json"]],
					stream: true,
				});
				if (!sent) throw new Error("Missing broker request");
				const body = wireBody(sent);
				expect(body).toBe(expected.body);
				expect(createHash("sha256").update(body).digest("hex")).toBe(expected.bodySha256);
				expect(JSON.parse(body)).toMatchObject({
					model: MODEL,
					stream: false,
					messages: [
						{ role: "system", content: REQUEST.system },
						{ role: "user", content: REQUEST.prompt },
					],
				});
				expect(success(await io.call("ai_probe", { model: MODEL }))).toEqual({ status: "ok" });
				expect(seen).toHaveLength(3);
				expect(seen[2]).toMatchObject({ method: "POST", url: expected.url, stream: true });
				expect(io.notifications).toEqual([]);
			} finally {
				await io.close();
			}
		},
	);

	it("refuses malformed generation and a different probe model before any broker call", async () => {
		const fetch = vi.fn(() => inline(completion(core()).body));
		const io = await mounted(fetch);
		try {
			for (const args of [
				{ model: MODEL, system: REQUEST.system, prompt: REQUEST.prompt },
				{ ...REQUEST, to: ["recipient@example.invalid"] },
			]) {
				const reply = await io.call("ai_draft_generate", args);
				expect(reply.error !== undefined || reply.result?.isError === true).toBe(true);
			}
			failure(await io.call("ai_probe", { model: "different-model" }), "INVALID_INPUT");
			failure(
				await io.call("ai_draft_generate", { ...REQUEST, model: "different-model" }),
				"INVALID_INPUT",
			);
			expect(fetch).not.toHaveBeenCalled();
			expect(success(await io.call("ai_draft_generate", REQUEST))).toMatchObject({
				kind: "draft",
				output: OUTPUT,
			});
			expect(fetch).toHaveBeenCalledTimes(1);
		} finally {
			await io.close();
		}
	});

	it("preserves refusal, truncation, invalid and unexpected outcomes without repair or provider switch", async () => {
		const provider = core();
		const responses = [
			completion(provider, PRIVATE_DETAIL, "content_filter"),
			completion(provider, PRIVATE_DETAIL, "length"),
			completion(provider, { ...OUTPUT, body: 1 }),
			completion(provider, PRIVATE_DETAIL, "unrecognized-stop"),
		];
		let calls = 0;
		const io = await mounted(() => {
			const response = responses[calls++];
			if (!response) throw new Error("Unexpected provider retry");
			return inline(response.body);
		});
		try {
			for (const response of responses) {
				const reply = await io.call("ai_draft_generate", REQUEST);
				expect(success(reply)).toEqual(provider.parse(REQUEST, response));
				expect(JSON.stringify(reply)).not.toContain(PRIVATE_DETAIL);
			}
			expect(calls).toBe(4);
		} finally {
			await io.close();
		}
	});

	it.each([
		{ status: 400, code: "INVALID_INPUT" },
		{ status: 401, code: "AUTH_REVOKED" },
		{ status: 403, code: "PERMISSION_DENIED" },
		{ status: 429, code: "RATE_LIMITED", retryAfterMs: 2000 },
		{ status: 500, code: "TRANSIENT" },
	])("returns only canonical $code for HTTP $status", async ({ status, code, retryAfterMs }) => {
		const fetch = vi.fn(() =>
			inline(JSON.stringify({ error: { message: PRIVATE_DETAIL } }), status, [
				["retry-after", "2"],
			]),
		);
		const io = await mounted(fetch);
		try {
			failure(await io.call("ai_draft_generate", REQUEST), code, retryAfterMs);
			expect(fetch).toHaveBeenCalledTimes(1);
		} finally {
			await io.close();
		}
	});

	it("preserves quota and retry hints without exposing provider error text", async () => {
		const io = await mounted(() =>
			inline(
				JSON.stringify({ error: { code: "insufficient_quota", message: PRIVATE_DETAIL } }),
				429,
				[["retry-after", "2"]],
			),
		);
		try {
			failure(await io.call("ai_draft_generate", REQUEST), "QUOTA_EXCEEDED", 2000);
		} finally {
			await io.close();
		}
	});

	it.each([
		{ kind: "denied", code: "PERMISSION_DENIED" },
		{ kind: "timeout", code: "TRANSIENT" },
		{ kind: "untrusted", code: "TRANSIENT" },
	])(
		"normalizes $kind broker failures without reading arbitrary error details",
		async ({ kind, code }) => {
			const io = await mounted(() => {
				if (kind !== "untrusted") throw new HostError(kind === "denied" ? "DENIED" : "TIMEOUT");
				throw new Error(PRIVATE_DETAIL);
			});
			try {
				failure(await io.call("ai_draft_generate", REQUEST), code);
			} finally {
				await io.close();
			}
		},
	);

	it.each([0, 1])(
		"bounds the aggregate completed response at MAX_RESPONSE_BYTES + %i",
		async (extra) => {
			const provider = core();
			const base = JSON.parse(Buffer.from(completion(provider).body).toString("utf8"));
			const empty = JSON.stringify({ ...base, padding: "" });
			const body = Buffer.from(
				JSON.stringify({
					...base,
					padding: "x".repeat(MAX_RESPONSE_BYTES + extra - Buffer.byteLength(empty)),
				}),
			);
			expect(body.byteLength).toBe(MAX_RESPONSE_BYTES + extra);
			let calls = 0;
			let emittedBytes = 0;
			let emittedChunks = 0;
			const io = await mounted(() => {
				calls++;
				let sequence = 0;
				for (let offset = 0; offset < body.byteLength; offset += 65_536) {
					const chunk = body.subarray(offset, offset + 65_536);
					io.host.notify({
						jsonrpc: "2.0",
						method: "host/stream.chunk",
						params: {
							streamId: "bounded-completion",
							sequence: sequence++,
							base64: chunk.toString("base64url"),
							done: offset + chunk.byteLength === body.byteLength,
						},
					});
					emittedBytes += chunk.byteLength;
					emittedChunks++;
				}
				return {
					status: 200,
					headers: [["content-type", "application/json"]],
					streamId: "bounded-completion",
				};
			});
			try {
				const reply = await io.call("ai_draft_generate", REQUEST);
				expect(emittedBytes).toBe(body.byteLength);
				expect(emittedChunks).toBe(extra === 0 ? 4 : 5);
				if (extra === 0) expect(success(reply)).toMatchObject({ kind: "draft", output: OUTPUT });
				else failure(reply, "TRANSIENT");
				expect(calls).toBe(1);
			} finally {
				await io.close();
			}
		},
	);

	it("propagates MCP cancellation to the actual SDK host signal while broker work unwinds", async () => {
		const entered = Promise.withResolvers<AbortSignal>();
		const release = Promise.withResolvers<void>();
		const settled = Promise.withResolvers<void>();
		const io = await mounted(async (_method, _params, signal) => {
			entered.resolve(signal);
			try {
				await release.promise;
				return inline(completion(core()).body);
			} finally {
				settled.resolve();
			}
		});
		try {
			const call = io.begin("tools/call", { name: "ai_draft_generate", arguments: REQUEST });
			const signal = await entered.promise;
			expect(signal.aborted).toBe(false);
			io.cancel(call.id);
			await expect.poll(() => signal.aborted).toBe(true);
			release.resolve();
			await settled.promise;
			expect(io.notifications).toEqual([]);
		} finally {
			release.resolve();
			await io.close();
		}
	});
});
