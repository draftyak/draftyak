import { lstat, mkdir, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { HostNotification } from "@draftyak/protocol/host-channel";
import { type HostChannel, memoryHost } from "@draftyak/sdk";
import { build } from "tsdown";
import { afterAll, beforeAll, expect, it } from "vitest";
import { bindProcessPlugin, createProcess } from "../src/process.ts";
import type { MockHost } from "../src/types.ts";
import { channelFixture } from "./fixtures/channel/plugin.ts";

const temporary = await realpath(tmpdir());
const root = await realpath(await mkdtemp(path.join(temporary, "draftyak-stream-cancel-")));
const directory = path.join(root, "plugin");
beforeAll(async () => {
	await mkdir(directory);
	await build({
		config: false,
		entry: {
			server: fileURLToPath(new URL("./fixtures/stdio-stream-cancel/server.ts", import.meta.url)),
		},
		outDir: directory,
		platform: "node",
		format: "esm",
		target: "node26",
		fixedExtension: true,
		deps: { alwaysBundle: [/.*/] },
		dts: false,
		sourcemap: false,
		clean: false,
		exports: false,
		report: false,
		logLevel: "warn",
		failOnWarn: true,
	});
	if ((await readdir(directory)).join() !== "server.mjs")
		throw new Error("Synthetic bundle closure changed");
});
afterAll(async () => {
	if (
		path.dirname(root) !== temporary ||
		!path.basename(root).startsWith("draftyak-stream-cancel-") ||
		(await lstat(root)).isSymbolicLink() ||
		(await realpath(root)) !== root
	)
		throw new Error("Synthetic cleanup root changed");
	await rm(root, { recursive: true, force: true });
});

async function fixture(parent: { readonly holdRequests?: boolean } = {}) {
	const originals = new Map<string, AbortSignal>();
	const aborts = new Map<string, number>();
	const disposals = new Map<string, number>();
	const held = new Map<string, ReadableStreamDefaultReader<Uint8Array>>();
	const producers = new Map<string, ReadableStreamDefaultController<Uint8Array>>();
	// Fetches reaching the parent host, memory handlers that ignore cancellation, and a gate that
	// keeps the parent host's own request promises unsettled after cancellation.
	const requested: string[] = [];
	const ignored: { readonly signal: AbortSignal; readonly release: () => void }[] = [];
	const gate = Promise.withResolvers<void>();
	const empty = { status: 200, headers: [], body: { base64: "" } };
	const release = (): void => {
		gate.resolve();
		for (const handler of ignored) handler.release();
	};
	let base: ReturnType<typeof memoryHost>;
	const terminal = (name: string): HostNotification => ({
		jsonrpc: "2.0",
		method: "host/stream.chunk",
		params: { streamId: name, sequence: 1, base64: "", done: true },
	});
	base = memoryHost(async (method, params, handlerSignal) => {
		if (method === "host/log") {
			if ((params as { message: string }).message === "release-sibling") {
				producers.get("sibling")?.close();
				if (!(await held.get("sibling")?.read())?.done) throw new Error("Synthetic EOF missing");
				base.notify(terminal("sibling"));
			}
			return null;
		}
		if (method !== "host/fetch") throw new Error("Synthetic host method refused");
		const name = new URL((params as { url: string }).url).pathname.slice(1);
		if (name === "over" || name === "after") return empty;
		if (name.startsWith("held-")) {
			const settle = Promise.withResolvers<typeof empty>();
			ignored.push({ signal: handlerSignal, release: () => settle.resolve(empty) });
			return settle.promise;
		}
		const signal = originals.get(name);
		if (!signal) throw new Error("Original parent signal missing");
		aborts.set(name, 0);
		const reader = new ReadableStream<Uint8Array>({
			start(controller) {
				producers.set(name, controller);
				if (name === "first" || name === "sibling")
					controller.enqueue(Buffer.from(name === "first" ? "a" : "b"));
			},
			cancel() {
				disposals.set(name, (disposals.get(name) ?? 0) + 1);
			},
		}).getReader();
		held.set(name, reader);
		signal.addEventListener(
			"abort",
			() => {
				aborts.set(name, (aborts.get(name) ?? 0) + 1);
				void reader.cancel();
			},
			{ once: true },
		);
		if (name === "pending")
			return new Promise<never>((_resolve, reject) =>
				signal.addEventListener("abort", () => reject(new Error("Synthetic cancellation")), {
					once: true,
				}),
			);
		// Intentionally precedes the header to exercise the existing same-read correlation contract.
		if (name !== "deadline") {
			const chunk = await reader.read();
			if (chunk.done) throw new Error("Synthetic held data missing");
			base.notify({
				jsonrpc: "2.0",
				method: "host/stream.chunk",
				params: {
					streamId: name,
					sequence: 0,
					base64: Buffer.from(chunk.value).toString("base64url"),
					done: false,
				},
			});
		}
		return { status: 200, headers: [], streamId: name };
	});
	// memoryHost's handler signal is RPC-scoped. The stream producer deliberately owns the
	// ORIGINAL request-options signal supplied by the public process adapter, not that inner signal.
	const host: HostChannel = {
		...base,
		request(method, params, options) {
			if (method === "host/fetch") {
				if (!options?.signal) throw new Error("Parent cancellation signal missing");
				const name = new URL((params as { url: string }).url).pathname.slice(1);
				originals.set(name, options.signal);
				requested.push(name);
				if (parent.holdRequests && name.startsWith("held-"))
					return gate.promise.then(() => empty as never);
			}
			return base.request(method, params, options);
		},
	};
	const process = createProcess(
		bindProcessPlugin(channelFixture(), { directory, entry: "server.mjs", files: ["server.mjs"] }),
		host as MockHost,
		{ plugin: "synthetic-stream", instance: "one" },
	);
	try {
		await process.request("server/discover");
		return {
			process,
			originals,
			aborts,
			disposals,
			requested,
			ignored,
			release,
			async close() {
				release();
				await process.close();
				base.close();
				for (const reader of held.values()) await reader.cancel();
			},
		};
	} catch (error) {
		release();
		await process.close();
		base.close();
		throw error;
	}
}
const callTool = (f: Awaited<ReturnType<typeof fixture>>, url: string) =>
	f.process.request("tools/call", { name: "channel_fetch", arguments: { url } });
it("carries actual child body cancellation to only the original parent-owned signal after headers", async () => {
	const f = await fixture();
	try {
		const result = await f.process.request("tools/call", {
			name: "channel_fetch",
			arguments: { url: "stream" },
		});
		expect(result.structuredContent).toEqual({ first: "a", sibling: "b" });
		expect([...f.aborts]).toEqual([
			["first", 1],
			["sibling", 0],
		]);
		expect(f.disposals.get("first")).toBe(1);
		expect(f.originals.get("sibling")?.aborted).toBe(false);
	} finally {
		await f.close();
	}
}, 30_000);
it("carries pending child cancellation to the original parent signal without killing the next host call", async () => {
	const f = await fixture();
	try {
		const result = await f.process.request("tools/call", {
			name: "channel_fetch",
			arguments: { url: "pending" },
		});
		expect(result.structuredContent).toEqual({ code: "DENIED" });
		expect(f.aborts.get("pending")).toBe(1);
		expect(f.disposals.get("pending")).toBe(1);
	} finally {
		await f.close();
	}
}, 30_000);
it("propagates an earlier child deadline after the streamed header instead of waiting thirty seconds", async () => {
	const f = await fixture();
	try {
		const result = await f.process.request("tools/call", {
			name: "channel_fetch",
			arguments: { url: "deadline" },
		});
		expect(result.structuredContent).toEqual({ deadline: true });
		expect(f.aborts.get("deadline")).toBe(1);
		expect(f.disposals.get("deadline")).toBe(1);
	} finally {
		await f.close();
	}
}, 30_000);
it("keeps cancelled memory-host work counted until handlers that ignore cancellation settle", async () => {
	const f = await fixture();
	try {
		const result = await callTool(f, "cycle");
		expect(result.structuredContent).toEqual({ cancelled: ["DENIED"], over: "TOO_LARGE" });
		expect(f.ignored).toHaveLength(16);
		expect(f.ignored.every(({ signal }) => signal.aborted)).toBe(true);
		// The process adapter admitted the request; the memory host refused it.
		expect(f.requested.filter((name) => name === "over")).toHaveLength(1);
		f.release();
		expect((await callTool(f, "after")).structuredContent).toEqual({ after: "SUCCESS" });
	} finally {
		await f.close();
	}
}, 30_000);
it("refuses with TOO_LARGE while cancelled requests still hold the process adapter's capacity", async () => {
	const f = await fixture({ holdRequests: true });
	try {
		const result = await callTool(f, "cycle");
		expect(result.structuredContent).toEqual({ cancelled: ["DENIED"], over: "TOO_LARGE" });
		expect(f.requested.filter((name) => name.startsWith("held-"))).toHaveLength(16);
		expect(f.requested).not.toContain("over");
		expect(f.originals.get("held-15")?.aborted).toBe(true);
		f.release();
		expect((await callTool(f, "after")).structuredContent).toEqual({ after: "SUCCESS" });
	} finally {
		await f.close();
	}
}, 30_000);
it("closes the process when a raw child exceeds sixteen active uncancelled requests", async () => {
	const f = await fixture();
	try {
		await expect(callTool(f, "flood")).rejects.toMatchObject({ code: "PROCESS_FRAME_INVALID" });
		expect(f.requested.filter((name) => name.startsWith("held-flood-"))).toHaveLength(16);
	} finally {
		await f.close();
	}
}, 30_000);
