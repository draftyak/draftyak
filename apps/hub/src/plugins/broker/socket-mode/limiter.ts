import { isProxy } from "node:util/types";
import {
	HOST_MAX_FRAME_BYTES,
	HOST_MAX_WS_DATA_LENGTH,
	type HostNotification,
} from "@draftyak/protocol/host-channel";
import { canonicalize, parseStrict } from "@draftyak/protocol/jcs";
import type { Clock } from "../../../kernel/clock.ts";
import { newId } from "../../../kernel/ids.ts";
import { refuseSocketMode } from "./refusal.ts";
import {
	type SocketModeEndpoint,
	type SocketModeOpenResponse,
	socketModeEndpoint,
	socketModeOpenUrl,
} from "./url.ts";

/** A bound URL opens one socket, and only within this time. */
export const SOCKET_MODE_URL_TTL_MS = 30_000;
export const SOCKET_MODE_MAX_PENDING_URLS = 4;
export const SOCKET_MODE_MAX_SOCKETS = 4;
/** An envelope can be acknowledged once, and only within this time of its arrival. */
export const SOCKET_MODE_ACK_WINDOW_MS = 3_000;
export const SOCKET_MODE_MAX_PENDING_ENVELOPES = 256;
/** Acknowledged envelope IDs remembered per socket, oldest forgotten first. */
export const SOCKET_MODE_ACKNOWLEDGED_MEMORY = 1024;
export const SOCKET_MODE_ENVELOPE_ID: RegExp = /^[\w-]{1,128}$/;

export interface SocketModeTarget extends SocketModeEndpoint {
	readonly socketId: string;
}

/**
 * What the native transport does with one inbound text message: forward it to the plugin, close
 * the socket with the given WebSocket status (the socket is already retired), or drop it.
 */
export type SocketModeDelivery =
	| {
			readonly kind: "deliver";
			readonly notification: HostNotification;
			readonly acknowledgeable: boolean;
	  }
	| { readonly kind: "close"; readonly code: 1003 | 1007 | 1009 }
	| { readonly kind: "drop" };

/**
 * Socket Mode authority for one plugin instance and account. The native broker creates one per
 * binding and never shares it. Only `open`, `acknowledge` and `close` take plugin params; every
 * other input is native. It opens no socket and sends nothing itself.
 */
export interface SocketModeLimiter {
	/** Binds the URL in the broker-observed response to the matched `apps.connections.open`. */
	bind(response: SocketModeOpenResponse): void;
	/** host/ws.open: consumes a bound URL and returns where to connect. */
	open(params: unknown): SocketModeTarget;
	/** The status of the native WebSocket handshake; anything but 101 retires the socket. */
	upgraded(socketId: string, status: number): void;
	/** One inbound message from the native transport. */
	receive(socketId: string, data: unknown): SocketModeDelivery;
	/** host/ws.send: the exact acknowledgement frame the native transport sends. */
	acknowledge(params: unknown): string;
	/** host/ws.close. */
	close(params: unknown): void;
	/** The native transport closed or lost the socket. */
	closed(socketId: string): void;
	/** Instance stop: every binding and socket loses its authority for good. */
	retire(): void;
}

interface SocketState {
	open: boolean;
	/** Envelope ID to arrival time. */
	readonly pending: Map<string, number>;
	readonly acknowledged: Set<string>;
}

const DROP: SocketModeDelivery = Object.freeze({ kind: "drop" });
const closeWith = (code: 1003 | 1007 | 1009): SocketModeDelivery =>
	Object.freeze({ kind: "close", code });

function exactStrings(value: unknown, names: readonly string[]): readonly string[] {
	if (value === null || typeof value !== "object" || isProxy(value))
		refuseSocketMode("PARAMS_INVALID");
	const proto: unknown = Object.getPrototypeOf(value);
	if (
		(proto !== Object.prototype && proto !== null) ||
		Reflect.ownKeys(value).length !== names.length
	)
		refuseSocketMode("PARAMS_INVALID");
	return names.map((name) => {
		const field = Object.getOwnPropertyDescriptor(value, name);
		if (!field?.enumerable || !Object.hasOwn(field, "value") || typeof field.value !== "string")
			refuseSocketMode("PARAMS_INVALID");
		return field.value as string;
	});
}

function envelopeOf(data: string): string | undefined {
	let frame: unknown;
	try {
		frame = parseStrict(data);
	} catch {
		return undefined;
	}
	if (frame === null || typeof frame !== "object" || Array.isArray(frame)) return undefined;
	const field = Object.getOwnPropertyDescriptor(frame, "envelope_id");
	const id: unknown = field?.value;
	return typeof id === "string" && SOCKET_MODE_ENVELOPE_ID.test(id) ? id : undefined;
}

/** Elapsed time that is negative or past the window counts as expired. */
const within = (since: number, now: number, windowMs: number): boolean =>
	now - since >= 0 && now - since <= windowMs;

