import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import { HOST_MAX_FRAME_BYTES } from "@draftyak/protocol/host-channel";
import { TOOL_ERROR_META_KEY } from "@draftyak/protocol/tool-v1";
import {
	type JSONRPCMessage,
	parseJSONRPCMessage,
	type Transport,
} from "@modelcontextprotocol/server";
import { describe, expect, it, vi } from "vitest";
import * as z from "zod";
import { checkedTool } from "../src/definitions.ts";
import { HostError, memoryHost } from "../src/host.ts";
import { type PluginEntry, type PluginTool, serve } from "../src/serve.ts";
import { stdioHost } from "../src/stdio.ts";

const meta = {
	"io.modelcontextprotocol/protocolVersion": "2026-07-28",
	"io.modelcontextprotocol/clientCapabilities": {},
};
const channel = "io.github.draftyak/channel";
const internalError = { code: -32603, message: "Internal error" };
interface Reply {
	readonly result?: Record<string, unknown>;
	readonly error?: unknown;
}

function entry(tools: readonly PluginTool[], extension = channel): PluginEntry {
	return {
		name: "frame-fixture",
		version: "1.0.0",
		plugin: "frame-fixture",
		extensions: { [extension]: {} },
		tools,
	};
}
function fill(size: () => number): PluginTool {
	return { name: "fixture_fill", handler: () => ({ data: "x".repeat(size()) }) };
}
function within<T>(promise: Promise<T>): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	return Promise.race([
		promise,
		new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new Error("No reply")), 5000);
		}),
	]).finally(() => clearTimeout(timer));
}
function codes(errors: readonly Error[]): string[] {
	return errors.map((error) => (error instanceof HostError ? error.code : error.message));
}

/** The parent side of an in-process stdio channel: one request at a time, each reply line whole. */
function stdioPeer(definition: PluginEntry, report: (error: Error) => void = () => {}) {
	const input = new PassThrough();
	const output = new PassThrough();
	const lines = createInterface({ input: output, crlfDelay: Number.POSITIVE_INFINITY });
	const replies = lines[Symbol.asyncIterator]();
	const errors: Error[] = [];
	const host = stdioHost({ input, output });
	const handle = serve(definition, {
		host,
		onerror: (error) => {
			errors.push(error);
			report(error);
		},
	});
	let id = 0;
	return {
		errors,
		async ask(
			method: string,
			params: Record<string, unknown> = {},
		): Promise<{ line: string; reply: Reply }> {
			input.write(
				`${JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params: { ...params, _meta: meta } })}\n`,
			);
			const next = await within(replies.next());
			if (next.done) throw new Error("Channel closed");
			const line = String(next.value);
			return { line, reply: JSON.parse(line) as Reply };
		},
		async close() {
			await handle.close();
			host.close();
			lines.close();
			input.destroy();
			output.destroy();
		},
	};
}

/** Serves over an MCP transport that refuses chosen messages, as the tagged channel's writer can. */
function refusingPeer(definition: PluginEntry, refuse: (message: JSONRPCMessage) => unknown) {
	const sent: JSONRPCMessage[] = [];
	const errors: Error[] = [];
	const transport: Transport = {
		async start() {},
		async send(message) {
			const refusal = refuse(message);
			if (refusal !== undefined) throw refusal;
			sent.push(message);
		},
		async close() {
			transport.onclose?.();
		},
	};
	const memory = memoryHost(() => {
		throw new Error("Unexpected host request");
	});
	const handle = serve(definition, {
		host: { ...memory, transport },
		onerror: (error) => errors.push(error),
	});
	let id = 0;
	return {
		sent,
		errors,
		request(method: string, params: Record<string, unknown> = {}): number {
			transport.onmessage?.(
				parseJSONRPCMessage({
					jsonrpc: "2.0",
					id: ++id,
					method,
					params: { ...params, _meta: { ...meta, ...(params._meta as object) } },
				}),
			);
			return id;
		},
		replies: (request: number) =>
			sent.filter((message) => "id" in message && message.id === request && !("method" in message)),
		async close() {
			await handle.close();
			memory.close();
		},
	};
}
const isReply = (message: JSONRPCMessage): boolean => "id" in message && !("method" in message);

