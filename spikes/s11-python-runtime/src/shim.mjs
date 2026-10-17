// The python plugin shim (plan §4 Python runtime): `node <flags> <runtimeDir>/shim.mjs <pluginDir>`
// boots unmodified Pyodide in §4's order and serves the plugin's entry on stdio MCP (2026-07-28)
// through the MCP server SDK. The runtime dir holds it as one bundle (scripts/build-shim.ts). It
// runs untrusted: the process and its flags are the boundary, and nothing the hub enforces depends
// on this file.
import fs from "node:fs";
import path from "node:path";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { format } from "node:util";
import { fromJsonSchema, McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport, serveStdio } from "@modelcontextprotocol/server/stdio";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/server/validators/cf-worker";
import * as z from "zod";

// Plan §4 Validators: zod runs jitless and JSON Schema goes through the cfWorker validator, so
// nothing here needs code generation from strings.
z.config({ jitless: true });

export const HOST_API = 1;
const LOG_LINES_PER_SECOND = 100;
const MAX_LOG_LINE = 2_048;
const READ_GRANT = "--allow-fs-read=";
// sys.executable and $_ default to argv[1], the shim's host path; this is Pyodide's browser value.
const SYS_EXECUTABLE = "./this.program";
const NULL_BODY = new Set([204, 205, 304]);

const fail = (code, message) => Object.assign(new Error(message), { code });

// Step 1. Under --permission, process.binding throws ERR_ACCESS_DENIED for every name, and
// Emscripten's NODEFS reads process.binding("constants").fs while Pyodide starts. The stub answers
// that one name from the public fs.constants; every other name still throws.
export function installBindingStub() {
	const constants = Object.freeze({ fs: Object.freeze({ ...fs.constants }) });
	function binding(name) {
		if (name === "constants") return constants;
		throw fail("ERR_ACCESS_DENIED", `process.binding(${JSON.stringify(String(name))}) is refused`);
	}
	Object.defineProperty(process, "binding", {
		value: binding,
		writable: false,
		configurable: false,
	});
}

// The host channel is Node's IPC channel on fd 3 (plan §4 Transport): JSON-RPC, never handles. An
// aborted request stops waiting; the channel has no cancel message yet.
export function connectHost(proc = process) {
	if (typeof proc.send !== "function") throw fail("UNSUPPORTED", "no IPC host channel on fd 3");
	const pending = new Map();
	let next = 0;
	proc.on("message", (message) => {
		const waiter = pending.get(message?.id);
		if (waiter === undefined) return;
		pending.delete(message.id);
		if (message.error) waiter.reject(fail(message.error.code, String(message.error.message)));
		else waiter.resolve(message.result);
	});
	return {
		notify: (method, params, done) => proc.send({ jsonrpc: "2.0", method, params }, done),
		request: (method, params, signal) =>
			new Promise((resolve, reject) => {
				signal?.throwIfAborted();
				const id = `host-${++next}`;
				const abandon = () => {
					pending.delete(id);
					reject(signal.reason);
				};
				const settle = (done) => (value) => {
					signal?.removeEventListener("abort", abandon);
					done(value);
				};
				signal?.addEventListener("abort", abandon, { once: true });
				pending.set(id, { resolve: settle(resolve), reject: settle(reject) });
				proc.send({ jsonrpc: "2.0", id, method, params });
			}),
	};
}

// Python output and stray console calls go to host/log, at most 100 lines a second.
export function createLog(notify, now = Date.now) {
	let windowStart = Number.NEGATIVE_INFINITY;
	let used = 0;
	let dropped = 0;
	return (level, message) => {
		const at = now();
		if (at - windowStart >= 1_000) {
			if (dropped > 0) notify("host/log", { level: "warn", message: `dropped ${dropped} lines` });
			windowStart = at;
			used = 0;
			dropped = 0;
		}
		if (used >= LOG_LINES_PER_SECOND) {
			dropped += 1;
			return;
		}
		used += 1;
		notify("host/log", { level, message: String(message).slice(0, MAX_LOG_LINE) });
	};
}

