import type { ChildProcess } from "node:child_process";
import type { Duplex } from "node:stream";
import { type BrokerDecision, type BrokerOptions, brokerDecision } from "./broker-stub.ts";

// The hub side of the JSON-RPC host channel on fd 3 (plan §4 Transport, Host channel). The plugin
// uses Node's IPC channel there (spawn.ts), but the hub never does: Node's parent-side parser
// throws out of the pipe callback on one malformed line, buffers an unterminated one without limit,
// asserts on a fake NODE_HANDLE_ACK and, on POSIX, accepts the descriptors a plugin passes (S2b,
// both Nodes). A plugin can always write raw bytes to fd 3 (fs.writeSync; on Windows also the IPC
// fd adopted as a socket), so this decoder treats every byte as hostile: any parse error, oversized
// or unterminated message, bad frame, handle transfer, NODE_* message or non-JSON-RPC message ends
// the channel and SIGKILLs the plugin. Reading fd 3 as a plain pipe also means a POSIX kernel
// closes, unread, any descriptor a plugin passes.

export const MAX_MESSAGE_BYTES = 1_048_576;

// libuv's Windows IPC frame header (src/win/pipe.c): flags, reserved, data length, reserved (0),
// each a little-endian u32. Flag 1: data follows; flags 2 and 4: a socket transfer.
const HEADER_BYTES = 16;
const HAS_DATA = 0x1;
const SOCKET_XFER = 0x6;
const FRAME_FLAGS = 0x7;

export type ViolationKind =
	| "bad-frame"
	| "handle"
	| "oversize"
	| "parse-error"
	| "internal-message"
	| "not-jsonrpc";

export interface HostViolation {
	readonly kind: ViolationKind;
	// A fixed label or a Node protocol token (NODE_*), never plugin content.
	readonly detail: string;
}

export interface DecoderOptions {
	readonly framed: boolean;
	readonly maxMessageBytes?: number;
	readonly onMessage: (message: Record<string, unknown>) => void;
	readonly onViolation: (violation: HostViolation) => void;
}

