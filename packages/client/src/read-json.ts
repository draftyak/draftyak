export type ApiResponseErrorCode =
	| "RESPONSE_INVALID"
	| "RESPONSE_TOO_LARGE"
	| "RESPONSE_ABORTED"
	| "RESPONSE_LIMIT_INVALID";

export class ApiResponseError extends Error {
	readonly code: ApiResponseErrorCode;

	constructor(code: ApiResponseErrorCode) {
		super("API response could not be read");
		this.name = "ApiResponseError";
		this.code = code;
	}
}

export interface ApiJsonOptions {
	readonly maxBytes: number;
	readonly signal?: AbortSignal;
}

const MAX_BYTES = 8 * 1024 * 1024;
const bodyGetter = Object.getOwnPropertyDescriptor(Response.prototype, "body")?.get;
const usedGetter = Object.getOwnPropertyDescriptor(Response.prototype, "bodyUsed")?.get;
const headersGetter = Object.getOwnPropertyDescriptor(Response.prototype, "headers")?.get;
const lockedGetter = Object.getOwnPropertyDescriptor(ReadableStream.prototype, "locked")?.get;
const abortedGetter = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted")?.get;
const getReader = ReadableStream.prototype.getReader;
const read = ReadableStreamDefaultReader.prototype.read;
const cancel = ReadableStreamDefaultReader.prototype.cancel;
const release = ReadableStreamDefaultReader.prototype.releaseLock;
const getHeader = Headers.prototype.get;
const addListener = EventTarget.prototype.addEventListener;
const removeListener = EventTarget.prototype.removeEventListener;
const typedArrayPrototype: object = Object.getPrototypeOf(Uint8Array.prototype);
const byteLengthGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteLength")?.get;
const byteOffsetGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteOffset")?.get;
const bufferGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, "buffer")?.get;
const tagGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, Symbol.toStringTag)?.get;
const copy = Uint8Array.prototype.set;

function invalid(): never {
	throw new ApiResponseError("RESPONSE_INVALID");
}

/** Only the media type and charset determine JSON decoding, never Content-Length. */
function jsonMediaType(value: string | null): boolean {
	if (value === null) return false;
	const essence = /^[\t ]*application\/json[\t ]*/i.exec(value);
	if (essence === null) return false;
	let index = essence[0].length;
	let charsetSeen = false;
	function whitespace(): void {
		while (value !== null && (value[index] === " " || value[index] === "\t")) index++;
	}
	function token(): string | undefined {
		const match = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+/.exec(value?.slice(index) ?? "");
		if (match === null) return undefined;
		index += match[0].length;
		return match[0];
	}
	while (index < value.length) {
		if (value[index++] !== ";") return false;
		whitespace();
		const name = token();
		if (name === undefined) return false;
		whitespace();
		if (value[index++] !== "=") return false;
		whitespace();
		let parameter: string;
		if (value[index] === '"') {
			index++;
			parameter = "";
			let closed = false;
			while (index < value.length) {
				let character = value[index++];
				if (character === '"') {
					closed = true;
					break;
				}
				if (character === "\\") character = value[index++];
				if (character === undefined) return false;
				const code = character.charCodeAt(0);
				if ((code < 0x20 && code !== 0x09) || code === 0x7f) return false;
				parameter += character;
			}
			if (!closed) return false;
		} else {
			const parsed = token();
			if (parsed === undefined) return false;
			parameter = parsed;
		}
		if (name.toLowerCase() === "charset") {
			if (charsetSeen || parameter.toLowerCase() !== "utf-8") return false;
			charsetSeen = true;
		}
		whitespace();
	}
	return true;
}

function chunkLength(value: unknown): number {
	if (tagGetter === undefined || byteLengthGetter === undefined) return invalid();
	if (Reflect.apply(tagGetter, value, []) !== "Uint8Array") return invalid();
	return Reflect.apply(byteLengthGetter, value, []) as number;
}

/**
 * Reads one unconsumed JSON response into bounded owned bytes. The result is
 * unvalidated DATA: the caller still validates its actual API/entity contract.
 * Cancellation joins the owned reader's cleanup, even if it ignores abort.
 */
