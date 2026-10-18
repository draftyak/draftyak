// SIWC failures as codes (plan §5). Errors keep codes, statuses and request ids, never text.

export type SiwcCode =
	| "USAGE_LIMIT"
	| "UNAVAILABLE"
	| "NOT_ELIGIBLE"
	| "UNSUPPORTED_CAPABILITY"
	| "ROUTE_NOT_SUPPORTED"
	| "INVALID_USER"
	| "SCOPE_NOT_AUTHORIZED"
	| "PLAN_USAGE_DISABLED"
	| "ADMISSION_REFUSED"
	| "BROKER_REFUSED"
	| "API_ERROR"
	| "STREAM_FAILED"
	| "STREAM_INTERRUPTED"
	| "PORT_IN_USE"
	| "SIGN_IN_FAILED"
	| "ID_TOKEN_INVALID"
	| "REAUTH_REQUIRED"
	| "INVALID_CLIENT"
	| "TRANSFER_REFUSED";

// Plan §4's plugin error codes.
export type PluginCode =
	| "AUTH_EXPIRED"
	| "AUTH_REVOKED"
	| "QUOTA_EXCEEDED"
	| "RATE_LIMITED"
	| "PERMISSION_DENIED"
	| "TRANSIENT"
	| "INVALID_INPUT"
	| "UNSUPPORTED";

// never: don't repeat the request; backoff: retry later, bounded; reauth: sign in again.
export type Recovery = "never" | "backoff" | "reauth";

export type BodyShape = "error-object" | "detail" | "event" | "none";

export interface ErrorFacts {
	readonly status?: number;
	readonly apiCode?: string;
	readonly param?: string;
	readonly requestId?: string;
	readonly shape?: BodyShape;
	readonly detail?: string;
	readonly clientId?: string;
}

type Rule = readonly [SiwcCode, PluginCode, Recovery];
const S = "subscription_sharing_";
const C = "chatpass_v2_";

// Errors and recovery: a usage limit pauses for Manage usage, never another billing path.
export const STRUCTURED: ReadonlyMap<string, Rule> = new Map<string, Rule>([
	[`${S}usage_limit_exceeded`, ["USAGE_LIMIT", "QUOTA_EXCEEDED", "never"]],
	[`${S}usage_unavailable`, ["UNAVAILABLE", "TRANSIENT", "backoff"]],
	[`${S}user_unavailable`, ["UNAVAILABLE", "TRANSIENT", "backoff"]],
	[`${S}user_not_eligible`, ["NOT_ELIGIBLE", "PERMISSION_DENIED", "never"]],
	[`${S}unsupported_capability`, ["UNSUPPORTED_CAPABILITY", "UNSUPPORTED", "never"]],
	[`${S}route_not_supported`, ["ROUTE_NOT_SUPPORTED", "UNSUPPORTED", "never"]],
	[`${S}invalid_user`, ["INVALID_USER", "AUTH_REVOKED", "reauth"]],
	[`${C}scope_not_authorized`, ["SCOPE_NOT_AUTHORIZED", "PERMISSION_DENIED", "never"]],
	[`${C}invalid_authorization_context`, ["SCOPE_NOT_AUTHORIZED", "PERMISSION_DENIED", "never"]],
]);

// Direct admission, before a stream opens, often {"detail": "..."} with no code.
const ADMISSION: ReadonlyMap<number, Rule> = new Map<number, Rule>([
	[401, ["ADMISSION_REFUSED", "AUTH_EXPIRED", "reauth"]],
	[403, ["ADMISSION_REFUSED", "PERMISSION_DENIED", "never"]],
	[503, ["UNAVAILABLE", "TRANSIENT", "backoff"]],
]);

const OWN: Partial<Record<SiwcCode, Rule>> = {
	UNAVAILABLE: ["UNAVAILABLE", "TRANSIENT", "backoff"],
	PLAN_USAGE_DISABLED: ["PLAN_USAGE_DISABLED", "PERMISSION_DENIED", "never"],
	BROKER_REFUSED: ["BROKER_REFUSED", "INVALID_INPUT", "never"],
	STREAM_FAILED: ["STREAM_FAILED", "TRANSIENT", "backoff"],
	STREAM_INTERRUPTED: ["STREAM_INTERRUPTED", "TRANSIENT", "backoff"],
	PORT_IN_USE: ["PORT_IN_USE", "TRANSIENT", "never"],
	SIGN_IN_FAILED: ["SIGN_IN_FAILED", "AUTH_EXPIRED", "reauth"],
	ID_TOKEN_INVALID: ["ID_TOKEN_INVALID", "AUTH_EXPIRED", "reauth"],
	REAUTH_REQUIRED: ["REAUTH_REQUIRED", "AUTH_REVOKED", "reauth"],
	INVALID_CLIENT: ["INVALID_CLIENT", "AUTH_REVOKED", "never"],
	TRANSFER_REFUSED: ["TRANSFER_REFUSED", "INVALID_INPUT", "never"],
};

