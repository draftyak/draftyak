import type { HeaderList } from "@draftyak/protocol/hash";
import {
	HOST_MAX_STREAM_BYTES,
	HostFetchResult,
	HostStreamChunk,
} from "@draftyak/protocol/host-channel";
import { MAX_INLINE_BYTES } from "@draftyak/protocol/normalized-change";
import { newId } from "../../../kernel/ids.ts";
import { NativeChannelHostError } from "./native-connection.ts";

export interface NativeMetadataBufferedResponse {
	readonly status: number;
	readonly headers: HeaderList;
	/** Ownership transfers to delivery; every terminal path erases this buffer. */
	readonly body: Buffer;
}

/** Resource acknowledgments only. The native caller owns all request authority checks. */
export interface NativeMetadataDeliveryWriter {
	readonly replyWritten: Promise<void>;
	writeChunk(chunk: HostStreamChunk): Promise<void>;
}

export interface NativeMetadataDelivery {
	readonly result: HostFetchResult;
	/** A rejected reply/chunk acknowledgment remains a delivery failure after result publication. */
	complete(): Promise<void>;
}

const refused = (): NativeChannelHostError => new NativeChannelHostError();

/** Delivers already-owned response DATA; this helper never grants or selects a native request. */
export function createNativeMetadataDelivery(
	response: NativeMetadataBufferedResponse,
	writer: NativeMetadataDeliveryWriter,
	stream: boolean,
	signal: AbortSignal,
): NativeMetadataDelivery {
	try {
		signal.throwIfAborted();
		if (response.body.length > HOST_MAX_STREAM_BYTES) throw refused();
		if (response.body.length <= MAX_INLINE_BYTES) {
			const result = HostFetchResult.parse({
				status: response.status,
				headers: response.headers,
				body: { base64: response.body.toString("base64url") },
			});
			response.body.fill(0);
			let started = false;
			return Object.freeze({
				result,
				async complete(): Promise<void> {
					if (started) throw refused();
					started = true;
					try {
						await writer.replyWritten;
					} catch {
						throw refused();
					} finally {
						response.body.fill(0);
					}
				},
			});
		}
		if (!stream) throw refused();
		const streamId = newId();
		const result = HostFetchResult.parse({
			status: response.status,
			headers: response.headers,
			streamId,
		});
		let started = false;
		return Object.freeze({
			result,
			async complete(): Promise<void> {
				if (started) throw refused();
				started = true;
				let acknowledged = false;
				let sequence = 0;
				try {
					await writer.replyWritten;
					acknowledged = true;
					for (let offset = 0; offset < response.body.length; offset += MAX_INLINE_BYTES) {
						signal.throwIfAborted();
						const end = Math.min(response.body.length, offset + MAX_INLINE_BYTES);
						await writer.writeChunk(
							HostStreamChunk.parse({
								streamId,
								sequence: sequence++,
								base64: response.body.subarray(offset, end).toString("base64url"),
								done: end === response.body.length,
							}),
						);
						// The successful final acknowledgment may end its own resource signal.
						if (end < response.body.length) signal.throwIfAborted();
					}
				} catch {
					// No chunk, including terminal control, precedes the initial reply acknowledgment.
					if (acknowledged) {
						try {
							await writer.writeChunk(
								HostStreamChunk.parse({
									streamId,
									sequence,
									base64: "",
									done: true,
									error: "DENIED",
								}),
							);
						} catch {
							/* A refused terminal write does not erase the original delivery failure. */
						}
					}
					throw refused();
				} finally {
					response.body.fill(0);
				}
			},
		});
	} catch {
		response.body.fill(0);
		throw refused();
	}
}
