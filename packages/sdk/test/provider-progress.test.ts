import { parseJSONRPCMessage, type Transport } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { describe, expect, it } from "vitest";
import {
	type AiProviderContext,
	type AiProviderPluginDefinition,
	defineAiProviderPlugin,
} from "../src/ai-provider.ts";
import { memoryHost } from "../src/host.ts";
import { createPluginServer } from "../src/serve.ts";
import { aiManifest } from "./definitions-fixtures.ts";

const meta = {
	"io.modelcontextprotocol/protocolVersion": "2026-07-28",
	"io.modelcontextprotocol/clientCapabilities": {},
};
const args = { model: "test-model", system: "Instructions", prompt: "Message", contextIds: [] };
const outcome = {
	kind: "unexpected" as const,
	stopReason: null,
	model: "test-model",
	fallback: false,
	usage: { input: 1, output: 1 },
};
type Reply = { result?: Record<string, unknown>; error?: unknown };
function definition(
	generateDraft: AiProviderPluginDefinition["generateDraft"],
): AiProviderPluginDefinition {
	return {
		manifest: aiManifest,
		describe: () => ({ name: "Provider", structuredOutput: "validated" }),
		listModels: () => ({ models: [] }),
		probe: () => ({ status: "ok" }),
		generateDraft,
	};
}
async function connection(generateDraft: AiProviderPluginDefinition["generateDraft"]) {
	const ready = Promise.withResolvers<void>();
	const pending = new Map<number, ReturnType<typeof Promise.withResolvers<Reply>>>();
	const notifications: unknown[] = [];
	const host = memoryHost(() => {
		throw new Error("Unexpected host call");
	});
	let nextId = 0;
	const transport: Transport = {
		async start() {
			ready.resolve();
		},
		async send(message) {
			if ("method" in message) notifications.push(message);
			else if (typeof message.id === "number") {
				pending.get(message.id)?.resolve(message);
				pending.delete(message.id);
			}
		},
		async close() {
			for (const item of pending.values()) item.reject(new Error("Closed"));
			pending.clear();
			transport.onclose?.();
		},
	};
	const handle = serveStdio(
		createPluginServer(defineAiProviderPlugin(definition(generateDraft)), host),
		{ legacy: "reject", transport },
	);
	await ready.promise;
	return {
		notifications,
		begin(prompt: string, metadata: Record<string, unknown> = {}) {
			const id = ++nextId;
			const reply = Promise.withResolvers<Reply>();
			void reply.promise.catch(() => {});
			const message = parseJSONRPCMessage({
				jsonrpc: "2.0",
				id,
				method: "tools/call",
				params: {
					name: "ai_draft_generate",
					arguments: { ...args, prompt },
					_meta: { ...meta, ...metadata },
				},
			});
			pending.set(id, reply);
			transport.onmessage?.(message);
			return { id, response: reply.promise };
		},
		cancel(requestId: number) {
			transport.onmessage?.(
				parseJSONRPCMessage({
					jsonrpc: "2.0",
					method: "notifications/cancelled",
					params: { requestId, _meta: meta },
				}),
			);
		},
		async close() {
			await handle.close();
			host.close();
		},
	};
}

