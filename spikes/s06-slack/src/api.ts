import { setTimeout as sleep } from "node:timers/promises";

// The Slack Web API as the spike calls it. Each method's HTTP verb, rate tier, token type and
// arguments come from its reference page (https://docs.slack.dev/reference/methods/<method>,
// read 2026-10-17). Tokens travel only in the Authorization header.
export const SLACK_API_BASE = "https://slack.com/api/";

export type Tier = 1 | 2 | 3 | 4 | "special";
export type TokenKind = "app" | "user";

export interface MethodSpec {
	readonly verb: "GET" | "POST";
	readonly tier: Tier;
	readonly token: TokenKind;
	readonly params: readonly string[];
}

// The poller and Socket Mode call the first five; M0.25 calls conversations.info for its rate-limit
// headers and the member count behind plan §3's pre-claim facts. users.conversations lists only the
// owner's conversations, where plan §4's slack-v1 names conversations.list.
export type Method =
	| "apps.connections.open"
	| "auth.test"
	| "users.conversations"
	| "conversations.history"
	| "conversations.replies"
	| "conversations.info";

export const METHODS: Readonly<Record<Method, MethodSpec>> = {
	"apps.connections.open": { verb: "POST", tier: 3, token: "app", params: [] },
	"auth.test": { verb: "POST", tier: "special", token: "user", params: [] },
	"users.conversations": {
		verb: "GET",
		tier: 3,
		token: "user",
		params: ["types", "exclude_archived", "limit", "cursor"],
	},
	"conversations.history": {
		verb: "GET",
		tier: 3,
		token: "user",
		params: ["channel", "oldest", "latest", "inclusive", "limit", "cursor"],
	},
	"conversations.replies": {
		verb: "GET",
		tier: 3,
		token: "user",
		params: ["channel", "ts", "oldest", "latest", "inclusive", "limit", "cursor"],
	},
	"conversations.info": {
		verb: "GET",
		tier: 3,
		token: "user",
		params: ["channel", "include_num_members"],
	},
};
export type Params = Readonly<Record<string, string | number | boolean | undefined>>;

// App-level tokens (xapp-, or xoxe.xapp- when rotating) open Socket Mode; user tokens (xoxp-,
// xoxe.xoxp-) read. Bot tokens are never used: the owner's app has no bot user.
const TOKEN_PREFIXES: Readonly<Record<TokenKind, readonly string[]>> = {
	app: ["xapp-", "xoxe.xapp-"],
	user: ["xoxp-", "xoxe.xoxp-"],
};

export function assertToken(kind: TokenKind, token: string): void {
	if (!TOKEN_PREFIXES[kind].some((prefix) => token.startsWith(prefix))) {
		throw new TypeError(`slack: expected ${kind === "app" ? "an app-level" : "a user"} token`);
	}
}

export type ErrorKind = "rate_limited" | "auth" | "transient" | "failed";

const AUTH_CODES = new Set([
	"account_inactive",
	"invalid_auth",
	"missing_args",
	"not_allowed_token_type",
	"not_authed",
	"token_expired",
	"token_revoked",
]);
const TRANSIENT_CODES = new Set([
	"fatal_error",
	"internal_error",
	"malformed",
	"network",
	"request_timeout",
	"service_unavailable",
]);
// Without a Retry-After header, wait out Slack's one-minute rate window; whatever the header says,
// wait at most 15 minutes.
export const DEFAULT_RETRY_AFTER_MS = 60_000;
export const MAX_RETRY_AFTER_MS = 900_000;

// A failed call. Only the method, status and Slack's error code are kept, never response content.
export class SlackError extends Error {
	readonly method: Method;
	readonly status: number;
	readonly code: string;
	readonly kind: ErrorKind;
	readonly retryAfterMs: number | null;

