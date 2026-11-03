import { addAbortListener } from "node:events";
import { isProxy } from "node:util/types";
import {
	HOST_JSON_MEMBER_MAX_ENTITY_BYTES,
	HOST_JSON_MEMBER_MAX_ERROR_BYTES,
	HostFetchParams,
} from "@draftyak/protocol/host-channel";
import { BlobRef } from "@draftyak/protocol/normalized-change";
import {
	isDetached,
	type JsonMember,
	type JsonMemberDecoder,
	type JsonMemberLimits,
	jsonMemberLimit,
} from "./decoder.ts";
import { JsonMemberRefusal, type JsonMemberRefusalCode } from "./refusal.ts";

/** Native facts about one host/fetch; only `params` comes from the plugin. */
export interface JsonMemberRequest {
	/** The calling plugin's kind. */
	readonly pluginKind: string;
	/** The broker's classification of the request. */
	readonly requestClass: string;
	readonly params: unknown;
}

/**
 * The hub-owned encrypted blob writer for one projection. Writes stage bytes; nothing is visible
 * until `commit`, which the projection calls once, only after the whole document validated.
 * `abort` discards everything staged, including after a commit that was still in flight.
 */
export interface JsonMemberWriter {
	write(bytes: Uint8Array, signal: AbortSignal): Promise<void>;
	commit(signal: AbortSignal): Promise<BlobRef>;
	abort(): Promise<void>;
}

/** A bounded inline body for a non-2xx response, which is never projected. */
export interface JsonMemberErrorBody {
	countCompressed(byteLength: number): void;
	push(chunk: Uint8Array): void;
	end(): Uint8Array;
}

function refuse(code: JsonMemberRefusalCode): never {
	throw new JsonMemberRefusal(code);
}

function ownValue(record: object, name: string): unknown {
	const field = Object.getOwnPropertyDescriptor(record, name);
	if (field !== undefined && (!field.enumerable || !Object.hasOwn(field, "value")))
		refuse("REQUEST_INVALID");
	return field?.value;
}

/**
 * Admits only an otherwise-authorized channel read: GET with the decoded-member option, without
 * `stream: true` and without a lookup permit. Returns the selected member.
 */
export function admitJsonMemberFetch(request: JsonMemberRequest): JsonMember {
	if (request === null || typeof request !== "object" || isProxy(request))
		refuse("REQUEST_INVALID");
	const params = ownValue(request, "params");
	const parsed = HostFetchParams.safeParse(params);
	if (!parsed.success) return refuse("REQUEST_INVALID");
	const { method, saveAs, stream, lookupPermit } = parsed.data;
	if (method !== "GET" || saveAs === undefined || saveAs === "blob" || stream === true)
		refuse("REQUEST_INVALID");
	if (
		ownValue(request, "pluginKind") !== "channel" ||
		ownValue(request, "requestClass") !== "read" ||
		lookupPermit !== undefined
	)
		refuse("REQUEST_DENIED");
	return saveAs.member;
}

function captureWriter(writer: JsonMemberWriter): JsonMemberWriter {
	if (writer === null || typeof writer !== "object" || isProxy(writer)) refuse("STORAGE_FAILED");
	const write: unknown = writer.write,
		commit: unknown = writer.commit,
		abort: unknown = writer.abort;
	if (typeof write !== "function" || typeof commit !== "function" || typeof abort !== "function")
		refuse("STORAGE_FAILED");
	return Object.freeze({
		write: (bytes: Uint8Array, signal: AbortSignal) =>
			Reflect.apply(write, writer, [bytes, signal]) as Promise<void>,
		commit: (signal: AbortSignal) => Reflect.apply(commit, writer, [signal]) as Promise<BlobRef>,
		abort: () => Reflect.apply(abort, writer, []) as Promise<void>,
	});
}

/**
 * Settles with the step's value, or refuses: ABORTED when the signal fires first, otherwise the
 * decoder's own refusal if it has one (a transport that stopped because of it), else `code`.
 */
function step<T>(
	work: () => Promise<T>,
	code: JsonMemberRefusalCode,
	decoder: JsonMemberDecoder,
	signal: AbortSignal,
): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		if (signal.aborted) {
			reject(new JsonMemberRefusal("ABORTED"));
			return;
		}
		const failed = (): void => reject(decoder.failure ?? new JsonMemberRefusal(code));
		const abort = addAbortListener(signal, () => reject(new JsonMemberRefusal("ABORTED")));
		let pending: Promise<T>;
		try {
			pending = Promise.resolve(work());
		} catch {
			abort[Symbol.dispose]();
			failed();
			return;
		}
		pending.then(
			(value) => {
				abort[Symbol.dispose]();
				if (signal.aborted) reject(new JsonMemberRefusal("ABORTED"));
				else resolve(value);
			},
			() => {
				abort[Symbol.dispose]();
				if (signal.aborted) reject(new JsonMemberRefusal("ABORTED"));
				else failed();
			},
		);
	});
}

