import { Readable } from "node:stream";
import { inspect, types } from "node:util";
import { MasterKey } from "./master-key.ts";
import { decodeLowerHex, type InitialFrame, scanSidecarFrame } from "./sidecar-frame.ts";

/** The input is not an unread, unshared byte-mode Readable, or stopped being one. */
export const SIDECAR_INPUT_SOURCE = "SIDECAR_INPUT_SOURCE";
/** The options or their signal are invalid. */
export const SIDECAR_INPUT_OPTIONS = "SIDECAR_INPUT_OPTIONS";
/** A frame header gives a payload length outside 1 through 1,048,576 bytes. */
export const SIDECAR_INPUT_BOUNDS = "SIDECAR_INPUT_BOUNDS";
/** A payload is not exactly one accepted frame object. */
export const SIDECAR_INPUT_FORMAT = "SIDECAR_INPUT_FORMAT";
/** A control frame came before the initial frame, or a second initial frame came. */
export const SIDECAR_INPUT_ORDER = "SIDECAR_INPUT_ORDER";
/** The input ended inside a frame or before the initial frame. */
export const SIDECAR_INPUT_TRUNCATED = "SIDECAR_INPUT_TRUNCATED";
/** The input failed, closed before its end, or could not be processed or cleaned up. */
export const SIDECAR_INPUT_IO = "SIDECAR_INPUT_IO";
/** takeInitial ran before the initial material was available or after it was taken. */
export const SIDECAR_INPUT_STATE = "SIDECAR_INPUT_STATE";
/** The receiver stopped without a fault (shutdown, EOF, cancellation or disposal). */
export const SIDECAR_INPUT_STOPPED = "SIDECAR_INPUT_STOPPED";
/** nextControl ran while an earlier call was still pending. */
export const SIDECAR_INPUT_CONSUMER = "SIDECAR_INPUT_CONSUMER";

export type SidecarFaultCode =
	| typeof SIDECAR_INPUT_SOURCE
	| typeof SIDECAR_INPUT_BOUNDS
	| typeof SIDECAR_INPUT_FORMAT
	| typeof SIDECAR_INPUT_ORDER
	| typeof SIDECAR_INPUT_TRUNCATED
	| typeof SIDECAR_INPUT_IO;
export type SidecarInputCode =
	| SidecarFaultCode
	| typeof SIDECAR_INPUT_OPTIONS
	| typeof SIDECAR_INPUT_STATE
	| typeof SIDECAR_INPUT_STOPPED
	| typeof SIDECAR_INPUT_CONSUMER;

export class SidecarInputError extends Error {
	readonly code: SidecarInputCode;
	constructor(code: SidecarInputCode) {
		super(code);
		this.name = "SidecarInputError";
		this.code = code;
	}
}

export type SidecarInputState =
	| "awaiting-initial"
	| "initial-available"
	| "initial-taken"
	| "closing"
	| "closed";
export type SidecarStopReason = "shutdown" | "eof" | "fault" | "cancelled" | "disposed";
export interface SidecarStop {
	readonly kind: "stop";
	readonly reason: SidecarStopReason;
	readonly code?: SidecarFaultCode;
}
export interface SidecarResumed {
	readonly kind: "resumed";
}
export type SidecarControl = SidecarResumed | SidecarStop;
export interface InitialMaterial {
	readonly masterKey: MasterKey;
	/** Exactly 16 bytes; the caller owns and erases this buffer. */
	readonly bootstrapSecret: Buffer;
}
export interface SidecarInputOptions {
	readonly signal?: AbortSignal;
}
export interface SidecarInput {
	readonly state: SidecarInputState;
	readonly initialReady: Promise<void>;
	takeInitial(): InitialMaterial;
	nextControl(): Promise<SidecarControl>;
	readonly terminal: Promise<SidecarStop>;
	readonly closed: Promise<void>;
	dispose(): Promise<void>;
}

const HEADER_BYTES = 4;
const MAX_FRAME_BYTES = 1_048_576;
const MAX_SLICE_BYTES = 65_536;
const RESUMED: SidecarResumed = Object.freeze({ kind: "resumed" });
const redacted = (): string => "[REDACTED]";
const ignore = (): void => {};

