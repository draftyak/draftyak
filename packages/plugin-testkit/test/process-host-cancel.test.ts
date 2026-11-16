import * as childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, lstatSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import {
	HOST_FRAME_TAG,
	HOST_MAX_ACTIVE_REQUESTS,
	type HostNotification,
} from "@draftyak/protocol/host-channel";
import * as pluginStdio from "@draftyak/protocol/plugin-stdio";
import { createPluginServer, HostError, memoryHost } from "@draftyak/sdk";
import { parseJSONRPCMessage, type Transport } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { afterEach, expect, it, vi } from "vitest";
import { bindProcessPlugin, createProcess } from "../src/process.ts";
import type { MockHost } from "../src/types.ts";
import { channelFixture } from "./fixtures/channel/plugin.ts";

vi.mock("node:child_process", async (original) => ({
	...(await original<typeof import("node:child_process")>()),
	spawn: vi.fn(),
}));

const roots = new Set<string>();
const cleanups: (() => Promise<void>)[] = [];
const temporary = realpathSync(tmpdir());

afterEach(async () => {
	vi.useRealTimers();
	for (const cleanup of cleanups.splice(0)) await cleanup();
	vi.restoreAllMocks();
	vi.mocked(childProcess.spawn).mockReset();
	for (const root of roots) {
		if (!existsSync(root)) continue;
		if (
			path.dirname(root) !== temporary ||
			!/^draftyak-(?:host-cancel-proof|plugin)-/.test(path.basename(root)) ||
			lstatSync(root).isSymbolicLink() ||
			realpathSync(root) !== root
		)
			throw new Error("Host cancellation fixture root changed");
		rmSync(root, { recursive: true, force: true });
	}
	roots.clear();
});

interface ParentRequest {
	readonly signal: AbortSignal;
	resolve(value: unknown): void;
	reject(error: unknown): void;
}

/** A raw child writes host frames while one tool call runs; the test settles each parent request. */
async function fixture(fakeClock = false) {
	const source = realpathSync(mkdtempSync(path.join(temporary, "draftyak-host-cancel-proof-")));
	roots.add(source);
	writeFileSync(path.join(source, "entry.mjs"), "export {};\n", { flag: "wx" });
	const entered = Promise.withResolvers<void>();
	const finish = Promise.withResolvers<void>();
	const plugin = channelFixture(async () => {
		entered.resolve();
		await finish.promise;
		return { finished: true };
	});
	// Parent requests are keyed by the fetch URL path or kv key, which carry the child's request ID.
	const requests = new Map<string, ParentRequest>();
	let listener: ((notification: HostNotification) => void) | undefined;
	const host = {
		request(
			method: string,
			params: { url?: string; key?: string },
			options?: { signal?: AbortSignal },
		) {
			if (!options?.signal) throw new Error("Parent cancellation signal missing");
			const name =
				method === "host/fetch" ? new URL(params.url ?? "").pathname.slice(1) : (params.key ?? "");
			const settle = Promise.withResolvers<unknown>();
			requests.set(name, {
				signal: options.signal,
				resolve: settle.resolve,
				reject: settle.reject,
			});
			return settle.promise;
		},
		subscribe(next: (notification: HostNotification) => void) {
			listener = next;
			return () => {
				listener = undefined;
			};
		},
		close() {},
	} as unknown as MockHost;
	const outputs = [new PassThrough(), new PassThrough()] as const;
	const frames: Record<string, unknown>[] = [];
	const peerReady = Promise.withResolvers<void>();
	const peer: Transport = {
		async start() {
			peerReady.resolve();
		},
		async send(message) {
			outputs[0].write(`${JSON.stringify(message)}\n`);
		},
		async close() {
			peer.onclose?.();
		},
	};
	const pluginHost = memoryHost(() => {
		throw new Error("Unexpected plugin host call");
	});
	const server = serveStdio(createPluginServer(plugin.entry, pluginHost), {
		legacy: "reject",
		transport: peer,
	});
	await peerReady.promise;
	const input = new Writable({
		write(chunk, _encoding, callback) {
			try {
				for (const line of String(chunk).trimEnd().split("\n"))
					if (line.startsWith(HOST_FRAME_TAG)) frames.push(JSON.parse(line.slice(1)));
					else peer.onmessage?.(parseJSONRPCMessage(JSON.parse(line)));
				callback();
			} catch (error) {
				callback(error as Error);
			}
		},
	});
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
	const adapter = createProcess(
		bindProcessPlugin(plugin, { directory: source, entry: "entry.mjs", files: ["entry.mjs"] }),
		host,
		{ plugin: "host-cancel-proof", instance: "one" },
	);
	cleanups.push(async () => {
		finish.resolve();
		await adapter.close();
		await server.close();
		pluginHost.close();
	});
	await adapter.request("server/discover");
	if (fakeClock) vi.useFakeTimers();
	let outcome: unknown;
	const call = adapter.request("tools/call", { name: "channel_fetch", arguments: { url: "held" } });
	void call.then(
		(value) => {
			outcome = value;
		},
		(error: unknown) => {
			outcome = error;
		},
	);
	await entered.promise;
	return {
		call,
		outcome: () => outcome,
		requests,
		frames,
		finish: () => finish.resolve(),
		send(frame: unknown): void {
			outputs[0].write(`${HOST_FRAME_TAG}${JSON.stringify(frame)}\n`);
		},
		notify(notification: HostNotification): void {
			listener?.(notification);
		},
	};
}

