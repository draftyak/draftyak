import { Hono } from "hono";
import { type Clock, checkDelay, createFaults, type Faults, wait } from "./faults.ts";
import type { Recorder } from "./recorder.ts";
import { createFake, type Fake } from "./server.ts";
import { rawTarget } from "./target.ts";

/** A logical host only: fetch is in memory; listen binds exclusively to loopback. */
export const RESPONSES_API_HOST = "api.openai.com";
export const RESPONSES_API_PATH = "/v1/responses";

interface Delivery {
	readonly status?: number;
	readonly headers?: Readonly<Record<string, string>>;
	/** Header delay; Infinity waits until the request aborts. */
	readonly delayMs?: number;
}
interface Chunking {
	readonly chunkBytes?: number;
	/** Delay between chunks, never before the first; Infinity waits until canceled. */
	readonly chunkDelayMs?: number;
}

export type ResponsesApiStep = Delivery &
	(
		| { readonly kind: "json"; readonly body: unknown }
		| (Chunking & {
				readonly kind: "sse";
				readonly events: readonly { readonly event: string; readonly data: unknown }[];
		  })
		| (Chunking & { readonly kind: "raw"; readonly body: string; readonly contentType?: string })
	);

export interface ResponsesApiFakeOptions {
	readonly clock?: Clock;
	readonly recorder?: Recorder;
	readonly steps?: readonly ResponsesApiStep[];
}
export interface ResponsesApiFake extends Fake {
	/** The same application handler, without the shared intake, recording or fault wrapper. */
	readonly handler: (request: Request) => Promise<Response>;
	/** Snapshots finite wire bytes now; later mutations of test data cannot change a response. */
	enqueue(...steps: ResponsesApiStep[]): void;
	/** Steps not yet admitted to the app; includes neither active delays nor active streams. */
	pending(): number;
}

interface Prepared {
	readonly bytes: Uint8Array;
	readonly status: number;
	readonly headers: Headers;
	readonly delayMs: number;
	readonly chunkBytes: number;
	readonly chunkDelayMs: number;
}

// Fake admission limits, not provider/native caps: scripts can exceed the consumer's limits.
const MAX_STEPS = 1024;
const MAX_EVENTS = 4096;
const MAX_BYTES = 16 * 1024 * 1024;
const MAX_QUEUED_BYTES = 64 * 1024 * 1024;
const MAX_CHUNK = 65_536;
const MAX_CHUNKS = 65_536;
const MAX_REQUEST_BYTES = 1024 * 1024;
const encoder = new TextEncoder();

function encoded(text: string, cap: number): Uint8Array {
	if (text.length > cap) throw new RangeError("Scripted response exceeds its byte budget");
	const bytes = encoder.encode(text);
	if (bytes.byteLength > cap) throw new RangeError("Scripted response exceeds its byte budget");
	return bytes;
}

function json(value: unknown): string {
	const text = JSON.stringify(value);
	if (text === undefined) throw new TypeError("A scripted JSON value must serialize");
	return text;
}

function prepare(step: ResponsesApiStep, available: number): Prepared {
	const cap = Math.min(MAX_BYTES, available);
	const status = step.status ?? 200;
	if (!Number.isInteger(status) || status < 200 || status > 599 || [204, 205, 304].includes(status))
		throw new RangeError("A scripted response needs a status that permits a body");
	const delayMs = step.delayMs ?? 0;
	const chunkDelayMs = step.kind === "json" ? 0 : (step.chunkDelayMs ?? 0);
	const chunkBytes = step.kind === "json" ? MAX_CHUNK : (step.chunkBytes ?? MAX_CHUNK);
	checkDelay("delayMs", delayMs);
	checkDelay("chunkDelayMs", chunkDelayMs);
	if (!Number.isInteger(chunkBytes) || chunkBytes < 1 || chunkBytes > MAX_CHUNK)
		throw new RangeError("chunkBytes must be from 1 to 65536");
	let body: string;
	let contentType: string;
	switch (step.kind) {
		case "json":
			body = json(step.body);
			contentType = "application/json";
			break;
		case "sse": {
			if (step.events.length > MAX_EVENTS) throw new RangeError("Too many scripted events");
			const frames: string[] = [];
			let length = 0;
			let events = 0;
			for (const entry of step.events) {
				if (++events > MAX_EVENTS) throw new RangeError("Too many scripted events");
				const { event, data } = entry;
				if (!/^[A-Za-z0-9_.-]{1,128}$/.test(event)) throw new TypeError("Invalid SSE event name");
				const frame = `event: ${event}\ndata: ${json(data)}\n\n`;
				length += encoded(frame, cap - length).byteLength;
				frames.push(frame);
			}
			body = frames.join("");
			contentType = "text/event-stream";
			break;
		}
		case "raw":
			if (typeof step.body !== "string") throw new TypeError("A raw body must be a string");
			body = step.body;
			contentType = step.contentType ?? "application/json";
			break;
		default:
			throw new TypeError("Unknown scripted response kind");
	}
	const bytes = encoded(body, cap);
	if (Math.ceil(bytes.byteLength / chunkBytes) > MAX_CHUNKS)
		throw new RangeError("Scripted response exceeds 65536 chunks");
	const headers = new Headers(step.headers);
	if (!headers.has("content-type")) headers.set("content-type", contentType);
	return { bytes, status, headers, delayMs, chunkBytes, chunkDelayMs };
}

