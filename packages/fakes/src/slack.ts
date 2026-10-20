import { createHash, randomBytes } from "node:crypto";
import { isProxy } from "node:util/types";
import { createFaults, type ManualClock, manualClock } from "./faults.ts";
import type { RecordedRequest, Recorder } from "./recorder.ts";
import { createFake, type Fake } from "./server.ts";
import { rawTarget, withTarget } from "./target.ts";

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
