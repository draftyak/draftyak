import { addAbortListener } from "node:events";
import { types } from "node:util";
import {
	HOST_MAX_STREAM_BYTES,
	HOST_REQUEST_TIMEOUT_MS,
	HostFetchResult,
	type HostNotification,
	HostStreamChunk,
} from "@draftyak/protocol/host-channel";
import type {
	ProviderHttpBroker,
	ProviderHttpStream,
	ProviderStreamSink,
} from "../../plugins/broker/provider-http.ts";

type NativeArguments = Parameters<ProviderHttpBroker["stream"]>;
export type ProviderStreamArguments = readonly [
	profile: NativeArguments[0],
	candidate: NativeArguments[1],
	binding: NativeArguments[2],
	reference: NativeArguments[3],
	credential: NativeArguments[4],
	signal: NativeArguments[5],
];
export interface ProviderStreamProgress {
	readonly bytes: number;
	/** Host chunk notifications, including the terminal; not provider SSE events. */
	readonly events: number;
}
export interface ProviderStreamOptions {
	readonly maxBytes?: number;
	readonly maxEvents?: number;
	readonly timeoutMs?: number;
	readonly onProgress?: (progress: Readonly<ProviderStreamProgress>) => void | Promise<void>;
}
export const MAX_PROVIDER_STREAM_EVENTS = 8_192;
const MAX_ENCODED_CHUNK = 87_382;
const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

export class ProviderStreamBoundaryError extends Error {
	readonly code = "PROVIDER_STREAM_REFUSED";
	constructor() {
		super("Provider stream unavailable");
	}
}
const refused = (): ProviderStreamBoundaryError => new ProviderStreamBoundaryError();

function data(value: unknown, names: readonly string[]): Record<string, unknown> {
	if (!value || typeof value !== "object" || types.isProxy(value) || Array.isArray(value))
		throw refused();
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) throw refused();
	const descriptors = Object.getOwnPropertyDescriptors(value);
	const result: Record<string, unknown> = Object.create(null);
	for (const key of Reflect.ownKeys(descriptors)) {
		if (typeof key !== "string" || !names.includes(key)) throw refused();
		const descriptor = descriptors[key];
		if (!descriptor || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable)
			throw refused();
		result[key] = descriptor.value;
	}
	return result;
}
function limit(value: unknown, fallback: number, minimum: number, maximum: number): number {
	if (value === undefined) return fallback;
	if (
		typeof value !== "number" ||
		!Number.isSafeInteger(value) ||
		value < minimum ||
		value > maximum
	)
		throw refused();
	return value;
}
function chunkBytes(value: unknown): number {
	if (typeof value !== "string" || value.length > MAX_ENCODED_CHUNK) throw refused();
	const remainder = value.length % 4;
	if (remainder === 1 || !/^[A-Za-z0-9_-]*$/.test(value)) throw refused();
	const last = value.length ? alphabet.indexOf(value[value.length - 1] as string) : 0;
	if ((remainder === 2 && (last & 15) !== 0) || (remainder === 3 && (last & 3) !== 0))
		throw refused();
	return Math.floor((value.length * 3) / 4);
}
function wait(work: PromiseLike<unknown>, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const abort = addAbortListener(signal, () => reject(refused()));
		Promise.resolve(work).then(
			() => {
				abort[Symbol.dispose]();
				if (signal.aborted) reject(refused());
				else resolve();
			},
			() => {
				abort[Symbol.dispose]();
				reject(refused());
			},
		);
	});
}

/**
 * Bounds an already-authorized native broker stream before SDK accumulation. It neither
 * constructs provider requests nor supplies generation, credential, routing or job authority.
 * The native owner must still observe completion independently of the headers response.
 * A downstream sink ignoring cancellation can remain pending; its owner still closes that consumer.
 */
