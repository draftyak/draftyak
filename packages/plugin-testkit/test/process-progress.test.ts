import * as childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, lstatSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import * as pluginStdio from "@draftyak/protocol/plugin-stdio";
import { createPluginServer, defineAiProviderPlugin } from "@draftyak/sdk";
import { Client } from "@modelcontextprotocol/client";
import { parseJSONRPCMessage, type Transport } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { afterEach, expect, it, vi } from "vitest";
import { memoryHost } from "../../sdk/src/host.ts";
import { aiManifest } from "../../sdk/test/definitions-fixtures.ts";
import {
	bindProcessPlugin,
	createMockHub,
	type MockCallOptions,
	type MockProgressNotification,
} from "../src/index.ts";

vi.mock("node:child_process", async (original) => ({
	...(await original<typeof import("node:child_process")>()),
	spawn: vi.fn(),
}));

const roots = new Set<string>();
const cleanups: (() => Promise<void>)[] = [];
const temporary = realpathSync(tmpdir());
const args = { model: "test-model", system: "Instructions", prompt: "first", contextIds: [] };
const result = {
	kind: "unexpected" as const,
	stopReason: null,
	model: "test-model",
	fallback: false,
	usage: { input: 1, output: 1 },
};
type Context = { progress(value: number, total?: number): Promise<void>; signal: AbortSignal };

afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
	vi.restoreAllMocks();
	vi.mocked(childProcess.spawn).mockReset();
	for (const root of roots) {
		if (!existsSync(root)) continue;
		if (
			path.dirname(root) !== temporary ||
			!/^draftyak-(?:progress-proof|plugin)-/.test(path.basename(root)) ||
			lstatSync(root).isSymbolicLink() ||
			realpathSync(root) !== root
		)
			throw new Error("Progress fixture root changed");
		rmSync(root, { recursive: true, force: true });
	}
	roots.clear();
});

async function fixture(
	generate: (prompt: string, context: Context) => Promise<typeof result>,
	tailAfterResult?: unknown,
) {
	const source = realpathSync(mkdtempSync(path.join(temporary, "draftyak-progress-proof-")));
	roots.add(source);
	writeFileSync(path.join(source, "entry.mjs"), "export {};\n", { flag: "wx" });
	const entry = defineAiProviderPlugin({
		manifest: aiManifest,
		describe: () => ({ name: "Provider", structuredOutput: "validated" }),
		listModels: () => ({ models: [] }),
		probe: () => ({ status: "ok" }),
		generateDraft: (request, context) => generate(request.prompt, context),
	});
	const host = memoryHost(() => {
		throw new Error("Unexpected child host call");
	});
	const outputs = [new PassThrough(), new PassThrough()] as const;
	const received: unknown[] = [];
	const originalConnect = Client.prototype.connect;
	vi.spyOn(Client.prototype, "connect").mockImplementation(function (
		this: Client,
		...parameters: Parameters<Client["connect"]>
	) {
		const transport = parameters[0];
		let delivery: Transport["onmessage"];
		Object.defineProperty(transport, "onmessage", {
			configurable: true,
			get: () => delivery,
			set: (listener: Transport["onmessage"]) => {
				delivery =
					listener &&
					((message, extra) => {
						received.push(message);
						listener(message, extra);
					});
			},
		});
		return originalConnect.apply(this, parameters);
	});
	const wire = (message: unknown, tagged = false): void => {
		outputs[0].write(`${tagged ? "\u001e" : ""}${JSON.stringify(message)}\n`);
	};
	const peerReady = Promise.withResolvers<void>();
	const peer: Transport = {
		async start() {
			peerReady.resolve();
		},
		async send(message) {
			if (
				tailAfterResult &&
				"result" in message &&
				message.result &&
				typeof message.result === "object" &&
				"structuredContent" in message.result
			) {
				outputs[0].write(`${JSON.stringify(message)}\n${JSON.stringify(tailAfterResult)}\n`);
				tailAfterResult = undefined;
			} else wire(message);
		},
		async close() {
			peer.onclose?.();
		},
	};
	const server = serveStdio(createPluginServer(entry, host), { legacy: "reject", transport: peer });
	await peerReady.promise;
	const child = Object.assign(new EventEmitter(), {
		pid: 1,
		exitCode: null as number | null,
		signalCode: null as NodeJS.Signals | null,
		kill: vi.fn(() => {
			queueMicrotask(() => {
				child.exitCode = 0;
				child.emit("exit", 0, null);
			});
			return true;
		}),
	});
	vi.mocked(childProcess.spawn).mockImplementation((...parameters) => {
		roots.add(path.dirname((parameters[2] as { cwd: string }).cwd));
		return child as unknown as childProcess.ChildProcess;
	});
	const input = new Writable({
		write(chunk, _encoding, callback) {
			try {
				for (const line of String(chunk).trimEnd().split("\n"))
					if (!line.startsWith("\u001e")) peer.onmessage?.(parseJSONRPCMessage(JSON.parse(line)));
				callback();
			} catch (error) {
				callback(error as Error);
			}
		},
	});
	vi.spyOn(pluginStdio, "openPluginStdio").mockResolvedValue({
		kind: "pipe",
		stdio: ["pipe", "pipe", "pipe"],
		attach: () => ({
			input,
			outputs,
			completion: new Promise<pluginStdio.PluginStdioResult>(() => {}),
			destroy: async () => {
				input.destroy();
				for (const output of outputs) output.destroy();
			},
		}),
		destroy: async () => {},
	});
	const plugin = { manifest: aiManifest, entry };
	const bound = bindProcessPlugin(plugin, {
		directory: source,
		entry: "entry.mjs",
		files: ["entry.mjs"],
	});
	const hub = createMockHub({ mode: "process", plugin: bound, upstreams: [] });
	cleanups.push(async () => {
		await hub.close();
		await server.close();
		host.close();
	});
	return { hub, plugin, wire, received };
}

