import { type ChildProcess, spawn } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type PluginErrorCode, PluginErrorResult } from "@draftyak/protocol/errors";
import {
	HOST_FRAME_TAG,
	type HostErrorCode,
	HostMessage,
	type HostMethod,
	HostNotification,
	type HostRequest,
} from "@draftyak/protocol/host-channel";
import { canonicalize, parseStrict } from "@draftyak/protocol/jcs";
import {
	buildPluginArgv,
	checkPluginArgv,
	isPluginNodeVersionSupported,
} from "@draftyak/protocol/plugin-argv";
import { openPluginStdio, type PluginStdioResult } from "@draftyak/protocol/plugin-stdio";

export type { HostRequest } from "@draftyak/protocol/host-channel";
export class ProductionCallError extends Error {
	readonly code: PluginErrorCode | undefined;
	constructor(code?: PluginErrorCode) {
		super("DYTEST_SLACK_TOOL_ERROR");
		this.code = code;
	}
}
export interface ProductionExit extends PluginStdioResult {
	readonly originalClose: true;
	readonly outputEof: readonly [boolean, boolean];
}
export interface ProductionMain {
	readonly argv: readonly string[];
	readonly expectedArgv: readonly string[];
	readonly kind: "pipe" | "fifo";
	readonly requests: readonly HostRequest[];
	readonly errors: readonly string[];
	/** Signals requested only by cleanup or a bounded transport refusal. */
	readonly forcedSignals: readonly NodeJS.Signals[];
	setHostHandler(handler: (request: HostRequest) => void | Promise<void>): void;
	call(name: string, args?: Record<string, unknown>): Promise<unknown>;
	waitForHost(method: HostMethod, ordinal?: number): Promise<HostRequest>;
	respond(request: HostRequest, result: unknown): void;
	respondError(request: HostRequest, code?: HostErrorCode): void;
	notifySocket(socketId: string, data: string): void;
	endInput(): void;
	waitForExit(timeoutMs?: number): Promise<ProductionExit>;
	close(): Promise<void>;
}

const MAX_BYTES = 1_048_576;
const MAX_REQUESTS = 256;
// Three bounded polling walks reread their checkpoint and baseline chunks through host KV.
const MAX_HOST_REQUESTS = 512;
const MAX_PENDING = 32;
const CALL_MS = 5_000;
const fixed = (code: string): Error => new Error(`DYTEST_SLACK_${code}`);
const fold = (value: string): string =>
	process.platform === "win32" ? value.toLowerCase() : value;

function physical(value: string, directory: boolean): string {
	const absolute = path.resolve(value);
	const stat = lstatSync(absolute);
	if (
		stat.isSymbolicLink() ||
		(directory ? !stat.isDirectory() : !stat.isFile()) ||
		fold(realpathSync.native(absolute)) !== fold(absolute)
	)
		throw fixed("PATH_INVALID");
	return absolute;
}

function within<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > CALL_MS)
		return Promise.reject(fixed("TIMEOUT_INVALID"));
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(fixed("WAIT_TIMEOUT")), timeoutMs);
		void promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error) => {
				clearTimeout(timer);
				reject(error);
			},
		);
	});
}

