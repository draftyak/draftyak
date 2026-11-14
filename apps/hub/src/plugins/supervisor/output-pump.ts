import { Readable } from "node:stream";
import { setImmediate } from "node:timers";
import { isPromise, isProxy } from "node:util/types";
import { createPluginWireDecoder, type PluginWireFrame } from "./tagged-wire.ts";

export class PluginOutputReadError extends Error {
	override readonly name = "PluginOutputReadError";
	readonly code = "PLUGIN_OUTPUT_READ_FAILED";
	constructor() {
		super("Plugin output read failed");
	}
}

export interface PluginOutputPump {
	/** First failure, or undefined after both original readers retire cleanly. */
	readonly failure: Promise<PluginOutputReadError | undefined>;
	/** Joins both original closes, final buffered reads and owned unexpected returned work. */
	readonly drained: Promise<void>;
}

const nativeThen = Promise.prototype.then;
const typedArray = Object.getPrototypeOf(Uint8Array.prototype);
const byteKind = Object.getOwnPropertyDescriptor(typedArray, Symbol.toStringTag)?.get;
const byteBuffer = Object.getOwnPropertyDescriptor(typedArray, "buffer")?.get;
const byteOffset = Object.getOwnPropertyDescriptor(typedArray, "byteOffset")?.get;
const byteLength = Object.getOwnPropertyDescriptor(typedArray, "byteLength")?.get;
const bufferLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength")?.get;
const bufferResizable = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "resizable")?.get;

function byteView(raw: unknown): Uint8Array {
	if (
		isProxy(raw) ||
		!byteKind ||
		!byteBuffer ||
		!byteOffset ||
		!byteLength ||
		!bufferLength ||
		!bufferResizable ||
		Reflect.apply(byteKind, raw, []) !== "Uint8Array"
	)
		throw new PluginOutputReadError();
	const backing = Reflect.apply(byteBuffer, raw, []) as ArrayBuffer;
	Reflect.apply(bufferLength, backing, []);
	if (Reflect.apply(bufferResizable, backing, [])) throw new PluginOutputReadError();
	return new Uint8Array(
		backing,
		Reflect.apply(byteOffset, raw, []) as number,
		Reflect.apply(byteLength, raw, []) as number,
	);
}

function ordinaryPromise(raw: unknown): raw is Promise<unknown> {
	return (
		!isProxy(raw) &&
		isPromise(raw) &&
		Object.getPrototypeOf(raw) === Promise.prototype &&
		!Object.hasOwn(raw, "constructor")
	);
}

interface Reader {
	readonly original: Readable;
	readonly stdout: boolean;
	readonly read: Readable["read"];
	ended: boolean;
	closed: boolean;
	retired: boolean;
	pumping: boolean;
	again: boolean;
	scheduled: boolean;
	onReadable(): void;
	onEnd(): void;
	onError(): void;
	onClose(): void;
}

/**
 * Consumes the two exclusive original byte readers supplied by PluginProcessIo.
 * The callback is synchronous DATA delivery and must return undefined. Neither
 * that return nor this reader join proves that hidden or Host work has finished;
 * the actual adapter must retain and join every nested original job separately.
 * This component never ends/destroys streams or proves child/descriptor closure.
 */
