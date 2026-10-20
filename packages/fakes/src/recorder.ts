import { createHash } from "node:crypto";
import { rawTarget, splitTarget } from "./target.ts";

export interface RecorderOptions {
	/** Headers (any case) whose values are kept; every other header keeps only its name. */
	readonly headerValues?: readonly string[];
	/** Prefix bytes kept per request; the hash covers every received byte. Default 65,536. */
	readonly maxBodyBytes?: number;
}

export interface RecordedRequest {
	readonly method: string;
	readonly host: string;
	/** The request target as it arrived (rawTarget): nothing decoded, resolved or dropped. */
	readonly target: string;
	/** The target's path, up to any `?` or `#`. */
	readonly path: string;
	/** The target's query without its `?`, up to any `#`; empty when there is none. */
	readonly query: string;
	/** Every header name, lower-case and sorted. */
	readonly headerNames: readonly string[];
	/** Values of the selected headers only. */
	readonly headers: Readonly<Record<string, string>>;
	/** The body's first `maxBodyBytes` bytes. */
	readonly body: Uint8Array;
	readonly bodyLength: number;
	/** Lowercase hex SHA-256 of received bytes; a refused upload may have an unread remainder. */
	readonly bodySha256: string;
	/** Present only when intake stopped before the whole upload was received. */
	readonly refused?: "request_body_too_large";
}

export interface Recording {
	/** Adds the exact bytes received, retaining only the recorder's configured prefix. */
	write(bytes: Uint8Array): void;
	finish(refused?: "request_body_too_large"): void;
	discard(): void;
}

export interface Recorder {
	/** Required for capped intake; reserves a slot that must be finished or discarded once. */
	begin?(request: Request): Recording;
	/**
	 * Takes the request's place in the record at once, in arrival order, and completes it once the
	 * body is read; the app still gets the body. Rejects, recording nothing, if the body can't be read.
	 */
	record(request: Request): Promise<void>;
	/**
	 * The requests recorded since the last call, oldest first; the recorder forgets them. One still
	 * reading its body holds back itself and every later request until a later call.
	 */
	takeRequests(): RecordedRequest[];
}

export interface StreamingRecorder extends Recorder {
	begin(request: Request): Recording;
}

export function createRecorder(options: RecorderOptions = {}): StreamingRecorder {
	const selected = new Set((options.headerValues ?? []).map((name) => name.toLowerCase()));
	const cap = options.maxBodyBytes ?? 65_536;
	if (!(Number.isSafeInteger(cap) && cap >= 0)) {
		throw new RangeError(`maxBodyBytes must be a whole number of bytes: ${cap}`);
	}
	const slots: { entry?: RecordedRequest }[] = [];
	const begin = (request: Request): Recording => {
		const slot: { entry?: RecordedRequest } = {};
		const target = rawTarget(request);
		const headers: Record<string, string> = {};
		for (const name of selected) {
			const value = request.headers.get(name);
			if (value !== null) headers[name] = value;
		}
		const headerNames = [...request.headers.keys()];
		const hash = createHash("sha256");
		slots.push(slot);
		const chunks: Uint8Array[] = [];
		let bodyLength = 0;
		let kept = 0;
		let settled = false;
		const active = (): void => {
			if (settled) throw new Error("Recording already settled");
		};
		return {
			write(value) {
				active();
				if (!(value instanceof Uint8Array)) throw new TypeError("Received non-Uint8Array chunk");
				hash.update(value);
				bodyLength += value.byteLength;
				const take = Math.min(value.byteLength, cap - kept);
				if (take > 0) {
					chunks.push(new Uint8Array(value.subarray(0, take)));
					kept += take;
				}
			},
			finish(refused) {
				active();
				settled = true;
				const body = new Uint8Array(kept);
				let offset = 0;
				for (const chunk of chunks) {
					body.set(chunk, offset);
					offset += chunk.byteLength;
				}
				slot.entry = {
					method: request.method,
					host: new URL(request.url).host,
					target,
					...splitTarget(target),
					headerNames,
					headers,
					body,
					bodyLength,
					bodySha256: hash.digest("hex"),
					...(refused === undefined ? {} : { refused }),
				};
			},
			discard() {
				active();
				settled = true;
				slots.splice(slots.indexOf(slot), 1);
			},
		};
	};
	return {
		begin,
		async record(request) {
			const recording = begin(request);
			let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
			try {
				reader = request.body === null ? undefined : request.clone().body?.getReader();
				if (reader) {
					for (;;) {
						const { done, value } = await reader.read();
						if (done) break;
						recording.write(value);
					}
				}
				recording.finish();
			} catch (error) {
				recording.discard();
				throw error;
			} finally {
				reader?.releaseLock();
			}
		},
		takeRequests() {
			const reading = slots.findIndex((slot) => slot.entry === undefined);
			const done = slots.splice(0, reading === -1 ? slots.length : reading);
			return done.flatMap((slot) => (slot.entry === undefined ? [] : [slot.entry]));
		},
	};
}
