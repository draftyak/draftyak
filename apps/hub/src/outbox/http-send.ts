import { addAbortListener } from "node:events";
import type { ClientRequest, IncomingMessage } from "node:http";
import { request } from "node:https";
import { types } from "node:util";
import type { HeaderList } from "@draftyak/protocol/hash";
import {
	HOST_MAX_ACTIVE_REQUESTS,
	HOST_MAX_HEADER_BYTES,
	HOST_REQUEST_TIMEOUT_MS,
} from "@draftyak/protocol/host-channel";
import { CredentialVault } from "../credentials/vault.ts";
import { MAX_WAIT_MS, systemClock, type TimerClock } from "../kernel/clock.ts";
import {
	captureEgressPolicy,
	createPinnedHttpsConnection,
	type EgressPolicy,
	resolveEgressAnswers,
	validateEgressAnswers,
} from "../plugins/broker/network/index.ts";
import type { SendAttempt } from "./ticket-storage.ts";
import {
	type NativeDispatchRequest,
	type SendDispatch,
	type SendRedemption,
	SendTicketLedger,
} from "./tickets.ts";

export const MAX_SEND_RESPONSE_BYTES = 1_048_576;
export const SEND_CLASSIFICATION_TIMEOUT_MS = 15_000;
export class NativeSendHttpError extends Error {
	readonly code = "SEND_HTTP_UNAVAILABLE";
	constructor() {
		super("Send request unavailable");
	}
}
const refused = (): NativeSendHttpError => new NativeSendHttpError();
declare const observationBrand: unique symbol;
declare const pendingBrand: unique symbol;
export interface NativeSendObservation {
	readonly [observationBrand]: true;
}
export interface PendingNativeSendClassification {
	readonly [pendingBrand]: true;
}
export type NativeSendObservationData =
	| {
			readonly kind: "transport";
			readonly written: "none" | "maybe";
			readonly error: "SEND_HTTP_UNAVAILABLE";
			readonly attempt: SendAttempt;
	  }
	| {
			readonly kind: "response";
			readonly written: "maybe";
			readonly status: number;
			readonly headers: HeaderList;
			readonly body: Uint8Array;
			readonly pending: PendingNativeSendClassification;
	  };
interface ActualResponse {
	status: number;
	headers: HeaderList;
	body: Buffer;
}
interface PendingState {
	readonly response: ActualResponse;
	readonly finish: () => void;
	readonly live: () => boolean;
}
const observations = new WeakMap<
	NativeSendObservation,
	{ failure?: Extract<NativeSendObservationData, { kind: "transport" }>; pending?: PendingState }
>();
const classifications = new WeakMap<PendingNativeSendClassification, PendingState>();
/** Native observation provenance only. A genuine provider classifier must join after forward. */
export function consumeNativeSendObservation(
	handle: NativeSendObservation,
): NativeSendObservationData {
	const saved = observations.get(handle);
	observations.delete(handle);
	if (!saved) throw refused();
	if (saved.failure) return saved.failure;
	const pending = saved.pending;
	if (!pending?.live()) throw refused();
	const token = Object.freeze(Object.create(null)) as PendingNativeSendClassification;
	classifications.set(token, pending);
	return Object.freeze({
		kind: "response",
		written: "maybe",
		status: pending.response.status,
		headers: pending.response.headers,
		body: Buffer.from(pending.response.body),
		pending: token,
	});
}
/** Tightening only. No public success enum, no-effect assertion, retry right or classifier callback. */
export function abandonNativeSendClassification(handle: PendingNativeSendClassification): void {
	const pending = classifications.get(handle);
	classifications.delete(handle);
	if (!pending) throw refused();
	pending.finish();
}
export interface NativeHttpSendTransport {
	send(redemption: SendRedemption, signal: AbortSignal): Promise<NativeSendObservation>;
	close(): void;
	/** Closes admission and joins only this transport's owned work and cleanup. */
	drain(): Promise<void>;
}
interface OwnedSendWork {
	readonly done: Promise<void>;
	cleanup: () => boolean;
	track<T>(task: Promise<T>): Promise<T>;
	seal(): void;
	retryCleanup(): boolean;
}
const useCredential = CredentialVault.prototype.withCredential,
	describeCredential = CredentialVault.prototype.describe;