const fetchFrame = (id: string) => ({
	jsonrpc: "2.0",
	id,
	method: "host/fetch",
	params: { method: "GET", url: `https://stream.invalid/${id}`, headers: [] },
});
const kvFrame = (id: string) => ({
	jsonrpc: "2.0",
	id,
	method: "host/kv.get",
	params: { key: id },
});
const cancelFrame = (requestId: string) => ({
	jsonrpc: "2.0",
	method: "host/cancel",
	params: { requestId },
});
// Polls quickly for in-process stream delivery and allows slow shared runners.
const until = <T>(check: () => T) => expect.poll(check, { interval: 5, timeout: 5_000 });
const header = (streamId: string) => ({ status: 200, headers: [], streamId });
const terminal = (streamId: string): HostNotification => ({
	jsonrpc: "2.0",
	method: "host/stream.chunk",
	params: { streamId, sequence: 0, base64: "", done: true },
});

it("writes no reply for a cancelled request when the host later resolves or rejects it", async () => {
	const f = await fixture();
	for (const id of ["resolved", "rejected", "answered"]) f.send(kvFrame(id));
	await until(() => f.requests.size).toBe(3);
	f.send(cancelFrame("resolved"));
	f.send(cancelFrame("rejected"));
	await until(() => f.requests.get("rejected")?.signal.aborted).toBe(true);
	expect(f.requests.get("resolved")?.signal.reason).toMatchObject({ code: "DENIED" });
	expect(f.requests.get("answered")?.signal.aborted).toBe(false);
	f.requests.get("resolved")?.resolve({ value: "late" });
	f.requests.get("rejected")?.reject(new HostError("BAD_REQUEST"));
	f.requests.get("answered")?.resolve({ value: "kept" });
	await until(() => f.frames.length).toBe(1);
	f.finish();
	expect((await f.call).structuredContent).toEqual({ finished: true });
	expect(f.frames).toEqual([{ jsonrpc: "2.0", id: "answered", result: { value: "kept" } }]);
});

it("keeps a streamed request's original signal until its terminal chunk or the end of its call", async () => {
	const f = await fixture();
	f.send(fetchFrame("finished"));
	f.send(fetchFrame("open"));
	await until(() => f.requests.size).toBe(2);
	f.requests.get("finished")?.resolve(header("finished-stream"));
	f.requests.get("open")?.resolve(header("open-stream"));
	await until(() => f.frames.length).toBe(2);
	f.notify(terminal("finished-stream"));
	expect(f.frames.at(-1)).toEqual(terminal("finished-stream"));
	expect(f.requests.get("open")?.signal.aborted).toBe(false);
	f.finish();
	expect((await f.call).structuredContent).toEqual({ finished: true });
	expect(f.requests.get("finished")?.signal.aborted).toBe(false);
	expect(f.requests.get("open")?.signal.reason).toMatchObject({ code: "DENIED" });
});