export function createPluginOutputPump(
	originalOutputs: readonly [Readable, Readable],
	onFrameData: (frame: PluginWireFrame) => void,
): PluginOutputPump {
	const [stdout, stderr] = originalOutputs;
	if (
		isProxy(stdout) ||
		isProxy(stderr) ||
		!(stdout instanceof Readable) ||
		!(stderr instanceof Readable) ||
		stdout === stderr ||
		typeof onFrameData !== "function"
	)
		throw new PluginOutputReadError();
	const decoder = createPluginWireDecoder();
	let resolveFailure!: (error: PluginOutputReadError | undefined) => void;
	let resolveDrained!: () => void;
	let rejectDrained!: (error: PluginOutputReadError) => void;
	const failure = new Promise<PluginOutputReadError | undefined>((resolve) => {
		resolveFailure = resolve;
	});
	const drained = new Promise<void>((resolve, reject) => {
		resolveDrained = resolve;
		rejectDrained = reject;
	});
	void Reflect.apply(nativeThen, drained, [undefined, () => {}]);
	let failed: PluginOutputReadError | undefined;
	let finished = false;
	let returnedPending = false;
	const readers: Reader[] = [];
	const fail = (): void => {
		if (!failed) {
			failed = new PluginOutputReadError();
			resolveFailure(failed);
		}
	};
	const finish = (): void => {
		if (
			finished ||
			returnedPending ||
			readers.length !== 2 ||
			readers.some((reader) => !reader.retired || reader.scheduled)
		)
			return;
		finished = true;
		for (const reader of readers) {
			for (const [event, listener] of [
				["readable", reader.onReadable],
				["end", reader.onEnd],
				["error", reader.onError],
				["close", reader.onClose],
			] as const) {
				try {
					reader.original.removeListener(event, listener);
				} catch {
					fail();
				}
			}
		}
		if (failed) rejectDrained(failed);
		else {
			resolveFailure(undefined);
			resolveDrained();
		}
	};
	const deliver = (frame: PluginWireFrame): void => {
		if (failed) return;
		let result: unknown;
		try {
			result = onFrameData(frame);
		} catch {
			fail();
			return;
		}
		if (result === undefined) return;
		// An unexpected return fences further delivery. Never assimilate a thenable.
		fail();
		if (!ordinaryPromise(result)) return;
		returnedPending = true;
		try {
			const observed = Reflect.apply(nativeThen, result, [
				() => {
					returnedPending = false;
					finish();
				},
				() => {
					returnedPending = false;
					finish();
				},
			]) as Promise<void>;
			void Reflect.apply(nativeThen, observed, [undefined, () => {}]);
		} catch {
			returnedPending = false;
			// Its lifetime is unknown; final rejection never certifies a work join.
		}
	};
	const consume = (raw: unknown, output: boolean): void => {
		if (failed || !output) return;
		const bytes = byteView(raw);
		let at = 0;
		while (at < bytes.byteLength && !failed) {
			const read = decoder.push(
				new Uint8Array(bytes.buffer, bytes.byteOffset + at, bytes.byteLength - at),
			);
			if (read.consumed <= 0 || read.consumed > bytes.byteLength - at)
				throw new PluginOutputReadError();
			at += read.consumed;
			if (read.frame) deliver(read.frame);
		}
	};
	const pump = (reader: Reader): void => {
		if (reader.retired || reader.scheduled) return;
		if (reader.pumping) {
			reader.again = true;
			return;
		}
		reader.pumping = true;
		let reads = 0;
		try {
			do {
				reader.again = false;
				let empty = false;
				try {
					while (reads < 64) {
						reads++;
						const chunk: unknown = Reflect.apply(reader.read, reader.original, []);
						if (chunk === null) {
							empty = true;
							break;
						}
						try {
							consume(chunk, reader.stdout);
						} catch {
							fail();
						}
					}
					if (!empty) {
						// Fairness only: no runtime output quota and at most one queued turn per reader.
						reader.scheduled = true;
						setImmediate(() => {
							reader.scheduled = false;
							pump(reader);
						});
					}
				} catch {
					fail();
					// A throwing read leaves consumption unqualified even after close.
					if (reader.closed) reader.retired = true;
				}
				if (reader.closed && empty) reader.retired = true;
			} while (reader.again && !reader.retired && !reader.scheduled);
		} finally {
			reader.pumping = false;
			finish();
		}
	};
	for (const [index, original] of [stdout, stderr].entries()) {
		const reader: Reader = {
			original,
			stdout: index === 0,
			read: original.read,
			ended: false,
			closed: false,
			retired: false,
			pumping: false,
			again: false,
			scheduled: false,
			onReadable() {
				pump(reader);
			},
			onEnd() {
				reader.ended = true;
				if (reader.stdout && !failed) {
					try {
						decoder.end();
					} catch {
						fail();
					}
				}
				pump(reader);
			},
			onError() {
				fail();
				pump(reader);
			},
			onClose() {
				reader.closed = true;
				if (!reader.ended) fail();
				pump(reader);
			},
		};
		readers.push(reader);
	}
	// Enroll both readers before the first read can synchronously invoke a producer.
	for (const reader of readers) {
		reader.original.on("error", reader.onError);
		reader.original.on("close", reader.onClose);
		reader.original.on("end", reader.onEnd);
		reader.original.on("readable", reader.onReadable);
	}
	for (const reader of readers) {
		reader.ended = reader.original.readableEnded;
		reader.closed = reader.original.closed;
		if (reader.original.errored || (reader.closed && !reader.ended)) fail();
		if (reader.stdout && reader.ended && !failed) {
			try {
				decoder.end();
			} catch {
				fail();
			}
		}
		pump(reader);
	}
	return Object.freeze({ failure, drained });
}