function byStatus(status: number | undefined): Rule {
	if (status === 429) return ["API_ERROR", "RATE_LIMITED", "backoff"];
	if (status === 401) return ["API_ERROR", "AUTH_EXPIRED", "reauth"];
	if (status === 403) return ["API_ERROR", "PERMISSION_DENIED", "never"];
	if (status !== undefined && status >= 500) return ["API_ERROR", "TRANSIENT", "backoff"];
	return ["API_ERROR", "INVALID_INPUT", "never"];
}

const SAY: Partial<Record<SiwcCode, string>> = {
	USAGE_LIMIT: "ChatGPT plan usage limit reached; open Manage usage in ChatGPT settings",
	PLAN_USAGE_DISABLED: "ChatGPT plan usage is off; turn it on or use an API key",
	PORT_IN_USE: "the sign-in port is held by another program; close it and try again",
	REAUTH_REQUIRED: "the ChatGPT sign-in has ended; sign in again",
};

export class SiwcError extends Error {
	override name = "SiwcError";
	readonly code: SiwcCode;
	readonly plugin: PluginCode;
	readonly recovery: Recovery;
	readonly facts: ErrorFacts;

	constructor(code: SiwcCode, facts: ErrorFacts = {}, chosen?: Rule) {
		const [, plugin, recovery] = chosen ?? OWN[code] ?? byStatus(facts.status);
		const said = [facts.apiCode, facts.status, facts.param, facts.detail].filter(
			(part) => part !== undefined,
		);
		super(`siwc: ${SAY[code] ?? code}${said.length > 0 ? ` (${said.join(", ")})` : ""}`);
		this.code = code;
		this.plugin = plugin;
		this.recovery = recovery;
		this.facts = facts;
	}
}

// Upstream codes and params are kept only when they look like identifiers.
const token = (value: unknown): string | undefined =>
	typeof value === "string" && /^[A-Za-z0-9_.[\]-]{1,80}$/.test(value) ? value : undefined;
const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);
const made = (rule: Rule, facts: ErrorFacts): SiwcError => new SiwcError(rule[0], facts, rule);

export function fromCode(apiCode: unknown, facts: ErrorFacts): SiwcError {
	const code = token(apiCode);
	const all = code === undefined ? facts : { ...facts, apiCode: code };
	const known = code === undefined ? undefined : STRUCTURED.get(code);
	if (known) return made(known, all);
	if (facts.shape === "event") return new SiwcError("STREAM_FAILED", all);
	return made(byStatus(facts.status), all);
}

const paramOf = (body: Record<string, unknown>): { param?: string } => {
	const value = token(body.param);
	return value === undefined ? {} : { param: value };
};

export function headFacts(status: number | undefined, headers: Headers | undefined): ErrorFacts {
	const requestId = token(headers?.get("x-request-id") ?? headers?.get("openai-request-id"));
	return { ...(status !== undefined && { status }), ...(requestId !== undefined && { requestId }) };
}

// The SDK's APIError has no status for an SSE `error` event; `head` is the stream's own.
export function classifyError(error: unknown, head: ErrorFacts = {}): SiwcError {
	if (error instanceof SiwcError) return error;
	const record = isRecord(error) ? error : {};
	const status = typeof record.status === "number" ? record.status : undefined;
	const body = record.error;
	if (status === undefined && !isRecord(body)) {
		const name = error instanceof Error ? token(error.name) : undefined;
		return new SiwcError("STREAM_INTERRUPTED", { ...head, ...(name && { detail: name }) });
	}
	const headers = record.headers instanceof Headers ? record.headers : undefined;
	const facts = { ...(status === undefined && head), ...headFacts(status, headers) };
	// The broker's own refusal: nothing reached OpenAI, and the code says what to do.
	if (isRecord(body) && body.type === "broker_refused") {
		const own = typeof body.code === "string" && Object.hasOwn(OWN, body.code);
		const code = own ? (body.code as SiwcCode) : "BROKER_REFUSED";
		return new SiwcError(code, { ...facts, shape: "error-object" });
	}
	if (isRecord(body) && (status === undefined || "code" in body)) {
		const shape = status === undefined ? "event" : "error-object";
		return fromCode(body.code, { ...facts, shape, ...paramOf(body) });
	}
	const shape = isRecord(body) && "detail" in body ? "detail" : "none";
	return made(ADMISSION.get(status ?? 0) ?? byStatus(status), { ...facts, shape });
}
