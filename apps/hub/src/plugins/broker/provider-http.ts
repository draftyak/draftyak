import { addAbortListener } from "node:events";
import type { ClientRequest, IncomingMessage } from "node:http";
import { request } from "node:https";
import {
	HOST_MAX_ACTIVE_REQUESTS,
	HOST_MAX_HEADER_BYTES,
	HOST_MAX_STREAM_BYTES,
	HOST_REQUEST_TIMEOUT_MS,
	HostFetchResult,
	HostHeaders,
	type HostNotification,
	HostStreamChunk,
} from "@draftyak/protocol/host-channel";
import type { AiProfile } from "@draftyak/protocol/manifest/ai-http";
import { MAX_INLINE_BYTES } from "@draftyak/protocol/normalized-change";
import { Ulid } from "@draftyak/protocol/scalars";
import { type CredentialBinding, CredentialVault } from "../../credentials/vault.ts";
import { newId } from "../../kernel/ids.ts";
import { fields } from "./ai/boundary.ts";
import {
	type AiProfileRegistry,
	type AiRequestLifecycle,
	type AiRequestSnapshot,
	aiRequestEndpoint,
	captureAiRequestInputs,
	failAiRequestCapture,
	snapshotVerifiedAiRequest,
	verifiedAiRequestLifecycle,
	verifyCapturedAiRequest,
} from "./ai/index.ts";
import {
	captureEgressPolicy,
	createPinnedHttpsConnection,
	type EgressPolicy,
	type PinnedAddress,
	resolveEgressAnswers,
	validateEgressAnswers,
} from "./network/index.ts";

export class ProviderHttpError extends Error {
	readonly code = "PROVIDER_HTTP_REFUSED";
	constructor() {
		super("Provider request unavailable");
	}
}
const refused = (): ProviderHttpError => new ProviderHttpError();
const useCredential = CredentialVault.prototype.withCredential;
const describeCredential = CredentialVault.prototype.describe;

export type ProviderStreamSink = (
	notification: HostNotification,
	signal: AbortSignal,
) => Promise<void>;
export interface ProviderHttpStream {
	readonly response: Promise<HostFetchResult>;
	readonly completion: Promise<void>;
	/** Begin notifications only after the native owner has delivered the host/fetch reply. */
	start(): void;
	cancel(): void;
}
interface StreamDelivery {
	readonly streamId: string;
	readonly started: Promise<void>;
	readonly sink: ProviderStreamSink;
	readonly open: (result: HostFetchResult) => void;
}
interface ResponseObservation {
	readonly maxResponseBytes: number;
	complete(status: number, body: Uint8Array): void;
	acknowledge(): void;
}

export interface ProviderHttpBroker {
	/** Native invocation data, never fields accepted from a plugin's host/fetch frame. */
	execute(
		profile: AiProfile,
		candidate: unknown,
		binding: unknown,
		reference: string,
		credential: CredentialBinding,
		signal: AbortSignal,
	): Promise<HostFetchResult>;
	stream(
		profile: AiProfile,
		candidate: unknown,
		binding: unknown,
		reference: string,
		credential: CredentialBinding,
		signal: AbortSignal,
		sink: ProviderStreamSink,
	): ProviderHttpStream;
	close(): void;
}

function untilAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const abort = addAbortListener(signal, () => reject(refused()));
		work.then(
			(value) => {
				abort[Symbol.dispose]();
				if (signal.aborted) reject(refused());
				else resolve(value);
			},
			() => {
				abort[Symbol.dispose]();
				reject(refused());
			},
		);
	});
}

