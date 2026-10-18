import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import { specTypeSchemas } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import { type Frame, wireProblems } from "./session.ts";

interface Permission {
	has(scope: string, reference?: string): boolean;
	drop(scope: string, reference?: string): void;
}

type Proc = EventEmitter & { send: (message: unknown) => void };

interface Host {
	notify(method: string, params: object): void;
	request(method: string, params: object, signal?: AbortSignal): Promise<unknown>;
}

interface Shim {
	guardStdio(
		log: (level: string, message: string) => void,
		onProblem: (text: string) => void,
	): (frame: string) => boolean;
	loaderProblem(message: string): boolean;
	createMcpServer(options: {
		info: { name: string; version: string };
		tools: object[];
		callTool: (name: string, args: object) => Promise<object>;
	}): unknown;
	serveMcp(
		factory: () => unknown,
		options: {
			input: PassThrough;
			writeFrame: (chunk: Buffer, done: () => void) => void;
		},
	): { close(): Promise<void> };
	curatedGlobals(
		host: Host,
		log: (level: string, message: string) => void,
	): Record<string, unknown>;
	createLog(
		notify: (method: string, params: { level: string; message: string }) => void,
		now?: () => number,
	): (level: string, message: string) => void;
	connectHost(proc: Proc): Host;
	dropReadGrants(execArgv: string[], dirs: string[], permission: Permission): number;
	sameNames(actual: string[], expected: string[]): boolean;
}

const shimUrl = new URL("../src/shim.mjs", import.meta.url).href;
const shim = (await import(shimUrl)) as Shim;
const envelope = {
	"io.modelcontextprotocol/protocolVersion": "2026-07-28",
	"io.modelcontextprotocol/clientCapabilities": {},
};

describe("the binding stub", () => {
	it("answers process.binding('constants') with fs.constants and refuses every other name", () => {
		const probe = `
			import fs from "node:fs";
			const { installBindingStub } = await import(${JSON.stringify(shimUrl)});
			installBindingStub();
			const out = { rdonly: process.binding("constants").fs.O_RDONLY === fs.constants.O_RDONLY };
			for (const name of ["fs", "spawn_sync", "natives"]) {
				try { process.binding(name); out[name] = "allowed"; } catch (error) { out[name] = error.code; }
			}
			try { process.binding = () => 1; out.replaced = true; } catch { out.replaced = false; }
			console.log(JSON.stringify(out));`;
		const result = spawnSync(process.execPath, ["--input-type=module", "-e", probe], {
			encoding: "utf8",
		});
		expect(result.stderr).toBe("");
		expect(JSON.parse(result.stdout)).toEqual({
			rdonly: true,
			fs: "ERR_ACCESS_DENIED",
			spawn_sync: "ERR_ACCESS_DENIED",
			natives: "ERR_ACCESS_DENIED",
			replaced: false,
		});
	});
});

describe("the stdio guard", () => {
	it("keeps fd 1 for frames and fd 0 for the transport; Node warnings log without aborting", () => {
		const probe = `
			import fs from "node:fs";
			const { guardStdio } = await import(${JSON.stringify(shimUrl)});
			const logs = [];
			const problems = [];
			const log = (level, message) => logs.push(level);
			const writeFrame = guardStdio(log, (text) => problems.push(text));
			console.log("to the log");
			process.stdout.write("stray\\n");
			fs.writeSync(1, "sync stray\\n");
			let read = "allowed";
			try { fs.readSync(0, Buffer.alloc(1)); } catch (error) { read = error.code; }
			console.error("a loader error");
			process.emitWarning("demo", "ExperimentalWarning");
			setTimeout(() => writeFrame(JSON.stringify({ logs, problems, read }) + "\\n"), 50);`;
		const result = spawnSync(process.execPath, ["--input-type=module", "-e", probe], {
			encoding: "utf8",
		});
		expect(result.stderr).toBe("");
		const lines = result.stdout.trim().split(/\r?\n/);
		expect(lines).toHaveLength(1);
		expect(JSON.parse(lines[0] ?? "")).toEqual({
			logs: ["info", "warn", "warn", "error", "error"],
			problems: ["a loader error"],
			read: "EIO",
		});
	});
});

