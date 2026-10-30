import { randomUUID } from "node:crypto";
import type { Readable, Writable } from "node:stream";
import {
	HOST_FRAME_TAG,
	HOST_MAX_ACTIVE_REQUESTS,
	HOST_MAX_FRAME_BYTES,
	HOST_REQUEST_TIMEOUT_MS,
	HostMessage,
	type HostMethod,
	type HostMethods,
	type HostNotification,
	type HostReply,
	jsonCopy,
	parseHostParams,
	parseHostResult,
} from "@draftyak/protocol/host-channel";
import { canonicalize, parseStrict } from "@draftyak/protocol/jcs";
import { parseJSONRPCMessage, type Transport } from "@modelcontextprotocol/server";
import { type HostChannel, HostError, type HostRequestOptions } from "./host.ts";

export interface StdioHost extends HostChannel {
	readonly transport: Transport;
}
export interface StdioHostOptions {
	readonly input?: Readable;
	readonly output?: Writable;
	readonly onerror?: (error: Error) => void;
}
interface Pending {
	readonly method: HostMethod;
	readonly signal: AbortSignal | undefined;
	readonly resolve: (value: never) => void;
	readonly reject: (error: unknown) => void;
	readonly cleanup: () => void;
}

const nativeSignalAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted")?.get;

function hasAborted(signal: AbortSignal | undefined): boolean {
	if (signal === undefined) return false;
	try {
		return (
			nativeSignalAborted === undefined || Reflect.apply(nativeSignalAborted, signal, []) !== false
		);
	} catch {
		return true;
	}
}