async function streamResponse(
	response: IncomingMessage,
	delivery: StreamDelivery,
	key: string,
	signal: AbortSignal,
	transportSignal: AbortSignal,
	status: number,
	observation?: ResponseObservation,
): Promise<void> {
	const keyBytes = Buffer.from(key, "ascii");
	const observed: Buffer[] = [];
	const maxBytes = observation?.maxResponseBytes ?? HOST_MAX_STREAM_BYTES;
	let tail: Buffer = Buffer.alloc(0),
		total = 0,
		sequence = 0,
		busy = false,
		terminal = false,
		released = false;
	const notify = async (bytes: Uint8Array, done: boolean, control = false): Promise<void> => {
		if (!control) transportSignal.throwIfAborted();
		const params = HostStreamChunk.parse({
			streamId: delivery.streamId,
			sequence: sequence++,
			base64: Buffer.from(bytes).toString("base64url"),
			done,
			...(control ? { error: "DENIED" } : {}),
		});
		const notification: HostNotification = Object.freeze({
			jsonrpc: "2.0",
			method: "host/stream.chunk",
			params: Object.freeze(params),
		});
		busy = true;
		const pending = Promise.resolve().then(() => delivery.sink(notification, signal));
		// Observe the actual sink acknowledgment even if cancellation stops waiting for it.
		pending.then(
			() => {
				busy = false;
			},
			() => {
				busy = false;
			},
		);
		await untilAbort(pending, control ? signal : transportSignal);
		if (done) terminal = true;
	};
	try {
		await untilAbort(delivery.started, transportSignal);
		released = true;
		for await (const raw of response) {
			transportSignal.throwIfAborted();
			if (!Buffer.isBuffer(raw) || raw.length > maxBytes - total) throw refused();
			total += raw.length;
			if (observation) observed.push(Buffer.from(raw));
			const joined = Buffer.concat([tail, raw]);
			tail.fill(0);
			try {
				if (joined.includes(keyBytes)) throw refused();
				// Keep enough suffix to detect a key spanning any later TCP/notification boundary.
				const safe = Math.max(0, joined.length - (keyBytes.length - 1));
				for (let offset = 0; offset < safe; offset += MAX_INLINE_BYTES)
					await notify(joined.subarray(offset, Math.min(safe, offset + MAX_INLINE_BYTES)), false);
				tail = Buffer.from(joined.subarray(safe));
			} finally {
				joined.fill(0);
			}
		}
		if (!response.complete) throw refused();
		if (observation) {
			const body = Buffer.concat(observed, total);
			try {
				observation.complete(status, body);
			} finally {
				body.fill(0);
			}
		}
		await notify(tail, true);
		observation?.acknowledge();
	} catch {
		// Headers may have been delivered before start. Release the failed socket now, but
		// preserve reply-before-notification ordering for its terminal frame under the deadline.
		response.destroy();
		if (!released && !signal.aborted) {
			try {
				await untilAbort(delivery.started, signal);
				released = true;
			} catch {
				/* Canceled before delivery starts. */
			}
		}
		// A stalled sink cannot accept an ordered terminal frame. Cancellation still releases
		// native resources; responsive sinks receive only this fixed, content-free error.
		if (released && !busy && !terminal) {
			try {
				await notify(Buffer.alloc(0), true, true);
			} catch {
				/* Delivery may already be canceled. */
			}
		}
		throw refused();
	} finally {
		for (const bytes of observed) bytes.fill(0);
		observed.length = 0;
		tail.fill(0);
		keyBytes.fill(0);
		response.destroy();
	}
}

function outboundHeaders(verified: AiRequestSnapshot, key: string): Record<string, string> {
	if (!key || key.length > 8192 || !/^[!-~]+$/.test(key)) throw refused();
	const headers: Record<string, string> = Object.create(null);
	for (const [name, value] of verified.headers) headers[name.toLowerCase()] = value;
	if (verified.profile === "messages-api-v1") {
		if (headers["x-api-key"] !== "brokered" || headers.authorization !== undefined) throw refused();
		headers["x-api-key"] = key;
	} else if (verified.profile === "responses-api-v1") {
		if (headers.authorization !== "Bearer brokered" || headers["x-api-key"] !== undefined)
			throw refused();
		headers.authorization = `Bearer ${key}`;
	} else if (verified.profile === "chat-completions-v1") {
		if (headers.authorization !== undefined || headers["x-api-key"] !== undefined) throw refused();
		headers.authorization = `Bearer ${key}`;
	} else throw refused();
	// The host protocol transports decoded bytes. Do not admit an unbounded decompression path.
	headers["accept-encoding"] = "identity";
	return headers;
}

