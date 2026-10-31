import { isPromise } from "node:util/types";
import {
	HOST_MAX_ACTIVE_REQUESTS,
	HOST_MAX_FRAME_BYTES,
	HOST_REQUEST_TIMEOUT_MS,
	type HostErrorCode,
	type HostFetchParams,
	type HostMethod,
	type HostMethods,
	HostNotification,
	parseHostResult,
} from "@draftyak/protocol/host-channel";
import { canonicalize, parseStrict } from "@draftyak/protocol/jcs";
import type { TimerClock } from "../../kernel/clock.ts";
import { PluginSupervisorError, refusalCode } from "./errors.ts";
import {
	encodeFrame,
	type Frame,
	FrameTooLargeError,
	type HostFrame,
	type McpFrame,
} from "./frames.ts";
import type { PluginKind } from "./generation.ts";
import { MAX_HOST_STREAMS } from "./policy.ts";
import type { PluginProcess } from "./process.ts";
import { schedule, type Timer } from "./timers.ts";

/** The MCP 2026-07-28 request envelope the hub sends with every request; callers never supply it. */
export const MCP_REQUEST_META: Readonly<Record<string, unknown>> = Object.freeze({
	"io.modelcontextprotocol/protocolVersion": "2026-07-28",
	"io.modelcontextprotocol/clientCapabilities": Object.freeze({}),
	"io.modelcontextprotocol/clientInfo": Object.freeze({ name: "draftyak-hub", version: "0.0.0" }),
});

export type RpcOutcome =
	| { readonly ok: true; readonly result: Record<string, unknown> }
	| { readonly ok: false; readonly rpcCode: number }
	| { readonly ok: false; readonly ended: true };

const ENDED: RpcOutcome = Object.freeze({ ok: false, ended: true });

export interface ProgressUpdate {
	readonly progress: number;
	readonly total?: number;
}

export type ProgressListener = (update: ProgressUpdate) => void;

/** The native invocation a host request is attributed to, and the signal that ends it. */
export interface HostBinding {
	readonly invocation: unknown;
	readonly signal: AbortSignal;
}

/** Frozen per request. The plugin's process, streams and pid are never part of it. */
export interface PluginHostRequestContext {
	readonly pluginId: string;
	readonly instanceId: string;
	readonly generation: string;
	readonly kind: PluginKind;
	readonly invocation: unknown;
	/**
	 * Aborts once the request is answered, at the host timeout, when the bound call or lease ends,
	 * at process end, revoke or close. A stream (host/fetch with stream: true, host/ws.open) stays
	 * open after its reply until its done chunk is sent, its socket is closed by host/ws.close, or
	 * its call or lease ends.
	 */
	readonly signal: AbortSignal;
	/** Resolves once the successful reply is written to the plugin; rejects otherwise. */
	readonly replyWritten: Promise<void>;
	/** Writes one tagged host notification; rejects once the signal aborted or the process ended. */
	notify(notification: HostNotification): Promise<void>;
}

export interface PluginHostHandler {
	request<M extends HostMethod>(
		method: M,
		params: HostMethods[M]["params"],
		context: PluginHostRequestContext,
	): Promise<HostMethods[M]["result"]>;
}

export interface EndpointOwner {
	readonly pluginId: string;
	readonly instanceId: string;
	readonly generation: string;
	readonly kind: PluginKind;
	readonly clock: TimerClock;
	binding(): HostBinding | undefined;
	dispatch(
		method: HostMethod,
		params: unknown,
		context: PluginHostRequestContext,
	): Promise<unknown>;
}

interface Pending {
	readonly resolve: (outcome: RpcOutcome) => void;
	readonly token: string | undefined;
}

/** One dispatched host request, from receipt until its context ends. It never holds the params. */
interface HostWork {
	readonly id: string;
	readonly method: HostMethod;
	/** host/fetch with stream: true, or host/ws.open: the context may outlive its reply. */
	readonly streaming: "fetch" | "ws" | undefined;
	/** The socket a host/ws.close names; its answer ends that socket's open context. */
	readonly closes: string | undefined;
	readonly binding: AbortSignal;
	readonly controller: AbortController;
	readonly replied: PromiseWithResolvers<void>;
	readonly onBindingAbort: () => void;
	timer: Timer | undefined;
	/** The reply or refusal is decided; a later handler outcome is ignored. */
	answered: boolean;
	/** The stream's done chunk is on its way: no further notification is accepted. */
	closing: boolean;
	ended: boolean;
	/** The streamId or socketId a successful streaming reply named. */
	stream: string | undefined;
}

