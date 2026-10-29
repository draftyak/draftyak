import { type Clock, checkDelay, createFaults, type Faults, wait } from "./faults.ts";
import type { Recorder } from "./recorder.ts";
import { createFake, type Fake } from "./server.ts";
import { rawTarget } from "./target.ts";

interface MessagesApiReply {
	readonly status?: number;
	readonly headers?: HeadersInit;
	readonly delayMs?: number;
}

interface MessagesApiChunks {
	readonly chunkBytes?: number;
	readonly chunkDelayMs?: number;
}

export interface MessagesApiEvent {
	readonly event: string;
	readonly data: unknown;
}

/** Trusted synthetic wire fixtures; raw steps also express deliberately malformed responses. */
export type MessagesApiStep = MessagesApiReply &
	(
		| { readonly kind: "json"; readonly body: unknown }
		| (MessagesApiChunks & { readonly kind: "sse"; readonly events: readonly MessagesApiEvent[] })
		| (MessagesApiChunks & {
				readonly kind: "raw";
				readonly body: string;
				readonly contentType?: string;
		  })
	);

export interface MessagesApiOptions {
	readonly clock?: Clock;
	readonly recorder?: Recorder;
	readonly steps?: readonly MessagesApiStep[];
}

export interface MessagesApiFake extends Fake {
	/** Atomically encodes and detaches trusted fixtures from subsequent caller mutations. */
	enqueue(...steps: readonly MessagesApiStep[]): void;
	pending(): number;
}

interface Prepared {
	readonly bytes: Uint8Array<ArrayBuffer>;
	readonly status: number;
	readonly headers: readonly [string, string][];
	readonly delayMs: number;
	readonly chunkBytes: number;
	readonly chunkDelayMs: number;
	readonly streamed: boolean;
}

// Harness resource limits, not provider or native consumer acceptance limits. The chunk bound
// prevents a large one-byte script from scheduling millions of individual pulls.
const MAX_STEPS = 1_024;
const MAX_EVENTS = 4_096;
const MAX_BYTES = 16 * 1_024 * 1_024;
const MAX_QUEUED_BYTES = 64 * 1_024 * 1_024;
const MAX_CHUNKS = 65_536;
const MAX_REQUEST_BYTES = 1_024 * 1_024;
const MAX_METADATA_TARGET = 4_096;
const encoder = new TextEncoder();