const beginDispatch = SendTicketLedger.prototype.beginDispatch,
	assertVault = SendTicketLedger.prototype.assertVault,
	prepareWrite = SendTicketLedger.prototype.prepareDispatchWrite,
	assertWriteCurrent = SendTicketLedger.prototype.assertDispatchWriteCurrent,
	recordOutcome = SendTicketLedger.prototype.recordOutcome;
const signalPrototype = Object.getPrototypeOf(new AbortController().signal),
	aborted = Object.getOwnPropertyDescriptor(signalPrototype, "aborted")?.get;
function captureSignal(input: AbortSignal): AbortSignal {
	if (
		!input ||
		typeof input !== "object" ||
		types.isProxy(input) ||
		Object.getPrototypeOf(input) !== signalPrototype ||
		["aborted", "reason", "addEventListener", "removeEventListener"].some((key) =>
			Object.hasOwn(input, key),
		) ||
		typeof aborted?.call(input) !== "boolean"
	)
		throw refused();
	return input;
}
function untilAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const listener = addAbortListener(signal, () => reject(refused()));
		work.then(
			(value) => {
				listener[Symbol.dispose]();
				if (signal.aborted) reject(refused());
				else resolve(value);
			},
			() => {
				listener[Symbol.dispose]();
				reject(refused());
			},
		);
	});
}
function route(render: NativeDispatchRequest): URL {
	const url = new URL(render.url),
		kind = render.credential.binding.kind;
	if (
		render.method !== "POST" ||
		render.headers.length !== 1 ||
		render.headers[0]?.[0] !== "content-type" ||
		render.headers[0]?.[1] !== render.contentType ||
		render.credential.binding.ownerKind !== "account" ||
		url.protocol !== "https:" ||
		url.href !== render.url ||
		url.port ||
		url.hash ||
		url.username ||
		url.password ||
		!(
			(kind === "slack-token" &&
				url.href === "https://slack.com/api/chat.postMessage" &&
				render.contentType === "application/json") ||
			(kind === "gmail-oauth" &&
				url.href ===
					"https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send?uploadType=multipart" &&
				/^multipart\/related; boundary="[A-Za-z0-9_-]{16,64}"(?![\s\S])/.test(render.contentType))
		)
	)
		throw refused();
	return url;
}
function timeoutValue(input: number | undefined, fallback: number, maximum: number): number {
	const value = input ?? fallback;
	if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw refused();
	return value;
}