/** Child-side framing only. The parent owns platform-safe spawn and exit/drain cleanup. */
export function stdioHost(options: StdioHostOptions = {}): StdioHost {
	const input = options.input ?? process.stdin;
	const output = options.output ?? process.stdout;
	const pending = new Map<string, Pending>();
	const subscriptions = new Set<{
		readonly listener: (notification: HostNotification) => void;
		readonly onclose: (() => void) | undefined;
	}>();
	let bytes = Buffer.alloc(0);
	let closed = false;
	let started = false;
	let writes = 0;
	const close = (): void => {
		if (closed) return;
		closed = true;
		const closing = [...subscriptions];
		subscriptions.clear();
		input.off("data", data);
		input.off("end", end);
		input.off("error", fail);
		output.off("error", fail);
		for (const request of pending.values()) {
			request.cleanup();
			request.reject(new HostError("DENIED"));
		}
		pending.clear();
		for (const subscription of closing) {
			try {
				subscription.onclose?.();
			} catch {
				/* Cleanup still closes every consumer. */
			}
		}
		bytes = Buffer.alloc(0);
		try {
			transport.onclose?.();
		} catch {
			/* The channel is already closed. */
		}
	};
	const fail = (): void => {
		const error = new HostError("BAD_REQUEST");
		try {
			options.onerror?.(error);
		} catch {
			/* Reporting cannot retain a malformed channel. */
		}
		try {
			transport.onerror?.(error);
		} catch {
			/* Closing is independent of the reporter. */
		}
		close();
	};
	const write = (value: unknown, host: boolean): Promise<void> => {
		if (closed || writes >= HOST_MAX_ACTIVE_REQUESTS * 2)
			return Promise.reject(new HostError("DENIED"));
		let line: string;
		try {
			// MCP's absent optional properties follow its JSON wire representation.
			const json = host ? canonicalize(value) : JSON.stringify(value);
			if (json === undefined) throw new HostError("BAD_REQUEST");
			line = `${host ? HOST_FRAME_TAG : ""}${host ? json : canonicalize(parseStrict(json))}\n`;
		} catch {
			return Promise.reject(new HostError("BAD_REQUEST"));
		}
		if (Buffer.byteLength(line) > HOST_MAX_FRAME_BYTES + (host ? 2 : 1))
			return Promise.reject(new HostError("TOO_LARGE"));
		writes++;
		return new Promise((resolve, reject) =>
			output.write(line, (error) => {
				writes--;
				if (error) {
					fail();
					reject(new HostError("DENIED"));
				} else resolve();
			}),
		);
	};
	const line = (raw: Buffer): void => {
		if (raw.length === 0) throw new HostError("BAD_REQUEST");
		const tagged = raw[0] === 0x1e;
		if (raw.length - (tagged ? 1 : 0) > HOST_MAX_FRAME_BYTES) throw new HostError("TOO_LARGE");
		const value = parseStrict(tagged ? raw.subarray(1) : raw);
		if (!tagged) {
			transport.onmessage?.(parseJSONRPCMessage(value));
			return;
		}
		const message = HostMessage.parse(value);
		if ("method" in message) {
			if ("id" in message) throw new HostError("BAD_REQUEST");
			for (const subscription of [...subscriptions]) {
				if (closed) break;
				try {
					subscription.listener(message);
				} catch {
					/* One callback cannot suppress another subscription's control frame. */
				}
			}
			return;
		}
		const reply: HostReply = message;
		const request = pending.get(reply.id);
		if (!request) return;
		pending.delete(reply.id);
		request.cleanup();
		// A source abort listener can deliver a reply before dependent abort listeners run.
		if (hasAborted(request.signal)) request.reject(new HostError("DENIED"));
		else if (reply.error) request.reject(new HostError(reply.error.data.code));
		else {
			try {
				request.resolve(parseHostResult(request.method, reply.result) as never);
			} catch {
				request.reject(new HostError("BAD_REQUEST"));
				throw new HostError("BAD_REQUEST");
			}
		}
	};
	const data = (chunk: Buffer | string): void => {
		if (closed) return;
		const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		let start = 0;
		try {
			for (let index = 0; index < incoming.length; index++)
				if (incoming[index] === 10) {
					const part = incoming.subarray(start, index);
					if (bytes.length + part.length > HOST_MAX_FRAME_BYTES + 1)
						throw new HostError("TOO_LARGE");
					line(Buffer.concat([bytes, part]));
					if (closed) return;
					bytes = Buffer.alloc(0);
					start = index + 1;
				}
			if (bytes.length + incoming.length - start > HOST_MAX_FRAME_BYTES + 1)
				throw new HostError("TOO_LARGE");
			bytes = Buffer.concat([bytes, incoming.subarray(start)]);
		} catch {
			fail();
		}
	};
	const end = (): void => {
		if (bytes.length) fail();
		else close();
	};
	const transport: Transport = {
		async start() {
			if (started || closed) throw new HostError("DENIED");
			started = true;
		},
		async send(message) {
			await write(message, false);
		},
		async close() {
			close();
		},
	};
	input.on("data", data);
	input.on("end", end);
	input.on("error", fail);
	output.on("error", fail);
	return {
		transport,
		request<M extends HostMethod>(
			method: M,
			params: HostMethods[M]["params"],
			settings: HostRequestOptions = {},
		): Promise<HostMethods[M]["result"]> {
			if (closed) return Promise.reject(new HostError("DENIED"));
			let requestedSignal: AbortSignal | undefined;
			let signal: AbortSignal | undefined;
			try {
				requestedSignal = settings.signal;
				if (requestedSignal !== undefined && !(requestedSignal instanceof AbortSignal))
					throw new HostError("BAD_REQUEST");
				signal = requestedSignal === undefined ? undefined : AbortSignal.any([requestedSignal]);
			} catch {
				return Promise.reject(new HostError("BAD_REQUEST"));
			}
			if (hasAborted(requestedSignal)) return Promise.reject(new HostError("DENIED"));
			if (pending.size >= HOST_MAX_ACTIVE_REQUESTS)
				return Promise.reject(new HostError("TOO_LARGE"));
			let timeout: number;
			try {
				timeout = settings.timeoutMs ?? HOST_REQUEST_TIMEOUT_MS;
			} catch {
				return Promise.reject(new HostError("BAD_REQUEST"));
			}
			if (!Number.isFinite(timeout) || timeout <= 0 || timeout > HOST_REQUEST_TIMEOUT_MS)
				return Promise.reject(new HostError("BAD_REQUEST"));
			let parsed: HostMethods[M]["params"];
			try {
				parsed = jsonCopy(parseHostParams(method, params));
			} catch {
				return Promise.reject(new HostError("BAD_REQUEST"));
			}
			if (hasAborted(requestedSignal)) return Promise.reject(new HostError("DENIED"));
			const id = randomUUID();
			return new Promise((resolve, reject) => {
				const cancel = (code: "DENIED" | "TIMEOUT"): void => {
					const request = pending.get(id);
					if (!request) return;
					pending.delete(id);
					request.cleanup();
					reject(new HostError(code));
				};
				const abort = (): void => cancel("DENIED");
				const timer = setTimeout(() => cancel("TIMEOUT"), timeout);
				pending.set(id, {
					method,
					signal: requestedSignal,
					resolve: resolve as (value: never) => void,
					reject,
					cleanup() {
						clearTimeout(timer);
						signal?.removeEventListener("abort", abort);
					},
				});
				signal?.addEventListener("abort", abort, { once: true });
				void write({ jsonrpc: "2.0", id, method, params: parsed }, true).catch(() =>
					cancel("DENIED"),
				);
			});
		},
		subscribe(listener, onclose) {
			if (closed) throw new HostError("DENIED");
			const subscription = { listener, onclose };
			subscriptions.add(subscription);
			return () => {
				subscriptions.delete(subscription);
			};
		},
		close,
	};
}