function streamingKind(frame: HostFrame): HostWork["streaming"] {
	if (frame.method === "host/ws.open") return "ws";
	return frame.method === "host/fetch" && (frame.params as HostFetchParams).stream === true
		? "fetch"
		: undefined;
}

function refusalLine(id: string, code: HostErrorCode): string | undefined {
	try {
		return encodeFrame(
			{
				jsonrpc: "2.0",
				id,
				error: { code: -32000, message: "Host request refused", data: { code } },
			},
			true,
		);
	} catch {
		return undefined;
	}
}

function contextEnded(): PluginSupervisorError {
	return new PluginSupervisorError("HOST_CONTEXT_ENDED");
}

/**
 * One process's protocol endpoint: the hub's MCP client side and its host server side, over the
 * merged framing only.
 */
export class Endpoint {
	readonly #process: PluginProcess;
	readonly #owner: EndpointOwner;
	readonly #pending = new Map<string, Pending>();
	readonly #progress = new Map<string, ProgressListener>();
	/** Requests whose answer has not been written yet: each keeps its id and one of the 16 slots. */
	readonly #active = new Map<string, HostWork>();
	/** Contexts not yet ended: unanswered requests and open streams. */
	readonly #open = new Set<HostWork>();
	readonly #closed = new AbortController();
	#streams = 0;
	#counter = 0;

	constructor(process: PluginProcess, owner: EndpointOwner) {
		this.#process = process;
		this.#owner = owner;
	}

