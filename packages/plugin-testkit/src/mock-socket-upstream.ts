import { randomUUID } from "node:crypto";
import { types } from "node:util";
import { type Fake, type ResolvedFakeTransport, resolveFakeTransport } from "@draftyak/fakes";
import { HOST_MAX_FRAME_BYTES, HostNotification } from "@draftyak/protocol/host-channel";
import { canonicalize } from "@draftyak/protocol/jcs";
import { HostError } from "@draftyak/sdk/host";
import { MockHubError } from "./types.ts";

export const MOCK_SOCKET_LIMIT = 16;
export const MOCK_SOCKET_EVENT_LIMIT = 16;
export const MOCK_SOCKET_QUEUE_BYTES: number = HOST_MAX_FRAME_BYTES;

export interface MockSocketOpenContext {
	readonly signal: AbortSignal;
	readonly onData: (data: string) => void;
}
export interface MockSocketConnection {
	ack(envelopeId: string): void | Promise<void>;
	close(): void | Promise<void>;
	/** Fulfilled void witnesses actual termination; rejection or another value is unqualified. */
	readonly closed: Promise<void>;
}
export interface MockSocketOptions {
	readonly url: string;
	readonly open: (
		context: MockSocketOpenContext,
	) => MockSocketConnection | Promise<MockSocketConnection>;
}
declare const socketBrand: unique symbol;
/** Constructor-issued test DATA, never a network permission or native account association. */
export interface MockSocketUpstream {
	readonly [socketBrand]: true;
}
interface CapturedUpstream {
	readonly fake: object;
	readonly transport: ResolvedFakeTransport;
	readonly url: string;
	readonly open: MockSocketOptions["open"];
}
const upstreams = new WeakMap<object, CapturedUpstream>();
const nativeSignalAny = AbortSignal.any.bind(AbortSignal);

function invalid(): never {
	throw new MockHubError("INVALID_SOCKET_UPSTREAM");
}
function slots(raw: unknown, names: readonly string[]): Record<string, unknown> {
	if (
		raw === null ||
		typeof raw !== "object" ||
		types.isProxy(raw) ||
		![Object.prototype, null].includes(Object.getPrototypeOf(raw))
	)
		invalid();
	const keys = Reflect.ownKeys(raw);
	if (
		keys.length !== names.length ||
		keys.some((key) => typeof key !== "string" || !names.includes(key))
	)
		invalid();
	const result: Record<string, unknown> = Object.create(null);
	for (const name of names) {
		const slot = Object.getOwnPropertyDescriptor(raw, name);
		if (!slot?.enumerable || !Object.hasOwn(slot, "value")) invalid();
		result[name] = slot.value;
	}
	return result;
}
function callback(raw: unknown): raw is (...args: never[]) => unknown {
	return typeof raw === "function" && !types.isProxy(raw);
}
function endpoint(raw: unknown): string {
	if (
		typeof raw !== "string" ||
		raw.length < 1 ||
		raw.length > 8192 ||
		!raw.isWellFormed() ||
		/[\s\\]/u.test(raw) ||
		[...raw].some((character) => {
			const code = character.charCodeAt(0);
			return code < 32 || code === 127;
		})
	)
		invalid();
	let parsed: URL;
	try {
		parsed = new URL(raw);
	} catch {
		return invalid();
	}
	if (
		parsed.protocol !== "wss:" ||
		!parsed.hostname ||
		parsed.username ||
		parsed.password ||
		parsed.hash
	)
		invalid();
	return raw;
}
/** Bind a synthetic socket backend to the original transport of one real HTTP fake. */
export function createMockSocketUpstream(
	fake: unknown,
	options: MockSocketOptions,
): MockSocketUpstream {
	const transport = resolveFakeTransport(fake);
	if (!transport || types.isProxy(fake)) invalid();
	const captured = slots(options, ["url", "open"]);
	const url = endpoint(captured.url);
	if (!callback(captured.open)) invalid();
	const companion = Object.freeze(Object.create(null)) as MockSocketUpstream;
	upstreams.set(
		companion,
		Object.freeze({
			fake: fake as object,
			transport,
			url,
			open: captured.open as MockSocketOptions["open"],
		}),
	);
	return companion;
}