export async function readApiJson(response: Response, options: ApiJsonOptions): Promise<unknown> {
	let maxBytes: number;
	try {
		const limit: unknown = options?.maxBytes;
		if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > MAX_BYTES)
			throw new ApiResponseError("RESPONSE_LIMIT_INVALID");
		maxBytes = limit;
	} catch {
		throw new ApiResponseError("RESPONSE_LIMIT_INVALID");
	}
	let signal: AbortSignal | undefined;
	let reader: ReadableStreamDefaultReader<unknown>;
	let headers: Headers;
	try {
		signal = options.signal;
		if (signal !== undefined) {
			if (abortedGetter === undefined) invalid();
			Reflect.apply(abortedGetter, signal, []);
		}
		if (
			bodyGetter === undefined ||
			usedGetter === undefined ||
			headersGetter === undefined ||
			lockedGetter === undefined
		)
			invalid();
		if (Reflect.apply(usedGetter, response, [])) invalid();
		const body = Reflect.apply(bodyGetter, response, []) as ReadableStream<unknown> | null;
		if (body === null || Reflect.apply(lockedGetter, body, [])) invalid();
		headers = Reflect.apply(headersGetter, response, []) as Headers;
		reader = Reflect.apply(getReader, body, []) as ReadableStreamDefaultReader<unknown>;
	} catch {
		throw new ApiResponseError("RESPONSE_INVALID");
	}

	let failure: ApiResponseErrorCode | undefined;
	let cancellation: Promise<void> | undefined;
	let listenerAdded = false;
	let parsed: unknown;

	function cancelOwned(): Promise<void> {
		if (cancellation !== undefined) return cancellation;
		let complete!: () => void;
		cancellation = new Promise<void>((resolve) => {
			complete = resolve;
		});
		// Reserve this exact join before the source's cancel callback can reenter abort.
		let cleanup: Promise<void>;
		try {
			cleanup = Reflect.apply(cancel, reader, []) as Promise<void>;
		} catch {
			complete();
			return cancellation;
		}
		void Promise.resolve(cleanup).then(complete, complete);
		return cancellation;
	}

	function abort(): void {
		failure ??= "RESPONSE_ABORTED";
		void cancelOwned();
	}

	function checkAbort(): void {
		if (
			signal !== undefined &&
			abortedGetter !== undefined &&
			Reflect.apply(abortedGetter, signal, [])
		)
			abort();
		if (failure !== undefined) throw new ApiResponseError(failure);
	}

	try {
		if (signal !== undefined) {
			Reflect.apply(addListener, signal, ["abort", abort, { once: true }]);
			listenerAdded = true;
		}
		checkAbort();
		if (!jsonMediaType(Reflect.apply(getHeader, headers, ["content-type"]) as string | null))
			invalid();
		const bytes = new Uint8Array(maxBytes);
		let length = 0;
		for (;;) {
			checkAbort();
			const result = await (Reflect.apply(read, reader, []) as Promise<
				ReadableStreamReadResult<unknown>
			>);
			checkAbort();
			if (result.done) break;
			const size = chunkLength(result.value);
			if (size > maxBytes - length) {
				failure = "RESPONSE_TOO_LARGE";
				throw new ApiResponseError(failure);
			}
			// Native slots determine size; this copies no oversized or non-byte chunk.
			if (bufferGetter === undefined || byteOffsetGetter === undefined) invalid();
			const buffer = Reflect.apply(bufferGetter, result.value, []) as ArrayBuffer;
			const offset = Reflect.apply(byteOffsetGetter, result.value, []) as number;
			const fixedChunk = new Uint8Array(buffer, offset, size);
			Reflect.apply(copy, bytes, [fixedChunk, length]);
			if (chunkLength(fixedChunk) !== size) invalid();
			length += size;
		}
		checkAbort();
		if (length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) invalid();
		const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
			bytes.subarray(0, length),
		);
		parsed = JSON.parse(text) as unknown;
		checkAbort();
	} catch {
		failure ??= "RESPONSE_INVALID";
		await cancelOwned();
	} finally {
		if (listenerAdded && signal !== undefined) {
			Reflect.apply(removeListener, signal, ["abort", abort]);
		}
		try {
			Reflect.apply(release, reader, []);
		} catch {
			failure ??= "RESPONSE_INVALID";
		}
	}
	if (failure !== undefined) throw new ApiResponseError(failure);
	return parsed;
}
