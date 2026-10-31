import {
	HOST_FRAME_TAG,
	HOST_MAX_FRAME_BYTES,
	HostMessage,
	type HostMethod,
	parseHostParams,
} from "@draftyak/protocol/host-channel";
import { canonicalize, parseStrict } from "@draftyak/protocol/jcs";
import type { ViolationKind } from "./policy.ts";

export type RpcId = string | number;

export interface HostFrame {
	readonly channel: "host";
	readonly id: string;
	readonly method: HostMethod;
	readonly params: unknown;
}

export type McpFrame =
	| {
			readonly channel: "mcp";
			readonly type: "result";
			readonly id: RpcId;
			readonly result: Record<string, unknown>;
	  }
	| { readonly channel: "mcp"; readonly type: "error"; readonly id: RpcId; readonly code: number }
	| {
			readonly channel: "mcp";
			readonly type: "notification";
			readonly method: string;
			readonly params: Record<string, unknown> | undefined;
	  }
	| {
			readonly channel: "mcp";
			readonly type: "request";
			readonly id: RpcId;
			readonly method: string;
	  };

export type Frame = HostFrame | McpFrame;

const LF = 0x0a;
const RS = 0x1e;

const isRecord = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === "object" && !Array.isArray(value);

function validId(value: unknown): value is RpcId {
	return (
		(typeof value === "string" && /^[!-~]{1,128}$/.test(value)) ||
		(typeof value === "number" && Number.isSafeInteger(value))
	);
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
	return Object.keys(value).every((key) => allowed.includes(key));
}

/** Strict JSON-RPC 2.0: one of the four exact envelopes, else undefined. */
function mcpFrame(value: Record<string, unknown>): McpFrame | undefined {
	if (value.jsonrpc !== "2.0") return undefined;
	const params = value.params;
	if (params !== undefined && !isRecord(params)) return undefined;
	if (Object.hasOwn(value, "id")) {
		const id = value.id;
		if (!validId(id)) return undefined;
		if (Object.hasOwn(value, "method")) {
			if (
				typeof value.method !== "string" ||
				!onlyKeys(value, ["jsonrpc", "id", "method", "params"])
			)
				return undefined;
			return { channel: "mcp", type: "request", id, method: value.method };
		}
		if (Object.hasOwn(value, "result")) {
			if (!isRecord(value.result) || !onlyKeys(value, ["jsonrpc", "id", "result"]))
				return undefined;
			return { channel: "mcp", type: "result", id, result: value.result };
		}
		const error = value.error;
		if (!isRecord(error) || !onlyKeys(value, ["jsonrpc", "id", "error"])) return undefined;
		if (
			!onlyKeys(error, ["code", "message", "data"]) ||
			typeof error.code !== "number" ||
			!Number.isSafeInteger(error.code) ||
			typeof error.message !== "string"
		)
			return undefined;
		return { channel: "mcp", type: "error", id, code: error.code };
	}
	if (typeof value.method !== "string" || !onlyKeys(value, ["jsonrpc", "method", "params"]))
		return undefined;
	return { channel: "mcp", type: "notification", method: value.method, params };
}

/** One complete line, tag included; a frame or the violation it is. */
export function decodeLine(line: Uint8Array): Frame | ViolationKind {
	const tagged = line[0] === RS;
	const body = tagged ? line.subarray(1) : line;
	if (body.length === 0) return "empty-line";
	if (body.length > HOST_MAX_FRAME_BYTES) return "oversize";
	let value: unknown;
	try {
		value = parseStrict(body);
	} catch {
		return "parse-error";
	}
	if (!isRecord(value)) return "not-jsonrpc";
	// Node's own IPC messages never belong on either channel.
	const cmd = Object.hasOwn(value, "cmd") ? value.cmd : undefined;
	if (typeof cmd === "string" && cmd.startsWith("NODE_"))
		return cmd === "NODE_HANDLE" ? "handle" : "internal-message";
	if (!tagged) return mcpFrame(value) ?? "not-jsonrpc";
	const parsed = HostMessage.safeParse(value);
	if (!parsed.success) return "bad-host-frame";
	const message = parsed.data;
	if (!("method" in message) || !("id" in message)) return "unexpected-frame";
	try {
		return {
			channel: "host",
			id: message.id,
			method: message.method,
			params: parseHostParams(message.method, message.params),
		};
	} catch {
		return "bad-host-frame";
	}
}

/**
 * The hub side of the merged stdout: LF-terminated lines, host frames tagged with RS at byte 0.
 * Bounded before the LF arrives; after a violation or a refused frame it drops every later byte.
 */
export class FrameDecoder {
	#parts: Uint8Array[] = [];
	#length = 0;
	#tagged = false;
	#stopped = false;

	get stopped(): boolean {
		return this.#stopped;
	}

	/** Bytes held for an unterminated line. */
	get pending(): number {
		return this.#length;
	}

	stop(): void {
		this.#stopped = true;
		this.#parts = [];
		this.#length = 0;
	}

	/**
	 * Decodes synchronously. `accept` sees each frame in order and returns false to stop decoding.
	 * Returns the first violation, after which nothing more is decoded.
	 */
	push(chunk: Uint8Array, accept: (frame: Frame) => boolean): ViolationKind | undefined {
		let start = 0;
		while (!this.#stopped && start < chunk.length) {
			const newline = chunk.indexOf(LF, start);
			const end = newline === -1 ? chunk.length : newline;
			if (end > start) {
				if (this.#length === 0) this.#tagged = chunk[start] === RS;
				const payload = this.#length + (end - start) - (this.#tagged ? 1 : 0);
				if (payload > HOST_MAX_FRAME_BYTES) return this.#violation("oversize");
				this.#parts.push(chunk.subarray(start, end));
				this.#length += end - start;
			}
			if (newline === -1) break;
			const line = Buffer.concat(this.#parts, this.#length);
			this.#parts = [];
			this.#length = 0;
			start = newline + 1;
			const frame = decodeLine(line);
			if (typeof frame === "string") return this.#violation(frame);
			if (!accept(frame)) this.stop();
		}
		return undefined;
	}

	/** At the end of output: a non-empty unterminated tail is a violation and is never dispatched. */
	finish(): ViolationKind | undefined {
		if (this.#stopped) return undefined;
		const tail = this.#length;
		this.stop();
		return tail > 0 ? "unterminated" : undefined;
	}

	#violation(kind: ViolationKind): ViolationKind {
		this.stop();
		return kind;
	}
}

export class FrameTooLargeError extends Error {
	constructor() {
		super("Frame too large.");
		this.name = "FrameTooLargeError";
	}
}

/** Canonical JSON and LF; host frames carry the RS tag. Never more than one frame's JSON. */
export function encodeFrame(value: unknown, host: boolean): string {
	const json = canonicalize(value);
	if (Buffer.byteLength(json) > HOST_MAX_FRAME_BYTES) throw new FrameTooLargeError();
	return `${host ? HOST_FRAME_TAG : ""}${json}\n`;
}