// URI spelling is separate from model admission. These fixtures also exercise malformed
// metadata, so an opaque path segment or cursor does not assert that a model exists.
function metadataComponent(value: string, query = false): boolean {
	const spelling = query
		? /^(?:[A-Za-z\d._~!$'()*+,;=:@/?-]|%[A-Fa-f\d]{2})+$/
		: /^(?:[A-Za-z\d._~!$&'()*+,;=:@-]|%[A-Fa-f\d]{2})+$/;
	if (!spelling.test(value)) return false;
	try {
		const decoded = decodeURIComponent(query ? value.replaceAll("+", " ") : value);
		return decoded.isWellFormed() && (query || (decoded !== "." && decoded !== ".."));
	} catch {
		return false;
	}
}

function metadataTarget(target: string): boolean {
	if (target.length > MAX_METADATA_TARGET) return false;
	const question = target.indexOf("?");
	if (question === -1)
		return (
			target.startsWith("/v1/models/") && metadataComponent(target.slice("/v1/models/".length))
		);
	if (target.slice(0, question) !== "/v1/models") return false;
	const pairs = target.slice(question + 1).split("&");
	if (pairs.length < 1 || pairs.length > 2) return false;
	let limit = false;
	let cursor = false;
	for (const pair of pairs) {
		if (pair === "limit=100" && !limit) limit = true;
		else if (pair.startsWith("after_id=") && !cursor && metadataComponent(pair.slice(9), true))
			cursor = true;
		else return false;
	}
	return limit;
}

function json(value: unknown): string {
	const encoded = JSON.stringify(value);
	if (encoded === undefined) throw new TypeError("Messages fake JSON must encode a value");
	return encoded;
}

function encoded(text: string, limit = MAX_BYTES): Uint8Array<ArrayBuffer> {
	if (text.length > limit) throw new RangeError("Messages fake byte limit");
	const bytes = encoder.encode(text);
	if (bytes.byteLength > limit) throw new RangeError("Messages fake byte limit");
	return bytes;
}

function prepare(step: MessagesApiStep, available: number): Prepared {
	const kind = step.kind;
	const limit = Math.min(MAX_BYTES, available);
	const delayMs = step.delayMs ?? 0;
	const streamed = kind !== "json";
	const chunkBytes = streamed ? (step.chunkBytes ?? 65_536) : 65_536;
	const chunkDelayMs = streamed ? (step.chunkDelayMs ?? 0) : 0;
	checkDelay("Messages fake delayMs", delayMs);
	checkDelay("Messages fake chunkDelayMs", chunkDelayMs);
	if (!(Number.isInteger(chunkBytes) && chunkBytes >= 1 && chunkBytes <= 65_536)) {
		throw new RangeError("Messages fake chunkBytes must be from 1 to 65536");
	}
	let text: string;
	let contentType: string;
	if (kind === "sse") {
		if (step.events.length > MAX_EVENTS) throw new RangeError("Messages fake event limit");
		const frames: string[] = [];
		let length = 0;
		let events = 0;
		for (const item of step.events) {
			if (++events > MAX_EVENTS) throw new RangeError("Messages fake event limit");
			const { event, data } = item;
			if (!/^[A-Za-z][A-Za-z0-9_]{0,127}$/.test(event)) {
				throw new TypeError("Messages fake SSE event name is invalid");
			}
			const frame = `event: ${event}\ndata: ${json(data)}\n\n`;
			length += encoded(frame, limit - length).byteLength;
			frames.push(frame);
		}
		text = frames.join("");
		contentType = "text/event-stream; charset=utf-8";
	} else {
		text = kind === "json" ? json(step.body) : step.body;
		contentType = kind === "json" ? "application/json" : (step.contentType ?? "text/plain");
	}
	const bytes = encoded(text, limit);
	if (Math.ceil(bytes.byteLength / chunkBytes) > MAX_CHUNKS) {
		throw new RangeError("Messages fake chunk work limit");
	}
	const status = step.status ?? 200;
	const headers = new Headers(step.headers);
	if (!headers.has("content-type")) headers.set("content-type", contentType);
	// Check the platform's response/status/header rules before publishing any queued step.
	new Response(bytes, { status, headers });
	return { bytes, status, headers: [...headers], delayMs, chunkBytes, chunkDelayMs, streamed };
}

function body(step: Prepared, signal: AbortSignal): ReadableStream<Uint8Array> {
	const waiting = new AbortController();
	let terminal = false;
	let offset = 0;
	let output: ReadableStreamDefaultController<Uint8Array>;
	const stop = (reason?: unknown): void => {
		if (terminal) return;
		terminal = true;
		signal.removeEventListener("abort", abort);
		waiting.abort(reason);
	};
	const abort = (): void => {
		if (terminal) return;
		stop(signal.reason);
		output.error(signal.reason);
	};
	return new ReadableStream<Uint8Array>({
		start(controller) {
			output = controller;
			signal.addEventListener("abort", abort, { once: true });
			if (signal.aborted) abort();
			else if (step.bytes.byteLength === 0) {
				stop();
				controller.close();
			}
		},
		async pull(controller) {
			try {
				if (terminal) return;
				if (offset !== 0 && step.chunkDelayMs !== 0) {
					await wait(step.chunkDelayMs, waiting.signal);
				}
				if (terminal) return;
				const end = Math.min(offset + step.chunkBytes, step.bytes.byteLength);
				controller.enqueue(step.bytes.slice(offset, end));
				offset = end;
				if (offset === step.bytes.byteLength) {
					stop();
					controller.close();
				}
			} catch (error) {
				if (terminal) return;
				stop(error);
				controller.error(error);
			}
		},
		cancel: stop,
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

function draftShape(value: unknown): boolean {
	if (
		!object(value) ||
		!keys(
			value,
			["model", "system", "messages", "max_tokens", "output_config"],
			["stream", "fallbacks"],
		)
	)
		return false;
	if (typeof value.model !== "string" || value.model.length === 0) return false;
	if (typeof value.system !== "string") return false;
	if (
		!Number.isSafeInteger(value.max_tokens) ||
		Number(value.max_tokens) < 1 ||
		Number(value.max_tokens) > 16_000
	)
		return false;
	if (!Array.isArray(value.messages) || value.messages.length !== 1) return false;
	const message: unknown = value.messages[0];
	if (!object(message) || !keys(message, ["role", "content"])) return false;
	if (message.role !== "user" || typeof message.content !== "string") return false;
	const output = value.output_config;
	if (!object(output) || !keys(output, ["effort", "format"])) return false;
	if (
		typeof output.effort !== "string" ||
		!["low", "medium", "high", "xhigh", "max"].includes(output.effort)
	)
		return false;
	const format = output.format;
	if (!object(format) || !keys(format, ["type", "schema"])) return false;
	if (format.type !== "json_schema" || !object(format.schema)) return false;
	if (Object.hasOwn(value, "stream") && typeof value.stream !== "boolean") return false;
	if (Object.hasOwn(value, "fallbacks") && value.fallbacks !== "default") return false;
	return true;
}

async function acceptsDraft(request: Request): Promise<boolean> {
	if (
		!/^\s*application\/json\s*(?:;\s*charset\s*=\s*(?:utf-8|"utf-8")\s*)?$/i.test(
			request.headers.get("content-type") ?? "",
		)
	)
		return false;
	request.signal.throwIfAborted();
	if (!request.body) return false;
	const reader = request.body.getReader();
	let canceled = false;
	const cancel = (): void => {
		if (canceled) return;
		canceled = true;
		// Shared bounded intake has already replaced the original upload.
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
			if (++chunks > MAX_CHUNKS || next.value.byteLength > MAX_REQUEST_BYTES - size) {
				cancel();
				return false;
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
	} finally {
		request.signal.removeEventListener("abort", cancel);
		reader.releaseLock();
	}
	try {
		return draftShape(
			JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size))),
		);
	} catch {
		return false;
	}
}

/**
 * A finite scripted Messages endpoint. Its vendor-shaped host is logical: fetch stays in memory,
 * and listen binds only the shared fake's ephemeral 127.0.0.1 server. Nothing calls a vendor.
 * Exact POST /v1/messages and /v1/messages?beta=true, and the client's GET model-list/page/retrieve
 * targets reserve the same next step at app admission,
 * after shared bounded intake. Pre-app Faults may bypass or delay admission; recorder order
 * remains original arrival order. Scripts produce wire fixtures, never native authorization.
 */
export function createMessagesApiFake(options: MessagesApiOptions = {}): MessagesApiFake {
	return createMessagesApi(options, false);
}

/**
 * Adds the closed DraftYak Messages draft-request shape to the generic scripted fixture.
 * Schema contents remain opaque; no native pin, prompt, credential, header or model authority
 * is checked. Matching POSTs reserve a step before validation; invalid input returns a fixed 400.
 * Model GETs retain arbitrary scripted replies and do not run the draft-body validator.
 * JSON accepts only an optional UTF-8 charset; decoding is fatal, with JSON.parse's last-member
 * semantics. Both factories use shared 1 MiB intake before redirect/application cloning.
 * The app's chunk check is defensive after buffering, not an original-ingress chunk limit.
 * Source failures and aborts reject normally. The generic factory remains script-only.
 */
export function createMessagesApiDraftFake(options: MessagesApiOptions = {}): MessagesApiFake {
	return createMessagesApi(options, true);
}

function createMessagesApi(options: MessagesApiOptions, strict: boolean): MessagesApiFake {
	const queue: Prepared[] = [];
	let queuedBytes = 0;
	let preparing = false;
	const enqueue = (...steps: readonly MessagesApiStep[]): void => {
		if (preparing) throw new TypeError("Messages fake enqueue reentrancy");
		preparing = true;
		try {
			if (queue.length + steps.length > MAX_STEPS)
				throw new RangeError("Messages fake queue limit");
			const prepared: Prepared[] = [];
			let bytes = queuedBytes;
			for (const step of steps) {
				const value = prepare(step, MAX_QUEUED_BYTES - bytes);
				prepared.push(value);
				bytes += value.bytes.byteLength;
			}
			queue.push(...prepared);
			queuedBytes = bytes;
		} finally {
			preparing = false;
		}
	};
	enqueue(...(options.steps ?? []));
	const baseFaults = createFaults({ clock: options.clock });
	const faults: Faults = {
		...baseFaults,
		async run(request, app) {
			let produced: Response | undefined;
			let returned: Response | undefined;
			try {
				returned = await baseFaults.run(request, async (forwarded) => {
					produced = await app(forwarded);
					return produced;
				});
				return returned;
			} finally {
				// An after-fault can replace a scripted stream or throw after creating it. Its
				// unused body must release the local listener and any pending chunk timer.
				if (produced?.body && produced.body !== returned?.body) {
					await produced.body.cancel().catch(() => {});
				}
			}
		},
	};
	const fake = createFake(
		{
			async fetch(request) {
				const target = rawTarget(request);
				const draft = target === "/v1/messages" || target === "/v1/messages?beta=true";
				const method = draft ? "POST" : metadataTarget(target) ? "GET" : undefined;
				if (method === undefined) {
					return Response.json(
						{
							type: "error",
							error: { type: "not_found_error", message: "Synthetic route missing" },
						},
						{ status: 404 },
					);
				}
				if (request.method !== method) {
					return Response.json(
						{
							type: "error",
							error: { type: "invalid_request_error", message: `Synthetic ${method} only` },
						},
						{ status: 405, headers: { allow: method } },
					);
				}
				const step = queue.shift();
				if (step === undefined) {
					return Response.json(
						{
							type: "error",
							error: { type: "overloaded_error", message: "Synthetic script exhausted" },
						},
						{ status: 503 },
					);
				}
				queuedBytes -= step.bytes.byteLength;
				if (strict && draft) {
					if (!(await acceptsDraft(request))) {
						return Response.json(
							{
								type: "error",
								error: { type: "invalid_request_error", message: "Synthetic request refused" },
							},
							{ status: 400 },
						);
					}
				} else {
					await request.arrayBuffer();
				}
				request.signal.throwIfAborted();
				if (step.delayMs !== 0) await wait(step.delayMs, request.signal);
				request.signal.throwIfAborted();
				return new Response(step.streamed ? body(step, request.signal) : step.bytes, {
					status: step.status,
					headers: [...step.headers],
				});
			},
		},
		{
			host: "api.anthropic.com",
			recorder: options.recorder,
			faults,
			maxRequestBodyBytes: MAX_REQUEST_BYTES,
		},
	);
	return { ...fake, enqueue, pending: () => queue.length };
}