describe("provider request progress", () => {
	it("preserves zero and exact string tokens and omits an absent total", async () => {
		const io = await connection(async (_args, context) => {
			await context.progress(2);
			return outcome;
		});
		try {
			for (const token of [0, "", "caller token / exact"])
				expect(
					(await io.begin("run", { progressToken: token }).response).result?.structuredContent,
				).toEqual(outcome);
			expect(io.notifications).toEqual(
				[0, "", "caller token / exact"].map((progressToken) =>
					expect.objectContaining({
						method: "notifications/progress",
						params: { progressToken, progress: 2 },
					}),
				),
			);
		} finally {
			await io.close();
		}
	});
	it("does not create progress or a token when the caller did not request it", async () => {
		const io = await connection(async (_args, context) => {
			await context.progress(1, 2);
			return outcome;
		});
		try {
			expect((await io.begin("no-token").response).result?.structuredContent).toEqual(outcome);
			expect(io.notifications).toEqual([]);
		} finally {
			await io.close();
		}
	});
	it("refuses malformed tokens before invoking the provider", async () => {
		let calls = 0;
		const io = await connection(() => {
			calls++;
			return outcome;
		});
		try {
			for (const progressToken of [null, {}, [], 1.5]) {
				let call: ReturnType<typeof io.begin> | undefined;
				try {
					call = io.begin("bad-token", { progressToken });
				} catch (error) {
					expect(error).toBeInstanceOf(Error);
				}
				if (call) {
					const reply = await call.response;
					expect(reply.error !== undefined || reply.result?.isError === true).toBe(true);
				}
			}
			expect(calls).toBe(0);
			expect(io.notifications).toEqual([]);
		} finally {
			await io.close();
		}
	});
	it("rejects nonfinite progress before emitting an MCP notification", async () => {
		const io = await connection(async (_args, context) => {
			await expect(context.progress(Number.NaN)).rejects.toThrow();
			await expect(context.progress(1, Number.POSITIVE_INFINITY)).rejects.toThrow();
			await context.progress(1, 2);
			return outcome;
		});
		try {
			expect(
				(await io.begin("valid", { progressToken: "bounded" }).response).result?.structuredContent,
			).toEqual(outcome);
			expect(io.notifications).toEqual([
				expect.objectContaining({
					method: "notifications/progress",
					params: { progressToken: "bounded", progress: 1, total: 2 },
				}),
			]);
		} finally {
			await io.close();
		}
	});
	it("isolates concurrent tokens and retires a completed call without ending the other call", async () => {
		const contexts = new Map<string, AiProviderContext>();
		const gates = new Map(["first", "second"].map((name) => [name, Promise.withResolvers<void>()]));
		const io = await connection(async (request, context) => {
			contexts.set(request.prompt, context);
			await gates.get(request.prompt)?.promise;
			return outcome;
		});
		try {
			const first = io.begin("first", { progressToken: "one" });
			const second = io.begin("second", { progressToken: 0 });
			await expect.poll(() => contexts.size).toBe(2);
			await contexts.get("second")?.progress(2, 3);
			await contexts.get("first")?.progress(1, 3);
			gates.get("first")?.resolve();
			expect((await first.response).result?.structuredContent).toEqual(outcome);
			await expect(contexts.get("first")?.progress(9)).rejects.toThrow("ended");
			await contexts.get("second")?.progress(3, 3);
			gates.get("second")?.resolve();
			expect((await second.response).result?.structuredContent).toEqual(outcome);
			expect(io.notifications).toEqual([
				expect.objectContaining({ params: { progressToken: 0, progress: 2, total: 3 } }),
				expect.objectContaining({ params: { progressToken: "one", progress: 1, total: 3 } }),
				expect.objectContaining({ params: { progressToken: 0, progress: 3, total: 3 } }),
			]);
		} finally {
			for (const gate of gates.values()) gate.resolve();
			await io.close();
		}
	});
	it("retires progress on cancellation even while the handler is still unwinding", async () => {
		const entered = Promise.withResolvers<AiProviderContext>();
		const gate = Promise.withResolvers<void>();
		const io = await connection(async (_args, context) => {
			entered.resolve(context);
			await gate.promise;
			return outcome;
		});
		try {
			const call = io.begin("cancel", { progressToken: "cancelled" });
			void call.response.catch(() => {});
			const context = await entered.promise;
			await context.progress(1);
			io.cancel(call.id);
			await expect.poll(() => context.signal.aborted).toBe(true);
			await expect(context.progress(2)).rejects.toThrow("ended");
			expect(io.notifications).toHaveLength(1);
			gate.resolve();
		} finally {
			gate.resolve();
			await io.close();
		}
	});
});