/**
 * Projects a 2xx entity through `decoder` into `writer`. The entity is the body after
 * Content-Encoding; a transport that also decompresses calls `decoder.countCompressed` for the
 * bytes it receives. Returns the committed reference only after the whole document validated and
 * storage committed. On any refusal the writer is aborted, no reference is returned and the
 * entity's iterator is closed.
 */
export async function writeJsonMember(
	decoder: JsonMemberDecoder,
	entity: AsyncIterable<Uint8Array>,
	writer: JsonMemberWriter,
	signal: AbortSignal,
): Promise<BlobRef> {
	const target = captureWriter(writer);
	let iterator: AsyncIterator<Uint8Array> | undefined;
	try {
		if (signal.aborted) refuse("ABORTED");
		try {
			iterator = entity[Symbol.asyncIterator]();
		} catch {
			refuse("ENTITY_FAILED");
		}
		const source = iterator;
		for (;;) {
			const next = await step(() => source.next(), "ENTITY_FAILED", decoder, signal);
			if (next.done === true) break;
			const decoded = decoder.push(next.value);
			if (decoded.byteLength > 0)
				await step(() => target.write(decoded, signal), "STORAGE_FAILED", decoder, signal);
		}
		decoder.end();
		const committed = await step(() => target.commit(signal), "STORAGE_FAILED", decoder, signal);
		const ref = BlobRef.safeParse(committed);
		if (!ref.success) return refuse("STORAGE_FAILED");
		return Object.freeze({ ref: ref.data.ref });
	} catch (error) {
		const source = iterator;
		void Promise.resolve()
			.then(() => {
				// Read once, inside the guard: a throwing getter cannot skip the cleanup below.
				const done = source?.return;
				return typeof done === "function" ? Reflect.apply(done, source, []) : undefined;
			})
			.catch(() => {});
		try {
			await target.abort();
		} catch {
			// The refusal below is reported whether or not cleanup itself failed.
		}
		throw error instanceof JsonMemberRefusal
			? error
			: (decoder.failure ?? new JsonMemberRefusal("ENTITY_FAILED"));
	}
}

/**
 * At most 65,536 bytes after Content-Encoding, or a stricter `decompressedEntityBytes`
 * (inclusive); an excess is refused, never cut.
 */
export function createJsonMemberErrorBody(
	limits: Pick<JsonMemberLimits, "compressedEntityBytes" | "decompressedEntityBytes"> = {},
): JsonMemberErrorBody {
	const maxCompressed = jsonMemberLimit(
		limits,
		"compressedEntityBytes",
		HOST_JSON_MEMBER_MAX_ENTITY_BYTES,
	);
	const maxBody = Math.min(
		HOST_JSON_MEMBER_MAX_ERROR_BYTES,
		jsonMemberLimit(limits, "decompressedEntityBytes", HOST_JSON_MEMBER_MAX_ENTITY_BYTES),
	);
	const chunks: Uint8Array[] = [];
	let compressed = 0,
		total = 0,
		failure: JsonMemberRefusal | undefined,
		finished = false;
	const fail = (code: JsonMemberRefusalCode): never => {
		failure = new JsonMemberRefusal(code);
		throw failure;
	};
	const usable = (): void => {
		if (failure !== undefined) throw failure;
		if (finished) fail("ENTITY_FAILED");
	};
	return Object.freeze({
		countCompressed(byteLength: number): void {
			usable();
			if (!Number.isSafeInteger(byteLength) || byteLength < 0) fail("ENTITY_FAILED");
			compressed += byteLength;
			if (compressed > maxCompressed) fail("COMPRESSED_TOO_LARGE");
		},
		push(chunk: Uint8Array): void {
			usable();
			if (!(chunk instanceof Uint8Array) || isProxy(chunk) || isDetached(chunk))
				fail("ENTITY_FAILED");
			if (total + chunk.byteLength > maxBody) fail("ERROR_BODY_TOO_LARGE");
			// A copy: a Buffer's slice() is a view of memory the transport may reuse.
			chunks.push(new Uint8Array(chunk));
			total += chunk.byteLength;
		},
		end(): Uint8Array {
			usable();
			finished = true;
			return new Uint8Array(Buffer.concat(chunks, total));
		},
	});
}