function nativePromise<T>(value: Promise<T>): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		Promise.prototype.then.call(value, resolve, reject);
	});
}
async function resultOf(value: unknown): Promise<unknown> {
	return types.isPromise(value) ? await nativePromise(value) : value;
}
interface CapturedConnection {
	readonly ack: MockSocketConnection["ack"];
	readonly close: MockSocketConnection["close"];
	readonly closed: Promise<void>;
}
function connection(raw: unknown): CapturedConnection {
	const data = slots(raw, ["ack", "close", "closed"]);
	if (!callback(data.ack) || !callback(data.close) || !types.isPromise(data.closed)) invalid();
	return {
		ack: data.ack as MockSocketConnection["ack"],
		close: data.close as MockSocketConnection["close"],
		closed: nativePromise(data.closed as Promise<void>),
	};
}
interface Socket {
	readonly id: string;
	readonly owner: AbortController;
	readonly done: ReturnType<typeof Promise.withResolvers<void>>;
	readonly pending: Set<Promise<unknown>>;
	opening: Promise<void>;
	opened: boolean;
	retiring: boolean;
	openSettled: boolean;
	closeStarted: boolean;
	closeSettled: boolean;
	backendSettled: boolean;
	cleanupFailed: boolean;
	terminationFailed: boolean;
	unknownBackend: boolean;
	removeLifetime: () => void;
	backend?: CapturedConnection;
}
interface Event {
	readonly socket: Socket;
	readonly notification: HostNotification;
	readonly bytes: number;
}
export interface MockSocketManager {
	open(
		url: string,
		signal: AbortSignal,
		lifetime?: AbortSignal,
	): Promise<{ readonly socketId: string }>;
	ack(socketId: string, envelopeId: string, signal: AbortSignal): Promise<null>;
	closeSocket(socketId: string): Promise<null>;
	abort(): void;
	settled(): Promise<void>;
}

/** Capture original companions before another constructor option can change the array. */
export function copyMockSocketUpstreams(raw: unknown): readonly MockSocketUpstream[] {
	if (types.isProxy(raw) || !Array.isArray(raw) || Object.getPrototypeOf(raw) !== Array.prototype)
		invalid();
	const length: unknown = Object.getOwnPropertyDescriptor(raw, "length")?.value;
	if (
		typeof length !== "number" ||
		!Number.isInteger(length) ||
		length > MOCK_SOCKET_LIMIT ||
		Reflect.ownKeys(raw).length !== length + 1
	)
		invalid();
	const copied: MockSocketUpstream[] = [];
	for (let at = 0; at < length; at++) {
		const slot = Object.getOwnPropertyDescriptor(raw, String(at));
		if (!slot?.enumerable || !Object.hasOwn(slot, "value")) invalid();
		const value: unknown = slot.value;
		if (value === null || typeof value !== "object" || !upstreams.has(value)) invalid();
		copied.push(value as MockSocketUpstream);
	}
	return Object.freeze(copied);
}