	constructor(method: Method, status: number, code: string, retryAfterMs: number | null = null) {
		const safe = /^[a-z0-9_]{1,64}$/.test(code) ? code : "unknown";
		super(`slack: ${method} failed: ${safe}${status > 0 ? ` (HTTP ${status})` : ""}`);
		this.name = "SlackError";
		this.method = method;
		this.status = status;
		this.code = safe;
		this.kind =
			status === 429 || safe === "ratelimited"
				? "rate_limited"
				: AUTH_CODES.has(safe)
					? "auth"
					: status >= 500 || TRANSIENT_CODES.has(safe)
						? "transient"
						: "failed";
		this.retryAfterMs =
			this.kind === "rate_limited" ? (retryAfterMs ?? DEFAULT_RETRY_AFTER_MS) : null;
	}
}

// Retry-After as delay-seconds (Slack's form) or an IMF-fixdate HTTP-date (RFC 9110 §10.2.3), in
// milliseconds from 0 to MAX_RETRY_AFTER_MS.
const HTTP_DATE = /^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/;

export function parseRetryAfter(value: string | null, now: number): number | null {
	const text = value?.trim() ?? "";
	const ms = /^\d+$/.test(text)
		? Number(text) * 1000
		: HTTP_DATE.test(text)
			? Date.parse(text) - now
			: Number.NaN;
	return Number.isNaN(ms) ? null : Math.min(MAX_RETRY_AFTER_MS, Math.max(0, ms));
}

// How long a rate-limited call waits: its Retry-After, but at least the caller's backoff step, so a
// 0 or a past date never means an immediate retry.
export function retryWait(error: SlackError, floorMs: number): number {
	return Math.max(floorMs, error.retryAfterMs ?? DEFAULT_RETRY_AFTER_MS);
}

export interface SlackResponse {
	readonly status: number;
	readonly headers: Headers;
	readonly data: Readonly<Record<string, unknown>>;
}

export interface CallOptions {
	readonly base?: string;
	readonly fetch?: typeof fetch;
	readonly signal?: AbortSignal;
	readonly now?: () => number;
}

export async function callSlack(
	method: Method,
	token: string,
	params: Params = {},
	options: CallOptions = {},
): Promise<SlackResponse> {
	const spec: MethodSpec = METHODS[method];
	assertToken(spec.token, token);
	const url = new URL(method, options.base ?? SLACK_API_BASE);
	const form = new URLSearchParams();
	for (const [name, value] of Object.entries(params)) {
		if (value === undefined) continue;
		if (!spec.params.includes(name)) throw new TypeError(`slack: ${method} takes no ${name}`);
		(spec.verb === "GET" ? url.searchParams : form).set(name, String(value));
	}
	const headers: Record<string, string> = { authorization: `Bearer ${token}` };
	if (spec.verb === "POST") headers["content-type"] = "application/x-www-form-urlencoded";
	let response: Response;
	try {
		response = await (options.fetch ?? globalThis.fetch)(url, {
			method: spec.verb,
			headers,
			...(spec.verb === "POST" ? { body: form } : {}),
			redirect: "error",
			...(options.signal ? { signal: options.signal } : {}),
		});
	} catch (error) {
		if (options.signal?.aborted) throw error;
		throw new SlackError(method, 0, "network");
	}
	const retryAfter = parseRetryAfter(
		response.headers.get("retry-after"),
		(options.now ?? Date.now)(),
	);
	let data: unknown;
	try {
		data = await response.json();
	} catch {
		options.signal?.throwIfAborted();
		data = undefined;
	}
	const body = typeof data === "object" && data !== null ? (data as Record<string, unknown>) : {};
	if (response.status === 200 && body.ok === true) {
		return { status: response.status, headers: response.headers, data: body };
	}
	const code =
		typeof body.error === "string"
			? body.error
			: response.status === 200
				? "malformed"
				: `http_${response.status}`;
	throw new SlackError(method, response.status, code, retryAfter);
}

// Injected time, so tests can run backoff and Retry-After waits on a virtual clock.
export interface Clock {
	now(): number;
	delay(ms: number, signal?: AbortSignal): Promise<void>;
}

// Node fires a timer over 2^31-1 ms after 1 ms, so a longer delay is cut to that.
const MAX_TIMER_MS = 2 ** 31 - 1;

export const systemClock: Clock = {
	now: () => Date.now(),
	delay: (ms, signal) => sleep(Math.min(ms, MAX_TIMER_MS), undefined, signal ? { signal } : {}),
};