it("aborts pending and streaming host work when the enclosing call reaches its original deadline", async () => {
	const f = await fixture(true);
	f.send(fetchFrame("pending"));
	f.send(fetchFrame("streaming"));
	await vi.advanceTimersByTimeAsync(0);
	expect(f.requests.size).toBe(2);
	f.requests.get("streaming")?.resolve(header("held"));
	await vi.advanceTimersByTimeAsync(0);
	expect(f.frames).toHaveLength(1);
	await vi.advanceTimersByTimeAsync(29_999);
	expect(f.requests.get("pending")?.signal.aborted).toBe(false);
	expect(f.requests.get("streaming")?.signal.aborted).toBe(false);
	await vi.advanceTimersByTimeAsync(1);
	expect(f.outcome()).toMatchObject({ code: "PROCESS_REQUEST_TIMEOUT" });
	expect(f.requests.get("pending")?.signal.aborted).toBe(true);
	expect(f.requests.get("streaming")?.signal.aborted).toBe(true);
});

it("closes the process without replying when the host reuses a live stream ID", async () => {
	const f = await fixture();
	f.send(fetchFrame("first"));
	f.send(fetchFrame("second"));
	await until(() => f.requests.size).toBe(2);
	f.requests.get("first")?.resolve(header("shared"));
	await until(() => f.frames.length).toBe(1);
	f.requests.get("second")?.resolve(header("shared"));
	await until(() => f.outcome()).toMatchObject({ code: "PROCESS_CLOSED" });
	expect(f.frames).toEqual([{ jsonrpc: "2.0", id: "first", result: header("shared") }]);
	expect(f.requests.get("first")?.signal.aborted).toBe(true);
});

it("closes the process without forwarding an invalid host notification", async () => {
	const f = await fixture();
	f.send(fetchFrame("open"));
	await until(() => f.requests.size).toBe(1);
	f.notify({ jsonrpc: "2.0", method: "host/unknown", params: {} } as unknown as HostNotification);
	await until(() => f.outcome()).toMatchObject({ code: "PROCESS_CLOSED" });
	expect(f.frames).toEqual([]);
	expect(f.requests.get("open")?.signal.aborted).toBe(true);
});

it("keeps the process open when seventeen cancelled streams finish while another fetch is pending", async () => {
	const f = await fixture();
	f.send(fetchFrame("pending"));
	for (let index = 0; index <= HOST_MAX_ACTIVE_REQUESTS; index++) {
		const id = `cancelled-${index}`;
		f.send(fetchFrame(id));
		await until(() => f.requests.has(id)).toBe(true);
		f.requests.get(id)?.resolve(header(`stream-${index}`));
		await until(() => f.frames.length).toBe(index + 1);
		f.send(cancelFrame(id));
		await until(() => f.requests.get(id)?.signal.aborted).toBe(true);
		// Write callbacks run on a later turn; then the cancelled record releases its capacity.
		await new Promise((resolve) => setImmediate(resolve));
	}
	// The host ignored each cancellation, so every terminal arrives after its record retired.
	for (let index = 0; index <= HOST_MAX_ACTIVE_REQUESTS; index++)
		f.notify(terminal(`stream-${index}`));
	f.requests.get("pending")?.resolve(header("pending-stream"));
	await until(() => f.frames.length).toBe(2 * (HOST_MAX_ACTIVE_REQUESTS + 1) + 1);
	f.finish();
	expect((await f.call).structuredContent).toEqual({ finished: true });
});

it("records at most sixteen early terminal IDs, so a header past the bound stays connected", async () => {
	const f = await fixture();
	f.send(fetchFrame("recorded"));
	f.send(fetchFrame("skipped"));
	await until(() => f.requests.size).toBe(2);
	for (let index = 0; index <= HOST_MAX_ACTIVE_REQUESTS; index++)
		f.notify(terminal(`early-${index}`));
	f.requests.get("recorded")?.resolve(header("early-0"));
	f.requests.get("skipped")?.resolve(header(`early-${HOST_MAX_ACTIVE_REQUESTS}`));
	await until(() => f.frames.length).toBe(HOST_MAX_ACTIVE_REQUESTS + 3);
	f.finish();
	expect((await f.call).structuredContent).toEqual({ finished: true });
	expect(f.requests.get("recorded")?.signal.aborted).toBe(false);
	expect(f.requests.get("skipped")?.signal.reason).toMatchObject({ code: "DENIED" });
});
