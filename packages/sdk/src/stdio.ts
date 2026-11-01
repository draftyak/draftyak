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
	readonly cancel: (code: "DENIED" | "TIMEOUT") => void;
	streamId?: string;
	settled: boolean;
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
	// Headers and terminal chunks can share one read, in either order. No payload is retained here.
	const earlyTerminals = new Set<string>();
	const unresolvedFetches = (): boolean =>
		[...pending.values()].some((request) => request.method === "host/fetch" && !request.settled);
	const retire = (id: string): Pending | undefined => {
		const request = pending.get(id);
		if (!request) return;
		pending.delete(id);
		request.cleanup();
		if (!unresolvedFetches()) earlyTerminals.clear();
		return request;
	};
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
		earlyTerminals.clear();
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
	// Each admitted request sends at most one cancellation, so cancellations skip the shared budget.
	const encode = (value: unknown, host: boolean, cancellation = false): string => {
		if (closed || (!cancellation && writes >= HOST_MAX_ACTIVE_REQUESTS * 2))
			throw new HostError("DENIED");
		let line: string;
		try {
			// MCP's absent optional properties follow its JSON wire representation.
			const json = host ? canonicalize(value) : JSON.stringify(value);
			if (json === undefined) throw new HostError("BAD_REQUEST");
			line = `${host ? HOST_FRAME_TAG : ""}${host ? json : canonicalize(parseStrict(json))}\n`;
		} catch {
			throw new HostError("BAD_REQUEST");
		}
		if (Buffer.byteLength(line) > HOST_MAX_FRAME_BYTES + (host ? 2 : 1))
			throw new HostError("TOO_LARGE");
		return line;
	};
	const send = (line: string): Promise<void> => {
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
	const write = (value: unknown, host: boolean, cancellation = false): Promise<void> => {
		try {
			return send(encode(value, host, cancellation));
		} catch (error) {
			return Promise.reject(error);
		}
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
			if ("id" in message || message.method === "host/cancel") throw new HostError("BAD_REQUEST");
			if (message.method === "host/stream.chunk") {
				const chunk = message.params;
				const owner = [...pending].find(([, request]) => request.streamId === chunk.streamId);
				if (owner) {
					if (hasAborted(owner[1].signal)) {
						owner[1].cancel("DENIED");
						return;
					}
					if (chunk.done || chunk.error) retire(owner[0]);
				} else if ((chunk.done || chunk.error) && unresolvedFetches()) {
					// Past this bound the stream router refuses unresolved fetches; the channel stays open.
					if (earlyTerminals.size < HOST_MAX_ACTIVE_REQUESTS) earlyTerminals.add(chunk.streamId);
				}
			}
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
		if (!request || request.settled) return;
		// A source abort listener can deliver a reply before dependent abort listeners run.
		if (hasAborted(request.signal)) request.cancel("DENIED");
		else if (reply.error) {
			retire(reply.id);
			request.reject(new HostError(reply.error.data.code));
		} else {
			try {
				const result = parseHostResult(request.method, reply.result);
				if (request.method === "host/fetch" && "streamId" in (result as object)) {
					const streamId = (result as HostMethods["host/fetch"]["result"]).streamId as string;
					if ([...pending.values()].some((other) => other.streamId === streamId))
						throw new HostError("BAD_REQUEST");
					request.streamId = streamId;
					request.settled = true;
					if (earlyTerminals.delete(streamId)) retire(reply.id);
					if (!unresolvedFetches()) earlyTerminals.clear();
				} else retire(reply.id);
				request.resolve(result as never);
			} catch {
				retire(reply.id);
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
			// Getters above can synchronously close the channel or admit sibling requests.
			if (closed) return Promise.reject(new HostError("DENIED"));
			if (pending.size >= HOST_MAX_ACTIVE_REQUESTS)
				return Promise.reject(new HostError("TOO_LARGE"));
			const id = randomUUID();
			let frame: string;
			try {
				frame = encode({ jsonrpc: "2.0", id, method, params: parsed }, true);
			} catch {
				// Refused before registration, so no cancellation can follow an unsent request.
				return Promise.reject(new HostError("DENIED"));
			}
			return new Promise((resolve, reject) => {
				const cancel = (code: "DENIED" | "TIMEOUT"): void => {
					const request = retire(id);
					if (!request) return;
					reject(new HostError(code));
					// A failed output has already closed the channel; there is nothing left to report.
					if (!closed)
						void write(
							{ jsonrpc: "2.0", method: "host/cancel", params: { requestId: id } },
							true,
							true,
						).catch(() => {});
				};
				const abort = (): void => cancel("DENIED");
				const timer = setTimeout(() => cancel("TIMEOUT"), timeout);
				pending.set(id, {
					method,
					settled: false,
					cancel,
					signal: requestedSignal,
					resolve: resolve as (value: never) => void,
					reject,
					cleanup() {
						clearTimeout(timer);
						signal?.removeEventListener("abort", abort);
					},
				});
				signal?.addEventListener("abort", abort, { once: true });
				// A failed output has already closed the channel and rejected this request.
				void send(frame).catch(() => {
					if (retire(id)) reject(new HostError("DENIED"));
				});
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
