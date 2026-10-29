import { checkDelay, wait } from "../faults.ts";

interface Delivery {
	/** 200 by default; any status from 200 to 599 that allows a body. */
	readonly status?: number;
	/** Any header but Content-Length and Transfer-Encoding, which the server sets. */
	readonly headers?: HeadersInit;
	/** Wait before the response headers; Infinity waits until the request aborts. */
	readonly delayMs?: number;
	/** Bytes per body chunk, 1 to 65,536 (the default). */
	readonly chunkBytes?: number;
	/** Wait between body chunks, never before the first; Infinity waits until the body ends. */
	readonly chunkDelayMs?: number;
}

/**
 * One scripted response, encoded when it is enqueued. `json` sends JSON.stringify(body) as
 * application/json; `raw` sends exact text or bytes, as application/json unless contentType says.
 */
export type CompatibleStep = Delivery &
	(
		| { readonly kind: "json"; readonly body: unknown }
		| {
				readonly kind: "raw";
				readonly body: string | Uint8Array;
				readonly contentType?: string;
		  }
	);

export interface Prepared {
	readonly bytes: Uint8Array<ArrayBuffer>;
	readonly status: number;
	readonly headers: readonly [string, string][];
	readonly delayMs: number;
	readonly chunkBytes: number;
	readonly chunkDelayMs: number;
}

export interface Script {
	/** Encodes and snapshots every step, or adds none of them. */
	enqueue(...steps: readonly CompatibleStep[]): void;
	/** Removes the next step and releases its bytes from the queue's budget. */
	take(): Prepared | undefined;
	pending(): number;
}

// The fixture's own work limits, not the consumer's: a step may exceed the core's response caps.
const MAX_STEPS = 1_024;
const MAX_BYTES = 16 * 1_024 * 1_024;
const MAX_QUEUED_BYTES = 64 * 1_024 * 1_024;
const MAX_CHUNK = 65_536;
const MAX_CHUNKS = 65_536;
const NO_BODY = new Set([204, 205, 304]);
const FRAMING = ["content-length", "transfer-encoding"];
const encoder = new TextEncoder();

function json(value: unknown): string {
	const text = JSON.stringify(value);
	if (text === undefined) throw new TypeError("Compatible fake JSON must encode a value");
	return text;
}

// Checks the cap before encoding or copying anything, and again on the copy.
function bytesOf(body: unknown, cap: number): Uint8Array<ArrayBuffer> {
	let bytes: Uint8Array<ArrayBuffer>;
	if (typeof body === "string") {
		if (body.length > cap) throw new RangeError("Compatible fake byte limit");
		bytes = encoder.encode(body);
	} else if (body instanceof Uint8Array) {
		if (body.byteLength > cap) throw new RangeError("Compatible fake byte limit");
		bytes = new Uint8Array(body);
	} else throw new TypeError("A raw compatible step body is text or bytes");
	if (bytes.byteLength > cap) throw new RangeError("Compatible fake byte limit");
	return bytes;
}

// Reads each field of the step once, so a getter cannot answer differently later.
function prepare(step: CompatibleStep, available: number): Prepared {
	const kind = step.kind;
	const cap = Math.min(MAX_BYTES, available);
	const status = step.status ?? 200;
	if (!Number.isInteger(status) || status < 200 || status > 599 || NO_BODY.has(status))
		throw new RangeError("A compatible step needs a status from 200 to 599 that allows a body");
	const delayMs = step.delayMs ?? 0;
	const chunkBytes = step.chunkBytes ?? MAX_CHUNK;
	const chunkDelayMs = step.chunkDelayMs ?? 0;
	checkDelay("Compatible fake delayMs", delayMs);
	checkDelay("Compatible fake chunkDelayMs", chunkDelayMs);
	if (!(Number.isInteger(chunkBytes) && chunkBytes >= 1 && chunkBytes <= MAX_CHUNK))
		throw new RangeError("Compatible fake chunkBytes must be from 1 to 65536");
	let bytes: Uint8Array<ArrayBuffer>;
	let contentType: string;
	if (kind === "json") {
		bytes = bytesOf(json(step.body), cap);
		contentType = "application/json";
	} else if (kind === "raw") {
		bytes = bytesOf(step.body, cap);
		contentType = step.contentType ?? "application/json";
	} else throw new TypeError("Unknown compatible step kind");
	if (Math.ceil(bytes.byteLength / chunkBytes) > MAX_CHUNKS)
		throw new RangeError("Compatible fake chunk work limit");
	const headers = new Headers(step.headers);
	if (FRAMING.some((name) => headers.has(name)))
		throw new TypeError("The fake sets a compatible step's framing headers");
	if (!headers.has("content-type")) headers.set("content-type", contentType);
	return { bytes, status, headers: [...headers], delayMs, chunkBytes, chunkDelayMs };
}

/** Encodes and snapshots one step outside any queue, within the per-step limits. */
export function prepareStep(step: CompatibleStep): Prepared {
	return prepare(step, MAX_BYTES);
}

export function createScript(): Script {
	const queue: Prepared[] = [];
	let queuedBytes = 0;
	let preparing = false;
	return {
		enqueue(...steps) {
			if (preparing) throw new TypeError("Compatible fake enqueue reentrancy");
			if (queue.length + steps.length > MAX_STEPS)
				throw new RangeError("Compatible fake queue limit");
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
		},
		take() {
			const step = queue.shift();
			if (step !== undefined) queuedBytes -= step.bytes.byteLength;
			return step;
		},
		pending: () => queue.length,
	};
}

/** The step's body in chunks; an abort errors it with the signal's reason and ends any wait. */
export function streamed(step: Prepared, signal: AbortSignal): ReadableStream<Uint8Array> {
	const local = new AbortController();
	let offset = 0;
	let ended = false;
	let abort = (): void => {};
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
				if (ended) return;
				const end = Math.min(offset + step.chunkBytes, step.bytes.byteLength);
				if (end > offset) controller.enqueue(step.bytes.slice(offset, end));
				offset = end;
				if (offset === step.bytes.byteLength) {
					finish();
					controller.close();
				}
			} catch (error) {
				if (ended) return;
				finish();
				controller.error(error);
			}
		},
		cancel(reason) {
			if (ended) return;
			finish();
			local.abort(reason);
		},
	});
}