export function openBoundedProviderStream(
	broker: ProviderHttpBroker,
	args: ProviderStreamArguments,
	sink: ProviderStreamSink,
	options: ProviderStreamOptions = {},
): ProviderHttpStream {
	const settings = data(options, ["maxBytes", "maxEvents", "timeoutMs", "onProgress"]);
	const maxBytes = limit(settings.maxBytes, HOST_MAX_STREAM_BYTES, 0, HOST_MAX_STREAM_BYTES);
	const maxEvents = limit(
		settings.maxEvents,
		MAX_PROVIDER_STREAM_EVENTS,
		1,
		MAX_PROVIDER_STREAM_EVENTS,
	);
	const timeoutMs = limit(settings.timeoutMs, HOST_REQUEST_TIMEOUT_MS, 1, HOST_REQUEST_TIMEOUT_MS);
	const progress = settings.onProgress;
	if (typeof sink !== "function" || (progress !== undefined && typeof progress !== "function"))
		throw refused();
	const signal = args[5];
	if (signal.aborted) {
		const response = Promise.reject<HostFetchResult>(refused());
		const completion = Promise.reject<void>(refused());
		void response.catch(() => {});
		void completion.catch(() => {});
		return Object.freeze({ response, completion, start(): void {}, cancel(): void {} });
	}
	const stopped = new AbortController();
	let native: ProviderHttpStream | undefined;
	let streamId: string | undefined;
	let started = false,
		terminal = false,
		terminalAcknowledged = false,
		receiving = false,
		busy = false,
		finished = false;
	let bytes = 0,
		events = 0,
		nextSequence = 0;
	let failure: ProviderStreamBoundaryError | undefined;
	let resolveResponse: (value: HostFetchResult) => void = () => {};
	let rejectResponse: (error: ProviderStreamBoundaryError) => void = () => {};
	const response = new Promise<HostFetchResult>((resolve, reject) => {
		resolveResponse = resolve;
		rejectResponse = reject;
	});
	const snapshot = (): Readonly<ProviderStreamProgress> => Object.freeze({ bytes, events });
	const deadline = performance.now() + timeoutMs;
	const timer = setTimeout(() => fail(), timeoutMs);
	const abort = addAbortListener(signal, () => fail());
	const dispose = (): void => {
		clearTimeout(timer);
		abort[Symbol.dispose]();
	};
	function fail(): ProviderStreamBoundaryError {
		if (failure) return failure;
		failure = refused();
		// Reserve the last slot for one content-free terminal, never an extra frame.
		// An outstanding ACK cannot accept an ordered concurrent terminal.
		if (started && streamId && !terminal && !busy && events < maxEvents && !signal.aborted) {
			terminal = true;
			const notification: HostNotification = Object.freeze({
				jsonrpc: "2.0",
				method: "host/stream.chunk",
				params: Object.freeze({
					streamId,
					sequence: events++,
					base64: "",
					done: true,
					error: "DENIED",
				}),
			});
			try {
				// The sink is the accepted native transport callback, not an authorization hook.
				// A sink ignoring cancellation may remain pending; no physical-drain claim is made.
				void Promise.resolve(sink(notification, signal)).catch(() => {});
			} catch {}
		}
		stopped.abort();
		dispose();
		rejectResponse(failure);
		try {
			native?.cancel();
		} catch {}
		return failure;
	}
	function live(): void {
		if (failure || finished || signal.aborted || performance.now() >= deadline) throw fail();
	}
	const receive: ProviderStreamSink = async (notification, transportSignal) => {
		if (receiving) throw fail();
		receiving = true;
		try {
			live();
			if (terminal || busy || !started || !streamId) throw fail();
			const outer = data(notification, ["jsonrpc", "method", "params"]);
			if (outer.jsonrpc !== "2.0" || outer.method !== "host/stream.chunk") throw fail();
			const fields = data(outer.params, ["streamId", "sequence", "base64", "done", "error"]);
			// Check encoded length, canonical trailing bits and decoded size without a byte allocation.
			const length = chunkBytes(fields.base64);
			const chunk = HostStreamChunk.parse(fields);
			if (chunk.streamId !== streamId || chunk.sequence !== nextSequence++) throw fail();
			if (length > maxBytes - bytes || events >= maxEvents) throw fail();
			if (!chunk.done && events + 1 >= maxEvents) throw fail();
			if (chunk.error && (!chunk.done || length !== 0)) throw fail();
			const captured: HostNotification = Object.freeze({
				jsonrpc: "2.0",
				method: "host/stream.chunk",
				params: Object.freeze(chunk),
			});
			bytes += length;
			events++;
			terminal = chunk.done;
			busy = true;
			try {
				const deliverySignal = AbortSignal.any(
					chunk.error === "DENIED"
						? [signal, stopped.signal]
						: [signal, stopped.signal, transportSignal],
				);
				await wait(
					Promise.resolve().then(() => {
						live();
						deliverySignal.throwIfAborted();
						return sink(captured, deliverySignal);
					}),
					deliverySignal,
				);
			} catch {
				throw fail();
			} finally {
				busy = false;
			}
			live();
			if (chunk.error) throw fail();
			if (progress) {
				const update = snapshot();
				await wait(
					Promise.resolve().then(() => {
						live();
						return progress(update);
					}),
					stopped.signal,
				);
				live();
			}
			if (chunk.done) terminalAcknowledged = true;
		} catch {
			throw fail();
		} finally {
			receiving = false;
		}
	};
	try {
		// Preserve all six native arguments, especially the original credential-binding signal.
		native = broker.stream(...args, receive);
		if (failure) native.cancel();
	} catch {
		fail();
		void response.catch(() => {});
		throw refused();
	}
	void native.response.then(
		(value) => {
			try {
				live();
				const header = HostFetchResult.parse(
					data(value, ["status", "headers", "body", "streamId"]),
				);
				if (!header.streamId || header.body !== undefined) throw fail();
				streamId = header.streamId;
				resolveResponse(header);
			} catch {
				fail();
			}
		},
		() => fail(),
	);
	const completion = native.completion.then(
		() => {
			live();
			if (!terminalAcknowledged) throw fail();
			finished = true;
			dispose();
		},
		() => {
			throw fail();
		},
	);
	// Either lifecycle promise may be awaited first without an unhandled background rejection.
	void response.catch(() => {});
	void completion.catch(() => {});
	return Object.freeze({
		response,
		completion,
		start(): void {
			if (started || failure || finished) return;
			live();
			if (!streamId) throw fail();
			started = true;
			try {
				native.start();
			} catch {
				throw fail();
			}
		},
		cancel(): void {
			if (!finished) fail();
		},
	});
}