describe("the MCP server SDK on stdio", () => {
	const tools = [
		{
			name: "hello",
			description: "Greets a name.",
			inputSchema: {
				type: "object",
				properties: { name: { type: "string" } },
				required: ["name"],
			},
		},
	];

	// A client over in-memory pipes: one request at a time, one answer each.
	function connect() {
		const calls: object[] = [];
		const factory = () =>
			shim.createMcpServer({
				info: { name: "py-hello", version: "0.1.0" },
				tools,
				callTool: async (name, args) => {
					calls.push({ name, args });
					return { content: [{ type: "text", text: `hello ${JSON.stringify(args)}` }] };
				},
			});
		const input = new PassThrough();
		const output = new PassThrough();
		const served = shim.serveMcp(factory, {
			input,
			writeFrame: (chunk, done) => output.write(chunk, done),
		});
		const lines = createInterface({ input: output })[Symbol.asyncIterator]();
		let id = 0;
		const ask = async (method: string, params: object, raw = false): Promise<Frame> => {
			const body = raw ? params : { ...params, _meta: envelope };
			input.write(`${JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params: body })}\n`);
			const { value } = await lines.next();
			return JSON.parse(String(value)) as Frame;
		};
		return { ask, calls, close: () => served.close() };
	}

	const issues = (
		name: "DiscoverResult" | "ListToolsResult" | "CallToolResult",
		value: unknown,
	) => {
		const outcome = specTypeSchemas[name]["~standard"].validate(value) as {
			issues?: readonly { message: string }[];
		};
		return outcome.issues?.map((issue) => issue.message) ?? [];
	};

	it("answers server/discover, tools/list and tools/call as 2026-07-28 results", async () => {
		const client = connect();
		try {
			const discover = await client.ask("server/discover", {});
			expect(wireProblems("server/discover", discover)).toEqual([]);
			expect(issues("DiscoverResult", discover.result)).toEqual([]);
			expect(discover.result).toMatchObject({
				resultType: "complete",
				supportedVersions: ["2026-07-28"],
				capabilities: { tools: { listChanged: false } },
				_meta: { "io.modelcontextprotocol/serverInfo": { name: "py-hello", version: "0.1.0" } },
			});
			const list = await client.ask("tools/list", {});
			expect(wireProblems("tools/list", list)).toEqual([]);
			expect(issues("ListToolsResult", list.result)).toEqual([]);
			expect(list.result?.tools).toEqual(tools);
			const call = await client.ask("tools/call", { name: "hello", arguments: { name: "S11" } });
			expect(wireProblems("tools/call", call)).toEqual([]);
			expect(issues("CallToolResult", call.result)).toEqual([]);
			expect(call.result?.content).toEqual([{ type: "text", text: 'hello {"name":"S11"}' }]);
			expect(client.calls).toEqual([{ name: "hello", args: { name: "S11" } }]);
		} finally {
			await client.close();
		}
	});

	it("checks arguments against the tool's JSON Schema before Python runs", async () => {
		const client = connect();
		try {
			const call = await client.ask("tools/call", { name: "hello", arguments: { nope: 1 } });
			expect(wireProblems("tools/call", call)).toEqual([]);
			expect(call.result).toMatchObject({ isError: true, resultType: "complete" });
			expect(client.calls).toEqual([]);
			const unknown = await client.ask("tools/call", { name: "nope", arguments: {} });
			expect(unknown.error?.code ?? unknown.result?.isError).toBeTruthy();
			expect((await client.ask("resources/list", {})).error?.code).toBe(-32601);
		} finally {
			await client.close();
		}
	});

	it("answers a 2025 initialize with -32022 and still serves a 2026 request", async () => {
		const client = connect();
		try {
			const opening = {
				protocolVersion: "2025-11-25",
				capabilities: {},
				clientInfo: { name: "x", version: "1" },
			};
			expect((await client.ask("initialize", opening, true)).error).toEqual({
				code: -32022,
				message: "Unsupported protocol version: 2025-11-25",
				data: { supported: ["2026-07-28"], requested: "2025-11-25" },
			});
			expect((await client.ask("tools/list", {})).result?.resultType).toBe("complete");
		} finally {
			await client.close();
		}
	});

	it("flags frames the SDK's client would refuse", () => {
		const bare = { jsonrpc: "2.0", id: 1, result: { tools: [] } };
		expect(wireProblems("tools/list", bare)).toEqual([
			"tools/list: resultType",
			"tools/list: ttlMs",
			"tools/list: cacheScope",
		]);
		expect(
			wireProblems("tools/call", { jsonrpc: "2.0", id: 1, result: { resultType: "complete" } }),
		).toEqual(["tools/call: content"]);
		expect(wireProblems("ping", null)).toEqual(["ping: no answer"]);
	});
});