/** Internal native send path. It consumes storage-issued tickets, never approval or caller DTOs. */
export function createNativeHttpSendTransport(options: {
	readonly ledger: SendTicketLedger;
	readonly vault: CredentialVault;
	readonly networkPolicy: EgressPolicy;
	readonly clock?: TimerClock;
	readonly timeoutMs?: number;
	readonly classificationTimeoutMs?: number;
}): NativeHttpSendTransport {
	const ledger = options.ledger,
		vault = options.vault,
		policy = captureEgressPolicy(options.networkPolicy),
		clock = options.clock ?? systemClock,
		timeoutMs = timeoutValue(options.timeoutMs, HOST_REQUEST_TIMEOUT_MS, HOST_REQUEST_TIMEOUT_MS),
		classificationMs = timeoutValue(
			options.classificationTimeoutMs,
			SEND_CLASSIFICATION_TIMEOUT_MS,
			MAX_WAIT_MS,
		);
	try {
		assertVault.call(ledger, vault);
	} catch {
		throw refused();
	}
	if (policy.allowLocal) throw refused();
	const active = new Set<{ cancel: () => void }>();
	const owned = new Set<OwnedSendWork>();
	let closed = false;
	let finalizationFailed = false;
	let draining: Promise<void> | undefined;
	function ownSend(): OwnedSendWork {
		const done = Promise.withResolvers<void>();
		const tasks = new Set<Promise<unknown>>();
		let sealed = false;
		let ended = false;
		const finish = (): void => {
			if (!sealed || tasks.size !== 0 || ended) return;
			ended = true;
			work.retryCleanup();
			done.resolve();
		};
		const work: OwnedSendWork = {
			done: done.promise,
			cleanup: () => true,
			track<T>(task: Promise<T>): Promise<T> {
				if (ended) throw refused();
				tasks.add(task);
				const settled = (): void => {
					tasks.delete(task);
					finish();
				};
				void task.then(settled, settled);
				return task;
			},
			seal(): void {
				sealed = true;
				finish();
			},
			retryCleanup(): boolean {
				if (!ended) return false;
				try {
					if (!work.cleanup()) return false;
					owned.delete(work);
					return true;
				} catch {
					return false;
				}
			},
		};
		owned.add(work);
		return work;
	}
	async function runSend(
		work: OwnedSendWork,
		redemption: SendRedemption,
		inputSignal: AbortSignal,
	): Promise<NativeSendObservation> {
		const signal = captureSignal(inputSignal),
			controller = new AbortController(),
			timer = new AbortController(),
			classificationStop = new AbortController();
		let dispatch: SendDispatch | undefined,
			attempted = false,
			settled = false,
			pending = false,
			response: ActualResponse | undefined,
			observation: NativeSendObservation | undefined;
		let external: Disposable | undefined;
		const context = {
			cancel: () => {
				controller.abort();
				if (pending) finishPending();
			},
		};
		const finishOutcome = (outcome: "FAILED" | "UNKNOWN"): SendAttempt => {
			if (!dispatch || settled) throw refused();
			settled = true;
			try {
				return recordOutcome.call(ledger, dispatch, outcome);
			} catch {
				finalizationFailed = true;
				throw refused();
			}
		};
		const cleanup = (): boolean => {
			let clean = true;
			try {
				external?.[Symbol.dispose]();
				external = undefined;
			} catch {
				clean = false;
			}
			for (const stop of [timer, classificationStop, controller])
				try {
					stop.abort();
				} catch {
					clean = false;
				}
			try {
				response?.body.fill(0);
			} catch {
				clean = false;
			}
			if (clean) active.delete(context);
			return clean;
		};
		work.cleanup = cleanup;
		function finishPending(): void {
			if (!pending || settled) return;
			pending = false;
			try {
				finishOutcome("UNKNOWN");
			} catch {
				/* A failed durable record stays unavailable/SENDING for recovery. */
			}
			if (observation) observations.delete(observation);
			cleanup();
		}
		active.add(context);
		external = addAbortListener(signal, context.cancel);
		if (aborted?.call(signal)) controller.abort();
		const wall = clock.wallMs(),
			mono = clock.monotonicMs();
		const expired = (): boolean => {
			const currentWall = clock.wallMs(),
				currentMono = clock.monotonicMs();
			return (
				controller.signal.aborted ||
				!Number.isFinite(currentWall) ||
				!Number.isFinite(currentMono) ||
				currentWall >= wall + timeoutMs ||
				currentMono >= mono + timeoutMs
			);
		};
		const watch = (async () => {
			try {
				for (;;) {
					const remaining = Math.min(
						wall + timeoutMs - clock.wallMs(),
						mono + timeoutMs - clock.monotonicMs(),
					);
					if (!Number.isFinite(remaining) || remaining <= 0) {
						context.cancel();
						return;
					}
					await clock.after(Math.min(MAX_WAIT_MS, Math.ceil(remaining)), timer.signal);
				}
			} catch {
				if (!timer.signal.aborted) context.cancel();
			}
		})();
		work.track(watch);
		try {
			const rendered = beginDispatch.call(ledger, redemption);
			dispatch = rendered.dispatch;
			const url = route(rendered);
			controller.signal.throwIfAborted();
			const answers = await untilAbort(
					work.track(resolveEgressAnswers(url.hostname, 443, policy, controller.signal)),
					controller.signal,
				),
				pin = validateEgressAnswers(answers, policy);
			controller.signal.throwIfAborted();
			try {
				await useCredential.call(
					vault,
					rendered.credential.reference,
					rendered.credential.binding,
					{ requestClass: "send", signal: controller.signal },
					(value, use) =>
						work.track(
							(async () => {
								if (
									value.kind !== rendered.credential.binding.kind ||
									value.kind === "provider-key" ||
									use.reference !== rendered.credential.reference ||
									use.generation !== rendered.credential.generation ||
									use.binding.ownerKind !== "account"
								)
									throw refused();
								const key = value.accessToken;
								if (!key || key.length > 8192 || !/^[!-~]+$/.test(key)) throw refused();
								const leaseAbort = addAbortListener(use.signal, () => controller.abort());
								try {
									response = await fetchPinnedSend(
										rendered,
										url,
										pin,
										policy,
										key,
										controller.signal,
										expired,
										() => {
											const fresh = prepareWrite.call(ledger, rendered.dispatch);
											route(fresh);
											if (
												fresh.credential.generation !== use.generation ||
												fresh.credential.reference !== use.reference ||
												use.signal.aborted ||
												describeCredential.call(vault, use.reference, use.binding).generation !==
													use.generation
											)
												throw refused();
											return fresh;
										},
										() => {
											attempted = true;
										},
										() => assertWriteCurrent.call(ledger, rendered.dispatch),
									);
								} finally {
									leaseAbort[Symbol.dispose]();
								}
							})(),
						),
				);
			} catch {
				if (!response) throw refused();
			}
			// A complete authentic response survives later credential change and ticket expiry.
			if (!response || closed) throw refused();
			timer.abort();
			external[Symbol.dispose]();
			external = undefined;
			pending = true;
			const state: PendingState = {
				response,
				finish: finishPending,
				live: () => pending && !settled,
			};
			observation = Object.freeze(Object.create(null)) as NativeSendObservation;
			observations.set(observation, { pending: state });
			const classificationTimer = (async () => {
				try {
					await clock.after(classificationMs, classificationStop.signal);
					finishPending();
				} catch {
					if (!classificationStop.signal.aborted) finishPending();
				}
			})();
			work.track(classificationTimer);
			return observation;
		} catch {
			try {
				const attempt = finishOutcome(attempted ? "UNKNOWN" : "FAILED"),
					handle = Object.freeze(Object.create(null)) as NativeSendObservation;
				observations.set(handle, {
					failure: Object.freeze({
						kind: "transport",
						written: attempted ? "maybe" : "none",
						error: "SEND_HTTP_UNAVAILABLE",
						attempt,
					}),
				});
				return handle;
			} catch {
				throw refused();
			}
		} finally {
			if (!pending) cleanup();
		}
	}
	const close = (): void => {
		if (closed) return;
		closed = true;
		for (const context of [...active]) context.cancel();
	};
	const drain = (): Promise<void> => {
		close();
		if (draining) return draining;
		const result = (async (): Promise<void> => {
			await Promise.all([...owned].map((work) => work.done));
			let clean = true;
			for (const work of [...owned]) if (!work.retryCleanup()) clean = false;
			if (!clean || finalizationFailed) throw refused();
		})();
		draining = result;
		void result.catch(() => {
			if (draining === result) draining = undefined;
		});
		return result;
	};
	return Object.freeze({
		send(redemption: SendRedemption, signal: AbortSignal): Promise<NativeSendObservation> {
			if (closed || owned.size >= HOST_MAX_ACTIVE_REQUESTS) return Promise.reject(refused());
			const work = ownSend();
			const operation = runSend(work, redemption, signal).catch(() => {
				throw refused();
			});
			work.track(operation);
			work.seal();
			return operation;
		},
		close,
		drain,
	});
}