function fetchPinned(
	verified: AiRequestSnapshot,
	host: string,
	pin: PinnedAddress,
	policy: EgressPolicy,
	key: string,
	signal: AbortSignal,
	delivery?: StreamDelivery,
	observation?: ResponseObservation,
): Promise<HostFetchResult> {
	const url = new URL(verified.url);
	if (url.protocol !== "https:" || url.username || url.password || url.hash) throw refused();
	const headers = outboundHeaders(verified, key);
	const connection = createPinnedHttpsConnection(host, Number(url.port || 443), pin, policy);
	return new Promise((resolve, reject) => {
		let settled = false;
		let req: ClientRequest | undefined;
		let incoming: IncomingMessage | undefined;
		let length = 0;
		const chunks: Buffer[] = [];
		const transportAbort = new AbortController();
		let streaming = false;
		const fail = (): void => {
			if (streaming) {
				transportAbort.abort();
				// Cancel an idle async-iterator read as well as a pending sink acknowledgment.
				incoming?.destroy();
				req?.destroy();
				connection.destroy();
			} else finish();
		};
		function finish(result?: HostFetchResult): void {
			if (settled) return;
			settled = true;
			signal.removeEventListener("abort", fail);
			req?.destroy();
			connection.destroy();
			for (const chunk of chunks) chunk.fill(0);
			chunks.length = 0;
			if (result) resolve(result);
			else reject(refused());
		}
		try {
			signal.throwIfAborted();
			signal.addEventListener("abort", fail, { once: true });
			req = request({
				...connection.options,
				method: verified.method,
				path: `${url.pathname}${url.search}`,
				headers: { ...headers, ...connection.options.headers },
			});
			req.once("error", fail);
			connection.guard(
				req,
				() => signal.aborted || settled,
				() => {
					if (signal.aborted || settled) return fail();
					req?.end(verified.body);
				},
				fail,
			);
			req.once("response", (response) => {
				incoming = response;
				try {
					if (settled || signal.aborted) return response.destroy();
					const status = response.statusCode;
					if (
						status === undefined ||
						status < 200 ||
						status >= 600 ||
						(status >= 300 && status < 400)
					)
						throw refused();
					if (
						response.headers["content-encoding"] &&
						response.headers["content-encoding"] !== "identity"
					)
						throw refused();
					if (
						response.rawHeaders.length > 128 ||
						Buffer.byteLength(response.rawHeaders.join("")) > HOST_MAX_HEADER_BYTES
					)
						throw refused();
					const selected: [string, string][] = [];
					const names = new Set<string>();
					for (let i = 0; i < response.rawHeaders.length; i += 2) {
						const name = response.rawHeaders[i]?.toLowerCase();
						const value = response.rawHeaders[i + 1];
						if (!name || value === undefined || value.includes(key)) throw refused();
						if (name !== "content-type" && name !== "retry-after") continue;
						if (names.has(name)) throw refused();
						names.add(name);
						selected.push([name, value]);
					}
					const safeHeaders = HostHeaders.parse(selected);
					response.once("aborted", fail);
					response.once("error", fail);
					if (delivery) {
						response.pause();
						streaming = true;
						const result = HostFetchResult.parse({
							status,
							headers: safeHeaders,
							streamId: delivery.streamId,
						});
						delivery.open(result);
						void streamResponse(
							response,
							delivery,
							key,
							signal,
							AbortSignal.any([signal, transportAbort.signal]),
							status,
							observation,
						).then(
							() => finish(result),
							() => finish(),
						);
						return;
					}
					response.on("data", (raw: Buffer) => {
						if (settled) return;
						if (signal.aborted || !Buffer.isBuffer(raw) || raw.length > MAX_INLINE_BYTES - length)
							return fail();
						length += raw.length;
						chunks.push(Buffer.from(raw));
					});
					response.once("end", () => {
						if (settled) return;
						let body: Buffer | undefined;
						try {
							if (!response.complete || signal.aborted) throw refused();
							body = Buffer.concat(chunks, length);
							if (body.includes(key)) throw refused();
							observation?.complete(status, body);
							observation?.acknowledge();
							finish({
								status,
								headers: safeHeaders,
								body: { base64: body.toString("base64url") },
							});
						} catch {
							fail();
						} finally {
							body?.fill(0);
						}
					});
				} catch {
					response.destroy();
					fail();
				}
			});
		} catch {
			fail();
		}
	});
}

/**
 * Internal native composition. Installed-generation, account and prompt authority must be
 * established by the native invocation owner before binding this to a host channel.
 */