	/** Writes one request now; throws PLUGIN_BUSY at the frame cap and FRAME_TOO_LARGE with nothing written. */
	request(
		method: string,
		params: Record<string, unknown>,
		onProgress?: ProgressListener,
	): { readonly id: string; readonly outcome: Promise<RpcOutcome> } {
		if (this.#closed.signal.aborted) throw new PluginSupervisorError("PLUGIN_EXITED");
		const id = `h${++this.#counter}`;
		const token = onProgress === undefined ? undefined : `progress-${id}`;
		const meta =
			token === undefined ? MCP_REQUEST_META : { ...MCP_REQUEST_META, progressToken: token };
		let line: string;
		try {
			line = encodeFrame({ jsonrpc: "2.0", id, method, params: { ...params, _meta: meta } }, false);
		} catch (error) {
			throw new PluginSupervisorError(
				error instanceof FrameTooLargeError ? "FRAME_TOO_LARGE" : "REQUEST_INVALID",
			);
		}
		// Registered before the write: a reply may arrive before write() returns.
		const { promise, resolve } = Promise.withResolvers<RpcOutcome>();
		this.#pending.set(id, { resolve, token });
		if (token !== undefined && onProgress !== undefined) this.#progress.set(token, onProgress);
		const written = this.#process.tryWrite(line);
		if (written === undefined) {
			this.#pending.delete(id);
			if (token !== undefined) this.#progress.delete(token);
			throw new PluginSupervisorError("PLUGIN_BUSY");
		}
		written.then(undefined, () => this.#settle(id, ENDED));
		return { id, outcome: promise };
	}

	/** Best effort: notifications/cancelled for a request already written. */
	cancel(id: string, reason: "timeout" | "cancelled"): void {
		const pending = this.#pending.get(id);
		if (pending?.token !== undefined) this.#progress.delete(pending.token);
		if (this.#closed.signal.aborted || pending === undefined) return;
		let line: string;
		try {
			line = encodeFrame(
				{ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id, reason } },
				false,
			);
		} catch {
			return;
		}
		this.#process.tryWrite(line)?.then(undefined, () => {});
	}

	/** True while the plugin has not yet answered this request. */
	outstanding(id: string): boolean {
		return this.#pending.has(id);
	}

	/** Stops progress delivery for a call that has settled. */
	forget(id: string): void {
		const token = this.#pending.get(id)?.token;
		if (token !== undefined) this.#progress.delete(token);
	}

	/** Aborts every host context and ends every pending request. Idempotent. */
	close(): void {
		if (this.#closed.signal.aborted) return;
		this.#closed.abort();
		for (const id of [...this.#pending.keys()]) this.#settle(id, ENDED);
		for (const work of [...this.#open]) this.#end(work);
		this.#active.clear();
		this.#progress.clear();
	}

	/** Each decoded frame in order; false stops decoding (the process is being killed). */
	frame(frame: Frame): boolean {
		if (frame.channel === "host") return this.#host(frame);
		this.#mcp(frame);
		return true;
	}

	#settle(id: string, outcome: RpcOutcome): void {
		const pending = this.#pending.get(id);
		if (pending === undefined) return;
		this.#pending.delete(id);
		if (pending.token !== undefined) this.#progress.delete(pending.token);
		pending.resolve(outcome);
	}

	#mcp(frame: McpFrame): void {
		switch (frame.type) {
			case "result":
				if (typeof frame.id === "string")
					this.#settle(frame.id, { ok: true, result: frame.result });
				return;
			case "error":
				if (typeof frame.id === "string")
					this.#settle(frame.id, { ok: false, rpcCode: frame.code });
				return;
			case "request": {
				// Plugin-initiated requests are never dispatched.
				let line: string;
				try {
					line = encodeFrame(
						{ jsonrpc: "2.0", id: frame.id, error: { code: -32601, message: "Method not found" } },
						false,
					);
				} catch {
					return;
				}
				this.#process.tryWrite(line)?.then(undefined, () => {});
				return;
			}
			case "notification":
				if (frame.method === "notifications/progress") this.#onProgress(frame.params);
				return;
		}
	}

	#onProgress(params: Record<string, unknown> | undefined): void {
		const token = params?.progressToken;
		if (typeof token !== "string") return;
		const listener = this.#progress.get(token);
		const progress = params?.progress;
		const total = params?.total;
		if (listener === undefined || typeof progress !== "number" || !Number.isFinite(progress))
			return;
		if (total !== undefined && (typeof total !== "number" || !Number.isFinite(total))) return;
		const update: ProgressUpdate = Object.freeze(
			total === undefined ? { progress } : { progress, total },
		);
		try {
			const returned: unknown = listener(update);
			if (isPromise(returned)) Promise.prototype.then.call(returned, undefined, () => {});
		} catch {
			/* A listener's failure never affects the call. */
		}
	}

	#host(frame: HostFrame): boolean {
		if (this.#closed.signal.aborted || this.#process.ending) return false;
		// A request keeps its id and its slot until its answer is written, so a plugin that stops
		// reading stdin stalls at sixteen and its next request is a violation, never a queue.
		if (this.#active.has(frame.id) || this.#active.size >= HOST_MAX_ACTIVE_REQUESTS) {
			this.#process.violate("host-limit");
			return false;
		}
		const binding = this.#owner.binding();
		const streaming = streamingKind(frame);
		if (
			binding === undefined ||
			binding.signal.aborted ||
			// Lookup permits belong to the postponed tool host; they are never honoured here.
			(frame.method === "host/fetch" &&
				(frame.params as HostFetchParams).lookupPermit !== undefined) ||
			(streaming !== undefined && this.#streams >= MAX_HOST_STREAMS)
		) {
			// Never dispatched and never queued: at the stdin frame cap the refusal is dropped.
			const line = refusalLine(frame.id, "DENIED");
			if (line !== undefined) this.#process.tryWrite(line)?.then(undefined, () => {});
			return true;
		}
		const work = this.#begin(frame, streaming, binding.signal);
		const context = this.#context(work, binding.invocation);
		const { method, params } = frame;
		queueMicrotask(() => this.#dispatch(work, method, params, context));
		return true;
	}

	#begin(frame: HostFrame, streaming: HostWork["streaming"], binding: AbortSignal): HostWork {
		const work: HostWork = {
			id: frame.id,
			method: frame.method,
			streaming,
			closes:
				frame.method === "host/ws.close"
					? (frame.params as HostMethods["host/ws.close"]["params"]).socketId
					: undefined,
			binding,
			controller: new AbortController(),
			replied: Promise.withResolvers<void>(),
			onBindingAbort: () => this.#end(work),
			timer: undefined,
			answered: false,
			closing: false,
			ended: false,
			stream: undefined,
		};
		work.replied.promise.catch(() => {});
		this.#active.set(work.id, work);
		this.#open.add(work);
		if (streaming !== undefined) this.#streams++;
		binding.addEventListener("abort", work.onBindingAbort, { once: true });
		work.timer = schedule(this.#owner.clock, HOST_REQUEST_TIMEOUT_MS, this.#closed.signal, () =>
			this.#refuse(work, "TIMEOUT"),
		);
		return work;
	}

	#context(work: HostWork, invocation: unknown): PluginHostRequestContext {
		return Object.freeze({
			pluginId: this.#owner.pluginId,
			instanceId: this.#owner.instanceId,
			generation: this.#owner.generation,
			kind: this.#owner.kind,
			invocation,
			signal: work.controller.signal,
			replyWritten: work.replied.promise,
			notify: (notification: HostNotification) => this.#notify(work, notification),
		});
	}

	#dispatch(
		work: HostWork,
		method: HostMethod,
		params: unknown,
		context: PluginHostRequestContext,
	): void {
		if (work.ended || this.#process.ending) {
			this.#refuse(work, "DENIED");
			return;
		}
		let outcome: Promise<unknown>;
		try {
			outcome = Promise.resolve(this.#owner.dispatch(method, params, context));
		} catch (error) {
			outcome = Promise.reject(error);
		}
		outcome.then(
			(value) => this.#answer(work, value),
			(error: unknown) => this.#refuse(work, refusalCode(error)),
		);
	}

	#answer(work: HostWork, value: unknown): void {
		if (work.answered) return;
		let result: unknown;
		let line: string;
		try {
			if (Buffer.byteLength(canonicalize(value)) > HOST_MAX_FRAME_BYTES) {
				this.#refuse(work, "TOO_LARGE");
				return;
			}
			result = parseHostResult(work.method, value);
			line = encodeFrame({ jsonrpc: "2.0", id: work.id, result }, true);
		} catch (error) {
			this.#refuse(work, error instanceof FrameTooLargeError ? "TOO_LARGE" : "DENIED");
			return;
		}
		work.answered = true;
		work.timer?.cancel();
		const stream =
			work.streaming === "fetch"
				? (result as HostMethods["host/fetch"]["result"]).streamId
				: work.streaming === "ws"
					? (result as HostMethods["host/ws.open"]["result"]).socketId
					: undefined;
		this.#write(work, line, () => {
			if (work.ended) {
				work.replied.reject(contextEnded());
				return;
			}
			work.stream = stream;
			work.replied.resolve();
			if (work.closes !== undefined) this.#closeSocket(work.closes);
			// An answered request is done; only a stream stays open after its reply.
			if (stream === undefined) this.#end(work);
		});
	}

	/** Answers with one fixed refusal code, unless already answered, and ends the context. */
	#refuse(work: HostWork, code: HostErrorCode): void {
		if (work.answered) return;
		work.answered = true;
		work.timer?.cancel();
		work.replied.reject(contextEnded());
		this.#end(work);
		if (this.#closed.signal.aborted) this.#retire(work);
		else this.#write(work, refusalLine(work.id, code));
	}

	/** Writes the answer once stdin has room; the request leaves its slot only when it is written. */
	#write(work: HostWork, line: string | undefined, written?: () => void): void {
		if (line === undefined) {
			this.#retire(work);
			return;
		}
		this.#process.writeWhenFree(line, this.#closed.signal).then(
			() => {
				this.#retire(work);
				written?.();
			},
			() => {
				this.#retire(work);
				work.replied.reject(contextEnded());
				this.#end(work);
			},
		);
	}

	#retire(work: HostWork): void {
		if (this.#active.get(work.id) === work) this.#active.delete(work.id);
	}

	/** Ends one context: its signal aborts and, still unanswered, it is refused. Idempotent. */
	#end(work: HostWork): void {
		if (work.ended) return;
		work.ended = true;
		work.binding.removeEventListener("abort", work.onBindingAbort);
		this.#open.delete(work);
		if (work.streaming !== undefined) this.#streams--;
		work.controller.abort();
		// Work whose call, lease or process ended is never answered with its result.
		this.#refuse(work, "DENIED");
	}

	#closeSocket(socketId: string): void {
		for (const work of [...this.#open])
			if (work.streaming === "ws" && work.stream === socketId) this.#end(work);
	}

	#notify(work: HostWork, raw: HostNotification): Promise<void> {
		if (work.ended || work.closing || this.#process.ending || this.#closed.signal.aborted)
			return Promise.reject(contextEnded());
		let notification: HostNotification;
		let line: string;
		try {
			const json = canonicalize(raw);
			if (Buffer.byteLength(json) > HOST_MAX_FRAME_BYTES)
				return Promise.reject(new PluginSupervisorError("FRAME_TOO_LARGE"));
			notification = HostNotification.parse(parseStrict(json));
			line = encodeFrame(notification, true);
		} catch (error) {
			return Promise.reject(
				new PluginSupervisorError(
					error instanceof FrameTooLargeError ? "FRAME_TOO_LARGE" : "REQUEST_INVALID",
				),
			);
		}
		const written = this.#process.writeWhenFree(line, work.controller.signal);
		// The done chunk of the context's own stream is its last frame: once it is written, it ends.
		if (
			work.streaming === "fetch" &&
			work.stream !== undefined &&
			notification.method === "host/stream.chunk" &&
			notification.params.streamId === work.stream &&
			notification.params.done
		) {
			work.closing = true;
			written.then(
				() => this.#end(work),
				() => this.#end(work),
			);
		}
		return written.then(undefined, () => {
			throw contextEnded();
		});
	}
}
