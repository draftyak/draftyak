import { randomBytes, randomInt, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { type WebSocket, WebSocketServer } from "ws";

// A local stand-in for Slack: the Web API methods the spike calls, checked against their reference
// pages (https://docs.slack.dev/reference/methods/<method>, read 2026-10-17), and a Socket Mode
// link on ws 8.22.0 that greets with `hello`, sends envelopes, records every ack and redelivers an
// envelope nobody acknowledged as a new envelope (retry_attempt + 1), up to three times.

// Token-shaped values are built here at run time; the repository holds none (vendor-guard).
export function fakeToken(kind: "xapp" | "xoxp" | "xoxb"): string {
	const digits = (): string => String(randomInt(1e9, 1e10));
	const secret = randomBytes(16).toString("hex");
	return kind === "xapp"
		? [kind, "1", "A0FAKEAPP", digits(), secret].join("-")
		: [kind, digits(), digits(), digits(), secret].join("-");
}

export const OWNER = "U0OWNER01";
export const TEAM = "T0FAKE001";

interface MethodRule {
	readonly verb: "GET" | "POST";
	readonly token: "app" | "user";
	readonly args: readonly string[];
}

// Each method's documented HTTP method, token type and arguments.
const RULES: Readonly<Record<string, MethodRule>> = {
	"apps.connections.open": { verb: "POST", token: "app", args: [] },
	"auth.test": { verb: "POST", token: "user", args: [] },
	"users.conversations": {
		verb: "GET",
		token: "user",
		args: ["cursor", "exclude_archived", "exclude_muted", "limit", "team_id", "types", "user"],
	},
	"conversations.history": {
		verb: "GET",
		token: "user",
		args: ["channel", "cursor", "include_all_metadata", "inclusive", "latest", "limit", "oldest"],
	},
	"conversations.replies": {
		verb: "GET",
		token: "user",
		args: [
			"channel",
			"ts",
			"cursor",
			"include_all_metadata",
			"inclusive",
			"latest",
			"limit",
			"oldest",
		],
	},
	"conversations.info": {
		verb: "GET",
		token: "user",
		args: ["channel", "include_locale", "include_num_members"],
	},
	"users.info": { verb: "GET", token: "user", args: ["user", "include_locale"] },
};

export interface FakeMessage {
	readonly ts: string;
	readonly user: string;
	readonly text: string;
	readonly replies?: FakeMessage[];
}

export interface FakeConversation {
	readonly id: string;
	readonly type: "im" | "mpim" | "channel" | "group";
	readonly messages: FakeMessage[];
}

export interface ApiRequest {
	readonly method: string;
	readonly verb: string;
	readonly params: Readonly<Record<string, string>>;
	readonly at: number;
}

export interface FakeConnection {
	readonly id: number;
	readonly socket: WebSocket;
	closedCode: number | null;
}

export interface Envelope {
	readonly envelopeId: string;
	readonly connection: number;
	readonly type: string;
	readonly retryAttempt: number;
	readonly payload: unknown;
	acknowledged: boolean;
	redelivered: boolean;
}

export interface Ack {
	readonly connection: number;
	readonly raw: string;
	readonly envelopeId: unknown;
	readonly dropped: boolean;
}

interface Scripted {
	readonly status: number;
	readonly error: string;
	readonly retryAfter: string | null;
}

const ok = (body: object): [number, object, Record<string, string>] => [
	200,
	{ ok: true, ...body },
	{},
];
const err = (error: string, status = 200): [number, object, Record<string, string>] => [
	status,
	{ ok: false, error },
	{},
];
const encode = (offset: number): string => Buffer.from(`offset:${offset}`).toString("base64url");
const decode = (cursor: string | undefined): number =>
	cursor ? Number(Buffer.from(cursor, "base64url").toString().slice(7)) || 0 : 0;
const after = (a: string, b: string): boolean => Number(a) > Number(b);

export class FakeSlack {
	readonly appToken: string = fakeToken("xapp");
	readonly userToken: string = fakeToken("xoxp");
	readonly requests: ApiRequest[] = [];
	readonly connections: FakeConnection[] = [];
	readonly envelopes: Envelope[] = [];
	readonly acks: Ack[] = [];
	readonly conversations: FakeConversation[] = [];
	readonly tickets: string[] = [];
	// Slack expects an ack within 3 s; tests that exercise redelivery shorten it.
	ackTimeoutMs = 3000;
	sendHello = true;
	dropAcks = 0;
	private readonly scripted = new Map<string, Scripted[]>();
	private readonly open = new Set<string>();
	private readonly timers = new Set<NodeJS.Timeout>();
	private readonly server = createServer((request, response) => {
		void this.api(request, response);
	});
	private readonly sockets = new WebSocketServer({ noServer: true });
	private port = 0;

	get apiBase(): string {
		return `http://127.0.0.1:${this.port}/api/`;
	}

	async start(): Promise<this> {
		this.server.on("upgrade", (request, socket, head) => {
			const url = new URL(request.url ?? "/", "http://127.0.0.1");
			const ticket = url.searchParams.get("ticket") ?? "";
			if (url.pathname !== "/link/" || !this.open.delete(ticket)) {
				socket.destroy();
				return;
			}
			this.sockets.handleUpgrade(request, socket, head, (ws) => this.connected(ws));
		});
		await new Promise<void>((resolve) =>
			this.server.listen({ host: "127.0.0.1", port: 0 }, resolve),
		);
		this.port = (this.server.address() as AddressInfo).port;
		return this;
	}

	async close(): Promise<void> {
		for (const timer of this.timers) clearTimeout(timer);
		for (const { socket } of this.connections) socket.terminate();
		await new Promise<void>((resolve) => this.sockets.close(() => resolve()));
		this.server.closeAllConnections();
		await new Promise<void>((resolve) => this.server.close(() => resolve()));
	}

	// The next `times` calls of `method` fail: a 429 with Retry-After (null leaves it out), or an
	// error code with its status.
	rateLimit(method: string, times: number, retryAfter: string | null): void {
		this.script(method, times, { status: 429, error: "ratelimited", retryAfter });
	}

	fail(method: string, times: number, error: string, status = 200): void {
		this.script(method, times, { status, error, retryAfter: null });
	}

	private script(method: string, times: number, outcome: Scripted): void {
		const queue = this.scripted.get(method) ?? [];
		for (let index = 0; index < times; index++) queue.push(outcome);
		this.scripted.set(method, queue);
	}

	calls(method: string): ApiRequest[] {
		return this.requests.filter((request) => request.method === method);
	}

	private async api(request: IncomingMessage, response: ServerResponse): Promise<void> {
		const chunks: Buffer[] = [];
		for await (const chunk of request) chunks.push(chunk as Buffer);
		const url = new URL(request.url ?? "/", "http://127.0.0.1");
		const method = url.pathname.replace(/^\/api\//, "");
		const params: Record<string, string> = Object.fromEntries(url.searchParams);
		const contentType = request.headers["content-type"] ?? "";
		if (chunks.length > 0 && contentType.startsWith("application/x-www-form-urlencoded")) {
			Object.assign(
				params,
				Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString())),
			);
		}
		this.requests.push({ method, verb: request.method ?? "", params, at: Date.now() });
		const [status, body, headers] = this.answer(method, request, params);
		response.writeHead(status, { "content-type": "application/json; charset=utf-8", ...headers });
		response.end(JSON.stringify(body));
	}

	private answer(
		method: string,
		request: IncomingMessage,
		params: Record<string, string>,
	): [number, object, Record<string, string>] {
		const rule = RULES[method];
		if (rule === undefined) return err("unknown_method", 404);
		if (request.method !== rule.verb) return err("method_not_allowed", 405);
		const auth = /^Bearer (.+)$/.exec(request.headers.authorization ?? "")?.[1];
		if ("token" in params || auth === undefined) return err("not_authed");
		const expected = rule.token === "app" ? this.appToken : this.userToken;
		if (auth !== expected) {
			const other = rule.token === "app" ? this.userToken : this.appToken;
			return err(auth === other ? "not_allowed_token_type" : "invalid_auth");
		}
		for (const name of Object.keys(params)) {
			if (!rule.args.includes(name)) return err("invalid_arg_name");
		}
		const scripted = this.scripted.get(method)?.shift();
		if (scripted !== undefined) {
			const headers: Record<string, string> =
				scripted.retryAfter === null ? {} : { "retry-after": scripted.retryAfter };
			return [scripted.status, { ok: false, error: scripted.error }, headers];
		}
		switch (method) {
			case "apps.connections.open": {
				const ticket = randomUUID();
				this.open.add(ticket);
				this.tickets.push(ticket);
				return ok({ url: `ws://127.0.0.1:${this.port}/link/?ticket=${ticket}` });
			}
			case "auth.test":
				return ok({ user_id: OWNER, team_id: TEAM, user: "owner name", team: "Fake team" });
			case "users.conversations":
				return this.list(params);
			case "conversations.history":
				return this.history(params);
			case "conversations.replies":
				return this.replies(params);
			default:
				return err("not_implemented");
		}
	}

	private find(channel: string | undefined): FakeConversation | undefined {
		return this.conversations.find((each) => each.id === channel);
	}

	private list(params: Record<string, string>): [number, object, Record<string, string>] {
		const types = new Set((params.types ?? "public_channel").split(","));
		const wanted = (type: FakeConversation["type"]): boolean =>
			types.has(
				type === "channel" ? "public_channel" : type === "group" ? "private_channel" : type,
			);
		const channels = this.conversations
			.filter((each) => wanted(each.type))
			.map((each) => ({
				id: each.id,
				name: `name of ${each.id}`,
				is_channel: each.type === "channel",
				is_group: each.type === "group",
				is_im: each.type === "im",
				is_mpim: each.type === "mpim",
				is_private: each.type !== "channel",
				is_archived: false,
			}));
		return this.page(channels, params, "channels");
	}

	private page(
		items: readonly object[],
		params: Record<string, string>,
		key: string,
	): [number, object, Record<string, string>] {
		const offset = decode(params.cursor);
		const limit = Math.max(1, Math.min(Number(params.limit ?? 100) || 100, 999));
		const slice = items.slice(offset, offset + limit);
		const more = offset + limit < items.length;
		return ok({
			[key]: slice,
			has_more: more,
			response_metadata: { next_cursor: more ? encode(offset + limit) : "" },
		});
	}

	private history(params: Record<string, string>): [number, object, Record<string, string>] {
		const conversation = this.find(params.channel);
		if (conversation === undefined) return err("channel_not_found");
		const top = [...conversation.messages]
			.filter((message) => !params.oldest || after(message.ts, params.oldest))
			.sort((a, b) => Number(b.ts) - Number(a.ts))
			.map((message) => this.render(message));
		return this.page(top, params, "messages");
	}

	private replies(params: Record<string, string>): [number, object, Record<string, string>] {
		const conversation = this.find(params.channel);
		const parent = conversation?.messages.find((message) => message.ts === params.ts);
		if (parent === undefined) return err("thread_not_found");
		const thread = [
			this.render(parent),
			...(parent.replies ?? []).map((reply) => ({
				type: "message",
				user: reply.user,
				text: reply.text,
				ts: reply.ts,
				thread_ts: parent.ts,
				parent_user_id: parent.user,
			})),
		].filter((message) => !params.oldest || after(message.ts, params.oldest));
		return this.page(thread, params, "messages");
	}

	private render(message: FakeMessage): { readonly ts: string; readonly [field: string]: unknown } {
		const replies = message.replies ?? [];
		const base = { type: "message", user: message.user, text: message.text, ts: message.ts };
		if (replies.length === 0) return base;
		return {
			...base,
			thread_ts: message.ts,
			reply_count: replies.length,
			reply_users: [...new Set(replies.map((reply) => reply.user))],
			latest_reply: replies.at(-1)?.ts,
		};
	}

	// Socket Mode.

	private connected(socket: WebSocket): void {
		const connection: FakeConnection = {
			id: this.connections.length + 1,
			socket,
			closedCode: null,
		};
		this.connections.push(connection);
		socket.on("message", (data) => this.received(connection, data.toString()));
		socket.on("close", (code) => {
			connection.closedCode = code;
		});
		if (this.sendHello) {
			this.frame(connection, {
				type: "hello",
				num_connections: this.live().length,
				debug_info: { host: "applink-fake", build_number: 1, approximate_connection_time: 18060 },
				connection_info: { app_id: "A0FAKEAPP" },
			});
		}
	}

	live(): FakeConnection[] {
		return this.connections.filter(
			(each) => each.closedCode === null && each.socket.readyState === 1,
		);
	}

	frame(connection: FakeConnection, frame: object): void {
		connection.socket.send(JSON.stringify(frame));
	}

	// Sends an event_callback in a new envelope on `connection` (by default the newest live one).
	deliver(
		event: object,
		options: { connection?: FakeConnection; type?: string; acceptsResponsePayload?: boolean } = {},
	): Envelope {
		return this.envelope(event, 0, options);
	}

	private envelope(
		payload: unknown,
		retryAttempt: number,
		options: { connection?: FakeConnection; type?: string; acceptsResponsePayload?: boolean },
	): Envelope {
		const connection = options.connection ?? this.live().at(-1);
		if (connection === undefined) throw new Error("fake slack: no live connection");
		const envelope: Envelope = {
			envelopeId: randomUUID(),
			connection: connection.id,
			type: options.type ?? "events_api",
			retryAttempt,
			payload,
			acknowledged: false,
			redelivered: false,
		};
		this.envelopes.push(envelope);
		this.frame(connection, {
			envelope_id: envelope.envelopeId,
			payload,
			type: envelope.type,
			accepts_response_payload: options.acceptsResponsePayload ?? false,
			retry_attempt: retryAttempt,
			retry_reason: retryAttempt === 0 ? "" : "timeout",
		});
		this.later(() => this.redeliver(envelope), this.ackTimeoutMs);
		return envelope;
	}

	private redeliver(envelope: Envelope): void {
		if (envelope.acknowledged || envelope.redelivered || envelope.retryAttempt >= 3) return;
		if (this.live().length === 0) {
			this.later(() => this.redeliver(envelope), this.ackTimeoutMs);
			return;
		}
		envelope.redelivered = true;
		this.envelope(envelope.payload, envelope.retryAttempt + 1, { type: envelope.type });
	}

	private later(task: () => void, ms: number): void {
		const timer = setTimeout(() => {
			this.timers.delete(timer);
			task();
		}, ms);
		this.timers.add(timer);
	}

	private received(connection: FakeConnection, raw: string): void {
		let envelopeId: unknown;
		try {
			envelopeId = (JSON.parse(raw) as { envelope_id?: unknown }).envelope_id;
		} catch {
			envelopeId = undefined;
		}
		const dropped = this.dropAcks > 0;
		if (dropped) this.dropAcks--;
		this.acks.push({ connection: connection.id, raw, envelopeId, dropped });
		const envelope = this.envelopes.find((each) => each.envelopeId === envelopeId);
		if (envelope !== undefined && !dropped) envelope.acknowledged = true;
	}

	disconnect(connection: FakeConnection, reason: string, closeAfterMs: number | null): void {
		this.frame(connection, { type: "disconnect", reason, debug_info: { host: "wss-fake" } });
		if (closeAfterMs !== null) this.later(() => connection.socket.close(1000), closeAfterMs);
	}

	terminate(connection: FakeConnection): void {
		connection.socket.terminate();
	}

	acksFor(envelopeId: string): Ack[] {
		return this.acks.filter((ack) => ack.envelopeId === envelopeId);
	}
}

export async function until(
	predicate: () => boolean,
	what: string,
	timeoutMs = 10_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

// A message event as the Events API wraps it, with text and other content the spike must drop.
export function messageEvent(
	event: Readonly<Record<string, unknown>>,
	eventId: string = `Ev${randomBytes(5).toString("hex").toUpperCase()}`,
): object {
	return {
		token: "verification-token-placeholder",
		team_id: TEAM,
		api_app_id: "A0FAKEAPP",
		event: { type: "message", ...event },
		type: "event_callback",
		event_id: eventId,
		event_time: 1_760_000_000,
		authorizations: [{ team_id: TEAM, user_id: OWNER, is_bot: false }],
	};
}
