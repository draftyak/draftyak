import type { IncomingMessage } from "node:http";
import { TLSSocket } from "node:tls";
import { checkFrameLength, EventFrame } from "@draftyak/protocol/device-api";
import { canonicalize } from "@draftyak/protocol/jcs";
import WebSocket, { type RawData, WebSocketServer } from "ws";
import type { NativeDevicePeer } from "../../authz/native-peer.ts";
import { assertHubSessionAdmission, type HubSession } from "../../lifecycle/session.ts";
import {
	createNativeEventPageReader,
	type NativeEventPage,
	NativeEventPageError,
} from "../events.ts";

export interface NativeEventWebSocket {
	upgrade(peer: NativeDevicePeer, request: IncomingMessage, socket: TLSSocket, head: Buffer): void;
	close(): Promise<void>;
}

type Timer = ReturnType<typeof setTimeout>;
type RefusalStatus = 400 | 403 | 503;
interface Connection {
	readonly peer: NativeDevicePeer;
	readonly socket: TLSSocket;
	readonly webSocket: WebSocket;
	readonly ended: Promise<void>;
	readonly finish: () => void;
	cursor: string | null;
	started: boolean;
	stopping: boolean;
	closed: boolean;
	initialTimer?: Timer;
	pollTimer?: Timer;
	forceTimer?: Timer;
}

const PROTOCOL = "draftyak.events.v1";
const EVENTS_PATH = "/device/v1/events";
const REQUEST_BYTES = 1024;
const HEADER_BYTES = 8192;
const HEADER_FIELDS = 64;
const OUTPUT_BYTES = 131072;
const OUTPUT_HEADROOM = 16;
const INITIAL_TIMEOUT_MS = 10000;
const POLL_MS = 1000;
const CLOSE_GRACE_MS = 1000;
const CLOSE_JOIN_MS = 2000;
const INITIAL_REQUEST = Buffer.from(canonicalize({ after: null }), "utf8");

function unavailable(): Error {
	return new Error("Event WebSocket is unavailable");
}

function requestHeaders(request: IncomingMessage): Map<string, string> | undefined {
	const raw = request.rawHeaders;
	if (raw.length % 2 !== 0 || raw.length > HEADER_FIELDS * 2) return undefined;
	let bytes = 0;
	const headers = new Map<string, string>();
	for (let index = 0; index < raw.length; index += 2) {
		const name = raw[index],
			value = raw[index + 1];
		if (typeof name !== "string" || typeof value !== "string") return undefined;
		bytes += Buffer.byteLength(name, "utf8") + Buffer.byteLength(value, "utf8") + 4;
		const key = name.toLowerCase();
		if (bytes > HEADER_BYTES || headers.has(key)) return undefined;
		headers.set(key, value);
	}
	return headers;
}

function upgradeRefusal(
	request: IncomingMessage,
	socket: TLSSocket,
	head: Buffer,
): RefusalStatus | undefined {
	if (!(socket instanceof TLSSocket) || request.socket !== socket) return 403;
	if (
		request.method !== "GET" ||
		request.url !== EVENTS_PATH ||
		request.httpVersion !== "1.1" ||
		!Buffer.isBuffer(head) ||
		head.byteLength !== 0
	)
		return 400;
	const headers = requestHeaders(request);
	if (!headers) return 400;
	for (const name of headers.keys()) {
		if (
			name === "origin" ||
			name === "forwarded" ||
			name === "via" ||
			name === "x-real-ip" ||
			name.startsWith("x-forwarded-") ||
			name.startsWith("proxy-")
		)
			return 403;
		if (["content-length", "transfer-encoding", "expect", "trailer", "te"].includes(name))
			return 400;
	}
	const port = socket.localPort;
	if (!Number.isSafeInteger(port) || port === undefined || port <= 0 || port > 65535) return 503;
	if (headers.get("host") !== `127.0.0.1:${port}`) return 403;
	const connection = headers
		.get("connection")
		?.toLowerCase()
		.split(",")
		.map((value) => value.trim());
	const key = headers.get("sec-websocket-key");
	if (
		headers.get("upgrade")?.toLowerCase() !== "websocket" ||
		!connection?.includes("upgrade") ||
		connection.includes("close") ||
		headers.get("sec-websocket-version") !== "13" ||
		headers.get("sec-websocket-protocol") !== PROTOCOL ||
		typeof key !== "string" ||
		!/^[A-Za-z0-9+/]{22}==$/.test(key) ||
		Buffer.from(key, "base64").toString("base64") !== key
	)
		return 400;
	return undefined;
}