describe("the curated jsglobals", () => {
	// A broker stub on a fake IPC channel: replies to host/fetch by URL.
	function broker(reply: (params: Record<string, unknown>) => unknown) {
		const sent: Record<string, unknown>[] = [];
		const proc: Proc = Object.assign(new EventEmitter(), {
			send: (message: unknown) => {
				const { id, params } = message as { id: string; params: Record<string, unknown> };
				sent.push(params);
				const result = reply(params);
				if (result !== undefined)
					queueMicrotask(() => proc.emit("message", { jsonrpc: "2.0", id, result }));
			},
		});
		const globals = shim.curatedGlobals(shim.connectHost(proc), () => {});
		return { fetch: globals.fetch as typeof fetch, sent, globals };
	}
	const bytes = Buffer.from(Array.from({ length: 256 }, (_, i) => i));

	it("holds the broker fetch, the classes pyfetch, urllib3 and requests use, timers and console", () => {
		const { globals } = broker(() => undefined);
		expect(Object.isFrozen(globals)).toBe(true);
		expect(Object.keys(globals).toSorted()).toEqual([
			"AbortController",
			"AbortSignal",
			"Headers",
			"Object",
			"Request",
			"Response",
			"TextDecoder",
			"TextEncoder",
			"URL",
			"clearInterval",
			"clearTimeout",
			"console",
			"fetch",
			"setInterval",
			"setTimeout",
		]);
	});

	it("carries request and response bytes as base64", async () => {
		const { fetch, sent } = broker((params) => ({
			status: 200,
			headers: { "content-type": "application/octet-stream" },
			bodyBase64: params.bodyBase64,
		}));
		const response = await fetch("https://broker.example/echo", { method: "POST", body: bytes });
		expect(Buffer.from(await response.arrayBuffer()).equals(bytes)).toBe(true);
		expect(response.headers.get("content-type")).toBe("application/octet-stream");
		expect(sent).toEqual([
			{
				url: "https://broker.example/echo",
				method: "POST",
				headers: {},
				bodyBase64: bytes.toString("base64"),
			},
		]);
	});

	it("gives null-body statuses and HEAD no body, and refuses a status fetch can't hold", async () => {
		for (const status of [204, 205, 304]) {
			const { fetch } = broker(() => ({ status, headers: {}, bodyBase64: "" }));
			const response = await fetch("https://broker.example/x");
			expect([response.status, response.body]).toEqual([status, null]);
		}
		const head = broker(() => ({ status: 200, headers: {}, bodyBase64: "eA==" }));
		expect((await head.fetch("https://broker.example/x", { method: "HEAD" })).body).toBeNull();
		for (const status of [101, 0, 600, "200"]) {
			const { fetch } = broker(() => ({ status, headers: {} }));
			await expect(fetch("https://broker.example/x")).rejects.toThrow(TypeError);
		}
	});

	it("stops waiting when its signal aborts", async () => {
		const { fetch, sent } = broker(() => undefined);
		const controller = new AbortController();
		const pending = fetch("https://broker.example/slow", { signal: controller.signal });
		await Promise.resolve();
		controller.abort();
		await expect(pending).rejects.toMatchObject({ name: "AbortError" });
		expect(sent).toHaveLength(1);
		await expect(
			fetch("https://broker.example/x", { signal: controller.signal }),
		).rejects.toMatchObject({
			name: "AbortError",
		});
		expect(sent).toHaveLength(1);
	});
});