it("receives exact request progress through the actual driver and preserves client dispatch", async () => {
	const state = await fixture(async (_prompt, context) => {
		await context.progress(1, 2);
		await context.progress(2);
		return result;
	});
	for (const token of [0, "", "caller / exact"]) {
		const receipts: MockProgressNotification[] = [];
		const metadata = { progressToken: token };
		expect(
			(
				await state.hub.call("ai_draft_generate", args, metadata, {
					onProgress: (notification) => receipts.push(notification),
				})
			).structuredContent,
		).toEqual(result);
		expect(metadata).toEqual({ progressToken: token });
		expect(receipts).toEqual([
			{
				jsonrpc: "2.0",
				method: "notifications/progress",
				params: { progressToken: token, progress: 1, total: 2 },
			},
			{
				jsonrpc: "2.0",
				method: "notifications/progress",
				params: { progressToken: token, progress: 2 },
			},
		]);
		for (const receipt of receipts) expect(state.received).toContainEqual(receipt);
	}
});

it("preserves full valid receipt fields and isolates its frozen copy from actual dispatch", async () => {
	const gate = Promise.withResolvers<void>();
	const entered = Promise.withResolvers<void>();
	const state = await fixture(async () => {
		entered.resolve();
		await gate.promise;
		return result;
	});
	const receipts: MockProgressNotification[] = [];
	const call = state.hub.call(
		"ai_draft_generate",
		args,
		{ progressToken: "one" },
		{
			onProgress: (receipt) => {
				receipts.push(receipt);
				expect(Object.isFrozen(receipt)).toBe(true);
				expect(Object.isFrozen(receipt.params)).toBe(true);
				expect(() => {
					(receipt.params as { progress: number }).progress = 99;
				}).toThrow(TypeError);
			},
		},
	);
	try {
		await entered.promise;
		const notification = {
			jsonrpc: "2.0",
			method: "notifications/progress",
			params: { progressToken: "one", progress: 1, message: "actual wire detail" },
		};
		state.wire(notification);
		expect(receipts).toEqual([notification]);
		const dispatched = state.received.find(
			(message) => (message as { method?: string }).method === "notifications/progress",
		);
		expect(dispatched).toEqual(notification);
		expect(dispatched).not.toBe(receipts[0]);
	} finally {
		gate.resolve();
		await call;
	}
});