export interface ChannelDecoder {
	readonly failed: boolean;
	push(chunk: Uint8Array): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function createChannelDecoder(options: DecoderOptions): ChannelDecoder {
	const max = options.maxMessageBytes ?? MAX_MESSAGE_BYTES;
	const utf8 = new TextDecoder("utf-8", { fatal: true });
	let failed = false;
	let header = Buffer.alloc(0);
	let frameLeft = 0;
	let line: Buffer[] = [];
	let lineBytes = 0;

	const fail = (kind: ViolationKind, detail: string): void => {
		if (failed) return;
		failed = true;
		line = [];
		options.onViolation({ kind, detail });
	};

	const message = (bytes: Buffer): void => {
		let value: unknown;
		try {
			value = JSON.parse(utf8.decode(bytes));
		} catch {
			fail("parse-error", "json");
			return;
		}
		if (isRecord(value) && typeof value.cmd === "string" && value.cmd.startsWith("NODE_")) {
			const cmd = /^NODE_[A-Z_]{1,40}$/.test(value.cmd) ? value.cmd : "NODE_*";
			fail(cmd === "NODE_HANDLE" ? "handle" : "internal-message", cmd);
		} else if (!isRecord(value) || value.jsonrpc !== "2.0") {
			fail("not-jsonrpc", "envelope");
		} else {
			options.onMessage(value);
		}
	};

	const data = (bytes: Buffer): void => {
		let rest = bytes;
		while (!failed && rest.length > 0) {
			const newline = rest.indexOf(0x0a);
			const part = newline === -1 ? rest : rest.subarray(0, newline);
			lineBytes += part.length;
			if (lineBytes > max) {
				fail("oversize", "message");
				break;
			}
			line.push(part);
			if (newline === -1) break;
			const whole = Buffer.concat(line);
			line = [];
			lineBytes = 0;
			rest = rest.subarray(newline + 1);
			message(whole);
		}
	};

	const headerProblem = (head: Buffer): readonly [ViolationKind, string] | null => {
		const flags = head.readUInt32LE(0);
		if ((flags & ~FRAME_FLAGS) !== 0 || head.readUInt32LE(12) !== 0) return ["bad-frame", "header"];
		if ((flags & SOCKET_XFER) !== 0) return ["handle", "socket-transfer-frame"];
		if (flags !== HAS_DATA) return ["bad-frame", "header"];
		if (head.readUInt32LE(8) > max) return ["oversize", "frame"];
		return null;
	};

	const frames = (bytes: Buffer): void => {
		let rest = bytes;
		while (!failed && rest.length > 0) {
			if (frameLeft > 0) {
				const take = Math.min(frameLeft, rest.length);
				frameLeft -= take;
				data(rest.subarray(0, take));
				rest = rest.subarray(take);
				continue;
			}
			const need = HEADER_BYTES - header.length;
			header = Buffer.concat([header, rest.subarray(0, need)]);
			rest = rest.subarray(need);
			if (header.length < HEADER_BYTES) break;
			const problem = headerProblem(header);
			frameLeft = header.readUInt32LE(8);
			header = Buffer.alloc(0);
			if (problem !== null) fail(...problem);
		}
	};

	return {
		get failed() {
			return failed;
		},
		push(chunk) {
			if (failed) return;
			const bytes = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
			if (options.framed) frames(bytes);
			else data(bytes);
		},
	};
}

// One message as the plugin's Node reads it: a JSON line, behind a libuv frame header on Windows.
export function encodeChannelMessage(message: unknown, framed: boolean): Buffer {
	const payload = Buffer.from(`${JSON.stringify(message)}\n`, "utf8");
	if (!framed) return payload;
	const head = Buffer.alloc(HEADER_BYTES);
	head.writeUInt32LE(HAS_DATA, 0);
	head.writeUInt32LE(payload.length, 8);
	return Buffer.concat([head, payload]);
}

export type JsonRpcId = string | number | null;

export interface JsonRpcResponse {
	readonly jsonrpc: "2.0";
	readonly id: JsonRpcId;
	readonly result?: unknown;
	readonly error?: { readonly code: number; readonly message: string; readonly data?: unknown };
}

export interface HostChannelOptions extends BrokerOptions {
	// Methods beyond host/fetch: return the result (or a promise of it), or throw for an error.
	readonly onRequest?: (method: string, params: unknown) => unknown;
	readonly onNotification?: (method: string, params: unknown) => void;
	readonly onViolation?: (violation: HostViolation) => void;
	// How to stop a hostile plugin (default: SIGKILL, which a POSIX plugin can't ignore).
	readonly kill?: () => void;
	readonly framed?: boolean;
	readonly maxMessageBytes?: number;
}

export interface HostChannel {
	// Every broker verdict on a host/fetch, in order.
	readonly audit: readonly BrokerDecision[];
	readonly violations: readonly HostViolation[];
	// Replies and requests that could not be written because the plugin was gone; never thrown.
	readonly droppedWrites: number;
	readonly closed: boolean;
	notify(method: string, params?: unknown): boolean;
	request(method: string, params?: unknown, timeoutMs?: number): Promise<JsonRpcResponse>;
	close(): void;
}

const isId = (value: unknown): value is JsonRpcId =>
	value === null || typeof value === "string" || typeof value === "number";

export function attachHostChannel(
	child: ChildProcess,
	options: HostChannelOptions = {},
): HostChannel {
	const stream = child.stdio[3] as Duplex | null | undefined;
	if (stream == null) throw new Error("the plugin has no fd-3 host channel (spawnPlugin's stdio)");
	const framed = options.framed ?? process.platform === "win32";
	const kill = options.kill ?? ((): void => void child.kill("SIGKILL"));
	const audit: BrokerDecision[] = [];
	const violations: HostViolation[] = [];
	const pending = new Map<string, (response: JsonRpcResponse | Error) => void>();
	let closed = false;
	let exited = false;
	let droppedWrites = 0;
	let nextId = 0;

	const shutdown = (): void => {
		if (closed) return;
		closed = true;
		stream.off("data", onData);
		for (const settle of pending.values()) settle(new Error("host channel closed"));
		pending.clear();
	};

	const write = (message: object): boolean => {
		if (closed || exited || !stream.writable || stream.destroyed) {
			droppedWrites += 1;
			return false;
		}
		stream.write(encodeChannelMessage(message, framed), (error) => {
			if (error) droppedWrites += 1;
		});
		return true;
	};
	const respond = (id: JsonRpcId, result: unknown): boolean =>
		write({ jsonrpc: "2.0", id, result });
	const refuse = (id: JsonRpcId, code: number, message: string, data?: unknown): boolean =>
		write({ jsonrpc: "2.0", id, error: { code, message, data } });

	const violate = (violation: HostViolation): void => {
		if (closed) return;
		violations.push(violation);
		shutdown();
		kill();
		stream.destroy();
		options.onViolation?.(violation);
	};

	const brokerFetch = (id: JsonRpcId | undefined, params: unknown): void => {
		const url = isRecord(params) && typeof params.url === "string" ? params.url : "";
		const decision = brokerDecision(url, options);
		audit.push(decision);
		if (id === undefined) return;
		if (decision.allow) respond(id, { allowed: true, port: decision.port });
		else refuse(id, -32001, "egress denied", { reason: decision.reason, port: decision.port });
	};

	const dispatch = async (message: Record<string, unknown>): Promise<void> => {
		const hasId = "id" in message;
		const id = message.id as JsonRpcId;
		const { method, params } = message;
		if (hasId && !isId(id)) {
			violate({ kind: "not-jsonrpc", detail: "id" });
		} else if (typeof method !== "string") {
			if (!hasId || !("result" in message || "error" in message)) {
				violate({ kind: "not-jsonrpc", detail: "shape" });
			} else {
				pending.get(String(id))?.(message as unknown as JsonRpcResponse);
				pending.delete(String(id));
			}
		} else if (method === "host/fetch") {
			brokerFetch(hasId ? id : undefined, params);
		} else if (!hasId) {
			options.onNotification?.(method, params);
		} else if (options.onRequest === undefined) {
			refuse(id, -32601, "method not found");
		} else {
			try {
				respond(id, await options.onRequest(method, params));
			} catch {
				refuse(id, -32000, "host error");
			}
		}
	};

	const decoder = createChannelDecoder({
		framed,
		maxMessageBytes: options.maxMessageBytes,
		onMessage: (message) => {
			if (!closed) dispatch(message).catch(() => {});
		},
		onViolation: violate,
	});
	const onData = (chunk: Buffer): void => decoder.push(chunk);
	stream.on("data", onData);
	// A broken pipe only ends the channel; it must never surface as an unhandled 'error'.
	stream.on("error", () => {});
	stream.once("close", shutdown);
	child.once("exit", () => {
		exited = true;
	});

	return {
		audit,
		violations,
		get droppedWrites() {
			return droppedWrites;
		},
		get closed() {
			return closed;
		},
		notify: (method, params) => write({ jsonrpc: "2.0", method, params }),
		request: (method, params, timeoutMs = 30_000) => {
			const id = `hub-${++nextId}`;
			return new Promise<JsonRpcResponse>((resolve, reject) => {
				const timer = setTimeout(() => {
					pending.delete(id);
					reject(new Error(`no reply to ${method} within ${timeoutMs} ms`));
				}, timeoutMs);
				pending.set(id, (outcome) => {
					clearTimeout(timer);
					if (outcome instanceof Error) reject(outcome);
					else resolve(outcome);
				});
				if (!write({ jsonrpc: "2.0", id, method, params })) {
					pending.get(id)?.(new Error("the plugin is gone"));
					pending.delete(id);
				}
			});
		},
		close: () => {
			shutdown();
			stream.destroy();
		},
	};
}