describe("host log and host channel", () => {
	it("caps the log at 100 lines a second and reports the dropped count", () => {
		const sent: string[] = [];
		let now = 0;
		const log = shim.createLog(
			(_method, params) => sent.push(params.message),
			() => now,
		);
		for (let i = 0; i < 150; i++) log("info", `line ${i}`);
		now = 1_000;
		log("info", "next second");
		expect(sent).toHaveLength(102);
		expect(sent.at(-2)).toBe("dropped 50 lines");
		expect(sent.at(-1)).toBe("next second");
	});

	it("correlates host requests with their replies over the IPC channel", async () => {
		const sent: { id?: string; method: string }[] = [];
		const proc = Object.assign(new EventEmitter(), {
			send: (message: unknown) => {
				sent.push(message as { id?: string; method: string });
			},
		});
		const host = shim.connectHost(proc);
		const ok = host.request("host/fetch", { url: "https://example.com/" });
		const bad = host.request("host/fetch", { url: "https://example.org/" });
		proc.emit("message", {
			jsonrpc: "2.0",
			id: sent[1]?.id,
			error: { code: -1, message: "denied" },
		});
		proc.emit("message", { jsonrpc: "2.0", id: sent[0]?.id, result: { status: 200 } });
		await expect(ok).resolves.toEqual({ status: 200 });
		await expect(bad).rejects.toThrow("denied");
		host.notify("host/log", { level: "info", message: "x" });
		expect(sent.map((message) => message.method)).toEqual(["host/fetch", "host/fetch", "host/log"]);
	});
});

describe("boot checks", () => {
	it("passes Pyodide's progress lines, whatever the package names, and flags every other message", () => {
		for (const text of [
			"Loading py-hello, typing-extensions",
			"Loaded py-hello, typing-extensions",
			"Loading pypika, pypinyin, pyodide-http, x.pypi.org",
			"Loaded pypika-lookup",
		]) {
			expect(shim.loaderProblem(text), text).toBe(false);
		}
		for (const text of [
			"Failed to load py-hello",
			"Didn't find package typing_extensions-4.15.0-py3-none-any.whl locally, attempting to load from https://cdn.jsdelivr.net/pyodide/v314.0.7/full/",
			"Package x loaded from y, caching the wheel in node_modules for future use.",
			"No new packages to load",
			"py-hello already loaded from default channel",
			"Loading https://example.com/x-1.0-py3-none-any.whl",
			"Loading py-hello\nDidn't find package",
		]) {
			expect(shim.loaderProblem(text), text).toBe(true);
		}
	});

	it("compares package names the way Pyodide normalizes them", () => {
		expect(
			shim.sameNames(["typing_extensions", "py-hello"], ["py-hello", "typing-extensions"]),
		).toBe(true);
		expect(shim.sameNames(["py-hello"], ["py-hello", "typing-extensions"])).toBe(false);
	});

	const permission = (granted: string[]) => {
		const live = new Set(granted);
		const dropped: string[] = [];
		const api: Permission = {
			has: (_scope, reference) => live.has(reference ?? ""),
			drop: (_scope, reference) => {
				dropped.push(reference ?? "");
				live.delete(reference ?? "");
			},
		};
		return { api, dropped };
	};
	const argv = [
		"--permission",
		"--allow-fs-read=/p",
		"--allow-fs-read=/r",
		"--max-old-space-size=256",
	];

	it("drops both read grants by their exact flag strings", () => {
		const { api, dropped } = permission(["/p", "/r"]);
		expect(shim.dropReadGrants(argv, ["/r", "/p"], api)).toBe(2);
		expect(dropped).toEqual(["/p", "/r"]);
	});

	it("refuses another grant shape, and fails when read access remains", () => {
		const { api } = permission(["/p", "/r"]);
		expect(() => shim.dropReadGrants(argv.slice(0, 2), ["/p"], api)).toThrow(/expected 2/);
		expect(() => shim.dropReadGrants([...argv, "--allow-fs-write=/d"], ["/r", "/p"], api)).toThrow(
			/write grant/,
		);
		const sticky: Permission = { has: () => true, drop: () => {} };
		expect(() => shim.dropReadGrants(argv, ["/r", "/p"], sticky)).toThrow(/remains/);
	});
});
