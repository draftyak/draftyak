import { performance } from "node:perf_hooks";
import type { DraftOutcome, DraftRequest } from "@draftyak/protocol/ai-provider-v1";
import { parseStrict } from "@draftyak/protocol/jcs";
import { _iterSSEMessages } from "openai/core/streaming";
import { buildRequest, type ResponsesRequest, type Settings } from "./request.ts";
import { readDraft } from "./response.ts";
import { normalizeError, ResponsesError, record } from "./shared.ts";

export type CompletedTransport = (
	request: ResponsesRequest,
	options: { readonly signal?: AbortSignal },
) => Promise<unknown>;

// The injected transport aggregates the SDK stream; this core never constructs a client or initiates I/O itself.
export async function generateDraft(
	input: DraftRequest,
	settings: Settings,
	transport: CompletedTransport,
	signal?: AbortSignal,
): Promise<DraftOutcome> {
	if (signal?.aborted) throw new ResponsesError("ABORTED");
	const request = buildRequest(input, settings);
	const contextIds = [...input.contextIds];
	let response: unknown;
	try {
		response = await transport(request, { signal });
	} catch (error) {
		throw signal?.aborted ? new ResponsesError("ABORTED") : normalizeError(error);
	}
	if (signal?.aborted) throw new ResponsesError("ABORTED");
	return readDraft(response, contextIds);
}

// Local consumer limits, separate from native execution policy and final draft-text limits.
export const MAX_WIRE_BYTES: number = 8 * 1024 * 1024;
export const MAX_RECORD_BYTES: number = 2 * 1024 * 1024;
export const MAX_EVENT_BYTES: number = 1792 * 1024;
export const MAX_WIRE_RECORDS = 16_384;
export const MAX_WIRE_EVENTS = 8_192;
export const MAX_WIRE_READS = 65_536;
export const MAX_FORWARDED_BYTES: number = 16 * 1024;
export const MAX_ERROR_BYTES: number = 64 * 1024;
export const CONSUMER_TIMEOUT_MS = 30_000;
export const MAX_METADATA_BYTES: number = 1024 * 1024;

const transient = (): ResponsesError => new ResponsesError("TRANSIENT");

function cancelBody(response: Response): void {
	try {
		void Promise.resolve(response.body?.cancel()).catch(() => undefined);
	} catch {
		// A late or failed response cannot delay the settled consumer.
	}
}

/** Bounded model metadata; no SDK body decoder or pagination runs. */
export async function metadataResponse(
	send: (signal: AbortSignal) => Promise<Response>,
	caller?: AbortSignal,
	modelLookup = false,
): Promise<unknown> {
	const deadline = performance.now() + CONSUMER_TIMEOUT_MS;
	const expired = (): boolean => performance.now() >= deadline;
	if (caller?.aborted) throw new ResponsesError("ABORTED");
	const controller = new AbortController();
	let response: Response | undefined;
	let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
	let ended = false;
	let reads = 0;
	let stopped = false;
	let reject: (reason: ResponsesError) => void = () => {};
	const interrupted = new Promise<never>((_resolve, no) => {
		reject = no;
	});
	void interrupted.catch(() => undefined);
	const stop = (): void => {
		if (stopped) return;
		stopped = true;
		controller.abort();
		try {
			if (!ended && reader) void Promise.resolve(reader.cancel()).catch(() => undefined);
			else if (!ended && response) cancelBody(response);
		} catch {
			// A cancellation hook cannot delay the bounded metadata result.
		}
	};
	const abort = (): void => {
		reject(caller?.aborted ? new ResponsesError("ABORTED") : transient());
		stop();
	};
	caller?.addEventListener("abort", abort, { once: true });
	const timer = setTimeout(abort, CONSUMER_TIMEOUT_MS);
	try {
		response = await Promise.race([
			Promise.resolve()
				.then(() => {
					if (controller.signal.aborted || expired()) throw transient();
					return send(controller.signal);
				})
				.then((received) => {
					if (controller.signal.aborted || expired()) {
						cancelBody(received);
						throw transient();
					}
					return received;
				}),
			interrupted,
		]);
		if (controller.signal.aborted || expired()) throw transient();
		if (modelLookup && response.status === 404) throw new ResponsesError("INVALID_INPUT");
		if (!response.body) throw response.ok ? transient() : normalizeError(response);
		reader = response.body.getReader();
		const decoder = new TextDecoder("utf-8", { fatal: true });
		const limit = response.ok ? MAX_METADATA_BYTES : MAX_ERROR_BYTES;
		let bytes = 0;
		let text = "";
		try {
			for (;;) {
				if (++reads > MAX_WIRE_READS || controller.signal.aborted || expired()) throw transient();
				const next = await Promise.race([reader.read(), interrupted]);
				if (controller.signal.aborted || expired()) throw transient();
				if (next.done) {
					ended = true;
					break;
				}
				if (!(next.value instanceof Uint8Array)) throw transient();
				bytes += next.value.byteLength;
				if (bytes > limit) throw transient();
				text += decoder.decode(next.value, { stream: true });
			}
			text += decoder.decode();
		} catch (error) {
			if (caller?.aborted || expired() || response.ok) throw error;
			// A malformed optional error body does not erase the known HTTP status/hint.
			throw normalizeError({ status: response.status, headers: response.headers });
		}
		if (expired()) throw transient();
		let value: unknown;
		try {
			value = parseStrict(text);
		} catch (error) {
			if (response.ok) throw error;
		}
		if (expired()) throw transient();
		if (!response.ok) {
			if (modelLookup && response.status === 404) throw new ResponsesError("INVALID_INPUT");
			throw normalizeError({
				status: response.status,
				headers: response.headers,
				result: record(value) ? value.result : undefined,
				error: record(value) && record(value.error) ? value.error : value,
			});
		}
		if (
			response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !==
			"application/json"
		)
			throw transient();
		stop();
		if (caller?.aborted || expired()) throw transient();
		return value;
	} catch (error) {
		throw caller?.aborted
			? new ResponsesError("ABORTED")
			: expired()
				? transient()
				: normalizeError(error);
	} finally {
		clearTimeout(timer);
		caller?.removeEventListener("abort", abort);
		stop();
		try {
			reader?.releaseLock();
		} catch {
			/* A detached pending read cannot replace the result. */
		}
	}
}