function streamed(step: Prepared, signal: AbortSignal): ReadableStream<Uint8Array> {
	const local = new AbortController();
	let offset = 0;
	let ended = false;
	let abort: () => void;
	const finish = (): void => {
		ended = true;
		signal.removeEventListener("abort", abort);
	};
	return new ReadableStream<Uint8Array>({
		start(controller) {
			abort = () => {
				if (ended) return;
				finish();
				local.abort(signal.reason);
				controller.error(signal.reason);
			};
			signal.addEventListener("abort", abort, { once: true });
			if (signal.aborted) abort();
		},
		async pull(controller) {
			if (ended) return;
			try {
				if (offset > 0 && step.chunkDelayMs > 0) await wait(step.chunkDelayMs, local.signal);
				local.signal.throwIfAborted();
				if (ended) return;
				const end = Math.min(offset + step.chunkBytes, step.bytes.byteLength);
				if (end > offset) controller.enqueue(step.bytes.slice(offset, end));
				offset = end;
				if (offset === step.bytes.byteLength) {
					finish();
					controller.close();
				}
			} catch (error) {
				if (!ended) {
					finish();
					controller.error(error);
				}
			}
		},
		cancel(reason) {
			if (ended) return;
			finish();
			local.abort(reason);
		},
	});
}

