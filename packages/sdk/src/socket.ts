import { HostNotification } from "@draftyak/protocol/host-channel";
import type { HostSocket } from "./context.ts";
import { type HostChannel, HostError } from "./host.ts";

const MAX_MESSAGES = 64;
const MAX_BYTES = 1_048_576;
interface Message {
	readonly data: string;
	readonly bytes: number;
}
interface Owner {
	readonly ready: () => void;
	readonly fail: (error: HostError) => void;
	readonly messages: Message[];
	id?: string;
}
interface Lease {
	bind(id: string): void;
	next(): Message | undefined;
	release(): void;
}
interface Router {
	acquire(ready: Owner["ready"], fail: Owner["fail"]): Lease;
}
const routers = new WeakMap<HostChannel, Router>();

function socketRouter(host: HostChannel): Router {
	const existing = routers.get(host);
	if (existing) return existing;
	const owners = new Set<Owner>();
	const pending = new Set<Owner>();
	const sockets = new Map<string, Owner>();
	const early = new Map<string, Message[]>();
	let count = 0;
	let bytes = 0;
	let unsubscribe: (() => void) | undefined;
	const discard = (messages: Message[]): void => {
		for (const message of messages) {
			count--;
			bytes -= message.bytes;
		}
		messages.length = 0;
	};
	const clearEarly = (): void => {
		for (const messages of early.values()) discard(messages);
		early.clear();
	};
	const release = (owner: Owner): void => {
		if (!owners.delete(owner)) return;
		pending.delete(owner);
		if (owner.id !== undefined) sockets.delete(owner.id);
		discard(owner.messages);
		if (!pending.size) clearEarly();
		if (!owners.size) {
			unsubscribe?.();
			unsubscribe = undefined;
			routers.delete(host);
		}
	};
	const fail = (owner: Owner, code: "DENIED" | "BAD_REQUEST" | "TOO_LARGE"): void => {
		release(owner);
		owner.fail(new HostError(code));
	};
	const refusePending = (code: "BAD_REQUEST" | "TOO_LARGE"): void => {
		clearEarly();
		for (const owner of [...pending]) fail(owner, code);
	};
	const notify = (notification: HostNotification): void => {
		if (notification.method !== "host/ws.message") return;
		let message: Extract<HostNotification, { method: "host/ws.message" }>;
		try {
			const parsed = HostNotification.parse(notification);
			if (parsed.method !== "host/ws.message") return;
			message = parsed;
		} catch {
			for (const owner of [...owners]) fail(owner, "BAD_REQUEST");
			return;
		}
		const owner = sockets.get(message.params.socketId);
		if (!owner && !pending.size) return;
		const size = Buffer.byteLength(JSON.stringify(message), "utf8");
		if (count >= MAX_MESSAGES || size > MAX_BYTES - bytes) {
			if (owner) fail(owner, "TOO_LARGE");
			else refusePending("TOO_LARGE");
			return;
		}
		const value = { data: message.params.data, bytes: size };
		if (owner) owner.messages.push(value);
		else {
			let messages = early.get(message.params.socketId);
			if (!messages) {
				messages = [];
				early.set(message.params.socketId, messages);
			}
			messages.push(value);
		}
		count++;
		bytes += size;
		owner?.ready();
	};
	const router: Router = {
		acquire(ready, onFailure) {
			const owner: Owner = { ready, fail: onFailure, messages: [] };
			owners.add(owner);
			pending.add(owner);
			try {
				// This receiver exists before the request can produce an early notification.
				if (!unsubscribe)
					unsubscribe = host.subscribe(notify, () => {
						for (const active of [...owners]) fail(active, "DENIED");
					});
				if (!owners.has(owner)) throw new HostError("DENIED");
			} catch (error) {
				release(owner);
				throw error;
			}
			return {
				bind(id) {
					if (!pending.has(owner) || sockets.has(id)) throw new HostError("DENIED");
					pending.delete(owner);
					owner.id = id;
					sockets.set(id, owner);
					const messages = early.get(id);
					if (messages) owner.messages.push(...messages);
					early.delete(id);
					if (!pending.size) clearEarly();
				},
				next() {
					const message = owner.messages.shift();
					if (message) {
						count--;
						bytes -= message.bytes;
					}
					return message;
				},
				release: () => release(owner),
			};
		},
	};
	routers.set(host, router);
	return router;
}

export async function openHostSocket(
	host: HostChannel,
	url: string,
	requestedSignal: AbortSignal,
): Promise<HostSocket> {
	let signal: AbortSignal;
	try {
		signal = AbortSignal.any([requestedSignal]);
	} catch {
		throw new HostError("BAD_REQUEST");
	}
	if (signal.aborted) throw new HostError("DENIED");
	let lease: Lease | undefined;
	let failure: HostError | undefined;
	let closed = false;
	let draining = false;
	let closing: Promise<void> | undefined;
	const stop = new AbortController();
	const listeners = new Set<{ readonly listener: (data: string) => void }>();
	const dispose = (): void => {
		lease?.release();
		signal.removeEventListener("abort", aborted);
		listeners.clear();
	};
	const fail = (error: HostError): void => {
		if (failure || closed) return;
		failure = error;
		stop.abort(error);
		dispose();
	};
	const aborted = (): void => fail(new HostError("DENIED"));
	const check = (): void => {
		if (failure) throw failure;
		if (closed || signal.aborted) throw new HostError("DENIED");
	};
	const drain = (): void => {
		if (draining) return;
		draining = true;
		try {
			while (!failure && !closed && listeners.size) {
				const message = lease?.next();
				if (!message) break;
				for (const subscription of [...listeners]) {
					if (failure || closed) break;
					if (!listeners.has(subscription)) continue;
					try {
						subscription.listener(message.data);
					} catch {
						// A listener cannot suppress another subscriber's message or later delivery.
					}
				}
			}
		} finally {
			draining = false;
		}
	};
	try {
		lease = socketRouter(host).acquire(drain, fail);
		signal.addEventListener("abort", aborted, { once: true });
		if (signal.aborted) aborted();
		check();
		const requestSignal = AbortSignal.any([signal, stop.signal]);
		const { socketId: id } = await host.request("host/ws.open", { url }, { signal: requestSignal });
		check();
		lease.bind(id);
		return Object.freeze({
			id,
			async sendAck(envelopeId: string): Promise<void> {
				check();
				await host.request("host/ws.send", { socketId: id, envelopeId }, { signal: requestSignal });
				check();
			},
			subscribe(listener: (data: string) => void): () => void {
				check();
				const subscription = { listener };
				listeners.add(subscription);
				drain();
				return () => {
					listeners.delete(subscription);
				};
			},
			close(): Promise<void> {
				if (closing) return closing;
				const outcome = Promise.withResolvers<void>();
				closing = outcome.promise;
				closed = true;
				void (async () => {
					stop.abort(new HostError("DENIED"));
					dispose();
					await host.request("host/ws.close", { socketId: id }, { signal });
				})().then(outcome.resolve, outcome.reject);
				return closing;
			},
		});
	} catch (error) {
		dispose();
		throw failure ?? error;
	}
}