/** Private host plumbing; callers still need the constructor-issued companion. */
export function createMockSocketManager(
	raw: unknown,
	http: ReadonlyMap<string, Fake>,
	publish: (notification: HostNotification) => void,
): MockSocketManager | undefined {
	if (raw === undefined) return undefined;
	const copied = copyMockSocketUpstreams(raw);
	const routes = new Map<string, CapturedUpstream>();
	for (const value of copied) {
		const captured = upstreams.get(value);
		if (
			!captured ||
			http.get(captured.transport.host) !== captured.fake ||
			resolveFakeTransport(captured.fake) !== captured.transport ||
			routes.has(captured.url)
		)
			invalid();
		routes.set(captured.url, captured);
	}
	if (!routes.size) return undefined;
	const prefix = randomUUID();
	let serial = 0,
		closed = false,
		cleanupFailed = false,
		unqualified = false,
		queuedBytes = 0,
		activeAcks = 0;
	let immediate: NodeJS.Immediate | undefined;
	const sockets = new Map<string, Socket>();
	const events: Event[] = [];
	function forgetEvents(socket?: Socket): void {
		for (let at = events.length - 1; at >= 0; at--) {
			const event = events[at];
			if (event && (socket === undefined || event.socket === socket)) {
				queuedBytes -= event.bytes;
				events.splice(at, 1);
			}
		}
		if (!events.length && immediate) {
			clearImmediate(immediate);
			immediate = undefined;
		}
	}
	function finish(socket: Socket): void {
		if (
			!socket.retiring ||
			!socket.openSettled ||
			socket.pending.size ||
			(socket.backend && !socket.closeSettled)
		)
			return;
		if (socket.unknownBackend || socket.terminationFailed) {
			unqualified = true;
			socket.done.reject(new MockHubError("SOCKET_TERMINATION_UNQUALIFIED"));
			return;
		}
		if (socket.backend && !socket.backendSettled) return;
		cleanupFailed ||= socket.cleanupFailed;
		socket.removeLifetime();
		sockets.delete(socket.id);
		socket.done.resolve();
	}
	async function invokeVoid(method: (...args: never[]) => unknown, args: unknown[]): Promise<void> {
		const value = Reflect.apply(method, undefined, args);
		if (value !== undefined && !types.isPromise(value)) throw new HostError("BAD_REQUEST");
		if ((await resultOf(value)) !== undefined) throw new HostError("BAD_REQUEST");
	}
	function retire(socket: Socket): void {
		socket.retiring = true;
		socket.opened = false;
		socket.owner.abort();
		forgetEvents(socket);
		if (socket.backend && !socket.closeStarted) {
			socket.closeStarted = true;
			void invokeVoid(socket.backend.close, [])
				.catch(() => {
					socket.cleanupFailed = true;
				})
				.finally(() => {
					socket.closeSettled = true;
					finish(socket);
				});
		}
		finish(socket);
	}
	function schedule(): void {
		if (immediate || !events.length || closed) return;
		immediate = setImmediate(() => {
			immediate = undefined;
			const event = events[0];
			if (!event) return;
			try {
				if (!closed && !event.socket.retiring) publish(event.notification);
			} catch {
				retire(event.socket);
			}
			// publish may synchronously close the host or retire this socket.
			const at = events.indexOf(event);
			if (at !== -1) {
				events.splice(at, 1);
				queuedBytes -= event.bytes;
			}
			schedule();
		});
	}
	function onData(socket: Socket, value: unknown): void {
		if (closed || socket.retiring) return;
		if (typeof value !== "string" || value.length > HOST_MAX_FRAME_BYTES || !value.isWellFormed()) {
			retire(socket);
			return;
		}
		const notification: HostNotification = {
			jsonrpc: "2.0",
			method: "host/ws.message",
			params: { socketId: socket.id, data: value },
		};
		if (!HostNotification.safeParse(notification).success) {
			retire(socket);
			return;
		}
		const bytes = Buffer.byteLength(canonicalize(notification), "utf8");
		if (
			bytes > HOST_MAX_FRAME_BYTES ||
			events.length >= MOCK_SOCKET_EVENT_LIMIT ||
			bytes > MOCK_SOCKET_QUEUE_BYTES - queuedBytes
		) {
			retire(socket);
			return;
		}
		queuedBytes += bytes;
		events.push({ socket, notification, bytes });
		schedule();
	}
	function owned(id: string): Socket {
		const socket = sockets.get(id);
		if (closed || !socket?.opened || socket.retiring) throw new HostError("DENIED");
		return socket;
	}
	return {
		async open(url, signal, lifetimeInput) {
			let lifetime: AbortSignal | undefined;
			try {
				lifetime = lifetimeInput === undefined ? undefined : nativeSignalAny([lifetimeInput]);
			} catch {
				throw new HostError("BAD_REQUEST");
			}
			if (closed || unqualified || signal.aborted || lifetime?.aborted)
				throw new HostError("DENIED");
			const route = routes.get(url);
			if (!route) throw new HostError("DENIED");
			if (sockets.size >= MOCK_SOCKET_LIMIT || serial >= Number.MAX_SAFE_INTEGER)
				throw new HostError("TOO_LARGE");
			const socket: Socket = {
				id: `${prefix}-${++serial}`,
				owner: new AbortController(),
				done: Promise.withResolvers<void>(),
				pending: new Set(),
				opening: Promise.resolve(),
				opened: false,
				retiring: false,
				openSettled: false,
				closeStarted: false,
				closeSettled: false,
				backendSettled: false,
				cleanupFailed: false,
				terminationFailed: false,
				unknownBackend: false,
				removeLifetime: () => {},
			};
			void socket.done.promise.catch(() => {});
			sockets.set(socket.id, socket);
			const abort = (): void => retire(socket);
			const lifetimeSignal = lifetime ?? signal;
			lifetimeSignal.addEventListener("abort", abort, { once: true });
			socket.removeLifetime = () => lifetimeSignal.removeEventListener("abort", abort);
			if (signal !== lifetimeSignal) signal.addEventListener("abort", abort, { once: true });
			if (signal.aborted || lifetimeSignal.aborted) abort();
			socket.opening = (async () => {
				try {
					if (socket.retiring || closed) throw new HostError("DENIED");
					const rawConnection = Reflect.apply(route.open, undefined, [
						Object.freeze({
							signal: socket.owner.signal,
							onData: (data: string) => onData(socket, data),
						}),
					]);
					const rawBackend = types.isPromise(rawConnection)
						? await nativePromise(rawConnection)
						: rawConnection;
					// An invalid returned backend has no safely captured termination witness.
					socket.unknownBackend = true;
					const backend = connection(rawBackend);
					socket.backend = backend;
					socket.unknownBackend = false;
					void backend.closed
						.then(
							(value) => {
								if (value === undefined) socket.backendSettled = true;
								else {
									socket.terminationFailed = true;
									unqualified = true;
								}
							},
							() => {
								socket.terminationFailed = true;
								unqualified = true;
							},
						)
						.then(() => retire(socket));
					if (closed || socket.retiring || signal.aborted || lifetime?.aborted) retire(socket);
					else socket.opened = true;
				} catch {
					retire(socket);
					throw new HostError("DENIED");
				} finally {
					socket.openSettled = true;
					if (signal !== lifetimeSignal) signal.removeEventListener("abort", abort);
					finish(socket);
				}
			})();
			await socket.opening;
			if (closed || signal.aborted || lifetime?.aborted || socket.retiring || !socket.opened)
				throw new HostError("DENIED");
			return { socketId: socket.id };
		},
		async ack(socketId, envelopeId, signal) {
			const socket = owned(socketId),
				backend = socket.backend;
			if (!backend || signal.aborted) throw new HostError("DENIED");
			if (activeAcks >= MOCK_SOCKET_LIMIT) throw new HostError("TOO_LARGE");
			const abort = (): void => retire(socket);
			signal.addEventListener("abort", abort, { once: true });
			activeAcks++;
			const pending = invokeVoid(backend.ack, [envelopeId]);
			socket.pending.add(pending);
			try {
				await pending;
			} catch {
				retire(socket);
				throw new HostError("DENIED");
			} finally {
				activeAcks--;
				socket.pending.delete(pending);
				signal.removeEventListener("abort", abort);
				finish(socket);
			}
			if (closed || signal.aborted || socket.retiring) throw new HostError("DENIED");
			return null;
		},
		async closeSocket(socketId) {
			const socket = sockets.get(socketId);
			if (closed || !socket) throw new HostError("DENIED");
			retire(socket);
			try {
				await socket.done.promise;
			} catch {
				throw new HostError("DENIED");
			}
			if (socket.cleanupFailed) throw new HostError("DENIED");
			return null;
		},
		abort() {
			if (closed) return;
			closed = true;
			forgetEvents();
			for (const socket of sockets.values()) retire(socket);
		},
		async settled() {
			const outcomes = await Promise.allSettled(
				[...sockets.values()].map((socket) => socket.done.promise),
			);
			for (const outcome of outcomes) if (outcome.status === "rejected") throw outcome.reason;
			if (cleanupFailed) throw new MockHubError("SOCKET_CLEANUP_FAILED");
		},
	};
}