/**
 * Take exclusive ownership of an unread byte-mode Readable with nothing buffered yet, carrying the
 * sidecar's private stdin frames. The receiver reads and destroys the input; the caller must not
 * read it, set its encoding, replace its methods or attach a data or readable listener. The input
 * must emit close once destroyed: closed and dispose settle only then.
 *
 * The receiver wipes its own buffers, every view it reads and, when it stops, what the input still
 * buffers. One limit remains: when a read spans chunks the input buffered separately, Node returns
 * a merged copy, and the receiver wipes the copy while those bytes stay in the original chunks.
 */
export function receiveSidecarInput(input: Readable, options?: SidecarInputOptions): SidecarInput {
	return new Receiver(input, options);
}

function unclaimedByteSource(input: unknown): input is Readable {
	try {
		return (
			input instanceof Readable &&
			input.readable === true &&
			input.destroyed === false &&
			input.readableObjectMode === false &&
			input.readableEncoding === null &&
			input.readableFlowing === null &&
			input.readableDidRead === false &&
			input.readableLength === 0 &&
			input.listenerCount("data") === 0 &&
			input.listenerCount("readable") === 0
		);
	} catch {
		return false;
	}
}

function optionSignal(options: unknown): AbortSignal | undefined {
	let signal: unknown = null;
	try {
		if (options === undefined) signal = undefined;
		else if (typeof options === "object" && options !== null)
			signal = (options as { readonly signal?: unknown }).signal;
		// AbortSignal.any brand-checks the signal; only the derived one is used after this.
		if (signal instanceof AbortSignal) return AbortSignal.any([signal]);
	} catch {
		signal = null;
	}
	if (signal === undefined) return undefined;
	throw new SidecarInputError(SIDECAR_INPUT_OPTIONS);
}

function initialMaterial(masterKey: MasterKey, bootstrapSecret: Buffer): InitialMaterial {
	const material = { masterKey, bootstrapSecret };
	Object.defineProperty(material, "toJSON", { value: redacted });
	Object.defineProperty(material, inspect.custom, { value: redacted });
	return Object.freeze(material);
}

class Receiver implements SidecarInput {
	readonly initialReady: Promise<void>;
	readonly terminal: Promise<SidecarStop>;
	readonly closed: Promise<void>;
	readonly #ready = Promise.withResolvers<void>();
	readonly #stopped = Promise.withResolvers<SidecarStop>();
	readonly #closing = Promise.withResolvers<void>();
	readonly #read: Readable["read"];
	readonly #destroy: Readable["destroy"];
	readonly #signal: AbortSignal | undefined;
	#input: Readable | undefined;
	#header: Buffer | undefined;
	#arena: Buffer | undefined;
	#headerFill = 0;
	#payloadLength = 0;
	#payloadFill = 0;
	#initialSeen = false;
	#readySettled = false;
	#taken = false;
	#masterKey: MasterKey | undefined;
	#bootstrapSecret: Buffer | undefined;
	#resumePending = false;
	#waiter: ((control: SidecarControl) => void) | undefined;
	#stop: SidecarStop | undefined;
	#sourceClosed = false;
	#ioFailed = false;
	#closedSettled = false;