function object(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function keys(
	value: Record<string, unknown>,
	required: readonly string[],
	optional: readonly string[] = [],
): boolean {
	return (
		required.every((key) => Object.hasOwn(value, key)) &&
		Object.keys(value).every((key) => required.includes(key) || optional.includes(key))
	);
}

function draftShape(body: unknown): boolean {
	if (!object(body)) return false;
	if (!keys(body, ["model", "instructions", "input", "text", "stream", "store"], ["reasoning"]))
		return false;
	if (typeof body.model !== "string" || body.model.length === 0) return false;
	if (typeof body.instructions !== "string") return false;
	if (body.store !== false) return false;
	if (body.stream !== true) return false;
	if (!Array.isArray(body.input) || body.input.length !== 1) return false;
	const input: unknown = body.input[0];
	if (!object(input) || !keys(input, ["role", "content"])) return false;
	if (input.role !== "user" || typeof input.content !== "string") return false;
	if (!object(body.text) || !keys(body.text, ["format"])) return false;
	const format = body.text.format;
	if (!object(format) || !keys(format, ["type", "name", "strict", "schema"])) return false;
	if (format.type !== "json_schema" || format.name !== "draft_output" || format.strict !== true)
		return false;
	if (!object(format.schema)) return false;
	if (Object.hasOwn(body, "reasoning")) {
		const reasoning = body.reasoning;
		if (!object(reasoning) || !keys(reasoning, ["effort"])) return false;
		if (typeof reasoning.effort !== "string" || reasoning.effort.length === 0) return false;
	}
	return true;
}

async function readBody(request: Request): Promise<Uint8Array | undefined> {
	request.signal.throwIfAborted();
	if (!request.body) return new Uint8Array(0);
	const reader = request.body.getReader();
	let canceled = false;
	const cancel = (): void => {
		if (canceled) return;
		canceled = true;
		// A caller's tee may have another reader; never wait for its cancellation here.
		void reader.cancel(request.signal.reason).catch(() => {});
	};
	request.signal.addEventListener("abort", cancel, { once: true });
	let bytes = new Uint8Array(4096);
	let size = 0;
	let chunks = 0;
	try {
		request.signal.throwIfAborted();
		for (;;) {
			const next = await reader.read();
			request.signal.throwIfAborted();
			if (next.done) break;
			if (!(next.value instanceof Uint8Array)) throw new TypeError("Invalid request body chunk");
			if (++chunks > MAX_CHUNKS || next.value.byteLength > MAX_REQUEST_BYTES - size) {
				cancel();
				return undefined;
			}
			const needed = size + next.value.byteLength;
			if (needed > bytes.byteLength) {
				const grown = new Uint8Array(
					Math.max(needed, Math.min(MAX_REQUEST_BYTES, bytes.byteLength * 2)),
				);
				grown.set(bytes.subarray(0, size));
				bytes = grown;
			}
			bytes.set(next.value, size);
			size = needed;
		}
	} catch (error) {
		cancel();
		throw error;
	} finally {
		request.signal.removeEventListener("abort", cancel);
		reader.releaseLock();
	}
	return bytes.subarray(0, size);
}

async function acceptsDraft(request: Request): Promise<boolean> {
	if (
		!/^\s*application\/json\s*(?:;\s*charset\s*=\s*(?:utf-8|"utf-8")\s*)?$/i.test(
			request.headers.get("content-type") ?? "",
		)
	)
		return false;
	const bytes = await readBody(request);
	if (bytes === undefined) return false;
	let body: unknown;
	try {
		body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
	} catch {
		return false;
	}
	return draftShape(body);
}

/**
 * Finite scripted Responses JSON/SSE. This fixture implements no request verifier or authority.
 * Matching POSTs consume at app admission, before awaits; pre-app fault delays may reorder them.
 * A pre-app fault consumes no step, an after-app fault does. Exhaustion returns a fixed 503.
 * Recorder retains its existing configured body prefix/hash and selected header-value policy.
 * Test-script admission: 1024 queued steps, 64 MiB queued response bytes, 4096 SSE events,
 * 16 MiB and 65536 chunks per step. Shared request intake is capped at 1 MiB before the app.
 */
export function createResponsesApiFake(options: ResponsesApiFakeOptions = {}): ResponsesApiFake {
	return createResponsesApi(options, false);
}

/**
 * Adds the closed DraftYak API-key draft-request shape to the generic scripted fake.
 * Schema contents remain opaque; no native pin, prompt, credential or header authority is checked.
 * JSON permits only an optional UTF-8 charset; decoding is fatal and duplicate members use
 * JSON.parse's last-member semantics. The shared wrapper admits at most 1 MiB before cloning
 * or invoking the app. Defensive app reads also cap bytes and 65536 yielded app chunks,
 * including empty chunks; buffered shared intake does not retain original ingress chunk counts.
 * Invalid matching POSTs consume a step before any await and return a fixed, content-free 400;
 * exhaustion still returns 503 first. Abort and source read failures retain their normal rejection.
 */
export function createResponsesApiDraftFake(
	options: ResponsesApiFakeOptions = {},
): ResponsesApiFake {
	return createResponsesApi(options, true);
}

function createResponsesApi(options: ResponsesApiFakeOptions, strict: boolean): ResponsesApiFake {
	const queue: Prepared[] = [];
	let queuedBytes = 0;
	let preparing = false;
	const enqueue = (...steps: ResponsesApiStep[]): void => {
		if (preparing) throw new TypeError("Cannot enqueue while preparing a script");
		if (queue.length + steps.length > MAX_STEPS) throw new RangeError("Too many scripted steps");
		preparing = true;
		try {
			const prepared: Prepared[] = [];
			let bytes = 0;
			for (const step of steps) {
				const next = prepare(step, MAX_QUEUED_BYTES - queuedBytes - bytes);
				bytes += next.bytes.byteLength;
				prepared.push(next);
			}
			queue.push(...prepared);
			queuedBytes += bytes;
		} finally {
			preparing = false;
		}
	};
	enqueue(...(options.steps ?? []));
	const baseFaults = createFaults({ clock: options.clock });
	// Shared after-app faults may replace an answer; release the discarded stream's own waits.
	const faults: Faults = {
		...baseFaults,
		async run(request, app) {
			let answered: Response | undefined;
			let result: Response | undefined;
			try {
				result = await baseFaults.run(request, async (forwarded) => {
					answered = await app(forwarded);
					return answered;
				});
				return result;
			} finally {
				if (answered?.body && answered.body !== result?.body) await answered.body.cancel();
			}
		},
	};
	const handler = async (request: Request): Promise<Response> => {
		if (rawTarget(request) !== RESPONSES_API_PATH) return new Response(null, { status: 404 });
		if (request.method !== "POST") return new Response(null, { status: 405 });
		const step = queue.shift();
		if (step) queuedBytes -= step.bytes.byteLength;
		if (!step)
			return Response.json(
				{
					error: {
						type: "server_error",
						code: "script_exhausted",
						message: "Synthetic exhaustion",
					},
				},
				{ status: 503 },
			);
		if (strict) {
			if (!(await acceptsDraft(request)))
				return Response.json(
					{
						error: {
							type: "invalid_request_error",
							code: "request_refused",
							message: "Synthetic request refused",
						},
					},
					{ status: 400 },
				);
		} else {
			if ((await readBody(request)) === undefined)
				return Response.json({ error: "request_body_too_large" }, { status: 413 });
		}
		request.signal.throwIfAborted();
		if (step.delayMs > 0) await wait(step.delayMs, request.signal);
		request.signal.throwIfAborted();
		return new Response(streamed(step, request.signal), {
			status: step.status,
			headers: step.headers,
		});
	};
	const app = new Hono();
	app.onError((error) => {
		throw error;
	});
	app.all("*", (context) => handler(context.req.raw));
	const fake = createFake(app, {
		host: RESPONSES_API_HOST,
		recorder: options.recorder,
		faults,
		maxRequestBodyBytes: MAX_REQUEST_BYTES,
	});
	return { ...fake, handler, enqueue, pending: () => queue.length };
}
