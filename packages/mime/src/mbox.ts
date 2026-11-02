import { canonicalAddress } from "./index.ts";
import { MAX_BYTES } from "./model.ts";

export const MBOX_CHUNK_BYTES = 65_536;
export const MBOX_MAX_MESSAGES = 10_000;
export const MBOX_MAX_OUTPUT_BYTES = 1_073_741_824;

export interface MboxMessage {
	readonly raw: Uint8Array;
	readonly envelopeFrom: string;
	readonly receivedAtMs: number;
}

export interface MboxOptions {
	readonly signal?: AbortSignal;
	readonly maxMessages?: number;
	readonly maxMessageBytes?: number;
	readonly maxOutputBytes?: number;
}

export type MboxErrorCode =
	| "BAD_INPUT"
	| "BAD_ENVELOPE"
	| "BAD_DATE"
	| "MESSAGE_TOO_LARGE"
	| "TOO_MANY_MESSAGES"
	| "OUTPUT_TOO_LARGE"
	| "ABORTED";

export class MboxError extends Error {
	readonly code: MboxErrorCode;
	constructor(code: MboxErrorCode) {
		super(`mbox: ${code}`);
		this.name = "MboxError";
		this.code = code;
	}
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function limit(value: number | undefined, maximum: number): number {
	if (value === undefined) return maximum;
	if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
		throw new MboxError("BAD_INPUT");
	}
	return value;
}

function checkAbort(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw new MboxError("ABORTED");
}

function envelope(message: MboxMessage): Uint8Array {
	let sender: string;
	try {
		sender = canonicalAddress(message.envelopeFrom);
	} catch {
		throw new MboxError("BAD_ENVELOPE");
	}
	const time = message.receivedAtMs;
	if (!Number.isSafeInteger(time) || time < 0 || time > 253_402_300_799_999) {
		throw new MboxError("BAD_DATE");
	}
	const date = new Date(time);
	const two = (value: number) => String(value).padStart(2, "0");
	const stamp = `${DAYS[date.getUTCDay()]} ${MONTHS[date.getUTCMonth()]} ${String(date.getUTCDate()).padStart(2, " ")} ${two(date.getUTCHours())}:${two(date.getUTCMinutes())}:${two(date.getUTCSeconds())} ${date.getUTCFullYear()}`;
	return new TextEncoder().encode(`From ${sender} ${stamp}\n`);
}

function quoted(raw: Uint8Array, start: number): boolean {
	let at = start;
	while (raw[at] === 62) at++;
	return (
		raw[at] === 70 &&
		raw[at + 1] === 114 &&
		raw[at + 2] === 111 &&
		raw[at + 3] === 109 &&
		raw[at + 4] === 32
	);
}

async function nextMessage(
	iterator: Iterator<MboxMessage> | AsyncIterator<MboxMessage>,
	signal: AbortSignal | undefined,
): Promise<IteratorResult<MboxMessage>> {
	checkAbort(signal);
	if (!signal) return iterator.next();
	let onAbort: () => void = () => {};
	const aborted = new Promise<never>((_resolve, reject) => {
		onAbort = () => reject(new MboxError("ABORTED"));
		signal.addEventListener("abort", onAbort, { once: true });
	});
	try {
		checkAbort(signal);
		return await Promise.race([iterator.next(), aborted]);
	} finally {
		signal.removeEventListener("abort", onAbort);
	}
}

async function closeSource(
	iterator: Iterator<MboxMessage> | AsyncIterator<MboxMessage>,
	signal: AbortSignal | undefined,
	failed: boolean,
): Promise<void> {
	if (!iterator.return) return;
	try {
		const closing = Promise.resolve(iterator.return());
		if (!signal) {
			await closing;
			return;
		}
		if (signal.aborted) {
			void closing.catch(() => {});
			return;
		}
		let onAbort: () => void = () => {};
		const aborted = new Promise<void>((resolve) => {
			onAbort = resolve;
			signal.addEventListener("abort", onAbort, { once: true });
		});
		try {
			// Also observe aborts that arrive after cleanup has already started.
			if (signal.aborted) onAbort();
			await Promise.race([closing, aborted]);
		} finally {
			signal.removeEventListener("abort", onAbort);
		}
	} catch (error) {
		if (!failed) throw error;
	}
}