	constructor(input: unknown, options: unknown) {
		const signal = optionSignal(options);
		if (!unclaimedByteSource(input)) throw new SidecarInputError(SIDECAR_INPUT_SOURCE);
		this.#input = input;
		this.#read = input.read;
		this.#destroy = input.destroy;
		this.#signal = signal;
		this.#header = Buffer.alloc(HEADER_BYTES);
		this.#arena = Buffer.alloc(MAX_FRAME_BYTES);
		this.initialReady = this.#ready.promise;
		this.terminal = this.#stopped.promise;
		this.closed = this.#closing.promise;
		// Rejections stay observable to callers that await them, never unhandled.
		this.initialReady.catch(ignore);
		this.closed.catch(ignore);
		input.on("error", this.#onError);
		input.on("close", this.#onClose);
		if (signal?.aborted) {
			this.#finish("cancelled");
			return;
		}
		signal?.addEventListener("abort", this.#onAbort, { once: true });
		input.on("end", this.#onEnd);
		input.on("readable", this.#onReadable);
	}

	get state(): SidecarInputState {
		if (this.#closedSettled) return "closed";
		if (this.#stop !== undefined) return "closing";
		if (this.#taken) return "initial-taken";
		return this.#masterKey === undefined ? "awaiting-initial" : "initial-available";
	}

	takeInitial(): InitialMaterial {
		if (this.#taken) throw new SidecarInputError(SIDECAR_INPUT_STATE);
		if (this.#stop !== undefined)
			throw new SidecarInputError(this.#stop.code ?? SIDECAR_INPUT_STOPPED);
		const masterKey = this.#masterKey;
		const bootstrapSecret = this.#bootstrapSecret;
		if (masterKey === undefined || bootstrapSecret === undefined)
			throw new SidecarInputError(SIDECAR_INPUT_STATE);
		this.#masterKey = undefined;
		this.#bootstrapSecret = undefined;
		this.#taken = true;
		return initialMaterial(masterKey, bootstrapSecret);
	}

	nextControl(): Promise<SidecarControl> {
		if (this.#waiter !== undefined)
			return Promise.reject(new SidecarInputError(SIDECAR_INPUT_CONSUMER));
		if (this.#resumePending) {
			this.#resumePending = false;
			return Promise.resolve(RESUMED);
		}
		if (this.#stop !== undefined) return Promise.resolve(this.#stop);
		const { promise, resolve } = Promise.withResolvers<SidecarControl>();
		this.#waiter = resolve;
		return promise;
	}

	dispose(): Promise<void> {
		this.#finish("disposed");
		return this.closed;
	}

	toJSON(): string {
		return redacted();
	}

	[inspect.custom](): string {
		return redacted();
	}

	readonly #onReadable = (): void => this.#pull();
	readonly #onEnd = (): void => {
		if (this.#headerFill !== 0 || !this.#initialSeen)
			this.#finish("fault", SIDECAR_INPUT_TRUNCATED);
		else this.#finish("eof");
	};
	readonly #onError = (): void => {
		this.#ioFailed = true;
		this.#finish("fault", SIDECAR_INPUT_IO);
	};
	readonly #onClose = (): void => {
		this.#sourceClosed = true;
		if (this.#stop === undefined) {
			this.#ioFailed = true;
			this.#finish("fault", SIDECAR_INPUT_IO);
		}
		this.#settleClosed();
	};
	readonly #onAbort = (): void => this.#finish("cancelled");

	// Reads what is available in slices of at most 64 KiB, never waiting for a full slice.
	#pull(): void {
		const input = this.#input;
		try {
			while (input !== undefined && this.#stop === undefined) {
				if (
					input.readableEncoding !== null ||
					input.listenerCount("data") !== 0 ||
					input.listenerCount("readable") !== 1
				) {
					this.#finish("fault", SIDECAR_INPUT_SOURCE);
					return;
				}
				const size = Math.min(input.readableLength, MAX_SLICE_BYTES);
				if (size === 0) {
					this.#read.call(input, 0);
					return;
				}
				const view: unknown = this.#read.call(input, size);
				if (!types.isUint8Array(view)) {
					this.#finish("fault", SIDECAR_INPUT_SOURCE);
					return;
				}
				try {
					if (view.length > 0 && view.length <= MAX_SLICE_BYTES) this.#consume(view);
					else this.#finish("fault", SIDECAR_INPUT_SOURCE);
				} finally {
					view.fill(0);
				}
			}
		} catch {
			this.#finish("fault", SIDECAR_INPUT_IO);
		}
	}

	#consume(view: Uint8Array): void {
		const header = this.#header;
		const arena = this.#arena;
		if (header === undefined || arena === undefined) return;
		let at = 0;
		while (at < view.length && this.#stop === undefined) {
			if (this.#headerFill < HEADER_BYTES) {
				const count = Math.min(HEADER_BYTES - this.#headerFill, view.length - at);
				header.set(view.subarray(at, at + count), this.#headerFill);
				this.#headerFill += count;
				at += count;
				if (this.#headerFill < HEADER_BYTES) return;
				const length = header.readUInt32BE(0);
				header.fill(0);
				if (length < 1 || length > MAX_FRAME_BYTES) {
					this.#finish("fault", SIDECAR_INPUT_BOUNDS);
					return;
				}
				this.#payloadLength = length;
				continue;
			}
			const count = Math.min(this.#payloadLength - this.#payloadFill, view.length - at);
			arena.set(view.subarray(at, at + count), this.#payloadFill);
			this.#payloadFill += count;
			at += count;
			if (this.#payloadFill < this.#payloadLength) return;
			const length = this.#payloadLength;
			this.#headerFill = 0;
			this.#payloadLength = 0;
			this.#payloadFill = 0;
			try {
				this.#frame(arena, length);
			} finally {
				arena.fill(0, 0, length);
			}
		}
	}

	#frame(bytes: Buffer, length: number): void {
		const frame = scanSidecarFrame(bytes, length);
		if (frame === undefined) {
			this.#finish("fault", SIDECAR_INPUT_FORMAT);
		} else if (frame.kind === "initial") {
			if (this.#initialSeen) this.#finish("fault", SIDECAR_INPUT_ORDER);
			else this.#accept(bytes, frame);
		} else if (!this.#initialSeen) {
			this.#finish("fault", SIDECAR_INPUT_ORDER);
		} else if (frame.kind === "shutdown") {
			this.#finish("shutdown");
		} else {
			const waiter = this.#waiter;
			this.#waiter = undefined;
			if (waiter === undefined) this.#resumePending = true;
			else waiter(RESUMED);
		}
	}

	#accept(bytes: Buffer, frame: InitialFrame): void {
		this.#initialSeen = true;
		const key = Buffer.alloc(32);
		let bootstrapSecret: Buffer | undefined;
		try {
			bootstrapSecret = Buffer.alloc(16);
			decodeLowerHex(bytes, frame.masterKeyAt, key);
			decodeLowerHex(bytes, frame.bootstrapSecretAt, bootstrapSecret);
			this.#masterKey = new MasterKey(key);
		} catch (error) {
			bootstrapSecret?.fill(0);
			throw error;
		} finally {
			key.fill(0);
		}
		this.#bootstrapSecret = bootstrapSecret;
		this.#readySettled = true;
		this.#ready.resolve();
	}

	// The first stop wins: erase receiver-owned bytes, settle every wait, then destroy the input.
	#finish(reason: SidecarStopReason, code?: SidecarFaultCode): void {
		if (this.#stop !== undefined) return;
		const stop = Object.freeze<SidecarStop>(
			code === undefined ? { kind: "stop", reason } : { kind: "stop", reason, code },
		);
		this.#stop = stop;
		this.#resumePending = false;
		this.#bootstrapSecret?.fill(0);
		this.#masterKey?.destroy();
		this.#bootstrapSecret = undefined;
		this.#masterKey = undefined;
		this.#header?.fill(0);
		this.#arena?.fill(0);
		this.#header = undefined;
		this.#arena = undefined;
		this.#headerFill = 0;
		this.#payloadLength = 0;
		this.#payloadFill = 0;
		const input = this.#input;
		input?.removeListener("readable", this.#onReadable);
		input?.removeListener("end", this.#onEnd);
		this.#signal?.removeEventListener("abort", this.#onAbort);
		if (!this.#readySettled) {
			this.#readySettled = true;
			this.#ready.reject(new SidecarInputError(code ?? SIDECAR_INPUT_STOPPED));
		}
		const waiter = this.#waiter;
		this.#waiter = undefined;
		waiter?.(stop);
		this.#stopped.resolve(stop);
		if (input !== undefined) this.#drain(input);
		try {
			if (input !== undefined) this.#destroy.call(input);
		} catch {
			this.#ioFailed = true;
			this.#settleClosed();
			return;
		}
		if (this.#sourceClosed) this.#settleClosed();
	}

	// One-byte reads never span two buffered chunks, so each wipe lands in the chunk itself.
	#drain(input: Readable): void {
		try {
			for (let left = input.readableLength; left > 0; left--) {
				if (input.readableEncoding !== null || input.listenerCount("data") !== 0) return;
				const view: unknown = this.#read.call(input, 1);
				if (!types.isUint8Array(view)) return;
				view.fill(0);
			}
		} catch {
			this.#ioFailed = true;
		}
	}

	#settleClosed(): void {
		if (this.#sourceClosed) {
			this.#input?.removeListener("error", this.#onError);
			this.#input?.removeListener("close", this.#onClose);
			this.#input = undefined;
		}
		if (this.#closedSettled || this.#stop === undefined) return;
		this.#closedSettled = true;
		if (this.#ioFailed) this.#closing.reject(new SidecarInputError(SIDECAR_INPUT_IO));
		else this.#closing.resolve();
	}
}
