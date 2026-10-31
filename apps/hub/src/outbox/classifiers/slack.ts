import {
	channelId,
	data,
	integer,
	invalid,
	keys,
	slackTimestamp,
} from "../../channels/slack/validation.ts";

export type SlackSendResult =
	| { readonly state: "SENT"; readonly channelId: string; readonly ts: string }
	| {
			readonly state: "RETRY_WAIT";
			readonly notBefore: number;
			readonly reason: "rate_limited" | "not_written" | "http_408";
	  }
	| { readonly state: "NEEDS_REAPPROVAL"; readonly reason: "missed" }
	| { readonly state: "FAILED"; readonly reason: "rejected" }
	| { readonly state: "UNKNOWN"; readonly reason: "ambiguous" };

const REJECTIONS = new Set([
	"channel_not_found",
	"not_in_channel",
	"msg_too_long",
	"no_text",
	"is_archived",
	"invalid_arguments",
	"invalid_arg_name",
	"invalid_array_arg",
	"invalid_charset",
	"restricted_action",
	"restricted_action_read_only_channel",
	"restricted_action_thread_only_channel",
	"restricted_action_thread_locked",
	"restricted_action_non_threadable_channel",
	"cannot_reply_to_message",
	"ekm_access_denied",
	"team_access_not_granted",
	"posting_to_general_channel_denied",
	"missing_scope",
	"not_authed",
	"invalid_auth",
	"token_revoked",
	"token_expired",
	"account_inactive",
	"not_allowed_token_type",
]);
const HTTP_DATE = /^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/;

export function parseSlackRetryAfter(value: unknown, now: number): number | null {
	integer(now, 8_640_000_000_000_000);
	if (
		typeof value !== "string" ||
		value.length > 512 ||
		!value.isWellFormed() ||
		value.includes("\r") ||
		value.includes("\n")
	)
		return null;
	const raw = value.trim();
	if (/^\d+$/.test(raw)) {
		const milliseconds = BigInt(raw) * 1000n;
		return milliseconds > BigInt(Number.MAX_SAFE_INTEGER)
			? Number.MAX_SAFE_INTEGER
			: Number(milliseconds);
	}
	if (!HTTP_DATE.test(raw)) return null;
	const at = Date.parse(raw);
	return Number.isFinite(at) && new Date(at).toUTCString() === raw ? Math.max(0, at - now) : null;
}

function responseData(value: unknown): Record<string, unknown> | null {
	try {
		return data(value);
	} catch {
		return null;
	}
}

export function classifySlackSend(input: unknown): SlackSendResult {
	const value = data(input);
	keys(value, ["channelId", "now", "deliverBy", "retryAttempt", "jitterMs", "observation"]);
	const channel = channelId(value.channelId);
	const now = integer(value.now, 8_640_000_000_000_000);
	const deliverBy = integer(value.deliverBy, 8_640_000_000_000_000);
	const attempt = integer(value.retryAttempt, 1_000_000);
	const jitter = value.jitterMs === undefined ? 0 : integer(value.jitterMs, 1000);
	const observed = data(value.observation);
	const retry = (
		reason: "rate_limited" | "not_written" | "http_408",
		header?: unknown,
	): SlackSendResult => {
		const backoff = Math.min(300_000, 2 ** Math.min(attempt, 19) * 1000 + jitter);
		const retryAfter =
			parseSlackRetryAfter(header, now) ?? (reason === "rate_limited" ? 60_000 : 0);
		const next = now + Math.max(backoff, retryAfter);
		return !Number.isSafeInteger(next) || next > deliverBy
			? { state: "NEEDS_REAPPROVAL", reason: "missed" }
			: { state: "RETRY_WAIT", notBefore: next, reason };
	};
	if (observed.kind === "transport") {
		keys(observed, ["kind", "written"]);
		if (observed.written !== "none" && observed.written !== "maybe") invalid();
		return observed.written === "none"
			? retry("not_written")
			: { state: "UNKNOWN", reason: "ambiguous" };
	}
	if (observed.kind !== "response") invalid();
	keys(observed, ["kind", "status", "body", "retryAfter"]);
	const status = integer(observed.status);
	if (status < 100) invalid();
	if (status >= 500 || status < 200 || (status >= 300 && status < 400))
		return { state: "UNKNOWN", reason: "ambiguous" };
	if (status === 429) return retry("rate_limited", observed.retryAfter);
	if (status === 408) return retry("http_408", observed.retryAfter);
	const body = responseData(observed.body);
	if (body?.ok === false && (body.error === "ratelimited" || body.error === "rate_limited"))
		return retry("rate_limited", observed.retryAfter);
	if (body?.ok === false && typeof body.error === "string" && REJECTIONS.has(body.error))
		return { state: "FAILED", reason: "rejected" };
	if (status < 300 && body?.ok === true && body.channel === channel) {
		try {
			return { state: "SENT", channelId: channel, ts: slackTimestamp(body.ts) };
		} catch {
			/* Reconcile malformed success. */
		}
	}
	return { state: "UNKNOWN", reason: "ambiguous" };
}