export function createSocketModeLimiter(clock: Pick<Clock, "monotonicMs">): SocketModeLimiter {
	const read: unknown =
		clock !== null && typeof clock === "object" && !isProxy(clock) ? clock.monotonicMs : undefined;
	if (typeof read !== "function") refuseSocketMode("CLOCK_INVALID");
	const urls = new Map<string, number>();
	const sockets = new Map<string, SocketState>();
	let retired = false;

	const now = (): number => {
		let time: unknown;
		try {
			time = Reflect.apply(read, clock, []);
		} catch {
			refuseSocketMode("CLOCK_INVALID");
		}
		if (typeof time !== "number" || !Number.isFinite(time)) refuseSocketMode("CLOCK_INVALID");
		return time;
	};
	const active = (): void => {
		if (retired) refuseSocketMode("RETIRED");
	};
	const pruneUrls = (time: number): void => {
		for (const [url, since] of urls)
			if (!within(since, time, SOCKET_MODE_URL_TTL_MS)) urls.delete(url);
	};
	const prunePending = (socket: SocketState, time: number): void => {
		for (const [id, since] of socket.pending)
			if (!within(since, time, SOCKET_MODE_ACK_WINDOW_MS)) socket.pending.delete(id);
	};

	return Object.freeze({
		bind(response: SocketModeOpenResponse): void {
			active();
			const url = socketModeOpenUrl(response);
			const time = now();
			pruneUrls(time);
			if (urls.has(url)) refuseSocketMode("URL_DUPLICATE");
			if (urls.size >= SOCKET_MODE_MAX_PENDING_URLS) refuseSocketMode("URL_LIMIT");
			urls.set(url, time);
		},
		open(params: unknown): SocketModeTarget {
			const [url] = exactStrings(params, ["url"]) as [string];
			active();
			const time = now();
			pruneUrls(time);
			if (sockets.size >= SOCKET_MODE_MAX_SOCKETS) refuseSocketMode("SOCKET_LIMIT");
			if (!urls.delete(url)) refuseSocketMode("URL_UNBOUND");
			const endpoint = socketModeEndpoint(url);
			const socketId = newId();
			sockets.set(socketId, { open: false, pending: new Map(), acknowledged: new Set() });
			return Object.freeze({ socketId, ...endpoint });
		},
		upgraded(socketId: string, status: number): void {
			active();
			const socket = sockets.get(socketId);
			if (socket === undefined || socket.open) refuseSocketMode("SOCKET_UNKNOWN");
			if (status !== 101) {
				sockets.delete(socketId);
				refuseSocketMode("UPGRADE_REFUSED");
			}
			socket.open = true;
		},
		receive(socketId: string, data: unknown): SocketModeDelivery {
			if (retired) return DROP;
			const socket = sockets.get(socketId);
			if (socket === undefined || !socket.open) return DROP;
			if (typeof data !== "string") {
				sockets.delete(socketId);
				return closeWith(1003);
			}
			if (!data.isWellFormed()) {
				sockets.delete(socketId);
				return closeWith(1007);
			}
			const notification: HostNotification = Object.freeze({
				jsonrpc: "2.0",
				method: "host/ws.message",
				params: Object.freeze({ socketId, data }),
			});
			// The hub never splits a message: one that cannot fit one host frame closes the socket.
			// Each UTF-16 unit takes at least one byte, so a longer text than the contract's data
			// length cannot fit and is refused without serializing it.
			if (
				data.length > HOST_MAX_WS_DATA_LENGTH ||
				Buffer.byteLength(canonicalize(notification)) > HOST_MAX_FRAME_BYTES
			) {
				sockets.delete(socketId);
				return closeWith(1009);
			}
			const time = now();
			prunePending(socket, time);
			const id = envelopeOf(data);
			let acknowledgeable = false;
			if (id !== undefined && !socket.acknowledged.has(id)) {
				// A repeat keeps its first arrival time; a full pending set takes no new envelope.
				if (socket.pending.has(id)) acknowledgeable = true;
				else if (socket.pending.size < SOCKET_MODE_MAX_PENDING_ENVELOPES) {
					socket.pending.set(id, time);
					acknowledgeable = true;
				}
			}
			return Object.freeze({ kind: "deliver", notification, acknowledgeable });
		},
		acknowledge(params: unknown): string {
			const [socketId, envelopeId] = exactStrings(params, ["socketId", "envelopeId"]) as [
				string,
				string,
			];
			active();
			const socket = sockets.get(socketId);
			if (socket === undefined || !socket.open) refuseSocketMode("SOCKET_UNKNOWN");
			prunePending(socket, now());
			if (socket.acknowledged.has(envelopeId)) refuseSocketMode("ENVELOPE_REPEATED");
			if (!socket.pending.delete(envelopeId)) refuseSocketMode("ENVELOPE_UNKNOWN");
			socket.acknowledged.add(envelopeId);
			if (socket.acknowledged.size > SOCKET_MODE_ACKNOWLEDGED_MEMORY)
				socket.acknowledged.delete(socket.acknowledged.values().next().value as string);
			// Acknowledgement only: the plugin supplies no payload, and the hub writes these exact bytes.
			return JSON.stringify({ envelope_id: envelopeId });
		},
		close(params: unknown): void {
			const [socketId] = exactStrings(params, ["socketId"]) as [string];
			active();
			if (!sockets.delete(socketId)) refuseSocketMode("SOCKET_UNKNOWN");
		},
		closed(socketId: string): void {
			sockets.delete(socketId);
		},
		retire(): void {
			retired = true;
			urls.clear();
			sockets.clear();
		},
	});
}
