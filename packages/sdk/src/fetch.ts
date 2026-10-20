import {
	type BlobRef,
	type Bytes,
	type HostStreamChunk as Chunk,
	HOST_MAX_ACTIVE_REQUESTS,
	HOST_MAX_STREAM_BYTES,
	HOST_REQUEST_TIMEOUT_MS,
	type HostErrorCode,
	type HostFetchParams,
	type HostNotification,
	HostStreamChunk,
} from "@draftyak/protocol/host-channel";
import { MAX_INLINE_BYTES } from "@draftyak/protocol/normalized-change";
import { type HostChannel, HostError } from "./host.ts";

export interface HostFetchInit extends Omit<RequestInit, "body"> {
	readonly body?: BodyInit | Bytes | null;
	readonly sendTicket?: unknown;
	readonly saveAs?: "blob";
	readonly stream?: boolean;
}
export interface HostResponse extends Response {
	readonly bodyRef?: BlobRef;
}
export type HostFetch = (input: RequestInfo | URL, init?: HostFetchInit) => Promise<HostResponse>;

async function boundedBody(request: Request, signal: AbortSignal): Promise<Bytes | undefined> {
	if (!request.body) return undefined;
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	let rejectAbort: (reason: unknown) => void = () => {};
	const aborted = new Promise<never>((_resolve, reject) => {
		rejectAbort = reject;
	});
	const abort = (): void => {
		void reader.cancel().catch(() => {});
		rejectAbort(new HostError("DENIED"));
	};
	signal.addEventListener("abort", abort, { once: true });
	try {
		while (true) {
			if (signal.aborted) throw new HostError("DENIED");
			const next = await Promise.race([reader.read(), aborted]);
			if (signal.aborted) throw new HostError("DENIED");
			if (next.done) break;
			size += next.value.byteLength;
			if (size > MAX_INLINE_BYTES) throw new HostError("TOO_LARGE");
			chunks.push(next.value);
		}
	} finally {
		signal.removeEventListener("abort", abort);
		// Do not await a caller stream's cancellation hook: it can itself remain pending.
		void reader.cancel().catch(() => {});
		reader.releaseLock();
	}
	return { base64: Buffer.concat(chunks).toString("base64url") };
}
function bodyReference(value: unknown): value is Bytes {
	return value !== null && typeof value === "object" && ("ref" in value || "base64" in value);
}

interface StreamLease {
	bind(streamId: string): readonly Chunk[];
	release(): void;
}
interface StreamOwner {
	readonly consume: (chunk: Chunk) => void;
	readonly fail: (code: HostErrorCode) => void;
	streamId?: string;
}
interface EarlyStream {
	chunks: Chunk[];
	bytes: number;
	failed: boolean;
}
interface StreamRouter {
	acquire(consume: StreamOwner["consume"], fail: StreamOwner["fail"]): StreamLease;
}
const streamRouters = new WeakMap<HostChannel, StreamRouter>();

function streamRouter(host: HostChannel): StreamRouter {
	const existing = streamRouters.get(host);
	if (existing) return existing;
	const leases = new Set<StreamOwner>();
	const unresolved = new Set<StreamOwner>();
	const streams = new Map<string, StreamOwner>();
	const early = new Map<string, EarlyStream>();
	let unsubscribe: (() => void) | undefined;
	const failUnresolved = (): void => {
		early.clear();
		for (const owner of [...unresolved]) owner.fail("TOO_LARGE");
	};
	const notify = (notification: HostNotification): void => {
		if (notification.method !== "host/stream.chunk") return;
		let chunk: Chunk;
		try {
			chunk = HostStreamChunk.parse(notification.params);
		} catch {
			for (const owner of [...leases]) owner.fail("BAD_REQUEST");
			return;
		}
		const owner = streams.get(chunk.streamId);
		if (owner) {
			owner.consume(chunk);
			return;
		}
		if (!unresolved.size) return;
		let mailbox = early.get(chunk.streamId);
		if (!mailbox) {
			// Correlation is not available yet. Exhaustion refuses unresolved calls only.
			if (early.size >= HOST_MAX_ACTIVE_REQUESTS) {
				failUnresolved();
				return;
			}
			mailbox = { chunks: [], bytes: 0, failed: false };
			early.set(chunk.streamId, mailbox);
		}
		if (mailbox.failed) return;
		// At most 16 IDs, each with 16 chunks / 1 MiB encoded, stored once per channel.
		if (mailbox.chunks.length >= 16 || mailbox.bytes + chunk.base64.length > 1_048_576) {
			mailbox.chunks = [];
			mailbox.bytes = 0;
			mailbox.failed = true;
			return;
		}
		mailbox.chunks.push(chunk);
		mailbox.bytes += chunk.base64.length;
	};
	const router: StreamRouter = {
		acquire(consume, fail) {
			// Include established streams: host replies alone must not free their leases.
			if (leases.size >= HOST_MAX_ACTIVE_REQUESTS) throw new HostError("TOO_LARGE");
			if (!unsubscribe)
				unsubscribe = host.subscribe(notify, () => {
					for (const owner of [...leases]) owner.fail("DENIED");
				});
			const owner: StreamOwner = { consume, fail };
			leases.add(owner);
			unresolved.add(owner);
			return {
				bind(streamId) {
					if (!leases.has(owner) || !unresolved.has(owner) || streams.has(streamId))
						throw new HostError("DENIED");
					const mailbox = early.get(streamId);
					early.delete(streamId);
					if (mailbox?.failed) throw new HostError("TOO_LARGE");
					unresolved.delete(owner);
					owner.streamId = streamId;
					streams.set(streamId, owner);
					if (!unresolved.size) early.clear();
					return mailbox?.chunks ?? [];
				},
				release() {
					if (!leases.delete(owner)) return;
					unresolved.delete(owner);
					if (owner.streamId) streams.delete(owner.streamId);
					if (!unresolved.size) early.clear();
					if (!leases.size) {
						unsubscribe?.();
						unsubscribe = undefined;
						streamRouters.delete(host);
					}
				},
			};
		},
	};
	streamRouters.set(host, router);
	return router;
}