const CONSOLE_LEVELS = { log: "info", info: "info", debug: "debug", trace: "debug" };
// Node prints process warnings through console.error; they are logged, but no loader error.
const NODE_WARNING = /^\(node:\d+\) \w+: /;

// fd 1 carries MCP frames only and fd 0 is read only by the transport: console calls, stray
// process.stdout writes and synchronous fs reads or writes on those fds never reach them. Returns the
// shim's own frame writer.
export function guardStdio(log, onProblem) {
	const out = process.stdout;
	const writeFrame = out.write.bind(out);
	for (const [name, level] of Object.entries(CONSOLE_LEVELS)) {
		console[name] = (...args) => log(level, format(...args));
	}
	for (const level of ["warn", "error"]) {
		console[level] = (...args) => {
			const text = format(...args);
			if (!NODE_WARNING.test(text)) onProblem(text);
			log(level, text);
		};
	}
	out.write = (chunk, encoding, callback) => {
		log("warn", `stdout: ${String(chunk)}`);
		(typeof encoding === "function" ? encoding : callback)?.();
		return true;
	};
	const { readSync, writeSync } = fs;
	fs.writeSync = function guardedWriteSync(fd, data, ...rest) {
		if (fd !== 0 && fd !== 1) return writeSync.call(fs, fd, data, ...rest);
		log("warn", "a synchronous write to a transport fd was diverted");
		if (typeof data === "string") return Buffer.byteLength(data);
		const [offset = 0, length = data.byteLength - offset] = rest;
		return length;
	};
	fs.readSync = function guardedReadSync(fd, ...rest) {
		if (fd === 0) throw fail("EIO", "fd 0 belongs to the transport");
		return readSync.call(fs, fd, ...rest);
	};
	return writeFrame;
}

const canonical = (name) =>
	String(name)
		.toLowerCase()
		.replace(/[-_.]+/g, "-");

export function sameNames(actual, expected) {
	const a = [...new Set(actual.map(canonical))].toSorted();
	const b = [...new Set(expected.map(canonical))].toSorted();
	return a.length === b.length && a.every((name, i) => name === b[i]);
}

// Pyodide reports a missing or failed wheel, and any fallback to its CDN, only through messages
// (plan §4 step 3). Its progress lines name packages ("Loading a, b", "Loaded a, b"); every other
// message, and a progress line naming anything but package names, aborts the boot.
const PROGRESS = /^Load(?:ing|ed) [\w.+-]+(?:, [\w.+-]+)*$/;
export const loaderProblem = (message) => !PROGRESS.test(String(message));

// Step 4. Drops both read grants by their exact flag strings, then checks no read access is left.
export function dropReadGrants(execArgv, dirs, permission = process.permission) {
	const grants = execArgv
		.filter((a) => a.startsWith(READ_GRANT))
		.map((a) => a.slice(READ_GRANT.length));
	if (grants.length !== 2)
		throw fail("UNSUPPORTED", `expected 2 read grants, got ${grants.length}`);
	if (execArgv.some((a) => a.startsWith("--allow-fs-write"))) {
		throw fail("UNSUPPORTED", "a python plugin has no write grant");
	}
	for (const dir of dirs) {
		if (!permission.has("fs.read", dir)) throw fail("UNSUPPORTED", "a runtime dir isn't granted");
	}
	for (const grant of grants) permission.drop("fs.read", grant);
	if (dirs.some((dir) => permission.has("fs.read", dir))) {
		throw fail("ERR_GRANT_KEPT", "read access remains after the drop");
	}
	return grants.length;
}

