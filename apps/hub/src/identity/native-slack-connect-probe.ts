import { addAbortListener } from "node:events";
import type { ClientRequest, IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import type { Socket } from "node:net";
import { types } from "node:util";
import { HOST_MAX_ACTIVE_REQUESTS } from "@draftyak/protocol/host-channel";
import { parseStrict } from "@draftyak/protocol/jcs";
import { AuditChain } from "../audit/chain.ts";
import { Authorizer } from "../authz/authorizer.ts";
import type { NativeDevicePeer } from "../authz/native-peer.ts";
import { dataMember, isPlainFunction } from "../extensions/values.ts";
import type { TimerClock } from "../kernel/clock.ts";
import {
	assertNativePluginOwner,
	type NativePluginSessionParts,
	nativePluginInputs,
} from "../lifecycle/native-session-context.ts";
import {
	captureEgressPolicy,
	createPinnedHttpsConnection,
	type PinnedHttpsConnection,
	resolveEgress,
} from "../plugins/broker/network/index.ts";
import { HubStore, type SqlReader } from "../store/store.ts";
import { DeviceRegistry } from "./devices.ts";

export const NATIVE_SLACK_CONNECT_PROBE_TIMEOUT_MS = 10_000;
export const NATIVE_SLACK_CONNECT_PROBE_BODY_BYTES = 65_536;
const MAX_TOKEN_BYTES = 8192;
const MAX_HEADER_BYTES = 16_384;
const MAX_HEADER_PAIRS = 128;
declare const probeBrand: unique symbol;
declare const resultBrand: unique symbol;
export interface NativeSlackConnectProbe {
	readonly [probeBrand]: true;
}
export interface NativeSlackConnectProbeResult {
	readonly [resultBrand]: true;
}
export interface NativeSlackConnectProbeData {
	readonly rawBody: Buffer;
	readonly rawHeaders: readonly string[];
}
export class NativeSlackConnectProbeError extends Error {
	readonly code = "SLACK_CONNECT_PROBE_UNAVAILABLE";
	constructor() {
		super("Slack connect probe unavailable");
		this.name = "NativeSlackConnectProbeError";
	}
}
function unavailable(): never {
	throw new NativeSlackConnectProbeError();
}
interface Completion {
	readonly promise: Promise<void>;
	resolve(): void;
}
interface Held {
	readonly value: ClientRequest | IncomingMessage | Socket;
	readonly close: Completion;
	readonly destroy: () => void;
	closed: boolean;
}
interface Attempt {
	readonly state: State;
	readonly peer: NativeDevicePeer;
	binding?: PeerBinding;
	cleaned: boolean;
	readonly signal: AbortSignal;
	readonly abort: AbortController;
	readonly stopTimer: AbortController;
	readonly handles: Set<Held>;
	readonly chunks: Buffer[];
	cleanup?: Promise<void>;
	listener?: Disposable;
	timer?: Promise<void>;
	connection?: PinnedHttpsConnection;
	token?: Buffer;
	form?: Buffer;
	body?: Buffer;
	headers?: readonly string[];
	wall?: number;
	mono?: number;
	write?: Completion;
	writeObserved: boolean;
	writeUncertain: boolean;
	constructorUncertain: boolean;
	failed: boolean;
	stopped: boolean;
}
interface PeerBinding {
	readonly ownerUserId: string;
	readonly userId: string;
	readonly epoch: number;
	readonly deviceId: string;
	readonly approvalKey: string;
}
interface State {
	readonly session: object;
	readonly parts: NativePluginSessionParts;
	readonly store: HubStore;
	readonly devices: DeviceRegistry;
	readonly audit: AuditChain;
	readonly authorizer: Authorizer;
	readonly requests: WeakMap<AbortSignal, Attempt>;
	readonly clock: TimerClock;
	readonly wall: () => unknown;
	readonly mono: () => unknown;
	readonly after: (ms: number, signal: AbortSignal) => unknown;
	readonly token: NativeSlackConnectProbe;
	readonly attempts: Set<Attempt>;
	readonly pending: Set<Promise<NativeSlackConnectProbeResult>>;
	readonly results: Set<object>;
	closing: boolean;
	closed: boolean;
	close?: Promise<void>;
}
interface Result {
	readonly owner: State;
	readonly attempt: Attempt;
	readonly headers: readonly string[];
	body: Buffer;
}
const states = new WeakMap<object, State>();
const sessions = new WeakMap<object, State>();
const original = Object.freeze({
	read: HubStore.prototype.read,
	verifyAudit: AuditChain.prototype.verify,
	assertDevices: DeviceRegistry.prototype.assertStore,
	requirePeer: Authorizer.prototype.requirePeerKind,
	assertGrant: Authorizer.prototype.assertCurrentGrant,
});
const results = new WeakMap<object, Result>();
const typedArray = Object.getPrototypeOf(Uint8Array.prototype);
const bufferGetter = Object.getOwnPropertyDescriptor(typedArray, "buffer")?.get;
const lengthGetter = Object.getOwnPropertyDescriptor(typedArray, "byteLength")?.get;
const offsetGetter = Object.getOwnPropertyDescriptor(typedArray, "byteOffset")?.get;
const signalAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted")?.get;
const domErrorName = Object.getOwnPropertyDescriptor(DOMException.prototype, "name")?.get;
const originalAbort = AbortController.prototype.abort;
const policy = captureEgressPolicy({ deniedAddresses: [], deniedPorts: [] });

function stateOf(value: unknown): State {
	if (!value || typeof value !== "object" || types.isProxy(value)) unavailable();
	return states.get(value) ?? unavailable();
}
function owner(state: State): void {
	try {
		if (
			state.closing ||
			state.closed ||
			sessions.get(state.session) !== state ||
			state.parts.clock !== state.clock ||
			state.parts.store !== state.store ||
			state.parts.devices !== state.devices ||
			state.parts.audit !== state.audit
		)
			unavailable();
		assertNativePluginOwner(state.session, state.parts);
	} catch {
		unavailable();
	}
}
function assertRequest(attempt: Attempt): void {
	try {
		const state = attempt.state;
		owner(state);
		if (state.requests.get(attempt.signal) !== attempt || signalAborted?.call(attempt.signal))
			unavailable();
		const current = original.read.call(state.store, (sql: SqlReader): PeerBinding => {
			owner(state);
			original.verifyAudit.call(state.audit, sql);
			const grant = original.requirePeer.call(
				state.authorizer,
				sql,
				attempt.peer,
				"account.connect",
			);
			original.assertGrant.call(state.authorizer, sql, grant);
			owner(state);
			return Object.freeze({
				ownerUserId: grant.ownerUserId,
				userId: grant.userId,
				epoch: grant.epoch,
				deviceId: grant.deviceId,
				approvalKey: grant.approvalKey,
			});
		}) as PeerBinding;
		const held = attempt.binding;
		if (
			held &&
			(held.ownerUserId !== current.ownerUserId ||
				held.userId !== current.userId ||
				held.epoch !== current.epoch ||
				held.deviceId !== current.deviceId ||
				held.approvalKey !== current.approvalKey)
		)
			unavailable();
		if (!held) attempt.binding = current;
		owner(state);
	} catch {
		unavailable();
	}
}
function releaseRequest(attempt: Attempt): void {
	const state = attempt.state;
	if (state.requests.get(attempt.signal) === attempt) state.requests.delete(attempt.signal);
	if (attempt.cleaned) state.attempts.delete(attempt);
}
function captureSignal(value: unknown): AbortSignal {
	if (
		!value ||
		typeof value !== "object" ||
		types.isProxy(value) ||
		Object.getPrototypeOf(value) !== AbortSignal.prototype ||
		["aborted", "reason", "addEventListener", "removeEventListener"].some((key) =>
			Object.hasOwn(value, key),
		) ||
		typeof signalAborted?.call(value) !== "boolean"
	)
		unavailable();
	return value as AbortSignal;
}
function captureToken(value: unknown): Buffer {
	if (!types.isUint8Array(value) || types.isProxy(value)) unavailable();
	const buffer = bufferGetter?.call(value),
		length = lengthGetter?.call(value),
		offset = offsetGetter?.call(value);
	if (
		!types.isArrayBuffer(buffer) ||
		!Number.isSafeInteger(length) ||
		length < 1 ||
		length > MAX_TOKEN_BYTES ||
		!Number.isSafeInteger(offset) ||
		offset < 0
	)
		unavailable();
	const copy = Buffer.from(new Uint8Array(buffer, offset, length));
	if (copy.some((byte) => byte < 0x21 || byte > 0x7e)) {
		copy.fill(0);
		unavailable();
	}
	return copy;
}
function formToken(token: Buffer): Buffer {
	const safe = (byte: number): boolean =>
		(byte >= 0x41 && byte <= 0x5a) ||
		(byte >= 0x61 && byte <= 0x7a) ||
		(byte >= 0x30 && byte <= 0x39) ||
		[0x2d, 0x2e, 0x5f, 0x7e].includes(byte);
	const size = 6 + token.reduce((sum, byte) => sum + (safe(byte) ? 1 : 3), 0);
	const form = Buffer.alloc(size);
	try {
		form.write("token=", 0, "ascii");
		let index = 6;
		const hex = "0123456789ABCDEF";
		for (const byte of token) {
			if (safe(byte)) form[index++] = byte;
			else {
				form[index++] = 0x25;
				form[index++] = hex.charCodeAt(byte >>> 4);
				form[index++] = hex.charCodeAt(byte & 15);
			}
		}
		return form;
	} catch {
		form.fill(0);
		return unavailable();
	}
}
function requestedAbort(reason: unknown): boolean {
	if (!reason || typeof reason !== "object" || types.isProxy(reason)) return false;
	try {
		return domErrorName?.call(reason) === "AbortError";
	} catch {
		/* Node AbortError is not a DOMException. */
	}
	if (!types.isNativeError(reason)) return false;
	return (
		Object.getOwnPropertyDescriptor(reason, "name")?.value === "AbortError" &&
		Object.getOwnPropertyDescriptor(reason, "code")?.value === "ABORT_ERR"
	);
}
function abort(attempt: Attempt): void {
	attempt.failed = true;
	try {
		originalAbort.call(attempt.abort);
	} catch {
		/* Retained handles still need physical cleanup. */
	}
}
function admitted(attempt: Attempt, afterCleanup = false): number {
	const state = attempt.state;
	owner(state);
	if (
		attempt.failed ||
		signalAborted?.call(attempt.signal) ||
		(!afterCleanup && attempt.abort.signal.aborted)
	)
		unavailable();
	const nowWall = state.wall(),
		nowMono = state.mono();
	if (
		typeof nowWall !== "number" ||
		!Number.isSafeInteger(nowWall) ||
		nowWall < 0 ||
		typeof nowMono !== "number" ||
		!Number.isFinite(nowMono) ||
		nowMono < 0 ||
		nowMono > Number.MAX_SAFE_INTEGER
	)
		unavailable();
	if (attempt.wall === undefined) {
		attempt.wall = nowWall;
		attempt.mono = nowMono;
	}
	if (
		nowWall < attempt.wall ||
		nowMono < (attempt.mono ?? unavailable()) ||
		nowWall - attempt.wall >= NATIVE_SLACK_CONNECT_PROBE_TIMEOUT_MS ||
		nowMono - (attempt.mono ?? unavailable()) >= NATIVE_SLACK_CONNECT_PROBE_TIMEOUT_MS
	)
		unavailable();
	owner(state);
	assertRequest(attempt);
	return Math.min(
		NATIVE_SLACK_CONNECT_PROBE_TIMEOUT_MS - (nowWall - attempt.wall),
		NATIVE_SLACK_CONNECT_PROBE_TIMEOUT_MS - (nowMono - (attempt.mono ?? unavailable())),
	);
}
function hold(attempt: Attempt, value: Held["value"]): Held {
	const close = Promise.withResolvers<void>();
	const destroy = value.destroy;
	const held: Held = {
		value,
		close,
		destroy: () => {
			Reflect.apply(destroy, value, []);
		},
		closed: false,
	};
	attempt.handles.add(held);
	try {
		value.once("close", () => {
			held.closed = true;
			close.resolve();
		});
		value.on("error", () => {
			if (!attempt.stopped) attempt.failed = true;
		});
	} catch {
		attempt.constructorUncertain = true;
		throw new NativeSlackConnectProbeError();
	}
	return held;
}
function headers(response: IncomingMessage): readonly string[] {
	const raw = response.rawHeaders;
	if (raw.length % 2 !== 0 || raw.length > MAX_HEADER_PAIRS * 2) unavailable();
	let bytes = 0;
	const copy: string[] = [];
	for (let index = 0; index < raw.length; index += 2) {
		const name = raw[index],
			value = raw[index + 1];
		if (typeof name !== "string" || typeof value !== "string") unavailable();
		bytes += Buffer.byteLength(name) + Buffer.byteLength(value) + 4;
		if (bytes > MAX_HEADER_BYTES) unavailable();
		copy.push(name, value);
	}
	const values = (name: string): string[] =>
		copy.filter((_value, index) => index % 2 === 1 && copy[index - 1]?.toLowerCase() === name);
	if (
		values("location").length ||
		values("content-encoding").some((value) => value.trim().toLowerCase() !== "identity") ||
		values("content-encoding").length > 1 ||
		values("content-type").length !== 1 ||
		!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(values("content-type")[0] ?? "") ||
		values("content-length").length > 1
	)
		unavailable();
	const length = values("content-length")[0];
	if (
		length !== undefined &&
		(!/^(0|[1-9][0-9]*)$/.test(length) || Number(length) > NATIVE_SLACK_CONNECT_PROBE_BODY_BYTES)
	)
		unavailable();
	return Object.freeze(copy);
}
function startTimer(attempt: Attempt): void {
	const done = Promise.withResolvers<void>();
	attempt.timer = done.promise;
	void (async () => {
		try {
			const remaining = admitted(attempt);
			const waiting = attempt.state.after(Math.ceil(remaining), attempt.stopTimer.signal);
			if (!types.isPromise(waiting)) unavailable();
			await waiting;
			if (!attempt.stopTimer.signal.aborted) abort(attempt);
		} catch (reason) {
			if (!attempt.stopTimer.signal.aborted || !requestedAbort(reason)) abort(attempt);
		} finally {
			done.resolve();
		}
	})();
}
async function network(attempt: Attempt): Promise<void> {
	admitted(attempt);
	const token = attempt.token ?? unavailable();
	attempt.form = formToken(token);
	token.fill(0);
	attempt.token = undefined;
	startTimer(attempt);
	admitted(attempt);
	const pin = await resolveEgress("slack.com", 443, policy, attempt.abort.signal);
	admitted(attempt);
	const connection = createPinnedHttpsConnection("slack.com", 443, pin, policy);
	attempt.connection = connection;
	const received = Promise.withResolvers<void>();
	void received.promise.catch(() => undefined);
	const fail = (): void => {
		if (attempt.stopped) return;
		abort(attempt);
		received.reject(new NativeSlackConnectProbeError());
	};
	const aborted = addAbortListener(attempt.abort.signal, fail);
	try {
		admitted(attempt);
		attempt.constructorUncertain = true;
		const request = httpsRequest({
			...connection.options,
			method: "POST",
			path: "/api/auth.test",
			signal: attempt.abort.signal,
			headers: {
				...connection.options.headers,
				Accept: "application/json",
				"Accept-Encoding": "identity",
				"Content-Type": "application/x-www-form-urlencoded",
				"Content-Length": attempt.form?.length ?? unavailable(),
				Connection: "close",
			},
		});
		hold(attempt, request);
		attempt.constructorUncertain = false;
		request.once("socket", (socket) => {
			try {
				hold(attempt, socket);
			} catch {
				fail();
			}
		});
		request.once("error", fail);
		request.once("close", () => {
			if (!attempt.body) fail();
		});
		request.once("response", (response) => {
			try {
				hold(attempt, response);
				admitted(attempt);
				if (response.statusCode !== 200) unavailable();
				attempt.headers = headers(response);
				let size = 0;
				response.on("data", (chunk: unknown) => {
					try {
						if (attempt.stopped || attempt.failed) return;
						admitted(attempt);
						if (!Buffer.isBuffer(chunk)) unavailable();
						size += chunk.length;
						if (size > NATIVE_SLACK_CONNECT_PROBE_BODY_BYTES) unavailable();
						attempt.chunks.push(Buffer.from(chunk));
					} catch {
						fail();
					}
				});
				response.once("error", fail);
				response.once("close", () => {
					if (!attempt.body) fail();
				});
				response.once("end", () => {
					try {
						admitted(attempt);
						if (!response.complete) unavailable();
						const body = Buffer.concat(attempt.chunks, size);
						attempt.body = body;
						const parsed = parseStrict(body);
						if (
							!parsed ||
							typeof parsed !== "object" ||
							Array.isArray(parsed) ||
							Object.getOwnPropertyDescriptor(parsed, "ok")?.value !== true
						)
							unavailable();
						const raw = attempt.headers ?? unavailable();
						for (let i = 0; i < raw.length; i += 2)
							if (raw[i]?.toLowerCase() === "content-length" && Number(raw[i + 1]) !== size)
								unavailable();
						received.resolve();
					} catch {
						fail();
					}
				});
			} catch {
				fail();
			}
		});
		connection.guard(
			request,
			() => {
				try {
					admitted(attempt);
					return false;
				} catch {
					return true;
				}
			},
			() => {
				try {
					admitted(attempt);
					const write = Promise.withResolvers<void>();
					attempt.write = write;
					attempt.writeUncertain = true;
					request.end(attempt.form ?? unavailable(), () => {
						attempt.writeObserved = true;
						write.resolve();
					});
					attempt.writeUncertain = false;
				} catch {
					fail();
				}
			},
			fail,
		);
		await received.promise;
		admitted(attempt);
	} finally {
		aborted[Symbol.dispose]();
	}
}

function cleanup(attempt: Attempt): Promise<void> {
	if (attempt.cleanup) return attempt.cleanup;
	const pending = Promise.withResolvers<void>();
	attempt.cleanup = pending.promise;
	void (async () => {
		attempt.stopped = true;
		let uncertain = attempt.constructorUncertain;
		try {
			originalAbort.call(attempt.abort);
		} catch {
			uncertain = true;
		}
		try {
			originalAbort.call(attempt.stopTimer);
		} catch {
			uncertain = true;
		}
		const failed = new Set<Held>();
		for (const held of attempt.handles) {
			if (held.closed) continue;
			try {
				held.destroy();
			} catch {
				failed.add(held);
			}
		}
		try {
			attempt.connection?.destroy();
		} catch {
			uncertain = true;
		}
		await Promise.all(
			[...attempt.handles].filter((held) => !failed.has(held)).map((held) => held.close.promise),
		);
		await attempt.timer;
		if (attempt.write && (!attempt.writeUncertain || attempt.writeObserved))
			await attempt.write.promise;
		if (attempt.writeUncertain && !attempt.writeObserved) uncertain = true;
		try {
			attempt.listener?.[Symbol.dispose]();
			attempt.listener = undefined;
		} catch {
			uncertain = true;
		}
		for (const chunk of attempt.chunks) chunk.fill(0);
		attempt.chunks.length = 0;
		attempt.token?.fill(0);
		attempt.token = undefined;
		if (!attempt.write || attempt.writeObserved) attempt.form?.fill(0);
		if (uncertain || [...attempt.handles].some((held) => !held.closed)) unavailable();
		attempt.form?.fill(0);
		attempt.form = undefined;
		attempt.connection = undefined;
		attempt.cleaned = true;
	})().then(pending.resolve, () => {
		attempt.cleanup = undefined;
		pending.reject(new NativeSlackConnectProbeError());
	});
	return pending.promise;
}

/** One fixed transport belongs to the genuine original Session and its captured clock. */
export function createNativeSlackConnectProbe(
	session: unknown,
	clock: TimerClock,
): NativeSlackConnectProbe {
	try {
		if (
			arguments.length !== 2 ||
			!session ||
			typeof session !== "object" ||
			types.isProxy(session) ||
			!clock ||
			typeof clock !== "object" ||
			types.isProxy(clock)
		)
			unavailable();
		const previous = sessions.get(session);
		if (previous) {
			owner(previous);
			if (previous.clock !== clock) unavailable();
			return previous.token;
		}
		const parts = nativePluginInputs(session);
		assertNativePluginOwner(session, parts);
		if (parts.clock !== clock) unavailable();
		const wall = dataMember(clock, "wallMs", "config"),
			mono = dataMember(clock, "monotonicMs", "config");
		const after = dataMember(clock, "after", "config");
		if (
			!isPlainFunction(wall) ||
			!isPlainFunction(mono) ||
			!isPlainFunction(after) ||
			types.isAsyncFunction(wall) ||
			types.isAsyncFunction(mono)
		)
			unavailable();
		const store = parts.store,
			devices = parts.devices,
			audit = parts.audit;
		original.assertDevices.call(devices, store);
		const authorizer = new Authorizer(devices);
		const token = Object.freeze(Object.create(null)) as NativeSlackConnectProbe;
		const state: State = {
			session,
			parts,
			store,
			devices,
			audit,
			authorizer,
			clock,
			token,
			wall: () => wall.call(clock),
			mono: () => mono.call(clock),
			after: (ms, signal) => after.call(clock, ms, signal),
			requests: new WeakMap(),
			attempts: new Set(),
			pending: new Set(),
			results: new Set(),
			closing: false,
			closed: false,
		};
		states.set(token, state);
		sessions.set(session, state);
		owner(state);
		return token;
	} catch {
		return unavailable();
	}
}
export function probeNativeSlackConnect(
	probe: unknown,
	peer: NativeDevicePeer,
	ownedToken: unknown,
	originalSignal: AbortSignal,
): Promise<NativeSlackConnectProbeResult> {
	const state = stateOf(probe);
	if (
		arguments.length !== 4 ||
		state.closing ||
		state.closed ||
		state.attempts.size >= HOST_MAX_ACTIVE_REQUESTS
	)
		return Promise.reject(new NativeSlackConnectProbeError());
	const pending = Promise.withResolvers<NativeSlackConnectProbeResult>();
	state.pending.add(pending.promise);
	const attempt: Attempt = {
		state,
		peer,
		cleaned: false,
		signal: originalSignal,
		abort: new AbortController(),
		stopTimer: new AbortController(),
		handles: new Set(),
		chunks: [],
		writeObserved: false,
		writeUncertain: false,
		constructorUncertain: false,
		failed: false,
		stopped: false,
	};
	state.attempts.add(attempt);
	const work = (async (): Promise<NativeSlackConnectProbeResult> => {
		try {
			owner(state);
			captureSignal(originalSignal);
			if (state.requests.has(originalSignal)) unavailable();
			state.requests.set(originalSignal, attempt);
			admitted(attempt);
			attempt.token = captureToken(ownedToken);
			attempt.listener = addAbortListener(originalSignal, () => abort(attempt));
			await network(attempt);
			await cleanup(attempt);
			admitted(attempt, true);
			const body = attempt.body ?? unavailable(),
				rawHeaders = attempt.headers ?? unavailable();
			const result = Object.freeze(Object.create(null)) as NativeSlackConnectProbeResult;
			results.set(result, { owner: state, attempt, headers: rawHeaders, body });
			state.results.add(result);
			attempt.body = undefined;
			return result;
		} catch {
			abort(attempt);
			try {
				await cleanup(attempt);
			} catch {
				/* Retain actual resources for explicit close retry. */
			}
			attempt.body?.fill(0);
			attempt.body = undefined;
			releaseRequest(attempt);
			throw new NativeSlackConnectProbeError();
		}
	})();
	void work.then(
		(result) => {
			state.pending.delete(pending.promise);
			pending.resolve(result);
		},
		() => {
			state.pending.delete(pending.promise);
			pending.reject(new NativeSlackConnectProbeError());
		},
	);
	return pending.promise;
}
/** One-use response DATA transfer; its native receiver must erase rawBody in finally. */
export function takeNativeSlackConnectProbeResult(
	probe: unknown,
	value: unknown,
): NativeSlackConnectProbeData {
	const state = stateOf(probe);
	owner(state);
	if (arguments.length !== 2 || !value || typeof value !== "object" || types.isProxy(value))
		unavailable();
	const result = results.get(value);
	if (!result || result.owner !== state) unavailable();
	admitted(result.attempt, true);
	results.delete(value);
	state.results.delete(value);
	releaseRequest(result.attempt);
	return Object.freeze({ rawBody: result.body, rawHeaders: result.headers });
}
/** Denial-only response cleanup; does not require a live Session or peer. */
export function discardNativeSlackConnectProbeResult(probe: unknown, value: unknown): void {
	const state = stateOf(probe);
	if (arguments.length !== 2 || !value || typeof value !== "object" || types.isProxy(value))
		unavailable();
	const held = results.get(value);
	if (!held) return;
	if (held.owner !== state) unavailable();
	held.body.fill(0);
	releaseRequest(held.attempt);
	results.delete(value);
	state.results.delete(value);
}

export function beginCloseNativeSlackConnectProbe(probe: unknown): void {
	const state = stateOf(probe);
	if (arguments.length !== 1) unavailable();
	state.closing = true;
	let failed = false;
	for (const value of state.results) {
		try {
			const result = results.get(value);
			result?.body.fill(0);
			if (result) releaseRequest(result.attempt);
			results.delete(value);
			state.results.delete(value);
		} catch {
			failed = true;
		}
	}
	for (const attempt of state.attempts) abort(attempt);
	if (failed) unavailable();
}
export function closeNativeSlackConnectProbe(probe: unknown): Promise<void> {
	const state = stateOf(probe);
	if (arguments.length !== 1) return Promise.reject(new NativeSlackConnectProbeError());
	if (state.close) return state.close;
	if (state.closed) return Promise.resolve();
	const pending = Promise.withResolvers<void>();
	state.close = pending.promise;
	let fenceFailed = false;
	try {
		beginCloseNativeSlackConnectProbe(probe);
	} catch {
		fenceFailed = true;
	}
	void (async () => {
		await Promise.allSettled([...state.pending]);
		const closed = await Promise.allSettled([...state.attempts].map(cleanup));
		for (const attempt of state.attempts) releaseRequest(attempt);
		if (
			fenceFailed ||
			closed.some((value) => value.status === "rejected") ||
			state.attempts.size ||
			state.results.size
		)
			unavailable();
		state.closed = true;
	})().then(pending.resolve, () => {
		state.close = undefined;
		pending.reject(new NativeSlackConnectProbeError());
	});
	return pending.promise;
}

/** Original Session cleanup only: private lookup performs no live key, Store or OPEN check. */
export function closeNativeSlackConnectProbeForSession(session: unknown): Promise<void> {
	if (arguments.length !== 1 || !session || typeof session !== "object" || types.isProxy(session))
		return Promise.reject(new NativeSlackConnectProbeError());
	const state = sessions.get(session);
	return state ? closeNativeSlackConnectProbe(state.token) : Promise.resolve();
}