/** The shipping main, ordinary production flags and real platform stdio; no native authority. */
export async function startProductionMain(builtEntry: string): Promise<ProductionMain> {
	if (!isPluginNodeVersionSupported(process.versions.node)) throw fixed("NODE_UNSUPPORTED");
	const expectedEntry = fileURLToPath(new URL("../../dist/runtime/main.mjs", import.meta.url));
	if (typeof builtEntry !== "string" || fold(path.resolve(builtEntry)) !== fold(expectedEntry))
		throw fixed("ENTRY_INVALID");
	const entry = physical(builtEntry, false);
	const pluginDir = physical(path.dirname(entry), true);
	const specification = { pluginDir, entry };
	const expectedArgv = Object.freeze(buildPluginArgv(specification));
	const stdio = await openPluginStdio();
	const env: NodeJS.ProcessEnv = {};
	for (const key of ["LANG", "TZ", "SystemRoot"])
		if (process.env[key] !== undefined) env[key] = process.env[key];
	let child: ChildProcess;
	try {
		child = spawn(process.execPath, [...expectedArgv], {
			cwd: pluginDir,
			env,
			stdio: [...stdio.stdio],
			windowsHide: true,
			shell: false,
		});
	} catch {
		await stdio.destroy();
		throw fixed("SPAWN_FAILED");
	}
	const errors: string[] = [];
	const forcedSignals: NodeJS.Signals[] = [];
	const requests: HostRequest[] = [];
	const outstanding = new Set<HostRequest>();
	const hostIds = new Set<string>();
	const issued = new Set<number>();
	const callbacks = new Set<Promise<void>>();
	let handler: ((request: HostRequest) => void | Promise<void>) | undefined;
	let originalClose: { code: number | null; signal: NodeJS.Signals | null } | undefined;
	let inputEnded = false;
	let closing: Promise<void> | undefined;
	let outputBytes = 0;
	let inputBytes = 0;
	let writes = 0;
	let sequence = 0;
	let pending = "";
	let capped = false;
	const eof: [boolean, boolean] = [false, false];
	const calls = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
	const waiters = new Set<{
		method: HostMethod;
		ordinal: number;
		resolve(value: HostRequest): void;
		reject(error: Error): void;
	}>();
	const rejectPending = (reason: Error = fixed("CLOSED")): void => {
		for (const value of calls.values()) value.reject(reason);
		calls.clear();
		for (const value of waiters) value.reject(reason);
		waiters.clear();
	};
	const closed = new Promise<void>((resolve) => {
		child.once("close", (code, signal) => {
			originalClose = { code, signal };
			rejectPending();
			resolve();
		});
	});
	const spawned = new Promise<void>((resolve, reject) => {
		child.once("spawn", () => resolve());
		child.once("error", () => {
			errors.push("DYTEST_SLACK_CHILD_ERROR");
			reject(fixed("CHILD_ERROR"));
		});
	});
	void spawned.catch(() => {});
	// attach is synchronous: the original child is retained even if spawn later fails.
	let io: ReturnType<typeof stdio.attach>;
	try {
		io = stdio.attach(child);
	} catch {
		try {
			if (child.exitCode === null && child.signalCode === null) {
				forcedSignals.push("SIGKILL");
				try {
					child.kill("SIGKILL");
				} catch {
					errors.push("DYTEST_SLACK_SIGNAL_ERROR");
				}
			}
			await within(closed, CALL_MS);
		} finally {
			await stdio.destroy();
		}
		throw fixed("STDIO_ATTACH");
	}
	const argv = Object.freeze(child.spawnargs.slice(1));
	const force = (signal: NodeJS.Signals): void => {
		if (originalClose || child.exitCode !== null || child.signalCode !== null) return;
		forcedSignals.push(signal);
		try {
			child.kill(signal);
		} catch {
			errors.push("DYTEST_SLACK_SIGNAL_ERROR");
		}
	};
	const fault = (code: string): void => {
		errors.push(`DYTEST_SLACK_${code}`);
		rejectPending(fixed(code));
		force("SIGKILL");
	};
	const write = (value: unknown, tagged: boolean): void => {
		if (originalClose || inputEnded || writes >= MAX_PENDING) throw fixed("INPUT_CLOSED");
		let text: string;
		try {
			text = `${tagged ? HOST_FRAME_TAG : ""}${canonicalize(parseStrict(JSON.stringify(value)))}\n`;
		} catch {
			throw fixed("FRAME_INVALID");
		}
		const size = Buffer.byteLength(text);
		if (size > MAX_BYTES - inputBytes) throw fixed("INPUT_LIMIT");
		inputBytes += size;
		writes++;
		try {
			io.input.write(text, (error) => {
				writes--;
				if (error && !originalClose) fault("INPUT_ERROR");
			});
		} catch {
			writes--;
			fault("INPUT_ERROR");
			throw fixed("INPUT_ERROR");
		}
	};
	const runHandler = (request: HostRequest): void => {
		if (!handler) return;
		const invoke = handler;
		const work = Promise.resolve().then(() => invoke(request));
		callbacks.add(work);
		void work.then(
			() => callbacks.delete(work),
			() => {
				callbacks.delete(work);
				errors.push("DYTEST_SLACK_HOST_HANDLER");
			},
		);
	};
	const line = (text: string): void => {
		if (!text) throw fixed("FRAME_INVALID");
		const tagged = text.startsWith(HOST_FRAME_TAG);
		const raw = parseStrict(tagged ? text.slice(HOST_FRAME_TAG.length) : text);
		if (tagged) {
			const message = HostMessage.parse(raw);
			if (!("id" in message) || !("method" in message)) throw fixed("HOST_FRAME_INVALID");
			if (requests.length >= MAX_HOST_REQUESTS) throw fixed("HOST_REQUEST_LIMIT");
			if (hostIds.has(message.id)) throw fixed("HOST_ID_REUSED");
			hostIds.add(message.id);
			const request = Object.freeze(message);
			requests.push(request);
			outstanding.add(request);
			for (const waiter of waiters) {
				const match = requests.filter((value) => value.method === waiter.method)[waiter.ordinal];
				if (match) {
					waiters.delete(waiter);
					waiter.resolve(match);
				}
			}
			runHandler(request);
			return;
		}
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw fixed("REPLY_INVALID");
		const value = raw as Record<string, unknown>;
		if (value.jsonrpc !== "2.0" || typeof value.id !== "number" || !issued.has(value.id))
			throw fixed("REPLY_INVALID");
		const call = calls.get(value.id);
		if (!call) return; // A reply after the caller's observation timeout remains accounted for.
		calls.delete(value.id);
		const result = value.result;
		if (value.error || !result || typeof result !== "object" || Array.isArray(result)) {
			call.reject(fixed("TOOL_ERROR"));
			return;
		}
		const reply = result as Record<string, unknown>;
		if (reply.isError) {
			const parsed = PluginErrorResult.safeParse(reply.structuredContent);
			call.reject(new ProductionCallError(parsed.success ? parsed.data.code : undefined));
		} else if (!Object.hasOwn(reply, "structuredContent")) call.reject(fixed("TOOL_ERROR"));
		else call.resolve(reply.structuredContent);
	};
	const outputs = io.outputs.map((stream, index) => {
		const decoder = new TextDecoder("utf-8", { fatal: true });
		const ended = new Promise<void>((resolve) => {
			stream.once("end", () => {
				eof[index] = true;
				try {
					const tail = decoder.decode();
					if (index === 0 && (tail || pending)) throw fixed("PARTIAL_FRAME");
				} catch {
					fault("OUTPUT_UTF8");
				}
				resolve();
			});
			stream.once("close", () => resolve());
		});
		stream.on("error", () => fault("OUTPUT_ERROR"));
		stream.on("data", (chunk: Buffer) => {
			outputBytes += chunk.length;
			if (capped) return;
			if (outputBytes > MAX_BYTES) {
				capped = true;
				fault("OUTPUT_LIMIT");
				return;
			}
			try {
				const decoded = decoder.decode(chunk, { stream: true });
				if (index === 1) {
					if (decoded) fault("STDERR");
					return;
				}
				pending += decoded;
				for (let at = pending.indexOf("\n"); at >= 0; at = pending.indexOf("\n")) {
					const frame = pending.slice(0, at);
					pending = pending.slice(at + 1);
					line(frame);
				}
			} catch (error) {
				const code =
					error instanceof Error && /^DYTEST_SLACK_[A-Z_]+$/.test(error.message)
						? error.message.slice("DYTEST_SLACK_".length)
						: "OUTPUT_FRAME";
				fault(code);
			}
		});
		return ended;
	});
	io.input.on("error", () => {
		if (!originalClose && !inputEnded) fault("INPUT_ERROR");
	});
	const finished = Promise.all([closed, io.completion, Promise.all(outputs)] as const).then(
		([, result]) => {
			if (!originalClose) throw fixed("ORIGINAL_CLOSE_MISSING");
			if (originalClose.code !== result.code || originalClose.signal !== result.signal)
				throw fixed("EXIT_MISMATCH");
			return Object.freeze({
				...result,
				originalClose: true as const,
				outputEof: Object.freeze([eof[0], eof[1]] as const),
			});
		},
	);
	void finished.catch(() => {});
	const take = (request: HostRequest): void => {
		if (!outstanding.delete(request)) throw fixed("HOST_REPLY_INVALID");
	};
	const main: ProductionMain = Object.freeze({
		argv,
		expectedArgv,
		kind: stdio.kind,
		get requests() {
			return Object.freeze([...requests]);
		},
		get errors() {
			return Object.freeze([...errors]);
		},
		get forcedSignals() {
			return Object.freeze([...forcedSignals]);
		},
		setHostHandler(value: (request: HostRequest) => void | Promise<void>) {
			handler = value;
		},
		async call(name: string, args: Record<string, unknown> = {}) {
			if (originalClose || calls.size >= MAX_PENDING || issued.size >= MAX_REQUESTS)
				throw fixed("CALL_LIMIT");
			if (typeof name !== "string" || !/^[a-z][a-z0-9_]{0,99}$/.test(name))
				throw fixed("TOOL_INVALID");
			const id = ++sequence;
			issued.add(id);
			const result = new Promise<unknown>((resolve, reject) => calls.set(id, { resolve, reject }));
			void result.catch(() => {});
			try {
				write(
					{
						jsonrpc: "2.0",
						id,
						method: "tools/call",
						params: {
							name,
							arguments: args,
							_meta: {
								"io.modelcontextprotocol/protocolVersion": "2026-07-28",
								"io.modelcontextprotocol/clientCapabilities": {},
							},
						},
					},
					false,
				);
				return await within(result, CALL_MS);
			} finally {
				calls.delete(id);
			}
		},
		async waitForHost(method: HostMethod, ordinal = 0) {
			if (!Number.isSafeInteger(ordinal) || ordinal < 0 || ordinal >= MAX_REQUESTS)
				throw fixed("HOST_ORDINAL");
			const present = requests.filter((value) => value.method === method)[ordinal];
			if (present) return present;
			if (originalClose || waiters.size >= MAX_PENDING) throw fixed("CLOSED");
			let waiter: Parameters<typeof waiters.add>[0] | undefined;
			const result = new Promise<HostRequest>((resolve, reject) => {
				waiter = { method, ordinal, resolve, reject };
				waiters.add(waiter);
			});
			try {
				return await within(result, CALL_MS);
			} finally {
				if (waiter) waiters.delete(waiter);
			}
		},
		respond(request: HostRequest, result: unknown) {
			take(request);
			write(HostMessage.parse({ jsonrpc: "2.0", id: request.id, result }), true);
		},
		respondError(request: HostRequest, code: HostErrorCode = "DENIED") {
			take(request);
			write(
				HostMessage.parse({
					jsonrpc: "2.0",
					id: request.id,
					error: { code: -32000, message: "Host request refused", data: { code } },
				}),
				true,
			);
		},
		notifySocket(socketId: string, data: string) {
			write(
				HostNotification.parse({
					jsonrpc: "2.0",
					method: "host/ws.message",
					params: { socketId, data },
				}),
				true,
			);
		},
		endInput() {
			if (inputEnded || originalClose) return;
			inputEnded = true;
			try {
				io.input.end();
			} catch {
				fault("INPUT_ERROR");
			}
		},
		waitForExit(timeoutMs = 3_000) {
			return within(finished, timeoutMs);
		},
		close() {
			closing ??= (async () => {
				let failure: unknown;
				try {
					main.endInput();
					try {
						await within(finished, 1_000);
					} catch (error) {
						if (originalClose) throw error;
						force("SIGKILL");
						await within(finished, CALL_MS);
					}
				} catch (error) {
					failure = error;
				} finally {
					for (const cleanup of [
						() => io.destroy(),
						() => stdio.destroy(),
						() => within(Promise.allSettled([...callbacks]), CALL_MS),
					]) {
						try {
							await cleanup();
						} catch (error) {
							failure ??= error;
						}
					}
				}
				if (failure) throw failure;
			})();
			return closing;
		},
	});
	try {
		if (checkPluginArgv(argv, specification).length !== 0) throw fixed("ARGV_INVALID");
		await within(spawned, CALL_MS);
		return main;
	} catch {
		await main.close();
		throw fixed("START_FAILED");
	}
}