// The plugin's tools on the MCP server SDK, 2026-07-28 only: tool arguments are checked against
// each tool's JSON Schema, and callTool returns a CallToolResult.
export function createMcpServer({ info, tools, callTool }) {
	const validator = new CfWorkerJsonSchemaValidator();
	const server = new McpServer(info, {
		capabilities: { tools: { listChanged: false } },
		jsonSchemaValidator: validator,
	});
	for (const { name, inputSchema = { type: "object" }, ...rest } of tools) {
		const config = { inputSchema: fromJsonSchema(inputSchema, validator) };
		for (const key of ["title", "description", "annotations"]) {
			if (rest[key] !== undefined) config[key] = rest[key];
		}
		server.registerTool(String(name), config, (args) => callTool(String(name), args ?? {}));
	}
	return server;
}

// Serves on stdio with the SDK, frames leaving only through writeFrame: a 2025 opening gets the
// SDK's -32022, and the connection stays open for a 2026 one.
export function serveMcp(factory, { input = process.stdin, writeFrame, onerror }) {
	const output = new Writable({ write: (chunk, _encoding, done) => writeFrame(chunk, done) });
	const transport = new StdioServerTransport(input, output);
	return serveStdio(factory, { legacy: "reject", transport, onerror });
}

// The jsglobals Pyodide exposes as Python's `js` module (plan §4): the broker fetch and the web
// classes it needs, timers, and a console that logs to the host. AbortSignal and Object are there
// because pyfetch, urllib3 and requests import them; Object was already reachable as js.constructor.
// Bodies cross the host channel as base64, so bytes survive JSON.
export function curatedGlobals(host, log) {
	async function fetch(input, init) {
		const request = new Request(input, init);
		const bytes = request.body === null ? null : Buffer.from(await request.arrayBuffer());
		const params = {
			url: request.url,
			method: request.method,
			headers: Object.fromEntries(request.headers),
			...(bytes === null ? {} : { bodyBase64: bytes.toString("base64") }),
		};
		const reply = await host.request("host/fetch", params, request.signal);
		const status = reply?.status;
		if (!Number.isInteger(status) || status < 200 || status > 599) {
			throw new TypeError("fetch failed: the broker's reply has no usable status");
		}
		const empty = request.method === "HEAD" || NULL_BODY.has(status);
		const body = empty ? null : Buffer.from(String(reply.bodyBase64 ?? ""), "base64");
		return new Response(body, { status, headers: reply.headers ?? {} });
	}
	const level =
		(name) =>
		(...args) =>
			log(name, format(...args));
	const console = Object.freeze({
		log: level("info"),
		info: level("info"),
		debug: level("debug"),
		warn: level("warn"),
		error: level("error"),
	});
	return Object.freeze({
		...{ fetch, Headers, Request, Response, AbortController, AbortSignal, URL, Object },
		...{ TextEncoder, TextDecoder, setTimeout, clearTimeout, setInterval, clearInterval, console },
	});
}

// The one object Python gets from the host: JSON-only calls, versioned with the SDK major.
function hostObject(host, log) {
	return Object.freeze({
		api: HOST_API,
		fetch: async (request) =>
			JSON.stringify(await host.request("host/fetch", JSON.parse(String(request)))),
		log: (level, message) => log(String(level), String(message)),
	});
}

