import { Buffer } from "node:buffer";
import { EventEmitter } from "node:events";
import { Writable } from "node:stream";
import { isProxy } from "node:util/types";
import { HOST_MAX_FRAME_BYTES } from "@draftyak/protocol/host-channel";

export class PluginInputWriteError extends Error {
	override readonly name = "PluginInputWriteError";
	readonly code = "PLUGIN_INPUT_WRITE_FAILED";
	constructor() {
		super("Plugin input write failed");
	}
}

export interface PluginInputWriter {
	/** Original input close plus owned operation outcomes; never child or reader retirement. */
	readonly drained: Promise<void>;
	/** Opaque complete frame from the actual encoder. Admission precedes this writer's copy. */
	write(frame: Uint8Array): Promise<void>;
	/** Stop new admission; accepted operations remain owned. */
	fence(): void;
	/** Same drained promise. The input owner starts end/destroy separately before awaiting it. */
	close(): Promise<void>;
}

const MAX_FRAME = HOST_MAX_FRAME_BYTES + 2;
const MAX_PENDING = 32;
const MAX_BYTES = 32 << 20;
const on = EventEmitter.prototype.on;
const off = EventEmitter.prototype.removeListener;
const typedArray = Object.getPrototypeOf(Uint8Array.prototype);
const byteKind = Object.getOwnPropertyDescriptor(typedArray, Symbol.toStringTag)?.get;
const byteBuffer = Object.getOwnPropertyDescriptor(typedArray, "buffer")?.get;
const byteOffset = Object.getOwnPropertyDescriptor(typedArray, "byteOffset")?.get;
const byteLength = Object.getOwnPropertyDescriptor(typedArray, "byteLength")?.get;
const bufferLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength")?.get;
const bufferResizable = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "resizable")?.get;

function unavailable(): never {
	throw new PluginInputWriteError();
}

function metadata(raw: Uint8Array): { backing: ArrayBuffer; offset: number; length: number } {
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
		unavailable();
	const backing = Reflect.apply(byteBuffer, raw, []) as ArrayBuffer;
	Reflect.apply(bufferLength, backing, []);
	if (Reflect.apply(bufferResizable, backing, [])) unavailable();
	return {
		backing,
		offset: Reflect.apply(byteOffset, raw, []) as number,
		length: Reflect.apply(byteLength, raw, []) as number,
	};
}

interface Operation {
	bytes: Buffer | undefined;
	readonly length: number;
	readonly promise: Promise<void>;
	readonly resolve: () => void;
	readonly reject: (error: PluginInputWriteError) => void;
	returnKnown: boolean;
	writeReturnedTrue: boolean;
	callbackDone: boolean;
	drainSeen: boolean;
	settled: boolean;
}

/**
 * Bind one ORIGINAL, exclusively written Node Writable, such as PluginProcessIo.input.
 * This structural API establishes no stream provenance, Native permission or peer receipt.
 * The writer never ends/destroys the input or child. Its owner must initiate cleanup before
 * awaiting close(). Input finish/error/destroyed state is not an observed input close.
 */
