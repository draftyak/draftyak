import { isProxy } from "node:util/types";
import { MAX_LEASE_MS } from "@draftyak/protocol/channel-v1";
import { HOST_MAX_FRAME_BYTES } from "@draftyak/protocol/host-channel";
import { parseStrict } from "@draftyak/protocol/jcs";
import { MAX_INLINE_BYTES } from "@draftyak/protocol/normalized-change";
import {
	type ContextIdentity,
	createPluginContext,
	type HostSocket,
	type PluginContext,
} from "@draftyak/sdk/context";
import type { HostChannel } from "@draftyak/sdk/host";
import { createSlackSocketProcessor, type SlackSocketProcessor } from "./socket-mode.ts";

const CONNECTIONS_URL = "https://slack.com/api/apps.connections.open";
const MAX_MESSAGES = 16;
const MAX_RECONNECTS = 3;
const RECONNECT_DELAY_MS = 1_000;

export interface SlackSocketLease {
	listen(leaseMs: number, callerSignal: AbortSignal): Promise<Readonly<{ leaseMs: number }>>;
	close(): Promise<void>;
}

function invalid(): never {
	throw new Error("SLACK_LEASE_INVALID");
}
function aborted(): Error {
	return new Error("SLACK_LEASE_ABORTED");
}
function failed(): Error {
	return new Error("SLACK_LEASE_FAILED");
}
function fields(raw: unknown, names: readonly string[]): Record<string, unknown> {
	if (raw === null || typeof raw !== "object" || isProxy(raw)) invalid();
	const prototype = Object.getPrototypeOf(raw);
	if (prototype !== null && prototype !== Object.prototype) invalid();
	const copy: Record<string, unknown> = Object.create(null);
	for (const name of names) {
		const descriptor = Object.getOwnPropertyDescriptor(raw, name);
		if (descriptor === undefined) continue;
		if (!descriptor.enumerable || !("value" in descriptor)) invalid();
		copy[name] = descriptor.value;
	}
	return copy;
}
function label(raw: unknown): string {
	if (typeof raw !== "string" || raw.length < 1 || raw.length > 256) invalid();
	for (const char of raw) if (char.charCodeAt(0) < 33 || char.charCodeAt(0) > 126) invalid();
	return raw;
}
function identityCopy(raw: ContextIdentity): ContextIdentity {
	const identity = fields(raw, ["plugin", "account", "instance"]);
	const plugin = label(identity.plugin);
	const account = identity.account === undefined ? undefined : label(identity.account);
	if (identity.instance === undefined)
		return Object.freeze({ plugin, ...(account === undefined ? {} : { account }) });
	const instance = fields(identity.instance, ["id", "config"]);
	const id = label(instance.id);
	const config = instance.config;
	if (config === null || typeof config !== "object" || isProxy(config)) invalid();
	const keys = Reflect.ownKeys(config);
	if (keys.length > 4096 || keys.some((key) => typeof key !== "string")) invalid();
	const copied = fields(
		config,
		keys.filter((key): key is string => typeof key === "string"),
	);
	return Object.freeze({
		plugin,
		...(account === undefined ? {} : { account }),
		instance: Object.freeze({ id, config: Object.freeze(copied) }),
	});
}
function isAborted(signal: AbortSignal): boolean {
	try {
		if (isProxy(signal)) invalid();
		return Reflect.get(AbortSignal.prototype, "aborted", signal) === true;
	} catch {
		return invalid();
	}
}
function onAbort(signal: AbortSignal, listener: () => void): () => void {
	Reflect.apply(EventTarget.prototype.addEventListener, signal, [
		"abort",
		listener,
		{ once: true },
	]);
	return () =>
		Reflect.apply(EventTarget.prototype.removeEventListener, signal, ["abort", listener]);
}
function slackUrl(raw: unknown): string {
	if (typeof raw !== "string" || raw.length > 8192) invalid();
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return invalid();
	}
	if (
		url.protocol !== "wss:" ||
		url.username !== "" ||
		url.password !== "" ||
		url.hash !== "" ||
		(url.port !== "" && url.port !== "443") ||
		(url.hostname !== "slack.com" && !url.hostname.endsWith(".slack.com")) ||
		url.hostname
			.split(".")
			.some((part) => part.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(part)) ||
		/[\s\\]/u.test(raw)
	)
		invalid();
	return raw;
}
async function connectionUrl(context: PluginContext): Promise<string> {
	const response = await context.fetch(CONNECTIONS_URL, { method: "POST", stream: false });
	if (
		!response.ok ||
		response.bodyRef !== undefined ||
		response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !==
			"application/json"
	)
		invalid();
	const reader = response.body?.getReader();
	if (!reader) invalid();
	const chunks: Uint8Array[] = [];
	let bytes = 0;
	try {
		while (true) {
			const next = await reader.read();
			if (isAborted(context.signal)) throw aborted();
			if (next.done) break;
			bytes += next.value.byteLength;
			if (bytes > MAX_INLINE_BYTES) invalid();
			chunks.push(next.value);
		}
		let value: unknown;
		try {
			value = parseStrict(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
		} catch {
			return invalid();
		}
		const result = fields(value, ["ok", "url", "error"]);
		if (result.ok !== true || Object.hasOwn(result, "error")) invalid();
		return slackUrl(result.url);
	} finally {
		void reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}

interface Connection {
	readonly abort: AbortController;
	readonly context: PluginContext;
	readonly early: Map<string, string[]>;
	readonly queue: string[];
	socket?: HostSocket;
	processor?: SlackSocketProcessor;
	awaitingId: boolean;
	stopped: boolean;
	count: number;
	bytes: number;
	delivery?: Promise<void>;
	closing?: Promise<void>;
}
interface Lease {
	phase: "opening" | "live" | "reconnecting" | "retiring";
	cancelled: boolean;
	expires: number;
	reconnects: number;
	connection?: Connection;
	opening?: Promise<void>;
	retiring?: Promise<void>;
	timer?: ReturnType<typeof setTimeout>;
	cancelDelay?: () => void;
	rejectCaller?: (error: Error) => void;
}

/** Cooperative child resources only. Native account, egress and lease authority stay with the parent. */
export function createSlackSocketLease(
	host: HostChannel,
	identity: ContextIdentity,
	processSignal: AbortSignal,
): SlackSocketLease {
	const capturedIdentity = identityCopy(identity);
	if (isAborted(processSignal)) throw aborted();
	let terminal = false;
	let eof = false;
	let current: Lease | undefined;
	let unsubscribe: (() => void) | undefined;
	let removeProcessAbort = (): void => {};
	let closing: Promise<void> | undefined;
	const work = new Set<Promise<unknown>>();
	function track<T>(promise: Promise<T>): Promise<T> {
		work.add(promise);
		void promise.then(
			() => work.delete(promise),
			() => work.delete(promise),
		);
		return promise;
	}
	function active(lease: Lease): boolean {
		return !terminal && !lease.cancelled && current === lease && !isAborted(processSignal);
	}
	function remaining(lease: Lease): boolean {
		return active(lease) && performance.now() < lease.expires;
	}
	function closeConnection(connection: Connection): Promise<void> {
		if (connection.closing) return connection.closing;
		connection.stopped = true;
		connection.processor?.dispose();
		connection.queue.length = 0;
		connection.early.clear();
		connection.closing = (async () => {
			try {
				// Do not pre-abort the context used by the normal close RPC.
				if (connection.socket && !eof) await connection.socket.close();
			} catch {
				// The parent owns remote cleanup when the channel/close refuses.
			} finally {
				connection.abort.abort();
			}
		})();
		return connection.closing;
	}
	function retire(lease: Lease, reason: Error = aborted()): Promise<void> {
		if (lease.retiring) return lease.retiring;
		lease.cancelled = true;
		lease.phase = "retiring";
		clearTimeout(lease.timer);
		lease.cancelDelay?.();
		lease.rejectCaller?.(reason);
		lease.retiring = (async () => {
			// A cancelled open remains accounted for until its SDK result/timeout.
			await lease.opening?.catch(() => {});
			if (lease.connection) await closeConnection(lease.connection);
			if (current === lease) current = undefined;
		})();
		return track(lease.retiring);
	}
	function expire(lease: Lease, leaseMs: number): void {
		clearTimeout(lease.timer);
		lease.expires = performance.now() + leaseMs;
		lease.timer = setTimeout(() => void retire(lease), leaseMs);
	}
	function delay(lease: Lease): Promise<boolean> {
		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				lease.cancelDelay = undefined;
				resolve(remaining(lease));
			}, RECONNECT_DELAY_MS);
			lease.cancelDelay = () => {
				clearTimeout(timer);
				lease.cancelDelay = undefined;
				resolve(false);
			};
		});
	}
	async function connect(lease: Lease): Promise<void> {
		const controller = new AbortController();
		// Process shutdown is bridged by stop(), preserving the normal close-before-abort order.
		const signal = controller.signal;
		const connection: Connection = {
			abort: controller,
			context: createPluginContext(capturedIdentity, host, signal),
			early: new Map(),
			queue: [],
			awaitingId: false,
			stopped: false,
			count: 0,
			bytes: 0,
		};
		lease.connection = connection;
		const opening = (async () => {
			const url = await connectionUrl(connection.context);
			if (!active(lease)) throw aborted();
			connection.awaitingId = true;
			connection.socket = await connection.context.ws.open(url);
			connection.awaitingId = false;
			if (!active(lease) || connection.stopped) throw aborted();
			const early = connection.early.get(connection.socket.id) ?? [];
			connection.early.clear();
			connection.count = early.length;
			connection.bytes = early.reduce((sum, data) => sum + Buffer.byteLength(data), 0);
			connection.queue.push(...early);
			connection.processor = createSlackSocketProcessor(connection.context, connection.socket);
		})();
		lease.opening = opening;
		try {
			await opening;
		} finally {
			if (lease.opening === opening) lease.opening = undefined;
		}
	}
	function rotate(lease: Lease, connection: Connection): void {
		if (!remaining(lease) || lease.phase !== "live" || connection.stopped) return;
		lease.phase = "reconnecting";
		void track(
			(async () => {
				await closeConnection(connection);
				while (remaining(lease) && lease.reconnects < MAX_RECONNECTS) {
					lease.reconnects++;
					if (!(await delay(lease))) break;
					try {
						await connect(lease);
						if (!remaining(lease)) break;
						lease.phase = "live";
						if (lease.connection) drain(lease, lease.connection);
						return;
					} catch {
						if (lease.connection) await closeConnection(lease.connection);
					}
				}
				await retire(lease);
			})(),
		);
	}
	function drain(lease: Lease, connection: Connection): void {
		if (connection.delivery || connection.stopped || !connection.processor) return;
		const processor = connection.processor;
		connection.delivery = track(
			(async () => {
				while (connection.queue.length && remaining(lease) && !connection.stopped) {
					const data = connection.queue.shift();
					if (data === undefined) break;
					try {
						await processor.receive(data);
						if (!remaining(lease) || connection.stopped) break;
						const control = fields(parseStrict(data), ["type"]);
						if (control.type === "disconnect") {
							rotate(lease, connection);
							break;
						}
					} catch {
						rotate(lease, connection);
						break;
					} finally {
						connection.count--;
						connection.bytes -= Buffer.byteLength(data);
					}
				}
			})(),
		);
		void connection.delivery.then(() => {
			connection.delivery = undefined;
			if (connection.queue.length && remaining(lease) && !connection.stopped)
				drain(lease, connection);
		});
	}
	function enqueue(lease: Lease, connection: Connection, socketId: string, data: string): void {
		if (connection.stopped) return;
		if (connection.socket && connection.socket.id !== socketId) return;
		if (!connection.socket && !connection.awaitingId) return;
		const size = Buffer.byteLength(data);
		if (connection.count >= MAX_MESSAGES || connection.bytes + size > HOST_MAX_FRAME_BYTES) {
			connection.stopped = true;
			connection.processor?.dispose();
			if (lease.phase === "live") void retire(lease);
			return;
		}
		connection.count++;
		connection.bytes += size;
		if (!connection.socket) {
			const mailbox = connection.early.get(socketId) ?? [];
			mailbox.push(data);
			connection.early.set(socketId, mailbox);
		} else {
			connection.queue.push(data);
			if (lease.phase === "live") drain(lease, connection);
		}
	}
	function stop(channelEnded: boolean): Promise<void> {
		if (closing) return closing;
		terminal = true;
		eof ||= channelEnded;
		unsubscribe?.();
		unsubscribe = undefined;
		removeProcessAbort();
		closing = (async () => {
			if (eof) current?.connection?.abort.abort();
			if (current) await retire(current);
			await Promise.allSettled([...work]);
		})();
		return closing;
	}
	unsubscribe = host.subscribe(
		(notification) => {
			const lease = current;
			if (terminal || !lease?.connection || notification.method !== "host/ws.message") return;
			enqueue(lease, lease.connection, notification.params.socketId, notification.params.data);
		},
		() => void stop(true),
	);
	removeProcessAbort = onAbort(processSignal, () => void stop(false));
	if (isAborted(processSignal)) void stop(false);
	return Object.freeze({
		async listen(
			leaseMs: number,
			callerSignal: AbortSignal,
		): Promise<Readonly<{ leaseMs: number }>> {
			if (!Number.isSafeInteger(leaseMs) || leaseMs < 1_000 || leaseMs > MAX_LEASE_MS) invalid();
			if (terminal || isAborted(processSignal) || isAborted(callerSignal)) throw aborted();
			if (current) {
				if (current.phase !== "live" || current.cancelled) throw failed();
				expire(current, leaseMs);
				current.reconnects = 0;
				return Promise.resolve(Object.freeze({ leaseMs }));
			}
			const lease: Lease = {
				phase: "opening",
				cancelled: false,
				expires: Number.POSITIVE_INFINITY,
				reconnects: 0,
			};
			current = lease;
			const cancelled = new Promise<never>((_resolve, reject) => {
				lease.rejectCaller = reject;
			});
			const cancel = (): void => {
				lease.cancelled = true;
				lease.rejectCaller?.(aborted());
			};
			const removeCallerAbort = onAbort(callerSignal, cancel);
			if (isAborted(callerSignal)) cancel();
			const opening = track(
				(async () => {
					try {
						await connect(lease);
						if (!active(lease) || isAborted(callerSignal)) throw aborted();
						lease.phase = "live";
						expire(lease, leaseMs);
						removeCallerAbort();
						lease.rejectCaller = undefined;
						if (lease.connection) drain(lease, lease.connection);
						return Object.freeze({ leaseMs });
					} catch (error) {
						const wasCancelled = lease.cancelled || terminal || isAborted(processSignal);
						const reason = wasCancelled
							? aborted()
							: new Error(
									error instanceof Error && error.message === "SLACK_LEASE_INVALID"
										? "SLACK_LEASE_INVALID"
										: "SLACK_LEASE_FAILED",
								);
						await retire(lease, reason);
						throw reason;
					}
				})(),
			);
			return Promise.race([opening, cancelled]).finally(removeCallerAbort);
		},
		close: () => stop(false),
	});
}
