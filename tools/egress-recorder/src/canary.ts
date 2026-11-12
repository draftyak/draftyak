import { types } from "node:util";
import { type CanaryVerdict, RecorderError } from "./schema.ts";

export const MAX_CANARY_BYTES = 1_048_576;
export const MAX_CANARY_CHUNKS = 4096;
export type PayloadChunks = Iterable<Uint8Array> | AsyncIterable<Uint8Array>;

const typedArrayLength = Object.getOwnPropertyDescriptor(
	Object.getPrototypeOf(Uint8Array.prototype),
	"length",
)?.get;

function byteLength(value: unknown): number {
	if (!types.isUint8Array(value) || !typedArrayLength) throw new RecorderError("INVALID_RESULT");
	// For Uint8Array, intrinsic element length is the actual byte count of this view.
	return Reflect.apply(typedArrayLength, value, []) as number;
}

/** Keeps one bounded pattern and its prefix table, never a payload or payload digest. */
export async function scanCanary(
	canary: Uint8Array,
	chunks: PayloadChunks,
	signal: AbortSignal,
): Promise<CanaryVerdict> {
	const patternLength = byteLength(canary);
	if (patternLength < 1 || patternLength > 256) throw new RecorderError("INVALID_RESULT");
	const pattern = new Uint8Array(patternLength);
	for (let index = 0; index < patternLength; index++) pattern[index] = canary[index] as number;
	const prefix = new Uint16Array(pattern.length);
	for (let i = 1, length = 0; i < pattern.length; i++) {
		while (length && pattern[i] !== pattern[length]) length = prefix[length - 1] ?? 0;
		if (pattern[i] === pattern[length]) length++;
		prefix[i] = length;
	}
	let seen = 0;
	let count = 0;
	let length = 0;
	let matched = false;
	let iterator: AsyncIterator<Uint8Array> | Iterator<Uint8Array> | undefined;
	let abort = (): void => {};
	try {
		const factory =
			Symbol.asyncIterator in chunks ? chunks[Symbol.asyncIterator] : chunks[Symbol.iterator];
		if (typeof factory !== "function") return "failed";
		const candidate: unknown = Reflect.apply(factory, chunks, []);
		if (candidate === null || (typeof candidate !== "object" && typeof candidate !== "function"))
			return "failed";
		iterator = candidate as AsyncIterator<Uint8Array> | Iterator<Uint8Array>;
		const nextMethod = iterator.next;
		if (typeof nextMethod !== "function") return "failed";
		const cancelled = new Promise<never>((_resolve, reject) => {
			abort = () => reject(new Error("Observation ended"));
			signal.addEventListener("abort", abort, { once: true });
		});
		for (;;) {
			signal.throwIfAborted();
			const next: unknown = await Promise.race([
				Promise.resolve().then(() => Reflect.apply(nextMethod, iterator, [])),
				cancelled,
			]);
			signal.throwIfAborted();
			if (next === null || (typeof next !== "object" && typeof next !== "function"))
				return "failed";
			const step = next as IteratorResult<Uint8Array>;
			if (step.done) return matched ? "matched" : "observed-clean";
			if (++count > MAX_CANARY_CHUNKS) return "failed";
			const bytes = step.value;
			const size = byteLength(bytes);
			if (size > MAX_CANARY_BYTES - seen) return "failed";
			seen += size;
			for (let index = 0; index < size; index++) {
				const byte = bytes[index] as number;
				while (length && byte !== pattern[length]) length = prefix[length - 1] ?? 0;
				if (byte === pattern[length]) length++;
				if (length === pattern.length) {
					matched = true;
					length = prefix[length - 1] ?? 0;
				}
			}
		}
	} catch {
		return "failed";
	} finally {
		signal.removeEventListener("abort", abort);
		try {
			void Promise.resolve(iterator?.return?.()).catch(() => {});
		} catch {
			/* A source cleanup failure never changes the fixed verdict. */
		}
		pattern.fill(0);
		prefix.fill(0);
	}
}