/**
 * Byte-preserving mboxrd: quote every LF-delimited ^>*From line, then append
 * exactly one archive LF per record. An inverse removes that one LF before
 * unquoting; raw data need not end in a newline. No header/body normalization is
 * performed. Importers that normalize newlines are not byte-preserving readers.
 * The caller supplies already selected raw mail and authoritative envelope/time;
 * this formatter grants no access or export authorization.
 */
export async function* writeMbox(
	messages: Iterable<MboxMessage> | AsyncIterable<MboxMessage>,
	options: MboxOptions = {},
): AsyncGenerator<Uint8Array> {
	const maxMessages = limit(options.maxMessages, MBOX_MAX_MESSAGES);
	const maxMessageBytes = limit(options.maxMessageBytes, MAX_BYTES);
	const maxOutputBytes = limit(options.maxOutputBytes, MBOX_MAX_OUTPUT_BYTES);
	const signal = options.signal;
	checkAbort(signal);
	if (!messages) throw new MboxError("BAD_INPUT");
	const iterator =
		Symbol.asyncIterator in Object(messages)
			? (messages as AsyncIterable<MboxMessage>)[Symbol.asyncIterator]()
			: (messages as Iterable<MboxMessage>)[Symbol.iterator]?.();
	if (!iterator || typeof iterator.next !== "function") throw new MboxError("BAD_INPUT");
	let done = false;
	let failed = false;
	let count = 0;
	let outputBytes = 0;
	try {
		while (true) {
			const result = await nextMessage(iterator, signal);
			checkAbort(signal);
			if (result.done) {
				done = true;
				return;
			}
			if (++count > maxMessages) throw new MboxError("TOO_MANY_MESSAGES");
			const message = result.value;
			const input = message?.raw;
			if (!(input instanceof Uint8Array)) throw new MboxError("BAD_INPUT");
			if (input.byteLength > maxMessageBytes) throw new MboxError("MESSAGE_TOO_LARGE");
			const prefix = envelope(message);
			// Copy once before yielding, so caller mutation cannot change this record.
			const raw = new Uint8Array(input);
			let size = prefix.byteLength + raw.byteLength + 1;
			for (let start = 0; start < raw.length; ) {
				checkAbort(signal);
				if (quoted(raw, start)) size++;
				const end = raw.indexOf(10, start);
				start = end < 0 ? raw.length : end + 1;
			}
			if (size > maxOutputBytes - outputBytes) throw new MboxError("OUTPUT_TOO_LARGE");
			outputBytes += size;
			checkAbort(signal);
			let buffer = new Uint8Array(MBOX_CHUNK_BYTES);
			buffer.set(prefix);
			let used = prefix.byteLength;
			for (let start = 0; start < raw.length; ) {
				checkAbort(signal);
				if (quoted(raw, start)) {
					buffer[used++] = 62;
					if (used === buffer.length) {
						yield buffer;
						buffer = new Uint8Array(MBOX_CHUNK_BYTES);
						used = 0;
					}
				}
				const end = raw.indexOf(10, start);
				const stop = end < 0 ? raw.length : end + 1;
				while (start < stop) {
					checkAbort(signal);
					const next = Math.min(stop, start + buffer.length - used);
					buffer.set(raw.subarray(start, next), used);
					used += next - start;
					start = next;
					if (used === buffer.length) {
						yield buffer;
						buffer = new Uint8Array(MBOX_CHUNK_BYTES);
						used = 0;
					}
				}
			}
			checkAbort(signal);
			buffer[used++] = 10;
			yield buffer.slice(0, used);
		}
	} catch (error) {
		failed = true;
		throw error;
	} finally {
		if (!done) await closeSource(iterator, signal, failed);
	}
}