function rejectUpgrade(socket: TLSSocket, status: RefusalStatus): void {
	const reason =
		status === 400 ? "Bad Request" : status === 403 ? "Forbidden" : "Service Unavailable";
	try {
		socket.end(
			`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
			() => socket.destroy(),
		);
	} catch {
		socket.destroy();
	}
}

function applicationCloseCode(error: unknown): number {
	return error instanceof NativeEventPageError &&
		(error.code === "INVALID_REQUEST" || error.code === "FORBIDDEN")
		? 1008
		: 1011;
}

function encodedFrame(value: EventFrame): {
	readonly type: EventFrame["type"];
	readonly bytes: Buffer;
} {
	const parsed = EventFrame.parse(value);
	const bytes = Buffer.from(canonicalize(parsed), "utf8");
	if (!checkFrameLength(bytes.byteLength)) throw unavailable();
	return { type: parsed.type, bytes };
}

/** Native peer authorization remains inside the original session's current page reader. */
export function createNativeEventWebSocket(session: HubSession): NativeEventWebSocket {
	assertHubSessionAdmission(session);
	const reader = createNativeEventPageReader(session);
	let server: WebSocketServer;
	try {
		server = new WebSocketServer({
			noServer: true,
			maxPayload: REQUEST_BYTES,
			perMessageDeflate: false,
			autoPong: false,
			handleProtocols: (protocols) =>
				protocols.size === 1 && protocols.has(PROTOCOL) ? PROTOCOL : false,
		});
	} catch {
		reader.close();
		throw unavailable();
	}
	const connections = new Set<Connection>();
	let closing = false;
	let failed = false;
	let readerClosed = false;
	let serverClosed = false;
	let closeAttempt: Promise<void> | undefined;
	const closeReader = (): void => {
		if (readerClosed) return;
		reader.close();
		readerClosed = true;
	};
	const clearActivity = (connection: Connection): void => {
		clearTimeout(connection.initialTimer);
		clearTimeout(connection.pollTimer);
		connection.initialTimer = undefined;
		connection.pollTimer = undefined;
	};
	const terminate = (connection: Connection): void => {
		if (connection.closed) return;
		try {
			connection.webSocket.terminate();
		} catch {
			// Retain the original connection; close() must still observe its actual close event.
		}
	};
	const stop = (connection: Connection, code: number): void => {
		if (connection.closed || connection.stopping) return;
		connection.stopping = true;
		clearActivity(connection);
		try {
			if (connection.webSocket.readyState === WebSocket.OPEN) connection.webSocket.close(code);
		} catch {
			terminate(connection);
		}
		connection.forceTimer = setTimeout(() => {
			connection.forceTimer = undefined;
			terminate(connection);
		}, CLOSE_GRACE_MS);
	};
	const fail = (): void => {
		failed = true;
		try {
			closeReader();
		} catch {
			/* The owned cleanup is retried by close(). */
		}
		for (const connection of connections) stop(connection, 1011);
	};
	const admit = (): void => {
		if (closing || failed) throw unavailable();
		try {
			assertHubSessionAdmission(session);
		} catch {
			fail();
			throw unavailable();
		}
	};
	const active = (connection: Connection): boolean =>
		!closing &&
		!failed &&
		!connection.stopping &&
		!connection.closed &&
		connection.webSocket.readyState === WebSocket.OPEN &&
		!connection.socket.destroyed &&
		!connection.socket.readableEnded &&
		!connection.socket.writableEnded;
	const withinOutputBudget = (connection: Connection, length: number): boolean => {
		if (!active(connection)) return false;
		const queued = Math.max(connection.webSocket.bufferedAmount, connection.socket.writableLength);
		if (!Number.isSafeInteger(queued) || queued < 0) throw unavailable();
		// Retain room for the library's frame envelope and an empty-reason close control frame.
		if (queued + length + OUTPUT_HEADROOM > OUTPUT_BYTES) {
			stop(connection, 1013);
			return false;
		}
		return true;
	};
	const send = (connection: Connection, bytes: Buffer): boolean => {
		if (!withinOutputBudget(connection, bytes.byteLength)) return false;
		connection.webSocket.send(bytes, { binary: false, compress: false }, (error) => {
			if (error) stop(connection, 1011);
		});
		return true;
	};
	const deliver = (connection: Connection, page: NativeEventPage, initial: boolean): void => {
		let ready = false;
		for (let index = 0; index < page.frames.length; index++) {
			const value = page.frames[index];
			if (value === undefined) throw unavailable();
			const frame = encodedFrame(value);
			if (frame.type === "reset") {
				if (index !== 0 || page.frames.length !== 1) throw unavailable();
				if (send(connection, frame.bytes)) stop(connection, 1000);
				return;
			}
			if (frame.type === "ready") {
				if (index !== 0) throw unavailable();
				ready = true;
				if (!initial) continue;
			} else if (!ready) throw unavailable();
			if (!send(connection, frame.bytes)) return;
		}
		if (!ready || typeof page.nextCursor !== "string") throw unavailable();
		connection.cursor = page.nextCursor;
	};
	const poll = (connection: Connection): void => {
		connection.pollTimer = undefined;
		if (!active(connection)) {
			stop(connection, 1001);
			return;
		}
		try {
			admit();
			const request = Buffer.from(canonicalize({ after: connection.cursor }), "utf8");
			// One bounded page per tick, including when more=true or every scanned row was hidden.
			deliver(connection, reader.read(connection.peer, request), false);
			if (active(connection)) connection.pollTimer = setTimeout(() => poll(connection), POLL_MS);
		} catch (error) {
			stop(connection, applicationCloseCode(error));
		}
	};
	const attach = (peer: NativeDevicePeer, socket: TLSSocket, webSocket: WebSocket): void => {
		let finish = (): void => {};
		const ended = new Promise<void>((resolve) => {
			finish = resolve;
		});
		const connection: Connection = {
			peer,
			socket,
			webSocket,
			ended,
			finish,
			cursor: null,
			started: false,
			stopping: false,
			closed: false,
		};
		connections.add(connection);
		const socketEnded = (): void => {
			stop(connection, 1001);
		};
		socket.once("close", socketEnded);
		socket.once("end", socketEnded);
		webSocket.once("close", () => {
			connection.closed = true;
			connection.stopping = true;
			clearActivity(connection);
			clearTimeout(connection.forceTimer);
			connection.forceTimer = undefined;
			socket.off("close", socketEnded);
			socket.off("end", socketEnded);
			connections.delete(connection);
			connection.finish();
		});
		webSocket.on("error", () => {
			// Preserve the library's protocol/UTF-8/maxPayload close when already closing.
			stop(connection, 1011);
		});
		webSocket.on("ping", (bytes: Buffer) => {
			if (!active(connection)) return;
			try {
				admit();
				if (!Buffer.isBuffer(bytes) || bytes.byteLength > 125) throw unavailable();
				if (!withinOutputBudget(connection, bytes.byteLength)) return;
				webSocket.pong(bytes, false, (error) => {
					if (error) stop(connection, 1011);
				});
			} catch (error) {
				stop(connection, applicationCloseCode(error));
			}
		});
		webSocket.on("pong", () => {
			if (!active(connection)) return;
			try {
				admit();
			} catch {
				stop(connection, 1011);
			}
		});
		webSocket.on("message", (raw: RawData, binary: boolean) => {
			if (!active(connection)) return;
			if (connection.started || binary || !Buffer.isBuffer(raw) || raw.byteLength > REQUEST_BYTES) {
				stop(connection, 1008);
				return;
			}
			connection.started = true;
			clearTimeout(connection.initialTimer);
			connection.initialTimer = undefined;
			try {
				admit();
				// The reader validates the received bytes before any canonicalization or cursor use.
				deliver(connection, reader.read(peer, raw), true);
				if (active(connection)) connection.pollTimer = setTimeout(() => poll(connection), POLL_MS);
			} catch (error) {
				stop(connection, applicationCloseCode(error));
			}
		});
		connection.initialTimer = setTimeout(() => stop(connection, 1008), INITIAL_TIMEOUT_MS);
		if (closing || failed) stop(connection, 1001);
	};
	server.once("close", () => {
		serverClosed = true;
	});
	server.on("error", fail);
	const join = async (connection: Connection): Promise<void> => {
		let timer: Timer | undefined;
		try {
			await Promise.race([
				connection.ended,
				new Promise<never>((_resolve, reject) => {
					timer = setTimeout(() => reject(unavailable()), CLOSE_JOIN_MS);
				}),
			]);
		} finally {
			clearTimeout(timer);
		}
	};
	const closeServer = async (): Promise<void> => {
		if (serverClosed) return;
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => reject(unavailable()), CLOSE_JOIN_MS);
			try {
				server.close((error) => {
					clearTimeout(timer);
					if (error) reject(unavailable());
					else {
						serverClosed = true;
						resolve();
					}
				});
			} catch {
				clearTimeout(timer);
				reject(unavailable());
			}
		});
	};
	return Object.freeze({
		upgrade(
			peer: NativeDevicePeer,
			request: IncomingMessage,
			socket: TLSSocket,
			head: Buffer,
		): void {
			if (closing || failed) {
				rejectUpgrade(socket, 503);
				return;
			}
			const status = upgradeRefusal(request, socket, head);
			if (status !== undefined) {
				rejectUpgrade(socket, status);
				return;
			}
			try {
				admit();
				// Authorize the genuine peer before upgrading, without exposing this preflight cursor.
				reader.read(peer, INITIAL_REQUEST);
				admit();
				server.handleUpgrade(request, socket, head, (webSocket) => attach(peer, socket, webSocket));
			} catch (error) {
				rejectUpgrade(
					socket,
					error instanceof NativeEventPageError && error.code === "FORBIDDEN" ? 403 : 503,
				);
			}
		},
		close(): Promise<void> {
			if (closeAttempt) return closeAttempt;
			closing = true;
			const attempt = (async (): Promise<void> => {
				const pending = [...connections];
				for (const connection of pending) {
					if (!connection.stopping) stop(connection, 1001);
					else if (!connection.forceTimer) terminate(connection);
				}
				await Promise.all(pending.map(join));
				await closeServer();
				closeReader();
			})();
			closeAttempt = attempt;
			void attempt.catch(() => {
				if (closeAttempt === attempt) closeAttempt = undefined;
			});
			return attempt;
		},
	});
}
