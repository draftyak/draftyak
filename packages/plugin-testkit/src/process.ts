import { AsyncLocalStorage } from "node:async_hooks";
import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	opendirSync,
	openSync,
	readSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { sha256Hex } from "@draftyak/protocol/hash";
import {
	HOST_FRAME_TAG,
	HOST_MAX_ACTIVE_REQUESTS,
	HOST_MAX_FRAME_BYTES,
	HOST_REQUEST_TIMEOUT_MS,
	HostMessage,
	type HostMethod,
	jsonCopy,
} from "@draftyak/protocol/host-channel";
import { canonicalize, parseStrict } from "@draftyak/protocol/jcs";
import { validateManifest } from "@draftyak/protocol/manifest";
import { buildPluginArgv, isPluginNodeVersionSupported } from "@draftyak/protocol/plugin-argv";
import {
	openPluginStdio,
	type PluginProcessIo,
	type PluginStdio,
} from "@draftyak/protocol/plugin-stdio";
import { HostError } from "@draftyak/sdk";
import { Client } from "@modelcontextprotocol/client";
import {
	type JSONRPCMessage,
	parseJSONRPCMessage,
	type Transport,
} from "@modelcontextprotocol/server";
import { MCP_VERSION } from "./in-memory.ts";
import { type MockHost, MockHubError, type MockPlugin } from "./types.ts";

export interface ProcessPluginFiles {
	readonly directory: string;
	readonly entry: string;
	readonly files: readonly string[];
	readonly data?: string;
	readonly args?: readonly string[];
}
interface Binding {
	readonly directory: string;
	readonly entry: string;
	readonly hashes: ReadonlyMap<string, string>;
	readonly data?: string;
	readonly args: readonly string[];
}
const bindings = new WeakMap<MockPlugin, Binding>();
const START_MS = 10_000;
const CLOSE_MS = 5_000;
const PACK_BYTES = 64 * 1024 ** 2;
const FILE_BYTES = 16 * 1024 ** 2;
const FILE_COUNT = 128;
const fold = (value: string): string =>
	process.platform === "win32" ? value.toLowerCase() : value;
function fail(code: string): never {
	throw new MockHubError(code);
}