export function hostFetch(host: HostChannel, defaultSignal?: AbortSignal): HostFetch {
	return async (input, init = {}) => {
		const { sendTicket, saveAs, stream, body, ...requestInit } = init;
		const reference = bodyReference(body) ? body : undefined;
		const url = input instanceof Request ? input.url : input.toString();
		// Request's URL parser cannot represent the hub's opaque secret references.
		const secret = url.startsWith("secret://");
		const request = new Request(secret ? "https://secret.invalid/" : input, {
			...requestInit,
			...(reference ? {} : body === undefined ? {} : { body: body as BodyInit }),
			duplex: "half",
		} as RequestInit);
		const signal = defaultSignal
			? AbortSignal.any([defaultSignal, request.signal])
			: request.signal;
		if (signal.aborted) throw signal.reason;
		const params: HostFetchParams = {
			method: request.method as HostFetchParams["method"],
			url,
			headers: Array.from(request.headers.entries()),
			...(reference
				? { body: reference }
				: await boundedBody(request, signal).then((value) => (value ? { body: value } : {}))),
			...(sendTicket === undefined ? {} : { sendTicket }),
			...(saveAs ? { saveAs } : {}),
			...(stream === undefined ? {} : { stream }),
		};
		let streamId: string | undefined;
		let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
		let total = 0;
		let sequence = 0;
		let finished = false;
		let failure: HostError | undefined;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let lease: StreamLease | undefined;
		const requestAbort = new AbortController();
		const dispose = (): void => {
			clearTimeout(timer);
			lease?.release();
			signal.removeEventListener("abort", onAbort);
		};
		const abort = (code: HostErrorCode = "DENIED"): void => {
			if (!finished) {
				finished = true;
				failure = new HostError(code);
				controller?.error(failure);
				requestAbort.abort(failure);
				dispose();
			}
		};
		const onAbort = (): void => abort();
		const consume = (chunk: Chunk): void => {
			if (finished || chunk.streamId !== streamId) return;
			const data = Buffer.from(chunk.base64, "base64url");
			total += data.length;
			if (chunk.sequence !== sequence++ || total > HOST_MAX_STREAM_BYTES || chunk.error) {
				finished = true;
				controller?.error(new HostError(chunk.error ?? "TOO_LARGE"));
				dispose();
				return;
			}
			if (data.length) controller?.enqueue(data);
			if (chunk.done) {
				finished = true;
				controller?.close();
				dispose();
			}
		};
		try {
			lease = streamRouter(host).acquire(consume, abort);
			signal.addEventListener("abort", onAbort, { once: true });
			if (signal.aborted) abort();
			if (finished) throw failure;
			const result = await host.request("host/fetch", params, {
				signal: AbortSignal.any([signal, requestAbort.signal]),
			});
			if (finished) throw failure;
			let responseBody: BodyInit | null = null;
			if (result.streamId) {
				streamId = result.streamId;
				timer = setTimeout(onAbort, HOST_REQUEST_TIMEOUT_MS);
				responseBody = new ReadableStream<Uint8Array>({
					start(value) {
						controller = value;
						const early = lease?.bind(result.streamId as string) ?? [];
						for (const chunk of early) consume(chunk);
					},
					cancel() {
						finished = true;
						dispose();
					},
				});
			} else if (result.body && "base64" in result.body) {
				responseBody = Buffer.from(result.body.base64, "base64url");
				dispose();
			} else dispose();
			if (request.method === "HEAD" || [204, 205, 304].includes(result.status)) {
				responseBody = null;
				dispose();
			}
			const response: HostResponse = new Response(responseBody, {
				status: result.status,
				headers: result.headers as [string, string][],
			});
			if (result.body && "ref" in result.body)
				Object.defineProperty(response, "bodyRef", {
					value: Object.freeze({ ref: result.body.ref }),
					enumerable: true,
				});
			return response;
		} catch (error) {
			dispose();
			throw failure ?? error;
		}
	};
}