function fetchPinnedSend(
	rendered: NativeDispatchRequest,
	url: URL,
	pin: Parameters<typeof createPinnedHttpsConnection>[2],
	policy: EgressPolicy,
	key: string,
	signal: AbortSignal,
	expired: () => boolean,
	prepare: () => NativeDispatchRequest,
	writeBoundary: () => void,
	checkCurrent: () => void,
): Promise<ActualResponse> {
	const connection = createPinnedHttpsConnection(url.hostname, 443, pin, policy);
	return new Promise((resolve, reject) => {
		let req: ClientRequest | undefined,
			incoming: IncomingMessage | undefined,
			settled = false,
			length = 0,
			wrote = false;
		const chunks: Buffer[] = [],
			keyBytes = Buffer.from(key, "ascii");
		let tail: Buffer = Buffer.alloc(0);
		const finish = (result?: ActualResponse) => {
			if (settled) return;
			settled = true;
			listener[Symbol.dispose]();
			incoming?.destroy();
			req?.destroy();
			connection.destroy();
			for (const chunk of chunks) chunk.fill(0);
			tail.fill(0);
			keyBytes.fill(0);
			if (result) resolve(result);
			else reject(refused());
		};
		const fail = () => finish(),
			listener = addAbortListener(signal, fail);
		try {
			signal.throwIfAborted();
			req = request({
				...connection.options,
				method: "POST",
				path: url.pathname + url.search,
				headers: { ...connection.options.headers },
			});
			req.once("error", fail);
			req.once("close", () => {
				if (!settled) fail();
			});
			req.once("upgrade", (_response, socket) => {
				socket.destroy();
				fail();
			});
			connection.guard(
				req,
				() => expired() || settled,
				() => {
					try {
						if (expired() || settled) throw refused();
						const fresh = prepare();
						if (
							fresh.url !== rendered.url ||
							fresh.ticket.id !== rendered.ticket.id ||
							Buffer.from(fresh.body).includes(keyBytes) ||
							expired()
						)
							throw refused();
						const outgoing = req;
						if (!outgoing) throw refused();
						outgoing.setHeader("content-type", fresh.contentType);
						outgoing.setHeader("authorization", `Bearer ${key}`);
						outgoing.setHeader("accept-encoding", "identity");
						outgoing.setHeader("content-length", fresh.body.byteLength);
						checkCurrent();
						if (expired()) throw refused();
						wrote = true;
						writeBoundary();
						outgoing.end(fresh.body);
					} catch {
						fail();
					}
				},
				fail,
			);
			req.once("response", (response) => {
				incoming = response;
				try {
					if (settled || expired() || !wrote) throw refused();
					const status = response.statusCode;
					if (
						status === undefined ||
						status < 200 ||
						status >= 600 ||
						(status >= 300 && status < 400) ||
						(response.headers["content-encoding"] &&
							response.headers["content-encoding"] !== "identity") ||
						response.rawHeaders.length > 128 ||
						Buffer.byteLength(response.rawHeaders.join("")) > HOST_MAX_HEADER_BYTES
					)
						throw refused();
					const headers: [string, string][] = [],
						names = new Set<string>();
					for (let index = 0; index < response.rawHeaders.length; index += 2) {
						const name = response.rawHeaders[index]?.toLowerCase(),
							value = response.rawHeaders[index + 1];
						if (!name || value === undefined || name.includes(key) || value.includes(key))
							throw refused();
						if (name !== "content-type" && name !== "retry-after") continue;
						if (names.has(name)) throw refused();
						names.add(name);
						headers.push([name, value]);
					}
					const selected: HeaderList = Object.freeze(headers.map((row) => Object.freeze(row)));
					response.once("aborted", fail);
					response.once("error", fail);
					response.on("data", (raw: Buffer) => {
						if (settled) return;
						try {
							if (
								expired() ||
								!Buffer.isBuffer(raw) ||
								raw.length > MAX_SEND_RESPONSE_BYTES - length
							)
								throw refused();
							const joined = Buffer.concat([tail, raw]);
							tail.fill(0);
							try {
								if (joined.includes(keyBytes)) throw refused();
								tail = Buffer.from(
									joined.subarray(Math.max(0, joined.length - keyBytes.length + 1)),
								);
							} finally {
								joined.fill(0);
							}
							length += raw.length;
							chunks.push(Buffer.from(raw));
						} catch {
							fail();
						}
					});
					response.once("end", () => {
						if (settled) return;
						try {
							if (expired() || !response.complete) throw refused();
							finish({ status, headers: selected, body: Buffer.concat(chunks, length) });
						} catch {
							fail();
						}
					});
				} catch {
					fail();
				}
			});
		} catch {
			fail();
		}
	});
}
