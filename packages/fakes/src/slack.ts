import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { isProxy } from "node:util/types";
import { type RawData, WebSocket, WebSocketServer } from "ws";
import { createFaults, type Fault, type Faults, type ManualClock, manualClock } from "./faults.ts";
import {
	createRecorder,
	type RecordedRequest,
	type Recorder,
	type StreamingRecorder,
} from "./recorder.ts";
import { createFake, type Fake, type Listening, RESERVED_PORTS } from "./server.ts";
import { rawTarget, targetOf, withTarget } from "./target.ts";

export const SLACK_READ_HOST = "slack.draftyak.example";
export const MAX_SLACK_CONVERSATIONS = 300;
export const MAX_SLACK_MESSAGES = 1024;
export const MAX_SLACK_USERS = 1024;
export const MAX_SLACK_STATE_BYTES: number = 4 * 1024 * 1024;
export const MAX_SLACK_RESPONSE_BYTES: number = 256 * 1024;
export const MAX_SLACK_READ_RECORDS = 1024;
const CURSOR_MS = 60_000,
	MAX_CURSORS = 128;
const methods = [
	"users.conversations",
	"users.info",
	"conversations.info",
	"conversations.history",
	"conversations.replies",
] as const;
type Method = (typeof methods)[number];
const SCOPES = [
	"channels:read",
	"groups:read",
	"im:read",
	"mpim:read",
	"channels:history",
	"groups:history",
	"im:history",
	"mpim:history",
	"users:read",
] as const;
export type SlackReadScope = (typeof SCOPES)[number];
export interface SlackReadUser {
	readonly id: string;
	readonly name: string;
	readonly displayName: string;
	readonly realName: string;
}