export function createProviderHttpBroker(options: {
	readonly registry: AiProfileRegistry;
	readonly vault: CredentialVault;
	readonly networkPolicy: EgressPolicy;
}): ProviderHttpBroker {
	const policy = captureEgressPolicy(options.networkPolicy);
	const registry = options.registry;
	const vault = options.vault;
	const active = new Set<AbortController>();
	let closed = false;
	const invoke = async (
		profile: AiProfile,
		candidate: unknown,
		binding: unknown,
		reference: string,
		credential: CredentialBinding,
		signal: AbortSignal,
		delivery?: StreamDelivery,
		originalCallSignal: AbortSignal = signal,
	): Promise<HostFetchResult> => {
		const controller = new AbortController();
		let timer: ReturnType<typeof setTimeout> | undefined;
		const abort = (): void => controller.abort();
		let lifecycle: AiRequestLifecycle | undefined;
		try {
			if (closed || active.size >= HOST_MAX_ACTIVE_REQUESTS) throw refused();
			signal.throwIfAborted();
			// Capture all request and pinned prompt bytes before the first DNS/vault await.
			const captured = captureAiRequestInputs(candidate, binding);
			const url = new URL(aiRequestEndpoint(captured));
			if (url.protocol !== "https:") throw refused();
			// URL keeps IPv6 authority brackets; DNS and TLS require the canonical bare IP.
			const host =
				url.hostname.startsWith("[") && url.hostname.endsWith("]")
					? url.hostname.slice(1, -1)
					: url.hostname;
			const selectedCredential = fields(credential, ["ownerKind", "ownerId", "kind"]);
			if (
				selectedCredential.kind !== "provider-key" ||
				selectedCredential.ownerKind !== "provider" ||
				!Ulid.safeParse(selectedCredential.ownerId).success
			)
				throw refused();
			const capturedCredential: CredentialBinding = Object.freeze({
				ownerKind: "provider",
				ownerId: selectedCredential.ownerId as string,
				kind: "provider-key",
			});
			active.add(controller);
			signal.addEventListener("abort", abort, { once: true });
			timer = setTimeout(abort, HOST_REQUEST_TIMEOUT_MS);
			const answers = await resolveEgressAnswers(
				host,
				Number(url.port || 443),
				policy,
				controller.signal,
			);
			controller.signal.throwIfAborted();
			const verified = verifyCapturedAiRequest(registry, profile, captured, { answers, policy });
			lifecycle = verifiedAiRequestLifecycle(verified);
			const snapshot = snapshotVerifiedAiRequest(verified);
			const pin = validateEgressAnswers(answers, policy);
			const result = await useCredential.call(
				vault,
				reference,
				capturedCredential,
				{ requestClass: "read", signal: controller.signal },
				async (value, use) => {
					if (value.kind !== "provider-key") throw refused();
					const observer = lifecycle;
					observer?.bindCredential(vault, use, originalCallSignal);
					const assertCurrent = (): void => {
						const actual = describeCredential.call(vault, use.reference, use.binding);
						if (use.signal.aborted || actual.generation !== use.generation) throw refused();
					};
					const observation: ResponseObservation | undefined = observer
						? {
								maxResponseBytes: observer.maxResponseBytes,
								complete(status, body) {
									assertCurrent();
									observer.complete(status, body);
								},
								acknowledge() {
									assertCurrent();
									observer.acknowledge();
								},
							}
						: undefined;
					return fetchPinned(
						snapshot,
						host,
						pin,
						policy,
						value.key,
						AbortSignal.any([
							controller.signal,
							use.signal,
							...(observer ? [observer.signal] : []),
						]),
						delivery,
						observation,
					);
				},
			);
			return HostFetchResult.parse(result);
		} catch {
			if (lifecycle) lifecycle.fail();
			else failAiRequestCapture(binding);
			throw refused();
		} finally {
			if (timer !== undefined) clearTimeout(timer);
			signal.removeEventListener("abort", abort);
			active.delete(controller);
			controller.abort();
		}
	};
	return Object.freeze<ProviderHttpBroker>({
		execute: invoke,
		stream(profile, candidate, binding, reference, credential, signal, sink) {
			const cancel = new AbortController();
			let resolveResponse: (result: HostFetchResult) => void = () => undefined;
			let rejectResponse: (error: Error) => void = () => undefined;
			let start: () => void = () => undefined;
			const response = new Promise<HostFetchResult>((resolve, reject) => {
				resolveResponse = resolve;
				rejectResponse = reject;
			});
			const started = new Promise<void>((resolve) => {
				start = resolve;
			});
			const completion = (async () => {
				try {
					if (typeof sink !== "function") throw refused();
					await invoke(
						profile,
						candidate,
						binding,
						reference,
						credential,
						AbortSignal.any([signal, cancel.signal]),
						{ streamId: newId(), started, sink, open: resolveResponse },
						signal,
					);
				} catch {
					failAiRequestCapture(binding);
					rejectResponse(refused());
					throw refused();
				}
			})();
			// Callers may await either lifecycle promise without unhandled background rejection.
			void response.catch(() => undefined);
			void completion.catch(() => undefined);
			return Object.freeze({ response, completion, start, cancel: () => cancel.abort() });
		},
		close(): void {
			closed = true;
			for (const controller of active) controller.abort();
		},
	});
}