export function createPluginInputWriter(originalInput: Writable): PluginInputWriter {
	if (isProxy(originalInput) || !(originalInput instanceof Writable)) unavailable();
	const originalWrite = originalInput.write;
	if (typeof originalWrite !== "function") unavailable();
	const queue: Operation[] = [];
	let active: Operation | undefined;
	let slots = 0;
	let bytes = 0;
	let fenced = false;
	let failed = false;
	let closed = false;
	let finished = false;
	let pumping = false;
	let resolveDrained!: () => void;
	let rejectDrained!: (error: PluginInputWriteError) => void;
	const drained = new Promise<void>((resolve, reject) => {
		resolveDrained = resolve;
		rejectDrained = reject;
	});
	void Promise.allSettled([drained]);

	function refused(): Promise<void> {
		const original = Promise.reject<void>(new PluginInputWriteError());
		void Promise.allSettled([original]);
		return original;
	}
	function settle(operation: Operation, success: boolean): void {
		if (operation.settled) return;
		operation.settled = true;
		operation.bytes = undefined;
		slots--;
		bytes -= operation.length;
		if (success) operation.resolve();
		else operation.reject(new PluginInputWriteError());
	}
	function rejectQueue(): void {
		for (const operation of queue.splice(0)) settle(operation, false);
	}
	function finishDrained(): void {
		if (!closed || active || slots || finished) return;
		finished = true;
		for (const [event, listener] of [
			["error", onError],
			["close", onClose],
			["drain", onDrain],
			["finish", onFinish],
		] as const) {
			try {
				Reflect.apply(off, originalInput, [event, listener]);
			} catch {
				failed = true;
			}
		}
		if (failed) rejectDrained(new PluginInputWriteError());
		else resolveDrained();
	}
	function progress(): void {
		const operation = active;
		if (operation?.returnKnown) {
			if (closed || failed) {
				active = undefined;
				settle(operation, false);
			} else if (operation.callbackDone && (operation.writeReturnedTrue || operation.drainSeen)) {
				active = undefined;
				settle(operation, true);
			}
		}
		if (closed) finishDrained();
		else if (!failed) pump();
	}
	function fault(): void {
		failed = true;
		fenced = true;
		rejectQueue();
		progress();
	}
	function onError(): void {
		fault();
	}
	function onClose(): void {
		if (closed) return;
		closed = true;
		fenced = true;
		if (slots) failed = true;
		rejectQueue();
		progress();
	}
	function onDrain(): void {
		if (!active) return;
		active.drainSeen = true;
		progress();
	}
	function onFinish(): void {
		fenced = true;
		if (slots) fault();
	}
	function inspect(): void {
		if (originalInput.errored !== null) fault();
		if (originalInput.closed) onClose();
		else if (originalInput.destroyed || originalInput.writableEnded) fenced = true;
	}
	function pump(): void {
		if (pumping || closed || failed || active) return;
		pumping = true;
		try {
			while (!closed && !failed && !active && queue.length) {
				inspect();
				if (closed || failed) break;
				if (originalInput.destroyed || originalInput.writableEnded) {
					fault();
					break;
				}
				const operation = queue.shift();
				if (!operation) break;
				active = operation;
				try {
					const result: unknown = Reflect.apply(originalWrite, originalInput, [
						operation.bytes,
						(error?: Error | null) => {
							if (operation.settled) return;
							if (error !== undefined && error !== null) fault();
							else {
								operation.callbackDone = true;
								progress();
							}
						},
					]);
					operation.writeReturnedTrue = result === true;
					if (typeof result !== "boolean") fault();
				} catch {
					fault();
				} finally {
					operation.returnKnown = true;
					progress();
				}
			}
		} finally {
			pumping = false;
		}
	}

	try {
		Reflect.apply(on, originalInput, ["error", onError]);
		Reflect.apply(on, originalInput, ["close", onClose]);
		Reflect.apply(on, originalInput, ["drain", onDrain]);
		Reflect.apply(on, originalInput, ["finish", onFinish]);
		// Listeners precede state inspection, including an original input closed before enrollment.
		inspect();
	} catch {
		for (const [event, listener] of [
			["error", onError],
			["close", onClose],
			["drain", onDrain],
			["finish", onFinish],
		] as const) {
			try {
				Reflect.apply(off, originalInput, [event, listener]);
			} catch {}
		}
		unavailable();
	}

	function fence(): void {
		fenced = true;
	}
	return Object.freeze({
		drained,
		write(raw: Uint8Array): Promise<void> {
			try {
				inspect();
			} catch {
				fault();
				return refused();
			}
			if (fenced || closed || failed) return refused();
			let length = 0;
			let reserved = false;
			try {
				const input = metadata(raw);
				length = input.length;
				if (
					length === 0 ||
					length > MAX_FRAME ||
					slots >= MAX_PENDING ||
					bytes > MAX_BYTES - length
				)
					unavailable();
				slots++;
				bytes += length;
				reserved = true;
				const source = new Uint8Array(input.backing, input.offset, length);
				const retained = Buffer.allocUnsafe(length);
				for (let at = 0; at < length; at++) retained[at] = source[at] as number;
				let resolve!: () => void;
				let reject!: (error: PluginInputWriteError) => void;
				const promise = new Promise<void>((yes, no) => {
					resolve = yes;
					reject = no;
				});
				void Promise.allSettled([promise]);
				queue.push({
					bytes: retained,
					length,
					promise,
					resolve,
					reject,
					returnKnown: false,
					writeReturnedTrue: false,
					callbackDone: false,
					drainSeen: false,
					settled: false,
				});
				reserved = false;
				pump();
				return promise;
			} catch {
				if (reserved) {
					slots--;
					bytes -= length;
				}
				return refused();
			}
		},
		fence,
		close(): Promise<void> {
			fence();
			try {
				inspect();
			} catch {
				fault();
			}
			return drained;
		},
	});
}