async function boot(started) {
	installBindingStub();
	const host = connectHost();
	process.once("disconnect", () => process.exit(0));
	const log = createLog(host.notify);
	const problems = [];
	let booting = true;
	const writeFrame = guardStdio(log, (text) => booting && problems.push(text));
	const step = { name: "read" };
	try {
		const runtimeDir = path.dirname(fileURLToPath(import.meta.url));
		const pluginDir = path.resolve(process.argv[2] ?? "");
		const manifest = JSON.parse(
			fs.readFileSync(path.join(pluginDir, "draftyak.plugin.json"), "utf8"),
		);
		const lockText = fs.readFileSync(path.join(pluginDir, "pyodide-lock.json"), "utf8");
		const lockNames = Object.values(JSON.parse(lockText).packages).map((entry) => entry.name);
		if (manifest.runtime !== "python") throw fail("UNSUPPORTED", "not a python plugin");

		step.name = "load";
		const { loadPyodide } = await import("./pyodide.mjs");
		const wheels = path.join(pluginDir, "wheels");
		const pyodide = await loadPyodide({
			indexURL: runtimeDir,
			lockFileContents: lockText,
			packageBaseUrl: wheels,
			packageCacheDir: wheels,
			jsglobals: curatedGlobals(host, log),
			env: { LANG: "C.UTF-8" },
			_sysExecutable: SYS_EXECUTABLE,
			checkAPIVersion: true,
			stdin: () => {
				throw fail("EIO", "input() is not available to plugins");
			},
			stdout: (line) => log("info", line),
			stderr: (line) => log("warn", line),
		});
		pyodide.setStdin({ error: true });

		step.name = "packages";
		const notices = [];
		await pyodide.loadPackage(lockNames, {
			messageCallback: (text) => notices.push(text),
			errorCallback: (text) => problems.push(text),
			checkIntegrity: true,
		});
		const flagged = [...problems, ...notices.filter(loaderProblem)];
		if (flagged.length > 0) throw fail("ERR_LOADER", flagged.join(" | ").slice(0, MAX_LOG_LINE));
		const loaded = Object.keys(pyodide.loadedPackages);
		if (!sameNames(loaded, lockNames))
			throw fail("ERR_LOADER", "loadedPackages differs from the lock");
		booting = false;

		step.name = "drop";
		const dropped = dropReadGrants(process.execArgv, [runtimeDir, pluginDir]);

		step.name = "entry";
		const [moduleName = "", attr = ""] = String(manifest.python?.entry).split(":");
		const plugin = pyodide.pyimport(moduleName)[attr];
		if (plugin?.api_version !== HOST_API) throw fail("UNSUPPORTED", "host API mismatch");
		const tools = JSON.parse(plugin.list_tools());
		const pythonObject = hostObject(host, log);
		const callTool = async (name, args) => {
			const call = plugin.call_tool;
			try {
				let result = await call.callPromising(name, JSON.stringify(args), pythonObject);
				if (typeof result?.then === "function") result = await result;
				const value = JSON.parse(String(result));
				if (value === null || typeof value !== "object" || Array.isArray(value)) {
					throw fail("UNSUPPORTED", "call_tool returned no result object");
				}
				return value;
			} catch (error) {
				log("error", error?.message ?? String(error));
				return { isError: true, content: [{ type: "text", text: "TRANSIENT" }] };
			} finally {
				call.destroy();
			}
		};
		const info = { name: String(manifest.id), version: String(manifest.version) };
		const factory = () => createMcpServer({ info, tools, callTool });
		factory();
		const served = serveMcp(factory, {
			writeFrame,
			onerror: (error) => log("error", error?.message ?? String(error)),
		});
		process.stdin.once("end", () => {
			served.close().finally(() => writeFrame("", () => process.exit(0)));
		});
		const python = pyodide.runPython("import sys; sys.version.split()[0]");
		host.notify("host/log", {
			level: "info",
			message: "ready",
			data: {
				pyodide: pyodide.version,
				python,
				jspi: typeof WebAssembly.Suspending,
				packages: loaded.toSorted(),
				grantsDropped: dropped,
				readAfterDrop: [runtimeDir, pluginDir].some((dir) =>
					process.permission.has("fs.read", dir),
				),
				bootMs: Math.round(performance.now() - started),
			},
		});
	} catch (error) {
		const code = typeof error?.code === "string" ? error.code : (error?.name ?? "Error");
		const message = String(error?.message ?? error).split("\n")[0];
		process.stderr.write(`shim: boot failed at ${step.name}: ${code}: ${message}\n`);
		process.exitCode = 1;
		const exit = () => process.exit(1);
		setTimeout(exit, 1_000).unref();
		host.notify(
			"host/log",
			{ level: "error", message: "boot failed", data: { step: step.name, code } },
			exit,
		);
	}
}

if (import.meta.main) await boot(performance.now());