function physical(directory: string): string {
	if (typeof directory !== "string" || !path.isAbsolute(directory)) fail("PROCESS_FILES_INVALID");
	const resolved = path.resolve(directory);
	let current = resolved;
	for (;;) {
		const stat = lstatSync(current);
		if (!stat.isDirectory() || stat.isSymbolicLink()) fail("PROCESS_FILES_INVALID");
		const parent = path.dirname(current);
		if (parent === current) break;
		current = parent;
	}
	if (fold(realpathSync(resolved)) !== fold(resolved)) fail("PROCESS_FILES_INVALID");
	return resolved;
}
function fileName(value: string): string {
	if (
		typeof value !== "string" ||
		value.length > 256 ||
		!/^[A-Za-z0-9_.\-/]+$/.test(value) ||
		value.split("/").some((part) => !part || part === "." || part === "..") ||
		path.isAbsolute(value)
	)
		fail("PROCESS_FILES_INVALID");
	return value;
}
function packed(directory: string, names: readonly string[]): Map<string, Buffer> {
	physical(directory);
	if (!Array.isArray(names) || names.length < 1 || names.length > FILE_COUNT)
		fail("PROCESS_FILES_INVALID");
	const expected = new Set(names.map(fileName));
	if (
		expected.size !== names.length ||
		new Set(names.map((name) => name.toLowerCase())).size !== names.length
	)
		fail("PROCESS_FILES_INVALID");
	const found = new Map<string, Buffer>();
	let bytes = 0,
		entries = 0;
	const walk = (relative: string): void => {
		const children = opendirSync(path.join(directory, relative));
		try {
			for (let child = children.readSync(); child !== null; child = children.readSync()) {
				const name = child.name;
				if (++entries > FILE_COUNT * 4) fail("PROCESS_FILES_INVALID");
				const member = relative ? `${relative}/${name}` : name;
				fileName(member);
				const absolute = path.join(directory, member);
				const stat = lstatSync(absolute);
				if (stat.isSymbolicLink()) fail("PROCESS_FILES_INVALID");
				if (stat.isDirectory()) {
					if (![...expected].some((file) => file.startsWith(`${member}/`)))
						fail("PROCESS_FILES_INVALID");
					walk(member);
					continue;
				}
				if (
					!expected.has(member) ||
					!stat.isFile() ||
					stat.nlink !== 1 ||
					stat.size > FILE_BYTES ||
					stat.size > PACK_BYTES - bytes
				)
					fail("PROCESS_FILES_INVALID");
				if (fold(realpathSync(absolute)) !== fold(path.resolve(absolute)))
					fail("PROCESS_FILES_INVALID");
				const descriptor = openSync(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
				try {
					const before = fstatSync(descriptor);
					if (
						!before.isFile() ||
						before.nlink !== 1 ||
						before.dev !== stat.dev ||
						before.ino !== stat.ino ||
						before.size !== stat.size
					)
						fail("PROCESS_FILES_CHANGED");
					const content = Buffer.alloc(stat.size);
					let offset = 0;
					while (offset < content.length) {
						const count = readSync(descriptor, content, offset, content.length - offset, offset);
						if (!count) break;
						offset += count;
					}
					const excess = readSync(descriptor, Buffer.alloc(1), 0, 1, stat.size);
					const after = fstatSync(descriptor);
					if (
						offset !== stat.size ||
						excess !== 0 ||
						before.dev !== after.dev ||
						before.ino !== after.ino ||
						before.size !== after.size ||
						before.mtimeMs !== after.mtimeMs ||
						before.ctimeMs !== after.ctimeMs ||
						after.nlink !== 1
					)
						fail("PROCESS_FILES_CHANGED");
					bytes += content.length;
					found.set(member, content);
				} finally {
					closeSync(descriptor);
				}
			}
		} finally {
			children.closeSync();
		}
	};
	walk("");
	if (found.size !== expected.size) fail("PROCESS_FILES_INVALID");
	return found;
}

/** Binds trusted packed files and their current hashes; never executes the in-memory handlers. */
export function bindProcessPlugin(plugin: MockPlugin, source: ProcessPluginFiles): MockPlugin {
	try {
		const {
			directory: inputDirectory,
			entry: inputEntry,
			files: inputFiles,
			data: inputData,
			args: inputArgs,
		} = source;
		const directory = physical(inputDirectory);
		const entry = fileName(inputEntry);
		if (!Array.isArray(inputFiles)) fail("PROCESS_FILES_INVALID");
		const fileCount = inputFiles.length;
		if (!Number.isInteger(fileCount) || fileCount < 1 || fileCount > FILE_COUNT)
			fail("PROCESS_FILES_INVALID");
		const files: string[] = [];
		for (let index = 0; index < fileCount; index++) files.push(inputFiles[index]);
		const contents = packed(directory, files);
		if (!contents.has(entry)) fail("PROCESS_FILES_INVALID");
		if (inputArgs !== undefined && !Array.isArray(inputArgs)) fail("PROCESS_FILES_INVALID");
		const argumentCount = inputArgs?.length ?? 0;
		if (!Number.isInteger(argumentCount) || argumentCount < 0 || argumentCount > 128)
			fail("PROCESS_FILES_INVALID");
		const args: string[] = [];
		for (let index = 0; index < argumentCount; index++) args.push(inputArgs?.[index] as string);
		if (
			args.length > 128 ||
			args.some(
				(arg) => typeof arg !== "string" || arg.includes("\0") || Buffer.byteLength(arg) > 4096,
			)
		)
			fail("PROCESS_FILES_INVALID");
		const data = inputData === undefined ? undefined : physical(inputData);
		// The shared builder checks path syntax and disjoint data grants before any process exists.
		buildPluginArgv({
			pluginDir: directory,
			entry: path.join(directory, entry),
			...(data ? { dataDir: data } : {}),
			entryArgs: args,
		});
		const bound = Object.freeze({ manifest: plugin.manifest, entry: plugin.entry });
		bindings.set(bound, {
			directory,
			entry,
			hashes: new Map([...contents].map(([name, bytes]) => [name, sha256Hex(bytes)])),
			...(data ? { data } : {}),
			args: Object.freeze(args),
		});
		return bound;
	} catch (error) {
		if (error instanceof MockHubError) throw error;
		return fail("PROCESS_FILES_INVALID");
	}
}

export function createProcess(
	plugin: MockPlugin,
	host: MockHost,
	identity: { plugin: string; instance: string },
): {
	request(
		method: string,
		params?: Record<string, unknown>,
		signal?: AbortSignal,
	): Promise<Record<string, unknown>>;
	close(): Promise<void>;
} {
	const checked = validateManifest(plugin.manifest);
	if (!checked.ok) fail("MANIFEST_INVALID");
	if (checked.manifest.kind === "tool") fail("PROCESS_KIND_UNAVAILABLE");
	const binding = bindings.get(plugin);
	if (!binding) fail("PROCESS_BINDING_REQUIRED");
	const source = binding;
	if (source.data !== undefined && checked.manifest.permissions.dataDir !== true)
		fail("PROCESS_DATA_UNDECLARED");
	let child: ChildProcess | undefined,
		io: PluginProcessIo | undefined,
		stdio: PluginStdio | undefined;
	let staging: string | undefined, pluginDir: string | undefined;
	let closed = false,
		started = false,
		writes = 0,
		stderrBytes = 0;
	let bytes = Buffer.alloc(0);
	let startup: Promise<void> | undefined, closing: Promise<void> | undefined;
	let client: Client | undefined;
	let discovery: Record<string, unknown> | undefined;
	let discoveryId: string | number | undefined;
	let scope: (<T>(action: () => T) => T) | undefined;
	const stop = new AbortController();
	const activeHosts = new Map<string, AbortController>();
	let unsubscribe: (() => void) | undefined;
	const waiting = new Map<
		string | number,
		{ resolve(value: Record<string, unknown>): void; reject(error: Error): void }
	>();
	const clientPending = new Set<string | number>();
	let sequence = 0;
	const requestPrefix = `testkit-${randomUUID()}-`;
	let tail = Promise.resolve();
	let admitted = 0;
	const teardown = async (): Promise<void> => {
		if (closing) return closing;
		closed = true;
		closing = Promise.resolve()
			.then(async () => {
				stop.abort(new MockHubError("PROCESS_CLOSED"));
				unsubscribe?.();
				for (const active of activeHosts.values()) active.abort();
				activeHosts.clear();
				for (const pending of waiting.values()) pending.reject(new MockHubError("PROCESS_CLOSED"));
				waiting.clear();
				clientPending.clear();
				try {
					transport.onclose?.();
				} catch {
					/* Cleanup owns every descriptor even if a consumer throws. */
				}
				let terminationFailed = false;
				if (child?.pid !== undefined && child.exitCode === null && child.signalCode === null) {
					const running = child;
					let deadline: NodeJS.Timeout | undefined;
					let force: NodeJS.Timeout | undefined;
					let onExit: (() => void) | undefined;
					let onError: (() => void) | undefined;
					try {
						await new Promise<void>((resolve, reject) => {
							onExit = () => resolve();
							onError = () => {
								/* A signal error neither confirms exit nor rules out a pending exit event. */
							};
							running.once("exit", onExit);
							running.on("error", onError);
							const terminate = (signal?: NodeJS.Signals): void => {
								try {
									running.kill(signal);
								} catch {
									/* Keep waiting for confirmed exit or the cleanup deadline. */
								}
							};
							force = setTimeout(() => terminate("SIGKILL"), CLOSE_MS);
							deadline = setTimeout(
								() => reject(new MockHubError("PROCESS_CLEANUP_FAILED")),
								CLOSE_MS * 2,
							);
							terminate();
						});
					} catch {
						terminationFailed = true;
					} finally {
						if (force) clearTimeout(force);
						if (deadline) clearTimeout(deadline);
						if (onExit) running.off("exit", onExit);
						if (onError) running.off("error", onError);
					}
				}
				await io?.destroy();
				await stdio?.destroy();
				if (terminationFailed) fail("PROCESS_CLEANUP_FAILED");
				if (staging) {
					try {
						rmSync(staging, { recursive: true, force: true });
						staging = undefined;
					} catch {
						fail("PROCESS_CLEANUP_FAILED");
					}
				}
			})
			.catch(() => fail("PROCESS_CLEANUP_FAILED"));
		return closing;
	};
	const failed = (code: string): void => {
		if (closed) return;
		const error = new MockHubError(code);
		stop.abort(error);
		try {
			transport.onerror?.(error);
		} catch {
			/* Reporting cannot prevent cleanup. */
		}
		for (const pending of waiting.values()) pending.reject(error);
		void teardown().catch(() => {});
	};
	const write = async (value: unknown, tagged: boolean): Promise<void> => {
		if (closed || !io || writes >= HOST_MAX_ACTIVE_REQUESTS * 2) fail("PROCESS_CLOSED");
		const line = `${tagged ? HOST_FRAME_TAG : ""}${canonicalize(parseStrict(JSON.stringify(value)))}\n`;
		if (Buffer.byteLength(line) > HOST_MAX_FRAME_BYTES + (tagged ? 2 : 1))
			fail("PROCESS_FRAME_TOO_LARGE");
		writes++;
		try {
			await new Promise<void>((resolve, reject) =>
				io?.input.write(line, (error) =>
					error ? reject(new MockHubError("PROCESS_CLOSED")) : resolve(),
				),
			);
		} finally {
			writes--;
		}
	};
	const hostRequest = (value: unknown): void => {
		const message = HostMessage.parse(value);
		if (!("method" in message) || !("id" in message)) fail("PROCESS_FRAME_INVALID");
		if (!scope) {
			void write(
				{
					jsonrpc: "2.0",
					id: message.id,
					error: { code: -32000, message: "Host request refused", data: { code: "DENIED" } },
				},
				true,
			).catch(() => failed("PROCESS_CLOSED"));
			return;
		}
		if (activeHosts.has(message.id) || activeHosts.size >= HOST_MAX_ACTIVE_REQUESTS)
			fail("PROCESS_FRAME_INVALID");
		const controller = new AbortController();
		activeHosts.set(message.id, controller);
		const execute = (): void => {
			void host
				.request(message.method as HostMethod, message.params as never, {
					signal: AbortSignal.any([controller.signal, stop.signal]),
				})
				.then(
					(result) => write({ jsonrpc: "2.0", id: message.id, result }, true),
					(error) =>
						write(
							{
								jsonrpc: "2.0",
								id: message.id,
								error: {
									code: -32000,
									message: "Host request refused",
									data: { code: error instanceof HostError ? error.code : "BAD_REQUEST" },
								},
							},
							true,
						),
				)
				.catch(() => failed("PROCESS_CLOSED"))
				.finally(() => activeHosts.delete(message.id));
		};
		scope(execute);
	};
	const line = (raw: Buffer): void => {
		const tagged = raw[0] === 0x1e;
		if (!raw.length) fail("PROCESS_FRAME_INVALID");
		if (raw.length - (tagged ? 1 : 0) > HOST_MAX_FRAME_BYTES) fail("PROCESS_FRAME_TOO_LARGE");
		const value = parseStrict(tagged ? raw.subarray(1) : raw);
		if (tagged) {
			hostRequest(value);
			return;
		}
		const message = parseJSONRPCMessage(value);
		if ("id" in message && message.id !== undefined && !("method" in message)) {
			const pending = waiting.get(message.id);
			if (pending) {
				waiting.delete(message.id);
				if (
					!("result" in message) ||
					!message.result ||
					typeof message.result !== "object" ||
					Array.isArray(message.result)
				)
					pending.reject(new MockHubError("PROCESS_REQUEST_REFUSED"));
				else pending.resolve(message.result as Record<string, unknown>);
				return;
			}
			// Late or duplicate replies for this transport's namespace never reach Client's requests.
			if (typeof message.id === "string" && message.id.startsWith(requestPrefix)) return;
			if (!clientPending.delete(message.id)) return;
			if (message.id === discoveryId && "result" in message)
				discovery = jsonCopy(message.result) as Record<string, unknown>;
		}
		transport.onmessage?.(message);
	};
	const transport: Transport = {
		async start() {
			if (started || closed) fail("PROCESS_CLOSED");
			started = true;
		},
		async send(message: JSONRPCMessage) {
			if ("id" in message && typeof message.id === "string" && message.id.startsWith(requestPrefix))
				fail("PROCESS_FRAME_INVALID");
			if ("method" in message && message.method === "initialize") fail("PROCESS_REQUEST_REFUSED");
			const requestId = "method" in message && "id" in message ? message.id : undefined;
			if (requestId !== undefined) {
				if (clientPending.has(requestId) || clientPending.size >= HOST_MAX_ACTIVE_REQUESTS)
					fail("PROCESS_REQUEST_LIMIT");
				clientPending.add(requestId);
			}
			if ("method" in message && message.method === "server/discover" && "id" in message)
				discoveryId = message.id;
			try {
				await write(message, false);
			} catch (error) {
				if (requestId !== undefined) clientPending.delete(requestId);
				throw error;
			}
		},
		async close() {
			await teardown();
		},
	};
	const rawRequest = async (
		method: string,
		params: Record<string, unknown>,
	): Promise<Record<string, unknown>> => {
		const id = `${requestPrefix}${++sequence}`;
		const result = new Promise<Record<string, unknown>>((resolve, reject) =>
			waiting.set(id, { resolve, reject }),
		);
		void result.catch(() => {});
		try {
			await write(
				{
					jsonrpc: "2.0",
					id,
					method,
					params: {
						...params,
						_meta: {
							"io.modelcontextprotocol/protocolVersion": MCP_VERSION,
							"io.modelcontextprotocol/clientCapabilities": {},
							"io.modelcontextprotocol/clientInfo": { name: "plugin-testkit", version: "0.0.0" },
							...(params._meta as object),
						},
					},
				},
				false,
			);
			return await result;
		} finally {
			waiting.delete(id);
		}
	};
	const ready = async (): Promise<void> => {
		if (startup) return startup;
		startup = (async () => {
			if (!isPluginNodeVersionSupported(process.versions.node)) fail("PROCESS_NODE_UNSUPPORTED");
			try {
				const contents = packed(source.directory, [...source.hashes.keys()]);
				for (const [name, content] of contents)
					if (sha256Hex(content) !== source.hashes.get(name)) fail("PROCESS_FILES_CHANGED");
				if (closed) fail("PROCESS_CLOSED");
				staging = mkdtempSync(path.join(os.tmpdir(), "draftyak-plugin-"));
				pluginDir = path.join(staging, "plugin");
				mkdirSync(pluginDir, { mode: 0o700 });
				for (const [name, content] of contents) {
					const target = path.join(pluginDir, name);
					mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
					writeFileSync(target, content, { flag: "wx", mode: 0o400 });
				}
				for (const [name, content] of packed(pluginDir, [...source.hashes.keys()]))
					if (sha256Hex(content) !== source.hashes.get(name)) fail("PROCESS_FILES_CHANGED");
				const data = source.data === undefined ? path.join(staging, "data") : physical(source.data);
				if (source.data === undefined) mkdirSync(data, { mode: 0o700 });
				const argv = buildPluginArgv({
					pluginDir,
					entry: path.join(pluginDir, source.entry),
					entryArgs: source.args,
					...(source.data ? { dataDir: data } : {}),
				});
				const opened = await openPluginStdio();
				if (closed) {
					await opened.destroy();
					fail("PROCESS_CLOSED");
				}
				stdio = opened;
				const env: NodeJS.ProcessEnv = {
					DRAFTYAK_PLUGIN_ID: identity.plugin,
					DRAFTYAK_INSTANCE_ID: identity.instance,
					HOME: data,
					USERPROFILE: data,
					TMPDIR: data,
					TEMP: data,
					TMP: data,
				};
				for (const key of ["LANG", "TZ", "SystemRoot"])
					if (process.env[key] !== undefined) env[key] = process.env[key];
				child = spawn(process.execPath, argv, {
					cwd: pluginDir,
					env,
					stdio: [...stdio.stdio],
					windowsHide: true,
					shell: false,
				});
				io = stdio.attach(child);
				io.outputs[0].on("data", (incoming: Buffer) => {
					if (closed) return;
					let start = 0;
					try {
						for (let index = 0; index < incoming.length; index++)
							if (incoming[index] === 10) {
								const part = incoming.subarray(start, index);
								if (bytes.length + part.length > HOST_MAX_FRAME_BYTES + 1)
									fail("PROCESS_FRAME_TOO_LARGE");
								line(Buffer.concat([bytes, part]));
								bytes = Buffer.alloc(0);
								start = index + 1;
								if (closed) return;
							}
						if (bytes.length + incoming.length - start > HOST_MAX_FRAME_BYTES + 1)
							fail("PROCESS_FRAME_TOO_LARGE");
						bytes = Buffer.concat([bytes, incoming.subarray(start)]);
					} catch (error) {
						failed(error instanceof MockHubError ? error.code : "PROCESS_FRAME_INVALID");
					}
				});
				io.outputs[0].once("end", () =>
					failed(bytes.length ? "PROCESS_FRAME_INVALID" : "PROCESS_EXITED"),
				);
				io.outputs[0].on("error", () => failed("PROCESS_FRAME_INVALID"));
				io.outputs[1].on("data", (chunk: Buffer) => {
					stderrBytes += chunk.length;
					if (stderrBytes > HOST_MAX_FRAME_BYTES) failed("PROCESS_STDERR_LIMIT");
				});
				io.outputs[1].on("error", () => failed("PROCESS_FRAME_INVALID"));
				void io.completion.then(
					() => failed("PROCESS_EXITED"),
					() => failed("PROCESS_EXITED"),
				);
				unsubscribe = host.subscribe(
					(notification) => {
						void write(notification, true).catch(() => failed("PROCESS_CLOSED"));
					},
					() => {
						void teardown().catch(() => {});
					},
				);
				client = new Client(
					{ name: "plugin-testkit", version: "0.0.0" },
					{ versionNegotiation: { mode: "auto" }, supportedProtocolVersions: [MCP_VERSION] },
				);
				await bounded(client.connect(transport), START_MS, "PROCESS_START_TIMEOUT");
				if (client.getNegotiatedProtocolVersion() !== MCP_VERSION || !discovery)
					fail("PROCESS_REQUEST_REFUSED");
			} catch (error) {
				await teardown();
				if (error instanceof MockHubError) throw error;
				fail("PROCESS_START_FAILED");
			}
		})();
		return startup;
	};
	async function bounded<T>(
		value: Promise<T>,
		budget: number,
		code: string,
		signal?: AbortSignal,
	): Promise<T> {
		const cancelled = AbortSignal.any([stop.signal, ...(signal ? [signal] : [])]);
		let abort: () => void = () => {};
		let timer: NodeJS.Timeout | undefined;
		const deadline = performance.now() + budget;
		try {
			const refusal = (): Error =>
				stop.signal.aborted
					? (stop.signal.reason as MockHubError)
					: new HostError(signal?.reason instanceof HostError ? signal.reason.code : "DENIED");
			if (cancelled.aborted) throw refusal();
			if (budget <= 0) fail(code);
			const result = await Promise.race([
				value,
				new Promise<never>((_, reject) => {
					abort = () => reject(refusal());
					cancelled.addEventListener("abort", abort, { once: true });
					timer = setTimeout(() => reject(new MockHubError(code)), budget);
				}),
			]);
			if (cancelled.aborted) throw refusal();
			if (performance.now() >= deadline) fail(code);
			return result;
		} finally {
			if (timer) clearTimeout(timer);
			cancelled.removeEventListener("abort", abort);
		}
	}
	return {
		async request(method, params = {}, signal) {
			if (closed) fail("PROCESS_CLOSED");
			if (signal?.aborted) throw new HostError("DENIED");
			if (!["server/discover", "tools/list", "tools/call"].includes(method))
				fail("PROCESS_REQUEST_REFUSED");
			const deadline = performance.now() + HOST_REQUEST_TIMEOUT_MS;
			const snapshot = AsyncLocalStorage.snapshot();
			const copied = jsonCopy(params);
			if (admitted >= HOST_MAX_ACTIVE_REQUESTS) fail("PROCESS_REQUEST_LIMIT");
			admitted++;
			let connected: Client;
			try {
				await ready();
				if (closed) fail("PROCESS_CLOSED");
				if (signal?.aborted) throw new HostError("DENIED");
				if (!client) fail("PROCESS_START_FAILED");
				connected = client;
			} catch (error) {
				admitted--;
				throw error;
			}
			const prior = tail;
			const released = Promise.withResolvers<void>();
			tail = prior.then(() => released.promise);
			let running = false;
			try {
				await bounded(prior, deadline - performance.now(), "PROCESS_REQUEST_TIMEOUT", signal);
				if (closed) fail("PROCESS_CLOSED");
				if (signal?.aborted) throw new HostError("DENIED");
				if (performance.now() >= deadline) fail("PROCESS_REQUEST_TIMEOUT");
				running = true;
				scope = snapshot;
				const result =
					method === "tools/call"
						? connected.callTool(copied as { name: string; arguments?: Record<string, unknown> })
						: rawRequest(method, copied);
				return jsonCopy(
					await bounded(result, deadline - performance.now(), "PROCESS_REQUEST_TIMEOUT", signal),
				) as Record<string, unknown>;
			} catch (error) {
				if (running) await teardown();
				if (error instanceof MockHubError) throw error;
				if (error instanceof HostError) throw error;
				return fail("PROCESS_REQUEST_REFUSED");
			} finally {
				if (running) {
					scope = undefined;
					for (const active of activeHosts.values()) active.abort();
				}
				// A cancelled queued call retains its place until predecessors settle, bounding tombstones.
				void prior.then(() => {
					admitted--;
					released.resolve();
				});
			}
		},
		async close() {
			await teardown();
			await startup?.catch(() => {});
			await tail;
			await client?.close();
		},
	};
}