/** Internal wire conversion; the caller supplies this package's SDK request operation. */
export async function completedResponse(
	send: (signal: AbortSignal) => Promise<Response>,
	caller?: AbortSignal,
): Promise<unknown> {
	const deadline = performance.now() + CONSUMER_TIMEOUT_MS;
	const expired = (): boolean => performance.now() >= deadline;
	if (caller?.aborted) throw new ResponsesError("ABORTED");
	const controller = new AbortController();
	let response: Response | undefined;
	let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
	let ended = false;
	let cancelled = false;
	let reads = 0;
	const cancel = (): void => {
		if (cancelled || ended || (!reader && !response)) return;
		cancelled = true;
		try {
			if (reader) void Promise.resolve(reader.cancel()).catch(() => undefined);
			else if (response) cancelBody(response);
		} catch {
			// Cleanup is detached from cancellation and failure results.
		}
	};
	let interrupt: (reason: ResponsesError) => void = () => {};
	const interrupted = new Promise<never>((_resolve, reject) => {
		interrupt = reject;
	});
	void interrupted.catch(() => undefined);
	const stop = (): void => {
		controller.abort();
		cancel();
	};
	const abort = (): void => {
		interrupt(caller?.aborted ? new ResponsesError("ABORTED") : transient());
		stop();
	};
	caller?.addEventListener("abort", abort, { once: true });
	const timer = setTimeout(abort, CONSUMER_TIMEOUT_MS);
	const read = async (): Promise<ReadableStreamReadResult<Uint8Array>> => {
		if (++reads > MAX_WIRE_READS || controller.signal.aborted || expired() || !reader)
			throw transient();
		const next = await Promise.race([reader.read(), interrupted]);
		if (controller.signal.aborted || expired()) throw transient();
		if (next.done) ended = true;
		else if (!(next.value instanceof Uint8Array)) throw transient();
		return next;
	};
	try {
		response = await Promise.race([
			Promise.resolve()
				.then(() => {
					if (controller.signal.aborted || expired()) throw transient();
					return send(controller.signal);
				})
				.then((received) => {
					if (controller.signal.aborted || expired()) {
						cancelBody(received);
						throw transient();
					}
					return received;
				}),
			interrupted,
		]);
		if (controller.signal.aborted || expired()) throw transient();
		const status = response.status;
		const headers = response.headers;
		const body = response.body;
		if (!body) {
			if (!response.ok) throw normalizeError({ status, headers });
			throw transient();
		}
		reader = body.getReader();
		const utf8 = new TextDecoder("utf-8", { fatal: true });
		if (!response.ok) {
			let text = "";
			let bytes = 0;
			for (;;) {
				const next = await read();
				if (next.done) break;
				bytes += next.value.byteLength;
				if (bytes > MAX_ERROR_BYTES) throw transient();
				text += utf8.decode(next.value, { stream: true });
			}
			text += utf8.decode();
			if (expired()) throw transient();
			let error: unknown;
			try {
				error = JSON.parse(text);
			} catch {
				// The known HTTP status still maps to a content-free canonical error.
			}
			if (expired()) throw transient();
			throw normalizeError({
				status,
				headers,
				result: record(error) ? error.result : undefined,
				error: record(error) && record(error.error) ? error.error : error,
			});
		}
		if (headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "text/event-stream")
			throw transient();
		let total = 0;
		let recordBytes = 0;
		let lineBytes = 0;
		let records = 0;
		let skipLF = false;
		let crClosedRecord = false;
		let closedRecordBytes = 0;
		const scan = (chunk: Uint8Array): void => {
			for (const byte of chunk) {
				if (skipLF && byte === 10) {
					skipLF = false;
					if (crClosedRecord) {
						if (closedRecordBytes + 1 > MAX_RECORD_BYTES) throw transient();
					} else if (++recordBytes > MAX_RECORD_BYTES) throw transient();
					continue;
				}
				skipLF = false;
				if (++recordBytes > MAX_RECORD_BYTES) throw transient();
				if (byte === 10 || byte === 13) {
					crClosedRecord = lineBytes === 0;
					if (crClosedRecord) {
						if (++records > MAX_WIRE_RECORDS) throw transient();
						closedRecordBytes = recordBytes;
						recordBytes = 0;
					}
					lineBytes = 0;
					skipLF = byte === 13;
				} else lineBytes++;
			}
		};
		let pending: Uint8Array | undefined;
		let offset = 0;
		let wireFailed = false;
		const bounded = new ReadableStream<Uint8Array>(
			{
				async pull(sink) {
					try {
						if (controller.signal.aborted || expired()) throw transient();
						if (!pending || offset === pending.byteLength) {
							const next = await read();
							if (next.done) {
								utf8.decode();
								if (recordBytes && ++records > MAX_WIRE_RECORDS) throw transient();
								sink.close();
								return;
							}
							total += next.value.byteLength;
							if (total > MAX_WIRE_BYTES) throw transient();
							pending = next.value;
							offset = 0;
						}
						const chunk = pending.slice(offset, offset + MAX_FORWARDED_BYTES);
						scan(chunk);
						utf8.decode(chunk, { stream: true });
						if (expired()) throw transient();
						offset += chunk.byteLength;
						sink.enqueue(chunk);
					} catch {
						wireFailed = true;
						stop();
						sink.error(transient());
					}
				},
				cancel,
			},
			{ highWaterMark: 0 },
		);
		const messages = _iterSSEMessages(new Response(bounded, { status, headers }), controller);
		let terminal: unknown;
		let hasTerminal = false;
		let done = false;
		let events = 0;
		try {
			for (;;) {
				if (expired()) throw transient();
				const next = await Promise.race([messages.next(), interrupted]);
				if (expired()) throw transient();
				if (next.done) break;
				const sse = next.value;
				if (
					++events > MAX_WIRE_EVENTS ||
					sse.data.length > MAX_EVENT_BYTES ||
					Buffer.byteLength(sse.data) > MAX_EVENT_BYTES ||
					done
				)
					throw transient();
				if (expired()) throw transient();
				if (sse.data === "[DONE]") {
					if (!hasTerminal) throw transient();
					done = true;
					continue;
				}
				const event: unknown = JSON.parse(sse.data);
				if (expired()) throw transient();
				if (
					!record(event) ||
					typeof event.type !== "string" ||
					(sse.event !== null && sse.event !== event.type) ||
					hasTerminal
				)
					throw transient();
				if (event.type === "error") throw normalizeError({ error: event, headers });
				if (
					event.type === "response.completed" ||
					event.type === "response.failed" ||
					event.type === "response.incomplete"
				) {
					if (!record(event.response) || event.response.status !== event.type.slice(9))
						throw transient();
					hasTerminal = true;
					terminal = event.response;
				} else if (!event.type.startsWith("response.")) throw transient();
			}
		} finally {
			// Abort first: SDK iterator cleanup must not await a pending body cancellation.
			controller.abort();
			void messages.return().catch(() => undefined);
		}
		if (!hasTerminal || caller?.aborted || !ended || wireFailed || expired()) throw transient();
		return terminal;
	} catch (error) {
		throw caller?.aborted
			? new ResponsesError("ABORTED")
			: expired()
				? transient()
				: normalizeError(error);
	} finally {
		clearTimeout(timer);
		caller?.removeEventListener("abort", abort);
		stop();
		try {
			reader?.releaseLock();
		} catch {
			// A detached pending read cannot replace the result.
		}
	}
}