it("does not deliver wrong tokens, host frames, queued-call tokens or completed-call receipts", async () => {
	const entered = new Map<string, Context>();
	const firstGate = Promise.withResolvers<void>();
	const secondGate = Promise.withResolvers<void>();
	const state = await fixture(async (prompt, context) => {
		entered.set(prompt, context);
		await (prompt === "first" ? firstGate.promise : secondGate.promise);
		return result;
	});
	const firstReceipts: MockProgressNotification[] = [],
		secondReceipts: MockProgressNotification[] = [];
	const first = state.hub.call(
		"ai_draft_generate",
		args,
		{ progressToken: "one" },
		{ onProgress: (value) => firstReceipts.push(value) },
	);
	await expect.poll(() => entered.has("first")).toBe(true);
	const second = state.hub.call(
		"ai_draft_generate",
		{ ...args, prompt: "second" },
		{ progressToken: "two" },
		{ onProgress: (value) => secondReceipts.push(value) },
	);
	try {
		state.wire({
			jsonrpc: "2.0",
			method: "notifications/progress",
			params: { progressToken: "two", progress: 10 },
		});
		state.wire(
			{
				jsonrpc: "2.0",
				id: "host-progress",
				method: "host/progress",
				params: { token: "one", progress: 99 },
			},
			true,
		);
		expect(firstReceipts).toEqual([]);
		expect(secondReceipts).toEqual([]);
		await entered.get("first")?.progress(1);
		expect(firstReceipts).toHaveLength(1);
		expect(secondReceipts).toEqual([]);
		firstGate.resolve();
		await first;
		await expect.poll(() => entered.has("second")).toBe(true);
		state.wire({
			jsonrpc: "2.0",
			method: "notifications/progress",
			params: { progressToken: "one", progress: 20 },
		});
		await entered.get("second")?.progress(2);
		expect(firstReceipts).toHaveLength(1);
		expect(secondReceipts).toHaveLength(1);
		secondGate.resolve();
		await second;
		state.wire({
			jsonrpc: "2.0",
			method: "notifications/progress",
			params: { progressToken: "two", progress: 30 },
		});
		expect(secondReceipts).toHaveLength(1);
	} finally {
		firstGate.resolve();
		secondGate.resolve();
		await Promise.allSettled([first, second]);
	}
});

it("refuses invalid observer options and missing caller tokens before launch", async () => {
	const state = await fixture(async () => result);
	let getterCalls = 0;
	const accessor = Object.defineProperty({}, "onProgress", {
		get() {
			getterCalls++;
			return () => {};
		},
	});
	for (const options of [{ onProgress: 1 }, { unknown: true }, accessor])
		await expect(
			state.hub.call(
				"ai_draft_generate",
				args,
				{ progressToken: "one" },
				options as MockCallOptions,
			),
		).rejects.toMatchObject({ code: "PROCESS_PROGRESS_INVALID" });
	for (const metadata of [{}, { progressToken: null }, { progressToken: 1.5 }])
		await expect(
			state.hub.call("ai_draft_generate", args, metadata, { onProgress: () => {} }),
		).rejects.toMatchObject({ code: "PROCESS_PROGRESS_INVALID" });
	expect(getterCalls).toBe(0);
	expect(childProcess.spawn).not.toHaveBeenCalled();
	const memory = createMockHub({ mode: "in-memory", plugin: state.plugin, upstreams: [] });
	try {
		await expect(
			memory.call("ai_draft_generate", args, { progressToken: "one" }, { onProgress: () => {} }),
		).rejects.toMatchObject({ code: "PROCESS_PROGRESS_UNAVAILABLE" });
	} finally {
		await memory.close();
	}
});

it.each(["throw", "reject"] as const)(
	"fails closed on observer %s without losing ordinary private client dispatch",
	async (mode) => {
		const state = await fixture(async (_prompt, context) => {
			await context.progress(1);
			return result;
		});
		await expect(
			state.hub.call(
				"ai_draft_generate",
				args,
				{ progressToken: "one" },
				{
					onProgress: () => {
						if (mode === "reject") return Promise.reject(new Error("Controlled observer failure"));
						throw new Error("Controlled observer failure");
					},
				},
			),
		).rejects.toMatchObject({ code: "PROCESS_PROGRESS_OBSERVER_FAILED" });
		expect(state.received).toContainEqual({
			jsonrpc: "2.0",
			method: "notifications/progress",
			params: { progressToken: "one", progress: 1 },
		});
	},
);

it("retires receipt observation before late progress in the same final-reply stdout chunk", async () => {
	const late = {
		jsonrpc: "2.0",
		method: "notifications/progress",
		params: { progressToken: "same-chunk", progress: 99 },
	};
	const state = await fixture(async (_prompt, context) => {
		await context.progress(1);
		return result;
	}, late);
	const receipts: MockProgressNotification[] = [];
	expect(
		(
			await state.hub.call(
				"ai_draft_generate",
				args,
				{ progressToken: "same-chunk" },
				{ onProgress: (value) => receipts.push(value) },
			)
		).structuredContent,
	).toEqual(result);
	expect(receipts).toEqual([
		{
			jsonrpc: "2.0",
			method: "notifications/progress",
			params: { progressToken: "same-chunk", progress: 1 },
		},
	]);
});

it("keeps ordinary calls unchanged when no observer is requested", async () => {
	const state = await fixture(async (_prompt, context) => {
		await context.progress(1);
		return result;
	});
	expect((await state.hub.call("ai_draft_generate", args)).structuredContent).toEqual(result);
	expect(
		(await state.hub.call("ai_draft_generate", args, { progressToken: "unobserved" }))
			.structuredContent,
	).toEqual(result);
});
