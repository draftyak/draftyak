import { createHash } from "node:crypto";
import { types } from "node:util";
import {
	BACKUP_ARTIFACT_HEADER_SIZE,
	BackupArtifactError,
	decodeBackupArtifactHeader,
} from "./backup-artifact.ts";

export interface BackupArtifactStream {
	bytes(): AsyncIterable<Uint8Array>;
	close(): Promise<void>;
}

const typedArray = Object.getPrototypeOf(Uint8Array.prototype);
const lengthOf = Object.getOwnPropertyDescriptor(typedArray, "byteLength")?.get;
const bufferOf = Object.getOwnPropertyDescriptor(typedArray, "buffer")?.get;
const copyBytes = Uint8Array.prototype.set;
const CHUNK_SIZE = 65_536;
function refuse(): never {
	throw new BackupArtifactError();
}

function capture(value: unknown, maximum: number, exact?: number): Buffer {
	if (types.isProxy(value) || !types.isUint8Array(value) || !lengthOf || !bufferOf) refuse();
	const length = lengthOf.call(value) as number;
	if (
		length < 1 ||
		length > maximum ||
		(exact !== undefined && length !== exact) ||
		types.isSharedArrayBuffer(bufferOf.call(value))
	)
		refuse();
	const owned = Buffer.alloc(length);
	try {
		copyBytes.call(owned, value as Uint8Array);
		return owned;
	} catch {
		owned.fill(0);
		return refuse();
	}
}

/** Frames encrypted DATA; no metadata or iterator here establishes native authority. */
export function createBackupArtifactStream(
	header: unknown,
	image: AsyncIterable<unknown>,
): BackupArtifactStream {
	let prefix: Buffer | undefined;
	let expectedLength: number;
	let expectedDigest: string;
	try {
		prefix = capture(header, BACKUP_ARTIFACT_HEADER_SIZE, BACKUP_ARTIFACT_HEADER_SIZE);
		const decoded = decodeBackupArtifactHeader(prefix);
		try {
			expectedLength = decoded.byteLength;
			expectedDigest = decoded.sha256;
		} finally {
			decoded.capsule.fill(0);
			decoded.binding.fill(0);
		}
	} catch {
		prefix?.fill(0);
		return refuse();
	}
	if (!prefix) return refuse();
	const ownedPrefix = prefix;
	let phase: "open" | "closing" | "closed" = "open";
	let claimed = false;
	let completed = false;
	let generator: AsyncGenerator<Uint8Array, void, unknown> | undefined;
	let source: AsyncIterator<unknown> | undefined;
	let sourceReturn: ((value?: unknown) => unknown) | undefined;
	let returnCaptured = false;
	let finalized = false;
	let finalizing: Promise<void> | undefined;
	let closing: Promise<void> | undefined;

	function captureReturn(): void {
		if (returnCaptured || !source) return;
		const method = source.return;
		if (method !== undefined && typeof method !== "function") refuse();
		sourceReturn = method;
		returnCaptured = true;
	}

	function finalize(): Promise<void> {
		if (finalized) return Promise.resolve();
		if (finalizing) return finalizing;
		const task = (async () => {
			if (source) {
				captureReturn();
				if (sourceReturn) {
					const result = await Reflect.apply(sourceReturn, source, []);
					if (!result || typeof result !== "object" || (result as { done?: unknown }).done !== true)
						refuse();
				}
			}
			finalized = true;
			source = undefined;
			sourceReturn = undefined;
		})();
		finalizing = task;
		void task.catch(() => {
			if (finalizing === task) finalizing = undefined;
		});
		return task;
	}

	const finish = async (valid: boolean, failed: boolean): Promise<void> => {
		ownedPrefix.fill(0);
		let incomplete = failed;
		try {
			await finalize();
		} catch {
			incomplete = true;
		}
		if (incomplete || (valid && phase !== "open")) {
			phase = "closing";
			throw new BackupArtifactError();
		}
		completed = valid;
		phase = "closed";
	};

	async function* generate(): AsyncGenerator<Uint8Array, void, unknown> {
		let failed = false;
		let valid = false;
		try {
			if (phase !== "open") refuse();
			yield Buffer.from(ownedPrefix);
			if (phase !== "open") refuse();
			const method = image[Symbol.asyncIterator];
			if (phase !== "open" || typeof method !== "function") refuse();
			const acquired = Reflect.apply(method, image, []);
			if (!acquired || typeof acquired !== "object") refuse();
			const originalIterator = acquired as AsyncIterator<unknown>;
			source = originalIterator;
			if (phase !== "open") refuse();
			captureReturn();
			if (phase !== "open") refuse();
			const next = originalIterator.next;
			if (phase !== "open" || typeof next !== "function") refuse();
			const hash = createHash("sha256");
			let total = 0;
			for (;;) {
				if (phase !== "open") refuse();
				const result = await Reflect.apply(next, originalIterator, []);
				if (phase !== "open" || !result || typeof result !== "object") refuse();
				const done = result.done;
				if (phase !== "open") refuse();
				if (done === true) {
					if (total !== expectedLength || hash.digest("hex") !== expectedDigest) refuse();
					valid = true;
					break;
				}
				if (done !== undefined && done !== false) refuse();
				const offered = result.value;
				if (phase !== "open") refuse();
				let chunk: Buffer | undefined = capture(offered, CHUNK_SIZE);
				try {
					if (phase !== "open" || chunk.length > expectedLength - total) refuse();
					total += chunk.length;
					hash.update(chunk);
					const outgoing = chunk;
					chunk = undefined;
					yield outgoing;
				} finally {
					chunk?.fill(0);
				}
			}
		} catch {
			failed = true;
		} finally {
			await finish(valid, failed);
		}
	}

	const close = (): Promise<void> => {
		if (closing) return closing;
		if (phase === "closed") return Promise.resolve();
		phase = "closing";
		const task = (async () => {
			let failed = false;
			try {
				if (generator) await generator.return();
			} catch {
				failed = true;
			}
			// A return that just failed finalization is not retried in the same close.
			if (!failed && !finalized) {
				try {
					await finalize();
				} catch {
					failed = true;
				}
			}
			ownedPrefix.fill(0);
			if (failed) throw new BackupArtifactError();
			phase = "closed";
		})();
		closing = task;
		void task.catch(() => {
			if (closing === task) closing = undefined;
		});
		return task;
	};

	return Object.freeze({
		bytes(): AsyncIterable<Uint8Array> {
			if (claimed || phase !== "open") return refuse();
			claimed = true;
			let iterated = false;
			return {
				[Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
					if (iterated || phase !== "open") return refuse();
					iterated = true;
					const current = generate();
					generator = current;
					return {
						next() {
							if (phase !== "open" && !completed) return Promise.reject(new BackupArtifactError());
							return current.next().then((result) => {
								if (!completed && (result.done || phase !== "open")) refuse();
								return result;
							});
						},
						return() {
							return close().then(() => ({ done: true, value: undefined }));
						},
						throw() {
							return close().then(() => refuse());
						},
					};
				},
			};
		},
		close,
	});
}