export const MAX_SLACK_SOCKET_BODY_BYTES: number = 16 * 1024;
export const MAX_SLACK_SOCKET_EVENT_BYTES: number = 16 * 1024;
export const MAX_SLACK_SOCKET_ACK_BYTES = 1024;
export const MAX_SLACK_SOCKET_CONNECTIONS = 8;
export const MAX_SLACK_SOCKET_TICKETS = 32;
export const MAX_SLACK_SOCKET_PENDING = 64;
export const MAX_SLACK_SOCKET_RECORDS = 256;
const SOCKET_TICKET_MS = 60_000,
	SOCKET_LIFETIME_MS = 60_000,
	SOCKET_TIMERS = 128;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export interface SlackSocketConnection {
	readonly id: number;
	readonly closedCode: number | null;
}
export interface SlackSocketEnvelope {
	readonly envelopeId: string;
	readonly connection: number;
	readonly type: string;
	readonly retryAttempt: number;
	readonly payload: Readonly<Record<string, unknown>>;
	readonly acknowledged: boolean;
	readonly redelivered: boolean;
}
export interface SlackSocketAck {
	readonly connection: number;
	readonly envelopeId?: string;
	readonly accepted: boolean;
	readonly dropped: boolean;
}
export interface SlackSocketFake extends Fake {
	readonly appToken: string;
	readonly userToken: string;
	readonly clock: ManualClock;
	readonly apiBase: string;
	readonly connections: readonly SlackSocketConnection[];
	readonly envelopes: readonly SlackSocketEnvelope[];
	readonly acks: readonly SlackSocketAck[];
	sendHello: boolean;
	dropAcks: number;
	start(): Promise<void>;
	close(): Promise<void>;
	live(): SlackSocketConnection[];
	frame(connection: SlackSocketConnection, value: Record<string, unknown>): void;
	deliver(
		payload: Record<string, unknown>,
		options?: {
			readonly connection?: SlackSocketConnection;
			readonly type?: string;
			readonly acceptsResponsePayload?: boolean;
		},
	): SlackSocketEnvelope;
	acksFor(envelopeId: string): SlackSocketAck[];
	disconnect(connection: SlackSocketConnection, reason: string, closeAfterMs?: number | null): void;
	terminate(connection: SlackSocketConnection): void;
	/** Fixture-local token state; app revocation also retires its socket resources. */
	revoke(token: "user" | "app"): void;
	stats(): { tickets: number; connections: number; pending: number; timers: number; http: number };
}
function socketRefused(): never {
	throw new Error("Slack socket fixture refused");
}
function socketInteger(value: unknown, min: number, max: number): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max)
		socketRefused();
	return value;
}
// Copy inert JSON data without invoking accessors, iterators or toJSON.
function socketJSON(input: unknown): Readonly<Record<string, unknown>> {
	let nodes = 0,
		bytes = 0;
	const copy = (value: unknown, depth: number): unknown => {
		if (++nodes > 1024 || depth > 8) socketRefused();
		if (value === null || typeof value === "boolean") return value;
		if (typeof value === "number") {
			if (!Number.isFinite(value)) socketRefused();
			return value;
		}
		if (typeof value === "string") {
			bytes += Buffer.byteLength(value);
			if (bytes > MAX_SLACK_SOCKET_EVENT_BYTES) socketRefused();
			return value;
		}
		if (!value || typeof value !== "object" || isProxy(value)) socketRefused();
		if (Array.isArray(value))
			return Object.freeze(list(value, 64).map((entry) => copy(entry, depth + 1)));
		if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) socketRefused();
		const keys = Reflect.ownKeys(value);
		if (keys.length > 64) socketRefused();
		const result: Record<string, unknown> = Object.create(null);
		for (const key of keys) {
			if (typeof key !== "string") socketRefused();
			bytes += Buffer.byteLength(key);
			if (bytes > MAX_SLACK_SOCKET_EVENT_BYTES) socketRefused();
			const d = Object.getOwnPropertyDescriptor(value, key);
			if (!d?.enumerable || !("value" in d)) socketRefused();
			result[key] = copy(d.value, depth + 1);
		}
		return Object.freeze(result);
	};
	if (!input || typeof input !== "object" || Array.isArray(input)) socketRefused();
	const result = copy(input, 0) as Readonly<Record<string, unknown>>;
	if (Buffer.byteLength(JSON.stringify(result)) > MAX_SLACK_SOCKET_EVENT_BYTES) socketRefused();
	return result;
}
function socketRecorder(): StreamingRecorder {
	const inner = createRecorder({ maxBodyBytes: 0 });
	let reserved = 0;
	const begin: StreamingRecorder["begin"] = (request) => {
		if (reserved >= MAX_SLACK_SOCKET_RECORDS) socketRefused();
		const target = rawTarget(request),
			names = [...request.headers.keys()];
		if (
			target.length > 2048 ||
			names.length > 64 ||
			names.reduce((n, name) => n + name.length + (request.headers.get(name)?.length ?? 0), 0) >
				8192
		)
			socketRefused();
		const path = target.split("?")[0];
		const safe =
			path === "/api/auth.test" || path === "/api/apps.connections.open" ? path : "/refused";
		const knownHeaders = [
			"authorization",
			"content-type",
			"content-length",
			"host",
			"connection",
			"transfer-encoding",
			"accept",
			"user-agent",
			"accept-encoding",
		];
		const knownMethods = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];
		const redacted = new Request(`https://${SLACK_READ_HOST}${safe}`, {
			method: knownMethods.includes(request.method) ? request.method : "OTHER",
			headers: names.filter((name) => knownHeaders.includes(name)).map((name) => [name, ""]),
		});
		const slot = inner.begin(redacted);
		reserved++;
		let settled = false;
		return {
			write: (bytes) => slot.write(bytes),
			finish(reason) {
				slot.finish(reason);
				settled = true;
			},
			discard() {
				if (settled) socketRefused();
				slot.discard();
				settled = true;
				reserved--;
			},
		};
	};
	return {
		begin,
		async record(request) {
			// Body-bearing admission must use the shared capped begin/write path.
			if (request.body) {
				void request.body.cancel().catch(() => {});
				socketRefused();
			}
			begin(request).finish();
		},
		takeRequests() {
			const rows = inner.takeRequests();
			reserved -= rows.length;
			return rows;
		},
	};
}
function socketAwait<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const aborted = () => {
			signal.removeEventListener("abort", aborted);
			reject(signal.reason);
		};
		signal.addEventListener("abort", aborted, { once: true });
		void work.then(
			(value) => {
				signal.removeEventListener("abort", aborted);
				resolve(value);
			},
			(error) => {
				signal.removeEventListener("abort", aborted);
				reject(error);
			},
		);
		if (signal.aborted) aborted();
	});
}
/** A bounded synthetic auth/Socket Mode companion; it grants no native authority. */
export function createSlackSocketFake(
	options: { readonly ackTimeoutMs?: number; readonly nowMs?: number } = {},
): SlackSocketFake {
	const config = object(options, ["ackTimeoutMs", "nowMs"]);
	const ackTimeout = socketInteger(config.ackTimeoutMs ?? 3000, 1, 60_000);
	const clock = manualClock(
		socketInteger(config.nowMs ?? 1_760_000_000_000, 0, 253_402_300_799_000),
	);
	const appToken = `DYTEST-SLACK-APP-${randomUUID()}`,
		userToken = `DYTEST-SLACK-USER-${randomUUID()}`;
	const recorder = socketRecorder(),
		sharedFaults = createFaults({ clock });
	const faultRuns = new Set<Promise<Response>>();
	const faults: Faults = {
		clock,
		add(...input: Fault[]) {
			active();
			if (input.length + sharedFaults.pending().length > 32) socketRefused();
			// Shared fault behavior, with finite fixture-local work instead of Infinity.
			for (const value of input) {
				const f = object(value, [
					"kind",
					"method",
					"path",
					"times",
					"after",
					"retryAfter",
					"status",
					"ms",
				]);
				socketInteger(f.times ?? 1, 1, 1024);
				if (f.kind === "latency") socketInteger(f.ms, 0, 1000);
			}
			sharedFaults.add(...input);
		},
		pending: () => sharedFaults.pending(),
		clear: () => sharedFaults.clear(),
		run(request, app) {
			active();
			if (faultRuns.size >= 16) socketRefused();
			const target = rawTarget(request);
			if (target.length > 2048 || request.method.length > 64) socketRefused();
			const signal = AbortSignal.any([request.signal, closingSignal.signal]);
			signal.throwIfAborted();
			// Fault selection needs method/path/signal only; intake may already hold the body reader.
			const metadata = withTarget(
				new Request(`https://${SLACK_READ_HOST}/`, { method: request.method, signal }),
				target,
			);
			const work = socketAwait(
				sharedFaults.run(metadata, () => app(request)),
				signal,
			);
			faultRuns.add(work);
			void work.finally(() => faultRuns.delete(work)).catch(() => {});
			return work;
		},
	};
	let closed = false,
		userRevoked = false,
		appRevoked = false,
		hello = true,
		drops = 0,
		nextConnection = 0,
		httpInFlight = 0;
	const closingSignal = new AbortController();
	const timers = new Set<ReturnType<typeof setTimeout>>();
	const tickets = new Map<string, number>();
	const tcp = new Set<Socket>();
	const httpWork = new Set<Promise<Response>>();
	let fetchOwned: Fake["fetch"];
	type Connection = {
		public: SlackSocketConnection;
		socket: WebSocket;
		closedCode: number | null;
		messages: number;
		frames: number;
		lifetime?: ReturnType<typeof setTimeout>;
		delays: Set<ReturnType<typeof setTimeout>>;
	};
	type Envelope = {
		public: SlackSocketEnvelope;
		envelopeId: string;
		connection: number;
		type: string;
		retryAttempt: number;
		payload: Readonly<Record<string, unknown>>;
		acknowledged: boolean;
		redelivered: boolean;
	};
	type Pending = { current: Envelope; timer?: ReturnType<typeof setTimeout> };
	const connections = new Map<SlackSocketConnection, Connection>(),
		connectionHistory: SlackSocketConnection[] = [];
	const envelopes: Envelope[] = [],
		acks: SlackSocketAck[] = [],
		pending = new Set<Pending>();
	const wss = new WebSocketServer({
		noServer: true,
		maxPayload: MAX_SLACK_SOCKET_ACK_BYTES,
		perMessageDeflate: false,
	});
	let wsServer: ReturnType<typeof createServer> | undefined,
		wsOrigin = "";
	let wsStarting: Promise<void> | undefined, startPromise: Promise<void> | undefined;
	let baseListener: Listening | undefined, closePromise: Promise<void> | undefined;
	const active = () => {
		if (closed) socketRefused();
	};
	const cancel = (timer?: ReturnType<typeof setTimeout>) => {
		if (timer) {
			clearTimeout(timer);
			timers.delete(timer);
		}
	};
	const later = (task: () => void, ms: number) => {
		active();
		if (timers.size >= SOCKET_TIMERS) socketRefused();
		const timer = setTimeout(() => {
			timers.delete(timer);
			if (!closed) task();
		}, ms);
		timers.add(timer);
		return timer;
	};
	const remember = <T>(rows: T[], value: T) => {
		rows.push(value);
		if (rows.length > MAX_SLACK_SOCKET_RECORDS) rows.shift();
	};
	const live = () =>
		[...connections.values()].filter((c) => !appRevoked && c.socket.readyState === WebSocket.OPEN);
	const connection = (handle: SlackSocketConnection) => {
		active();
		const value = connections.get(handle);
		if (appRevoked || !value || value.socket.readyState !== WebSocket.OPEN) socketRefused();
		return value;
	};
	const send = (c: Connection, value: Readonly<Record<string, unknown>>) => {
		const text = JSON.stringify(value),
			bytes = Buffer.byteLength(text);
		if (
			bytes > MAX_SLACK_SOCKET_EVENT_BYTES ||
			c.frames >= MAX_SLACK_SOCKET_RECORDS ||
			c.socket.bufferedAmount + bytes > 4 * MAX_SLACK_SOCKET_EVENT_BYTES
		)
			socketRefused();
		c.frames++;
		c.socket.send(text, (error) => {
			if (error) c.socket.terminate();
		});
	};
	const expireTickets = () => {
		for (const [ticket, until] of tickets) if (until <= clock.now()) tickets.delete(ticket);
	};
	const settle = (work: Pending) => {
		cancel(work.timer);
		pending.delete(work);
	};
	const emit = (
		work: Pending,
		c: Connection,
		payload: Readonly<Record<string, unknown>>,
		type: string,
		attempt: number,
		accepts: boolean,
	): Envelope => {
		const record = {
			envelopeId: randomUUID(),
			connection: c.public.id,
			type,
			retryAttempt: attempt,
			payload,
			acknowledged: false,
			redelivered: false,
		} as Envelope;
		record.public = Object.freeze({
			envelopeId: record.envelopeId,
			connection: record.connection,
			type,
			retryAttempt: attempt,
			payload,
			get acknowledged() {
				return record.acknowledged;
			},
			get redelivered() {
				return record.redelivered;
			},
		});
		send(c, {
			envelope_id: record.envelopeId,
			payload,
			type,
			accepts_response_payload: accepts,
			retry_attempt: attempt,
			retry_reason: attempt === 0 ? "" : "timeout",
		});
		work.current = record;
		remember(envelopes, record);
		work.timer = later(() => {
			if (record.acknowledged || record.retryAttempt >= 3) {
				settle(work);
				return;
			}
			const next = live().at(-1);
			// S6 waits indefinitely without a live socket; this bounded companion stops.
			if (!next) {
				settle(work);
				return;
			}
			record.redelivered = true;
			try {
				emit(work, next, payload, type, attempt + 1, false);
			} catch {
				settle(work);
				next.socket.terminate();
			}
		}, ackTimeout);
		return record;
	};
	const received = (c: Connection): boolean => {
		if (++c.messages > MAX_SLACK_SOCKET_RECORDS) {
			c.socket.close(1008);
			return false;
		}
		return true;
	};
	const receive = (c: Connection, data: RawData, binary: boolean) => {
		if (appRevoked) return;
		if (!received(c)) return;
		if (binary) {
			c.socket.close(1003);
			return;
		}
		const bytes = Buffer.isBuffer(data)
			? data
			: Array.isArray(data)
				? Buffer.concat(data)
				: Buffer.from(data);
		if (bytes.length > MAX_SLACK_SOCKET_ACK_BYTES) {
			c.socket.close(1009);
			return;
		}
		let id: string;
		try {
			const value = object(JSON.parse(bytes.toString("utf8")), ["envelope_id"]);
			if (typeof value.envelope_id !== "string" || !UUID.test(value.envelope_id)) socketRefused();
			id = value.envelope_id;
		} catch {
			c.socket.close(1008);
			return;
		}
		const envelope =
			[...pending].find((work) => work.current.envelopeId === id)?.current ??
			envelopes.find((e) => e.envelopeId === id);
		const accepted = envelope !== undefined && envelope.connection === c.public.id;
		const dropped = accepted && drops > 0;
		if (dropped) drops--;
		remember(
			acks,
			Object.freeze({
				connection: c.public.id,
				...(envelope ? { envelopeId: id } : {}),
				accepted,
				dropped,
			}),
		);
		if (!accepted || dropped) return;
		envelope.acknowledged = true;
		for (const work of pending) if (work.current === envelope) settle(work);
	};
	const ensureWS = (): Promise<void> => {
		active();
		wsStarting ??= (async () => {
			for (let attempt = 0; attempt < 10; attempt++) {
				const server = createServer(
					{ maxHeaderSize: 4096, highWaterMark: MAX_SLACK_SOCKET_BODY_BYTES + 1 },
					(request, response) => {
						const abort = new AbortController();
						response.once("close", () => {
							if (!response.writableEnded) abort.abort(new Error("Slack fixture client closed"));
						});
						void (async () => {
							const target = request.url ?? "/";
							if (target.length > 2048 || request.headers.host !== wsOrigin.slice(5)) {
								response.writeHead(421, { Connection: "close" });
								response.end();
								return;
							}
							const method = request.method ?? "GET";
							if (
								(method === "GET" || method === "HEAD") &&
								(request.headers["content-length"] !== undefined ||
									request.headers["transfer-encoding"] !== undefined)
							) {
								response.writeHead(400, { Connection: "close" });
								response.end();
								return;
							}
							const headers = new Headers();
							for (let at = 0; at < request.rawHeaders.length; at += 2)
								headers.append(request.rawHeaders[at] ?? "", request.rawHeaders[at + 1] ?? "");
							let detach = () => {};
							const body =
								method === "GET" || method === "HEAD"
									? undefined
									: new ReadableStream<Uint8Array>({
											start(controller) {
												const data = (chunk: Buffer) => {
													request.pause();
													controller.enqueue(new Uint8Array(chunk));
												};
												const end = () => {
													detach();
													controller.close();
												};
												const failed = () => {
													detach();
													controller.error(new Error("Slack fixture upload failed"));
												};
												detach = () => {
													request.pause();
													request.off("data", data);
													request.off("end", end);
													request.off("error", failed);
													request.off("aborted", failed);
												};
												request.on("data", data);
												request.once("end", end);
												request.once("error", failed);
												request.once("aborted", failed);
												request.pause();
											},
											pull() {
												request.resume();
											},
											// Stop reading while the small refusal response closes this connection.
											cancel() {
												detach();
											},
										});
							const input = withTarget(
								new Request(`https://${SLACK_READ_HOST}${target}`, {
									method,
									headers,
									body,
									signal: abort.signal,
									duplex: "half",
								} as RequestInit),
								target,
							);
							const answer = await fetchOwned(input);
							response.writeHead(answer.status, {
								...Object.fromEntries(answer.headers),
								Connection: "close",
							});
							response.end(Buffer.from(await answer.arrayBuffer()), () => request.destroy());
						})().catch(() => {
							if (!response.headersSent) response.writeHead(503, { Connection: "close" });
							response.end();
						});
					},
				);
				server.maxConnections = MAX_SLACK_SOCKET_CONNECTIONS;
				server.maxRequestsPerSocket = 1;
				server.headersTimeout = 1000;
				server.requestTimeout = 1000;
				server.on("connection", (socket) => {
					if (closed || tcp.size >= MAX_SLACK_SOCKET_CONNECTIONS) {
						socket.destroy();
						return;
					}
					tcp.add(socket);
					socket.setTimeout(SOCKET_LIFETIME_MS, () => socket.destroy());
					socket.once("close", () => tcp.delete(socket));
				});
				server.on("upgrade", (request, socket, head) => {
					const target = request.url ?? "";
					const ticket = target.startsWith("/link/") ? target.slice(6) : "";
					expireTickets();
					if (
						closed ||
						appRevoked ||
						request.method !== "GET" ||
						!UUID.test(ticket) ||
						request.headers.host !== wsOrigin.slice(5) ||
						request.headers.origin !== undefined ||
						connections.size >= MAX_SLACK_SOCKET_CONNECTIONS ||
						!tickets.delete(ticket)
					) {
						socket.destroy();
						return;
					}
					try {
						wss.handleUpgrade(request, socket, head, (ws) => {
							if (closed || appRevoked) {
								ws.terminate();
								return;
							}
							const c = {
								socket: ws,
								closedCode: null,
								messages: 0,
								frames: 0,
								delays: new Set(),
							} as Connection;
							c.public = Object.freeze({
								id: ++nextConnection,
								get closedCode() {
									return c.closedCode;
								},
							});
							connections.set(c.public, c);
							remember(connectionHistory, c.public);
							ws.on("error", () => {});
							ws.on("message", (data, binary) => receive(c, data, binary));
							ws.on("ping", () => {
								received(c);
							});
							ws.on("pong", () => {
								received(c);
							});
							ws.once("close", (code) => {
								c.closedCode = code;
								cancel(c.lifetime);
								for (const timer of c.delays) cancel(timer);
								c.delays.clear();
								connections.delete(c.public);
							});
							c.lifetime = later(() => ws.terminate(), SOCKET_LIFETIME_MS);
							if (hello)
								send(c, {
									type: "hello",
									num_connections: live().length,
									debug_info: {
										host: "dytest-fixture",
										build_number: 1,
										approximate_connection_time: 0,
									},
									connection_info: { app_id: "ADYTEST01" },
								});
						});
					} catch {
						socket.destroy();
					}
				});
				await new Promise<void>((resolve, reject) => {
					server.once("error", reject);
					server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => {
						server.off("error", reject);
						resolve();
					});
				});
				const port = (server.address() as AddressInfo).port;
				if (closed || RESERVED_PORTS.has(port)) {
					for (const socket of tcp) socket.destroy();
					await new Promise<void>((resolve) => server.close(() => resolve()));
					if (closed) socketRefused();
					continue;
				}
				wsServer = server;
				wsOrigin = `ws://127.0.0.1:${port}`;
				return;
			}
			socketRefused();
		})();
		return wsStarting;
	};
	const fake = createFake(
		{
			async fetch(request) {
				if (closed) return Response.json({ ok: false, error: "fixture_closed" }, { status: 503 });
				const target = rawTarget(request);
				const match = /^\/api\/(auth\.test|apps\.connections\.open)$/.exec(
					target.split("?")[0] ?? "",
				);
				if (!match) return Response.json({ ok: false, error: "unknown_method" }, { status: 404 });
				if (request.method !== "POST")
					return Response.json({ ok: false, error: "method_not_allowed" }, { status: 405 });
				const authorization = request.headers.get("authorization") ?? "";
				if (!authorization.startsWith("Bearer "))
					return Response.json({ ok: false, error: "not_authed" });
				const token = authorization.slice(7),
					app = match[1] === "apps.connections.open";
				if (token === (app ? userToken : appToken))
					return Response.json({ ok: false, error: "not_allowed_token_type" });
				if (token !== (app ? appToken : userToken))
					return Response.json({ ok: false, error: "invalid_auth" });
				const revoked = () => (app ? appRevoked : userRevoked);
				if (revoked()) return Response.json({ ok: false, error: "token_revoked" });
				if (target.includes("?") || (await request.text()) !== "")
					return Response.json({ ok: false, error: "invalid_arg_name" });
				if (revoked()) return Response.json({ ok: false, error: "token_revoked" });
				if (!app)
					return Response.json({
						ok: true,
						user_id: "UDYTEST01",
						team_id: "TDYTEST01",
						user: "dytest-owner",
						team: "DYTEST workspace",
					});
				await ensureWS();
				if (revoked()) return Response.json({ ok: false, error: "token_revoked" });
				expireTickets();
				active();
				if (tickets.size >= MAX_SLACK_SOCKET_TICKETS)
					return Response.json({ ok: false, error: "fixture_capacity" }, { status: 503 });
				const ticket = randomUUID();
				tickets.set(ticket, clock.now() + SOCKET_TICKET_MS);
				return Response.json({ ok: true, url: `${wsOrigin}/link/${ticket}` });
			},
		},
		{ host: SLACK_READ_HOST, recorder, faults, maxRequestBodyBytes: MAX_SLACK_SOCKET_BODY_BYTES },
	);
	fetchOwned = (input, init) => {
		active();
		const url =
			typeof input === "string" && input.startsWith("/") ? `https://${fake.host}${input}` : input;
		const original = url instanceof Request && init === undefined ? url : new Request(url, init);
		if (httpInFlight >= 16) {
			if (original.body) void original.body.cancel().catch(() => {});
			socketRefused();
		}
		const timeout = new AbortController();
		const timer = later(() => timeout.abort(new Error("Slack fixture upload timeout")), 1000);
		httpInFlight++;
		const work = (async () => {
			let forwarded: Request | undefined;
			try {
				forwarded = withTarget(
					new Request(original, {
						redirect: "error",
						signal: AbortSignal.any([original.signal, closingSignal.signal, timeout.signal]),
					}),
					typeof url === "string" ? targetOf(url) : rawTarget(original),
				);
				return await fake.fetch(forwarded);
			} catch (error) {
				if (forwarded?.body && !forwarded.body.locked) void forwarded.body.cancel().catch(() => {});
				throw error;
			} finally {
				cancel(timer);
				httpInFlight--;
			}
		})();
		httpWork.add(work);
		void work.finally(() => httpWork.delete(work)).catch(() => {});
		return work;
	};
	const listen = async (): Promise<Listening> => {
		await ensureWS();
		active();
		const address = wsServer?.address();
		if (!address || typeof address === "string") socketRefused();
		if (!baseListener)
			baseListener = {
				port: address.port,
				origin: wsOrigin.replace("ws:", "http:"),
				close: () => companion.close(),
			};
		return baseListener;
	};
	const companion: SlackSocketFake = {
		host: fake.host,
		recorder,
		faults,
		clock,
		appToken,
		userToken,
		get apiBase() {
			if (!baseListener) socketRefused();
			return `${baseListener.origin}/api/`;
		},
		get connections() {
			return Object.freeze([...connectionHistory]);
		},
		get envelopes() {
			return Object.freeze(envelopes.map((e) => e.public));
		},
		get acks() {
			return Object.freeze([...acks]);
		},
		get sendHello() {
			return hello;
		},
		set sendHello(value) {
			if (typeof value !== "boolean") socketRefused();
			hello = value;
		},
		get dropAcks() {
			return drops;
		},
		set dropAcks(value) {
			drops = socketInteger(value, 0, MAX_SLACK_SOCKET_RECORDS);
		},
		fetch: fetchOwned,
		listen,
		async start() {
			active();
			startPromise ??= (async () => {
				baseListener = await listen();
			})();
			await startPromise;
		},
		close() {
			closePromise ??= (async () => {
				closed = true;
				closingSignal.abort(new Error("Slack fixture closed"));
				for (const timer of timers) clearTimeout(timer);
				timers.clear();
				tickets.clear();
				pending.clear();
				faults.clear();
				for (const c of connections.values()) c.socket.terminate();
				for (const socket of tcp) socket.destroy();
				await Promise.allSettled([wsStarting, startPromise]);
				await Promise.allSettled([...httpWork, ...faultRuns]);
				if (wsServer)
					await new Promise<void>((resolve) => {
						wsServer?.close(() => resolve());
						wsServer?.closeAllConnections();
					});
				await new Promise<void>((resolve) => wss.close(() => resolve()));
				connections.clear();
				tcp.clear();
				connectionHistory.length = 0;
				envelopes.length = 0;
				acks.length = 0;
				recorder.takeRequests();
			})();
			return closePromise;
		},
		live: () => live().map((c) => c.public),
		frame(handle, value) {
			const c = connection(handle);
			send(c, socketJSON(value));
		},
		deliver(payload, raw = {}) {
			active();
			const options = object(raw, ["connection", "type", "acceptsResponsePayload"]);
			const c =
				options.connection === undefined
					? live().at(-1)
					: connection(options.connection as SlackSocketConnection);
			if (!c || pending.size >= MAX_SLACK_SOCKET_PENDING || timers.size >= SOCKET_TIMERS)
				socketRefused();
			const type = options.type ?? "events_api";
			if (
				typeof type !== "string" ||
				!/^[a-z_]{1,64}$/.test(type) ||
				(options.acceptsResponsePayload !== undefined &&
					typeof options.acceptsResponsePayload !== "boolean")
			)
				socketRefused();
			const copied = socketJSON(payload),
				work = {} as Pending;
			const result = emit(work, c, copied, type, 0, options.acceptsResponsePayload === true);
			pending.add(work);
			return result.public;
		},
		acksFor: (id) => acks.filter((ack) => ack.envelopeId === id),
		disconnect(handle, reason, closeAfterMs = null) {
			const c = connection(handle);
			if (typeof reason !== "string" || Buffer.byteLength(reason) > 256) socketRefused();
			if (closeAfterMs !== null) {
				socketInteger(closeAfterMs, 0, 60_000);
				if (timers.size >= SOCKET_TIMERS) socketRefused();
			}
			send(c, { type: "disconnect", reason, debug_info: { host: "dytest-fixture" } });
			if (closeAfterMs !== null) {
				const timer = later(() => {
					c.delays.delete(timer);
					c.socket.close(1000);
				}, closeAfterMs);
				c.delays.add(timer);
			}
		},
		terminate(handle) {
			connection(handle).socket.terminate();
		},
		revoke(token) {
			active();
			if (token !== "user" && token !== "app") socketRefused();
			if (token === "user") {
				userRevoked = true;
				return;
			}
			appRevoked = true;
			tickets.clear();
			for (const work of pending) settle(work);
			for (const c of connections.values()) {
				cancel(c.lifetime);
				for (const timer of c.delays) cancel(timer);
				c.delays.clear();
				c.socket.terminate();
			}
			connections.clear();
		},
		stats() {
			expireTickets();
			return {
				tickets: tickets.size,
				connections: connections.size,
				pending: pending.size,
				timers: timers.size,
				http: httpInFlight,
			};
		},
	};
	return companion;
}
export interface SlackReadConversation {
	readonly id: string;
	readonly name: string;
	readonly kind: "public_channel" | "private_channel" | "im" | "mpim";
	readonly member: boolean;
	readonly archived: boolean;
	readonly sharing: "none" | "internal" | "external";
	readonly memberCount: number;
}
export interface SlackReadMessage {
	readonly ts: string;
	readonly user: string;
	readonly text: string;
	readonly threadTs?: string;
}
export interface SlackReadFake extends Fake {
	readonly clock: ManualClock;
	readonly ownerId: string;
	conversation(id: string): SlackReadConversation;
	changeConversation(id: string, patch: Partial<Omit<SlackReadConversation, "id" | "kind">>): void;
	addMessage(channel: string, message: SlackReadMessage): void;
	/** Simulates revocation of this instance's credential; it calls no provider. */
	revoke(): void;
}
function refuse(): never {
	throw new Error("Slack read fixture refused");
}
function object(raw: unknown, keys: readonly string[]): Record<string, unknown> {
	if (
		!raw ||
		typeof raw !== "object" ||
		isProxy(raw) ||
		![Object.prototype, null].includes(Object.getPrototypeOf(raw))
	)
		refuse();
	const names = Reflect.ownKeys(raw);
	if (names.length > keys.length) refuse();
	const result: Record<string, unknown> = Object.create(null);
	for (const name of names) {
		if (typeof name !== "string" || !keys.includes(name)) refuse();
		const descriptor = Object.getOwnPropertyDescriptor(raw, name);
		if (!descriptor?.enumerable || !("value" in descriptor)) refuse();
		result[name] = descriptor.value;
	}
	return result;
}
function list(raw: unknown, maximum: number): unknown[] {
	if (isProxy(raw) || !Array.isArray(raw) || Object.getPrototypeOf(raw) !== Array.prototype)
		refuse();
	const length = Object.getOwnPropertyDescriptor(raw, "length")?.value;
	if (
		!Number.isSafeInteger(length) ||
		length > maximum ||
		Reflect.ownKeys(raw).length !== length + 1
	)
		refuse();
	const values: unknown[] = [];
	for (let at = 0; at < length; at++) {
		const value = Object.getOwnPropertyDescriptor(raw, String(at));
		if (!value?.enumerable || !("value" in value)) refuse();
		values.push(value.value);
	}
	return values;
}
function text(raw: unknown, bytes: number): string {
	if (
		typeof raw !== "string" ||
		raw.length > bytes ||
		!raw.isWellFormed() ||
		Buffer.byteLength(raw) > bytes
	)
		refuse();
	return raw;
}
function identifier(raw: unknown): string {
	const id = text(raw, 32);
	if (!/^[CDG][A-Z0-9]{2,31}$/.test(id)) refuse();
	return id;
}
function controls(value: string, multiline = false): boolean {
	for (let at = 0; at < value.length; at++) {
		const code = value.charCodeAt(at);
		if ((code < 32 && !(multiline && (code === 9 || code === 10))) || code === 127) return true;
	}
	return false;
}
function userId(raw: unknown): string {
	const id = text(raw, 21);
	if (!/^[UW][A-Z0-9]{2,20}$/.test(id)) refuse();
	return id;
}
function user(raw: unknown): SlackReadUser {
	const data = object(raw, ["id", "name", "displayName", "realName"]);
	const id = userId(data.id),
		name = text(data.name, 64),
		displayName = text(data.displayName, 256),
		realName = text(data.realName, 256);
	if (!name || controls(name) || controls(displayName) || controls(realName)) refuse();
	return Object.freeze({ id, name, displayName, realName });
}
const conversationKeys = ["id", "name", "kind", "member", "archived", "sharing", "memberCount"];
function conversation(raw: unknown): SlackReadConversation {
	const data = object(raw, conversationKeys),
		id = identifier(data.id),
		name = text(data.name, 256);
	if (
		!name ||
		controls(name) ||
		!["public_channel", "private_channel", "im", "mpim"].includes(data.kind as string) ||
		typeof data.member !== "boolean" ||
		typeof data.archived !== "boolean" ||
		!["none", "internal", "external"].includes(data.sharing as string) ||
		!Number.isSafeInteger(data.memberCount) ||
		(data.memberCount as number) < 0 ||
		(data.memberCount as number) > 1_000_000_000
	)
		refuse();
	return Object.freeze({
		id,
		name,
		kind: data.kind as SlackReadConversation["kind"],
		member: data.member,
		archived: data.archived,
		sharing: data.sharing as SlackReadConversation["sharing"],
		memberCount: data.memberCount as number,
	});
}
function stamp(raw: unknown): string {
	const value = text(raw, 22);
	if (!/^(?:0|[1-9][0-9]{0,11})\.[0-9]{1,9}$/.test(value)) refuse();
	return value;
}
const ticks = (value: string): bigint => {
	const [s, f] = value.split(".");
	return BigInt(s as string) * 1_000_000_000n + BigInt((f as string).padEnd(9, "0"));
};
function message(raw: unknown): SlackReadMessage {
	const data = object(raw, ["ts", "user", "text", "threadTs"]),
		ts = stamp(data.ts),
		user = text(data.user, 32),
		body = text(data.text, 4096);
	if (
		!/^U[A-Z0-9]{2,31}$/.test(user) ||
		!body ||
		body.normalize("NFC") !== body ||
		controls(body, true)
	)
		refuse();
	return Object.freeze({
		ts,
		user,
		text: body,
		...(data.threadTs === undefined ? {} : { threadTs: stamp(data.threadTs) }),
	});
}
function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
	const wire = JSON.stringify(body);
	if (Buffer.byteLength(wire) > MAX_SLACK_RESPONSE_BYTES)
		return json({ ok: false, error: "fixture_response_limit" }, 413);
	return new Response(wire, {
		status,
		headers: { "content-type": "application/json", connection: "close", ...extra },
	});
}
const failure = (error: string, status = 400): Response => json({ ok: false, error }, status);
function bodyless(request: Request): boolean {
	return (
		request.body === null &&
		!request.headers.has("transfer-encoding") &&
		[null, "0"].includes(request.headers.get("content-length"))
	);
}
/** Unlike the generic recorder, this never reads an unsupported body to compute a hash. */
function readRecorder(): Recorder {
	const entries: RecordedRequest[] = [];
	let bytes = 0;
	return {
		async record(request): Promise<void> {
			if (request.method !== "GET" || !bodyless(request)) {
				if (request.body) void request.body.cancel().catch(() => {});
				return;
			}
			const target = rawTarget(request),
				headers = [...request.headers];
			const size =
				Buffer.byteLength(target) +
				headers.reduce((n, [k, v]) => n + Buffer.byteLength(k) + Buffer.byteLength(v), 0);
			if (
				target.length > 2048 ||
				headers.length > 64 ||
				size > 8192 ||
				entries.length >= MAX_SLACK_READ_RECORDS ||
				bytes + size > MAX_SLACK_STATE_BYTES
			)
				refuse();
			const queryAt = target.indexOf("?");
			entries.push(
				Object.freeze({
					method: "GET",
					host: new URL(request.url).host,
					target,
					path: queryAt < 0 ? target : target.slice(0, queryAt),
					query: queryAt < 0 ? "" : target.slice(queryAt + 1),
					headerNames: Object.freeze(headers.map(([name]) => name).sort()),
					headers: Object.freeze({}),
					body: new Uint8Array(),
					bodyLength: 0,
					bodySha256: createHash("sha256").digest("hex"),
				}),
			);
			bytes += size;
		},
		takeRequests(): RecordedRequest[] {
			bytes = 0;
			return entries.splice(0);
		},
	};
}
interface Cursor {
	readonly key: string;
	readonly rows: readonly unknown[];
	readonly index: number;
	readonly at: number;
	readonly next: Map<number, string>;
	readonly bytes: number;
}
/** Synthetic read-only upstream state; no authentication, send or native authority implementation. */
export function createSlackReadFake(raw: {
	readonly conversations: readonly SlackReadConversation[];
	/** Synthetic identity bound to this instance, never selected by a list request. */
	readonly ownerId?: string;
	readonly users?: readonly SlackReadUser[];
	/** Defaults to all supported read scopes; users.info always requires users:read. */
	readonly scopes?: readonly SlackReadScope[];
	readonly nowMs?: number;
	/** Synthetic per-method fixed window; this is not a provider tier guarantee. */
	readonly readBudget?: { readonly calls: number; readonly windowMs: number };
}): SlackReadFake {
	try {
		const input = object(raw, [
			"conversations",
			"ownerId",
			"users",
			"scopes",
			"nowMs",
			"readBudget",
		]);
		const ownerId = userId(input.ownerId === undefined ? "UDYTEST01" : input.ownerId);
		const scopes = new Set<SlackReadScope>();
		for (const scope of list(
			input.scopes === undefined ? [...SCOPES] : input.scopes,
			SCOPES.length,
		)) {
			if (!SCOPES.includes(scope as SlackReadScope) || scopes.has(scope as SlackReadScope))
				refuse();
			scopes.add(scope as SlackReadScope);
		}
		const users = new Map<string, SlackReadUser>();
		const owner = {
			id: ownerId,
			name: "dytest-owner",
			displayName: "DYTEST owner",
			realName: "DYTEST owner",
		};
		for (const value of list(input.users === undefined ? [owner] : input.users, MAX_SLACK_USERS)) {
			const checked = user(value);
			if (users.has(checked.id)) refuse();
			users.set(checked.id, checked);
		}
		const now = input.nowMs === undefined ? 1_760_000_000_000 : input.nowMs;
		if (!Number.isSafeInteger(now) || (now as number) < 0 || (now as number) > 253_402_300_799_000)
			refuse();
		const time = manualClock(now as number);
		const checkedTime = (value: number): void => {
			if (!Number.isSafeInteger(value) || value < 0 || value > 253_402_300_799_000) refuse();
		};
		const clock: ManualClock = Object.freeze({
				now: () => time.now(),
				set: (value: number) => {
					checkedTime(value);
					time.set(value);
				},
				advance: (value: number) => {
					if (!Number.isSafeInteger(value)) refuse();
					const next = time.now() + value;
					checkedTime(next);
					time.set(next);
				},
			}),
			channels = new Map<string, SlackReadConversation>(),
			messages = new Map<string, readonly SlackReadMessage[]>();
		for (const value of list(input.conversations, MAX_SLACK_CONVERSATIONS)) {
			const checked = conversation(value);
			if (channels.has(checked.id)) refuse();
			channels.set(checked.id, checked);
			messages.set(checked.id, Object.freeze([]));
		}
		const budget =
			input.readBudget === undefined
				? { calls: 1000, windowMs: 60_000 }
				: object(input.readBudget, ["calls", "windowMs"]);
		if (
			!Number.isSafeInteger(budget.calls) ||
			(budget.calls as number) < 1 ||
			(budget.calls as number) > 10000 ||
			!Number.isSafeInteger(budget.windowMs) ||
			(budget.windowMs as number) < 1 ||
			(budget.windowMs as number) > 3_600_000
		)
			refuse();
		const cursors = new Map<string, Cursor>(),
			rates = new Map<Method, { start: number; count: number }>();
		let revoked = false;
		let last = now as number,
			count = 0,
			messageBytes = 0,
			cursorBytes = 0;
		const current = (): number => {
			const value = clock.now();
			if (!Number.isSafeInteger(value) || value < 0 || value > 253_402_300_799_000) refuse();
			if (value < last) {
				cursors.clear();
				cursorBytes = 0;
				rates.clear();
			}
			last = value;
			for (const [key, cursor] of cursors)
				if (value - cursor.at >= CURSOR_MS) {
					cursors.delete(key);
					cursorBytes -= cursor.bytes;
				}
			return value;
		};
		const channel = (id: string): SlackReadConversation => {
			const value = channels.get(identifier(id));
			if (!value) refuse();
			return value;
		};
		const scopeFor = (kind: SlackReadConversation["kind"], history = false): SlackReadScope => {
			const prefix =
				kind === "public_channel" ? "channels" : kind === "private_channel" ? "groups" : kind;
			return `${prefix}:${history ? "history" : "read"}` as SlackReadScope;
		};
		const facts = (c: SlackReadConversation, members = true): Record<string, unknown> => ({
			id: c.id,
			name: c.name,
			is_channel: c.kind === "public_channel" || c.kind === "private_channel",
			is_group: c.kind === "private_channel" || c.kind === "mpim",
			is_im: c.kind === "im",
			is_mpim: c.kind === "mpim",
			is_private: c.kind === "private_channel" || c.kind === "mpim",
			is_member: c.member,
			is_archived: c.archived,
			is_shared: c.sharing !== "none",
			is_ext_shared: c.sharing === "external",
			is_org_shared: c.sharing === "internal",
			is_pending_ext_shared: false,
			...(members ? { num_members: c.memberCount } : {}),
		});
		const wireMessage = (
			m: SlackReadMessage,
			all: readonly SlackReadMessage[],
		): Record<string, unknown> => ({
			type: "message",
			ts: m.ts,
			user: m.user,
			text: m.text,
			...(m.threadTs === undefined ? {} : { thread_ts: m.threadTs }),
			reply_count: all.filter((r) => r.threadTs === m.ts && r.ts !== m.ts).length,
		});
		const page = (
			key: string,
			q: Map<string, string>,
			rows: () => readonly unknown[],
			now: number,
		): { rows: readonly unknown[]; next: string; more: boolean } => {
			const rawLimit = q.get("limit") ?? "100";
			if (!/^[1-9][0-9]{0,2}$/.test(rawLimit)) refuse();
			const limit = Number(rawLimit);
			if (limit > 200) refuse();
			const token = q.get("cursor");
			let entry: Cursor;
			if (token !== undefined) {
				if (!/^[0-9a-f]{32}$/.test(token)) refuse();
				const found = cursors.get(token);
				if (!found || found.key !== key) throw new Error("invalid_cursor");
				entry = found;
			} else {
				const captured = Object.freeze([...rows()]);
				const bytes = Buffer.byteLength(JSON.stringify(captured));
				if (bytes > MAX_SLACK_STATE_BYTES) throw new Error("fixture_cursor_limit");
				entry = { key, rows: captured, index: 0, at: now, next: new Map(), bytes };
			}
			const end = Math.min(entry.rows.length, entry.index + limit),
				more = end < entry.rows.length;
			let next = "";
			if (more) {
				next = entry.next.get(end) ?? "";
				if (!next) {
					if (cursors.size >= MAX_CURSORS || cursorBytes + entry.bytes > MAX_SLACK_STATE_BYTES)
						throw new Error("fixture_cursor_limit");
					next = randomBytes(16).toString("hex");
					entry.next.set(end, next);
					cursors.set(next, { ...entry, index: end });
					cursorBytes += entry.bytes;
				}
			}
			return { rows: entry.rows.slice(entry.index, end), next, more };
		};
		const fake = createFake(
			{
				fetch(request) {
					try {
						if (request.method !== "GET") return failure("unknown_method", 405);
						if (!bodyless(request)) return failure("body_not_allowed");
						const target = rawTarget(request);
						if (
							target.length > 2048 ||
							!/^\/api\/(?:users\.(?:conversations|info)|conversations\.(?:info|history|replies))(?:\?[A-Za-z0-9_.%=&,-]*)?$/.test(
								target,
							)
						)
							return failure("invalid_arguments");
						const url = new URL(request.url),
							method = url.pathname.slice(5) as Method;
						if (!methods.includes(method)) return failure("unknown_method", 404);
						const allowed =
							method === "users.conversations"
								? ["cursor", "limit", "types", "exclude_archived"]
								: method === "users.info"
									? ["user"]
									: method === "conversations.info"
										? ["channel", "include_num_members"]
										: [
												"channel",
												"cursor",
												"limit",
												"oldest",
												"latest",
												"inclusive",
												...(method === "conversations.replies" ? ["ts"] : []),
											];
						const q = new Map<string, string>();
						for (const [k, v] of url.searchParams) {
							if (q.has(k) || !allowed.includes(k) || !v) refuse();
							q.set(k, v);
						}
						if (revoked) return failure("token_revoked", 200);
						const at = current(),
							prior = rates.get(method),
							rate =
								!prior || at - prior.start >= (budget.windowMs as number)
									? { start: at, count: 0 }
									: prior;
						rates.set(method, rate);
						if (rate.count >= (budget.calls as number))
							return json({ ok: false, error: "ratelimited" }, 429, {
								"retry-after": String(
									Math.ceil((rate.start + (budget.windowMs as number) - at) / 1000),
								),
							});
						rate.count++;
						if (method === "users.info") {
							const id = userId(q.get("user"));
							if (!scopes.has("users:read")) return failure("missing_scope", 200);
							const value = users.get(id);
							return value
								? json({
										ok: true,
										user: {
											id: value.id,
											name: value.name,
											is_bot: false,
											deleted: false,
											real_name: value.realName,
											profile: { display_name: value.displayName, real_name: value.realName },
										},
									})
								: failure("user_not_found", 200);
						}
						if (method === "conversations.info") {
							const c = channels.get(identifier(q.get("channel")));
							if (!c) return failure("channel_not_found", 200);
							if (!scopes.has(scopeFor(c.kind))) return failure("missing_scope", 200);
							if (
								q.has("include_num_members") &&
								!["true", "false"].includes(q.get("include_num_members") as string)
							)
								refuse();
							return json({ ok: true, channel: facts(c, q.get("include_num_members") === "true") });
						}
						const key = JSON.stringify([
							method,
							...[...q]
								.filter(([k]) => k !== "cursor")
								.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
						]);
						if (method === "users.conversations") {
							const types = (q.get("types") ?? "public_channel").split(",");
							if (
								new Set(types).size !== types.length ||
								types.some((t) => !["public_channel", "private_channel", "im", "mpim"].includes(t))
							)
								refuse();
							if (
								q.has("exclude_archived") &&
								!["true", "false"].includes(q.get("exclude_archived") as string)
							)
								refuse();
							const result = page(
								key,
								q,
								() =>
									[...channels.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
								at,
							);
							// Provider filters apply after the virtual page, so a non-final page may be empty.
							return json({
								ok: true,
								channels: (result.rows as readonly SlackReadConversation[])
									.filter(
										(c) =>
											channels.get(c.id)?.member === true &&
											scopes.has(scopeFor(c.kind)) &&
											types.includes(c.kind) &&
											!(q.get("exclude_archived") === "true" && c.archived),
									)
									.map((c) => facts(c)),
								response_metadata: { next_cursor: result.next },
							});
						}
						const id = identifier(q.get("channel"));
						if (!channels.has(id)) return failure("channel_not_found", 200);
						if (!scopes.has(scopeFor(channel(id).kind, true))) return failure("missing_scope", 200);
						const all = messages.get(id) as readonly SlackReadMessage[];
						const root = method === "conversations.replies" ? stamp(q.get("ts")) : undefined;
						if (root !== undefined && !all.some((m) => m.ts === root))
							return failure("thread_not_found", 200);
						const oldest = q.has("oldest") ? ticks(stamp(q.get("oldest"))) : undefined,
							latest = q.has("latest") ? ticks(stamp(q.get("latest"))) : undefined;
						if (oldest !== undefined && latest !== undefined && oldest > latest) refuse();
						if (q.has("inclusive") && !["true", "false"].includes(q.get("inclusive") as string))
							refuse();
						const inclusive = q.get("inclusive") === "true";
						const result = page(
							key,
							q,
							() =>
								all
									.filter(
										(m) =>
											(root === undefined
												? m.threadTs === undefined || m.threadTs === m.ts
												: m.ts === root || m.threadTs === root) &&
											(oldest === undefined ||
												(inclusive ? ticks(m.ts) >= oldest : ticks(m.ts) > oldest)) &&
											(latest === undefined ||
												(inclusive ? ticks(m.ts) <= latest : ticks(m.ts) < latest)),
									)
									.sort((a, b) => {
										const d = ticks(a.ts) < ticks(b.ts) ? -1 : ticks(a.ts) > ticks(b.ts) ? 1 : 0;
										return root === undefined ? -d : d;
									})
									.map((m) => Object.freeze(wireMessage(m, all))),
							at,
						);
						return json({
							ok: true,
							messages: result.rows,
							has_more: result.more,
							response_metadata: { next_cursor: result.next },
						});
					} catch (error) {
						return failure(
							error instanceof Error &&
								["invalid_cursor", "fixture_cursor_limit"].includes(error.message)
								? error.message
								: "invalid_arguments",
						);
					}
				},
			},
			{ host: SLACK_READ_HOST, faults: createFaults({ clock }), recorder: readRecorder() },
		);
		return Object.freeze({
			...fake,
			// No redirect route is supported. Avoid the generic fetch's pre-recorder body tee.
			async fetch(
				input: Parameters<Fake["fetch"]>[0],
				init?: Parameters<Fake["fetch"]>[1],
			): Promise<Response> {
				if (input instanceof Request)
					return fake.fetch(
						withTarget(new Request(input, { ...init, redirect: "error" }), rawTarget(input)),
					);
				return fake.fetch(input, { ...init, redirect: "error" });
			},
			clock,
			ownerId,
			revoke(): void {
				revoked = true;
				cursors.clear();
				cursorBytes = 0;
				rates.clear();
			},
			conversation: channel,
			changeConversation(
				id: string,
				patch: Partial<Omit<SlackReadConversation, "id" | "kind">>,
			): void {
				current();
				const prior = channel(id),
					changes = object(patch, ["name", "member", "archived", "sharing", "memberCount"]);
				channels.set(id, conversation({ ...prior, ...changes }));
			},
			addMessage(id: string, rawMessage: SlackReadMessage): void {
				current();
				channel(id);
				const value = message(rawMessage),
					prior = messages.get(id) as readonly SlackReadMessage[];
				const bytes = Buffer.byteLength(value.text);
				if (
					count >= MAX_SLACK_MESSAGES ||
					messageBytes + bytes > MAX_SLACK_STATE_BYTES ||
					prior.some((m) => ticks(m.ts) === ticks(value.ts)) ||
					(value.threadTs !== undefined &&
						!prior.some((m) => m.ts === value.threadTs && m.threadTs === undefined))
				)
					refuse();
				messages.set(id, Object.freeze([...prior, value]));
				count++;
				messageBytes += bytes;
			},
		});
	} catch {
		return refuse();
	}
}

/** Wire intake is separate from the read fixture's 4,096-byte stored-text limit. */
export const MAX_SLACK_SEND_REQUEST_BYTES: number = 32 * 1024;

export interface SlackSendFake extends Fake {
	/** Revokes only this sender's synthetic credential. */
	revoke(): void;
}

/**
 * A synthetic provider write surface sharing only the supplied reader's public controls.
 * The caller owns the reader; this factory does not grant native send or reconcile authority.
 */
export function createSlackSendFake(raw: {
	readonly read: SlackReadFake;
	readonly userToken: string;
}): SlackSendFake {
	const options = object(raw, ["read", "userToken"]);
	const reader = options.read as SlackReadFake;
	if (reader === null || typeof reader !== "object" || isProxy(reader)) refuse();
	const token = text(options.userToken, 160);
	if (!/^DYTEST-[A-Za-z0-9._-]{1,128}$/.test(token)) refuse();
	const owner = message({ ts: "0.0", user: reader.ownerId, text: "DYTEST owner" }).user;
	const clock = reader.clock;
	const now = clock.now.bind(clock);
	const inspect = reader.conversation.bind(reader);
	const append = reader.addMessage.bind(reader);
	let committed = -1n;
	let revoked = false;
	const fake = createFake(
		{
			async fetch(request) {
				try {
					if (request.method !== "POST") return failure("unknown_method", 405);
					if (rawTarget(request) !== "/api/chat.postMessage") return failure("invalid_arguments");
					if (request.headers.get("authorization") !== `Bearer ${token}`)
						return failure("invalid_auth", 401);
					if (revoked) return failure("token_revoked", 200);
					if (request.headers.get("content-type") !== "application/json")
						return failure("invalid_arguments");
					const fields = object(await request.json(), [
						"channel",
						"text",
						"thread_ts",
						"unfurl_links",
						"unfurl_media",
					]);
					const id = identifier(fields.channel);
					if (fields.unfurl_links !== false || fields.unfurl_media !== false) refuse();
					const parent = fields.thread_ts === undefined ? undefined : stamp(fields.thread_ts);
					inspect(id);
					const milliseconds = now();
					if (
						!Number.isSafeInteger(milliseconds) ||
						milliseconds < 0 ||
						milliseconds > 253_402_300_799_000
					)
						refuse();
					const observed = BigInt(milliseconds) * 1_000_000n;
					const next = observed > committed ? observed : committed + 1n;
					if (next > 253_402_300_799_999_999_999n) refuse();
					const ts = `${next / 1_000_000_000n}.${String(next % 1_000_000_000n).padStart(9, "0")}`;
					const value = message({
						ts,
						user: owner,
						text: fields.text,
						...(parent === undefined ? {} : { threadTs: parent }),
					});
					const response = json({
						ok: true,
						channel: id,
						ts,
						message: {
							type: "message",
							user: value.user,
							text: value.text,
							ts,
							...(parent === undefined ? {} : { thread_ts: parent }),
						},
					});
					request.signal.throwIfAborted();
					if (revoked) return failure("token_revoked", 200);
					append(id, value);
					committed = next;
					return response;
				} catch (error) {
					if (request.signal.aborted) throw error;
					return failure("invalid_arguments");
				}
			},
		},
		{
			host: SLACK_READ_HOST,
			maxRequestBodyBytes: MAX_SLACK_SEND_REQUEST_BYTES,
			faults: createFaults({ clock: { now } }),
		},
	);
	return Object.freeze({
		...fake,
		revoke(): void {
			revoked = true;
		},
		async fetch(input: Request | URL | string, init?: RequestInit): Promise<Response> {
			if (input instanceof Request) {
				const forwarded = withTarget(
					new Request(input, { ...init, redirect: "error" }),
					rawTarget(input),
				);
				return await fake.fetch(forwarded);
			}
			return await fake.fetch(input, { ...init, redirect: "error" });
		},
	});
}