describe("reply frames", () => {
	it.each([
		["channel", channel, { structuredContent: { code: "TRANSIENT" } }],
		[
			"tool",
			"io.github.draftyak/tool",
			{ _meta: { [TOOL_ERROR_META_KEY]: { code: "TRANSIENT" } } },
		],
	])(
		"delivers a %s result whose reply fills the frame and refuses one more byte at once",
		async (_kind, extension, refusal) => {
			let size = 0;
			const peer = stdioPeer(entry([fill(() => size)], extension));
			try {
				const call = () => peer.ask("tools/call", { name: "fixture_fill", arguments: {} });
				const empty = await call();
				size = HOST_MAX_FRAME_BYTES - Buffer.byteLength(empty.line);
				const full = await call();
				expect(Buffer.byteLength(full.line)).toBe(HOST_MAX_FRAME_BYTES);
				expect(full.reply.result?.structuredContent).toEqual({ data: "x".repeat(size) });
				expect(full.reply.result?.content).toEqual([
					{ type: "text", text: "Result in structuredContent." },
				]);
				size++;
				const over = await call();
				expect(over.reply.result).toMatchObject({ isError: true, ...refusal });
				expect(Buffer.byteLength(over.line)).toBeLessThan(1024);
				expect(peer.errors).toEqual([]);
			} finally {
				await peer.close();
			}
		},
	);

	it("delivers checked results in the range that used to vanish and refuses at once those the frame cannot hold", async () => {
		let size = 0;
		const contract = {
			description: "Frame fixture",
			input: z.strictObject({}),
			output: z.strictObject({ data: z.string() }),
		};
		const peer = stdioPeer(
			entry([checkedTool("fixture_checked", contract, () => ({ data: "x".repeat(size) }))]),
		);
		const wrapper = Buffer.byteLength('{"data":""}');
		try {
			// Request ids stay single-digit, so every reply envelope has the same length.
			const call = () => peer.ask("tools/call", { name: "fixture_checked", arguments: {} });
			const largest = HOST_MAX_FRAME_BYTES - Buffer.byteLength((await call()).line) + wrapper;
			// 611,958 bytes: seven 64 KiB inline bodies in one reconcile result.
			for (const bytes of [524_289, 611_958, 1_000_000, largest]) {
				size = bytes - wrapper;
				expect((await call()).reply.result?.structuredContent).toEqual({ data: "x".repeat(size) });
			}
			// Up to the definition's 1 MiB cap: accepted there, refused only by the reply frame.
			for (const bytes of [largest + 1, 1_048_575, 1_048_576]) {
				size = bytes - wrapper;
				const refused = await call();
				expect(refused.reply.result).toMatchObject({
					isError: true,
					structuredContent: { code: "TRANSIENT" },
				});
				expect(Buffer.byteLength(refused.line)).toBeLessThan(1024);
			}
			expect(peer.errors).toEqual([]);
		} finally {
			await peer.close();
		}
	});

	it("measures escaped and multi-byte text exactly at the frame boundary", async () => {
		// A quote, a backslash and a control character are escaped; the rest take 2, 3 and 4 bytes.
		const unit = `${String.fromCharCode(34, 92, 1)}é€😀`;
		const cost = Buffer.byteLength(JSON.stringify(unit)) - 2;
		let data = "";
		const peer = stdioPeer(entry([{ name: "fixture_text", handler: () => ({ data }) }]));
		try {
			const call = () => peer.ask("tools/call", { name: "fixture_text", arguments: {} });
			const room = HOST_MAX_FRAME_BYTES - Buffer.byteLength((await call()).line);
			data = unit.repeat(Math.floor(room / cost)) + "x".repeat(room % cost);
			const full = await call();
			expect(Buffer.byteLength(full.line)).toBe(HOST_MAX_FRAME_BYTES);
			expect(full.reply.result?.structuredContent).toEqual({ data });
			data += "x";
			expect((await call()).reply.result).toMatchObject({
				isError: true,
				structuredContent: { code: "TRANSIENT" },
			});
			expect(peer.errors).toEqual([]);
		} finally {
			await peer.close();
		}
	});

	it.each([
		["oversized", "d".repeat(HOST_MAX_FRAME_BYTES), "TOO_LARGE"],
		["unencodable", "lone \ud800 surrogate", "BAD_REQUEST"],
	])(
		"answers an %s list reply with a small error and keeps serving",
		async (_kind, description, code) => {
			const peer = stdioPeer(
				entry([{ name: "fixture_listed", description, handler: () => ({ listed: true }) }]),
			);
			try {
				const listed = await peer.ask("tools/list");
				expect(listed.reply).toEqual({ jsonrpc: "2.0", id: 1, error: internalError });
				expect(codes(peer.errors)).toEqual([code]);
				const called = await peer.ask("tools/call", { name: "fixture_listed", arguments: {} });
				expect(called.reply.result?.structuredContent).toEqual({ listed: true });
			} finally {
				await peer.close();
			}
		},
	);

	it("still answers a refused reply when the error reporter throws", async () => {
		const peer = stdioPeer(
			entry([
				{
					name: "fixture_listed",
					description: "d".repeat(HOST_MAX_FRAME_BYTES),
					handler: () => ({}),
				},
			]),
			() => {
				throw new Error("DYTEST-reporter");
			},
		);
		try {
			expect((await peer.ask("tools/list")).reply.error).toEqual(internalError);
			expect(codes(peer.errors)).toEqual(["TOO_LARGE"]);
		} finally {
			await peer.close();
		}
	});

	it.each([
		["result", new HostError("TOO_LARGE"), "fixture_fill", "TOO_LARGE"],
		["result", new HostError("BAD_REQUEST"), "fixture_fill", "BAD_REQUEST"],
		["result", new HostError("DENIED"), "fixture_fill", "DENIED"],
		["result", "DYTEST-refusal", "fixture_fill", "DYTEST-refusal"],
		["error", new HostError("TOO_LARGE"), "fixture_missing", "TOO_LARGE"],
	])(
		"reports a refused %s reply and answers its request once (%s)",
		async (kind, refusal, name, reported) => {
			let refused = false;
			const peer = refusingPeer(entry([fill(() => 1)]), (message) => {
				if (refused || !isReply(message)) return undefined;
				refused = true;
				return kind in message ? refusal : new Error("Unexpected reply kind");
			});
			try {
				const request = peer.request("tools/call", { name, arguments: {} });
				await vi.waitFor(() => expect(peer.replies(request)).toHaveLength(1));
				expect(peer.replies(request)).toEqual([
					{ jsonrpc: "2.0", id: request, error: internalError },
				]);
				expect(codes(peer.errors)).toEqual([reported]);
			} finally {
				await peer.close();
			}
		},
	);

	it("tries one replacement for a reply the channel keeps refusing", async () => {
		const attempts: JSONRPCMessage[] = [];
		const peer = refusingPeer(entry([fill(() => 1)]), (message) => {
			if (!isReply(message)) return undefined;
			attempts.push(message);
			return new HostError("DENIED");
		});
		try {
			peer.request("tools/call", { name: "fixture_fill", arguments: {} });
			await vi.waitFor(() => expect(attempts).toHaveLength(2));
			await new Promise((resolve) => setTimeout(resolve, 50));
			expect(attempts).toHaveLength(2);
			expect(attempts[1]).toMatchObject({ error: internalError });
			expect(codes(peer.errors)).toEqual(["DENIED"]);
			expect(peer.sent).toEqual([]);
		} finally {
			await peer.close();
		}
	});

	it("leaves a refused notification to its sender instead of answering it", async () => {
		const outcome = Promise.withResolvers<unknown>();
		const peer = refusingPeer(
			entry(
				[
					{
						name: "ai_draft_generate",
						handler: async (_args, _context, _metadata, request) => {
							await request?.progress(1).then(
								() => outcome.resolve("sent"),
								(error: unknown) => outcome.resolve(error),
							);
							return { done: true };
						},
					},
				],
				"io.github.draftyak/ai-provider",
			),
			(message) => (isReply(message) ? undefined : new HostError("TOO_LARGE")),
		);
		try {
			const request = peer.request("tools/call", {
				name: "ai_draft_generate",
				arguments: {},
				_meta: { progressToken: "DYTEST-progress" },
			});
			expect(await within(outcome.promise)).toMatchObject({ code: "TOO_LARGE" });
			await vi.waitFor(() => expect(peer.replies(request)).toHaveLength(1));
			expect(peer.replies(request)[0]).toMatchObject({
				result: { structuredContent: { done: true } },
			});
			expect(peer.sent).toHaveLength(1);
			expect(peer.errors).toEqual([]);
		} finally {
			await peer.close();
		}
	});
});
