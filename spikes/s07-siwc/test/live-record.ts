import type OpenAI from "openai";
import type { ResponseStreamEvent } from "openai/resources/responses/responses";
import {
	type Credential,
	type Endpoints,
	REGISTRATION_CLIENT,
	RESOURCE,
	type TokenResponse,
	type Tokens,
	tokenRequest,
} from "../src/auth.ts";
import { createBroker } from "../src/broker.ts";
import { classifyError, SiwcError } from "../src/errors.ts";
import {
	buildRequest,
	createClient,
	type DraftJob,
	runDraft,
	type Structure,
} from "../src/responses.ts";
import { type CredentialStore, Session } from "../src/session.ts";

// What M0.27's live session records, for test/live-session.ts and the hub process
// (test/transfer-child.ts): names, shapes, sizes, codes and timings. Never a token, prompt or
// completion text, account ID or e-mail address. Request IDs stay raw here: only the session, which
// holds the HMAC key, writes them, hashed.

// Synthetic content: the live drafts answer this thread and nothing else.
export const LIVE_JOB: Pick<DraftJob, "instructions" | "prompt"> = {
	instructions: "Draft a short, friendly reply to the thread, in under 50 words.",
	prompt: "<thread>Hi! Are we still on for Tuesday at 10?</thread>",
};

export const liveJob = (model: string, structure: Structure): DraftJob => ({
	...LIVE_JOB,
	model,
	structure,
});

// src/verify.ts's model rule.
export const MODEL_SLUG: RegExp = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export const WITHHELD = "(withheld)";
const NAME = /^[A-Za-z][\w.:[\]/-]{0,99}$/;
const PATH = /^\/[\w./-]{0,99}$/;
const DETAIL = /^[A-Za-z][\w .:/-]{0,99}$/;
const noDigitRun = (text: string): boolean => !/\d{9}/.test(text);

// An upstream name (code, param, field, scope, claim, header, type), or WITHHELD.
export function name(value: unknown): string {
	return typeof value === "string" && NAME.test(value) && noDigitRun(value) ? value : WITHHELD;
}

export const pathName = (value: unknown): string =>
	typeof value === "string" && PATH.test(value) && noDigitRun(value) ? value : WITHHELD;

// SiwcError details are src/'s own phrases, such as "discovery: issuer".
export const detailText = (value: unknown): string =>
	typeof value === "string" && DETAIL.test(value) && noDigitRun(value) ? value : WITHHELD;

export const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const sorted = (values: Iterable<string>): string[] => [...new Set(values)].sort();
const keysOf = (value: unknown): string[] => (isRecord(value) ? sorted(Object.keys(value)) : []);
const kind = (value: unknown): string =>
	value === null ? "null" : Array.isArray(value) ? "array" : typeof value;

function decodePart(part: string | undefined): Record<string, unknown> | undefined {
	try {
		const value: unknown = JSON.parse(Buffer.from(part ?? "", "base64url").toString("utf8"));
		return isRecord(value) ? value : undefined;
	} catch {
		return undefined;
	}
}

// What src/id-token.ts checks an ID token's claims against.
export interface ClaimCheck {
	readonly issuer: string;
	readonly clientId: string;
}

// Yes or no for each claim an issuer, audience or authorized-party refusal turns on; never a value.
function claimFacts(claims: Record<string, unknown>, check: ClaimCheck): Record<string, boolean> {
	const audience: unknown[] = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
	return {
		audHasClientId: audience.includes(check.clientId),
		audHasDynamicAgentClient: audience.includes(REGISTRATION_CLIENT),
		audHasResource: audience.includes(RESOURCE),
		azpIsClientId: claims.azp === check.clientId,
		issIsIssuer: claims.iss === check.issuer,
	};
}

// A token's format and length; for a JWT, its header fields and claim names, never their values,
// and with a check, an ID token's facts.
export function tokenFormat(
	value: unknown,
	check?: ClaimCheck,
): Record<string, unknown> | undefined {
	if (typeof value !== "string") return undefined;
	const parts = value.split(".");
	const header = parts.length === 3 ? decodePart(parts[0]) : undefined;
	const claims = parts.length === 3 ? decodePart(parts[1]) : undefined;
	if (!header || !claims) return { format: "opaque", length: value.length };
	return {
		format: "jwt",
		length: value.length,
		alg: name(header.alg),
		typ: typeof header.typ === "string" ? name(header.typ) : null,
		kid: typeof header.kid === "string",
		claims: keysOf(claims).map(name),
		...("aud" in claims && { audType: kind(claims.aud) }),
		...(check && { facts: claimFacts(claims, check) }),
	};
}

// earliest_refresh_at is undocumented: its JSON type and how far ahead it points.
function refreshAt(value: unknown, now: number): Record<string, unknown> {
	if (typeof value === "number" && Number.isFinite(value)) {
		const unit = value > 1e11 ? "ms" : "s";
		const at = value * (unit === "s" ? 1000 : 1);
		return { type: "number", unit, inS: Math.round((at - now) / 1000) };
	}
	const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN;
	return {
		type: kind(value),
		...(Number.isNaN(parsed) ? {} : { inS: Math.round((parsed - now) / 1000) }),
	};
}

// A token endpoint answer, success or error; an ID token in it is checked against `check`.
export function tokenShape(
	body: unknown,
	now: number = Date.now(),
	check?: ClaimCheck,
): Record<string, unknown> {
	if (!isRecord(body)) return { json: false };
	const fields = keysOf(body);
	const shape: Record<string, unknown> = {
		fields: fields.map(name),
		types: Object.fromEntries(fields.map((field) => [name(field), kind(body[field])])),
	};
	if (typeof body.token_type === "string") shape.tokenType = name(body.token_type);
	if (typeof body.expires_in === "number") shape.expiresIn = body.expires_in;
	if (typeof body.scope === "string") {
		shape.scopes = sorted(body.scope.split(" ").filter(Boolean)).map(name);
	}
	if ("earliest_refresh_at" in body) {
		shape.earliestRefreshAt = refreshAt(body.earliest_refresh_at, now);
	}
	for (const [field, key] of [
		["access_token", "accessToken"],
		["refresh_token", "refreshToken"],
		["id_token", "idToken"],
	] as const) {
		const format = tokenFormat(body[field], field === "id_token" ? check : undefined);
		if (format) shape[key] = format;
	}
	const error = body.error;
	if (error !== undefined) {
		shape.error = isRecord(error)
			? { code: name(error.code), fields: keysOf(error).map(name) }
			: { code: name(error) };
		shape.description = typeof body.error_description === "string";
	}
	return shape;
}

const ENDPOINTS = ["authorization_endpoint", "token_endpoint", "revocation_endpoint", "jwks_uri"];
const LISTS = [
	"scopes_supported",
	"id_token_signing_alg_values_supported",
	"code_challenge_methods_supported",
	"grant_types_supported",
	"response_types_supported",
	"token_endpoint_auth_methods_supported",
];

// The discovery document: each endpoint's host, path and whether it shares the issuer's origin.
export function discoveryShape(doc: unknown, issuer: string): Record<string, unknown> {
	if (!isRecord(doc)) return { json: false };
	const origin = new URL(issuer).origin;
	const endpoint = (value: unknown): Record<string, unknown> => {
		if (typeof value !== "string" || !URL.canParse(value)) return { present: value !== undefined };
		const url = new URL(value);
		const query = url.search !== "";
		return {
			host: name(url.host),
			path: pathName(url.pathname),
			sameOrigin: url.origin === origin,
			query,
		};
	};
	const lists = LISTS.flatMap((field) => {
		const list = doc[field];
		return Array.isArray(list) ? [[field, sorted(list.map(name))]] : [];
	});
	return {
		issuerMatches: doc.issuer === issuer,
		endpoints: Object.fromEntries(ENDPOINTS.map((field) => [field, endpoint(doc[field])])),
		fields: keysOf(doc).map(name),
		...Object.fromEntries(lists),
	};
}

// A field a key leaves out reads "absent", apart from a value withheld as content-shaped.
export function jwksShape(doc: unknown): Record<string, unknown> {
	const keys = isRecord(doc) && Array.isArray(doc.keys) ? doc.keys.filter(isRecord) : undefined;
	if (!keys) return { json: isRecord(doc) };
	const field = (key: string): string[] =>
		sorted(keys.map((jwk) => (jwk[key] === undefined ? "absent" : name(jwk[key]))));
	return { keys: keys.length, kty: field("kty"), alg: field("alg"), use: field("use") };
}

export type AuthKind = "discovery" | "jwks" | "token" | "refresh" | "revocation" | "other";

export interface AuthCall {
	readonly kind: AuthKind;
	// 0: no answer.
	status: number;
	ms: number;
	headers?: readonly string[];
	requestId?: string;
	shape?: Record<string, unknown>;
}

const requestIdOf = (headers: Headers): string | undefined =>
	headers.get("x-request-id") ?? headers.get("openai-request-id") ?? undefined;

function authKind(method: string, url: URL, form: URLSearchParams | undefined): AuthKind {
	if (method === "GET") {
		return url.pathname.endsWith("/.well-known/openid-configuration") ? "discovery" : "jwks";
	}
	const grant = form?.get("grant_type");
	if (grant === "authorization_code") return "token";
	if (grant === "refresh_token") return "refresh";
	return form?.has("token_type_hint") ? "revocation" : "other";
}

const urlOf = (input: RequestInfo | URL): URL =>
	new URL(input instanceof Request ? input.url : String(input));

// The fetch for discovery, sign-in, refresh and revocation: each answer's shape, read from a clone
// before the caller sees the response. Given the issuer, an ID token gets its facts against it and
// the client ID its request named.
export function authRecorder(
	base: typeof fetch = fetch,
	issuer?: string,
): {
	readonly fetch: typeof fetch;
	readonly calls: AuthCall[];
} {
	const calls: AuthCall[] = [];
	const recorded = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const url = urlOf(input);
		const method = (
			init?.method ?? (input instanceof Request ? input.method : "GET")
		).toUpperCase();
		const form = typeof init?.body === "string" ? new URLSearchParams(init.body) : undefined;
		const call: AuthCall = { kind: authKind(method, url, form), status: 0, ms: 0 };
		calls.push(call);
		const started = performance.now();
		const response = await base(input, init);
		call.status = response.status;
		call.headers = sorted(response.headers.keys()).map(name);
		const requestId = requestIdOf(response.headers);
		if (requestId !== undefined) call.requestId = requestId;
		const copy = response.clone();
		if (call.kind === "revocation" || call.kind === "other") {
			const bytes = await copy.arrayBuffer().catch(() => new ArrayBuffer(0));
			call.shape = { bytes: bytes.byteLength };
		} else {
			const json: unknown = await copy.json().catch(() => undefined);
			const clientId = form?.get("client_id");
			const check = issuer !== undefined && clientId ? { issuer, clientId } : undefined;
			call.shape =
				call.kind === "discovery"
					? discoveryShape(json, url.href.replace(/\/\.well-known\/openid-configuration$/, ""))
					: call.kind === "jwks"
						? jwksShape(json)
						: tokenShape(json, Date.now(), check);
		}
		call.ms = Math.round(performance.now() - started);
		return response;
	};
	return { fetch: recorded as typeof fetch, calls };
}

export interface Chunks {
	readonly count: number;
	readonly bytes: number;
	readonly min: number;
	readonly max: number;
	readonly median: number;
	readonly firstChunkMs: number | null;
	// In arrival order, the first 400.
	readonly sizes: readonly number[];
}

export interface UpstreamCall {
	readonly method: string;
	readonly path: string;
	status: number;
	// To the response head.
	ms: number;
	headers?: readonly string[];
	// Values only for rate limits, retry-after and content-type (Conventions → Evidence); whole
	// numbers as numbers.
	values?: Readonly<Record<string, string | number>>;
	requestId?: string;
	errorBody?: Readonly<Record<string, unknown>>;
	// The body's chunk sizes as they arrived, and when the first one came.
	sizes?: number[];
	firstChunkMs?: number | null;
}

const KEPT_VALUE = /ratelimit|^retry-after$|^content-type$/;
const VALUE = /^[\w .,;:=/+-]{0,100}$/;
const MAX_SIZES = 400;
const NULL_BODY = new Set([101, 204, 205, 304]);

const headerValue = (value: string): string | number => {
	if (/^\d{1,15}$/.test(value)) return Number(value);
	return VALUE.test(value) ? value : WITHHELD;
};

export function chunkStats(call: UpstreamCall): Chunks | undefined {
	const sizes = call.sizes;
	if (sizes === undefined) return undefined;
	const order = [...sizes].sort((a, b) => a - b);
	return {
		count: sizes.length,
		bytes: sizes.reduce((sum, size) => sum + size, 0),
		min: order[0] ?? 0,
		max: order.at(-1) ?? 0,
		median: order[Math.floor(order.length / 2)] ?? 0,
		firstChunkMs: call.firstChunkMs ?? null,
		sizes: sizes.slice(0, MAX_SIZES),
	};
}

// An error body's field names and, for {"error": {...}}, the code, type and param it has.
export function errorBodyShape(body: unknown): Record<string, unknown> {
	if (!isRecord(body)) return { json: false };
	const error = isRecord(body.error) ? body.error : undefined;
	const named = (key: string) =>
		error && key in error ? { [key]: error[key] === null ? null : name(error[key]) } : {};
	return {
		fields: keysOf(body).map(name),
		...(error && {
			error: {
				fields: keysOf(error).map(name),
				...named("code"),
				...named("type"),
				...named("param"),
			},
		}),
	};
}

// The broker's upstream fetch: the status, header names, the body's chunk sizes as they arrive, and
// an error body's shape.
export function upstreamRecorder(base: typeof fetch = fetch): {
	readonly fetch: typeof fetch;
	readonly calls: UpstreamCall[];
} {
	const calls: UpstreamCall[] = [];
	const recorded = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const url = urlOf(input);
		const method = (
			init?.method ?? (input instanceof Request ? input.method : "GET")
		).toUpperCase();
		const known = url.pathname === "/v1/responses" || url.pathname === "/v1/models";
		const call: UpstreamCall = { method, path: known ? url.pathname : "(other)", status: 0, ms: 0 };
		calls.push(call);
		const started = performance.now();
		const response = await base(input, init);
		call.status = response.status;
		call.ms = Math.round(performance.now() - started);
		call.headers = sorted(response.headers.keys()).map(name);
		const values = [...response.headers].filter(([header]) => KEPT_VALUE.test(header));
		call.values = Object.fromEntries(
			values.map(([header, value]) => [name(header), headerValue(value)]),
		);
		const requestId = requestIdOf(response.headers);
		if (requestId !== undefined) call.requestId = requestId;
		if (response.status >= 400) {
			call.errorBody = errorBodyShape(
				await response
					.clone()
					.json()
					.catch(() => undefined),
			);
		}
		if (response.body === null || NULL_BODY.has(response.status)) return response;
		const sizes: number[] = [];
		call.sizes = sizes;
		call.firstChunkMs = null;
		const counted = response.body.pipeThrough(
			new TransformStream<Uint8Array, Uint8Array>({
				transform(chunk, controller) {
					call.firstChunkMs ??= Math.round(performance.now() - started);
					sizes.push(chunk.byteLength);
					controller.enqueue(chunk);
				},
			}),
		);
		const { status, statusText, headers } = response;
		return new Response(counted, { status, statusText, headers });
	};
	return { fetch: recorded as typeof fetch, calls };
}

export interface EventSummary {
	readonly counts: Readonly<Record<string, number>>;
	readonly deltas: number;
	readonly deltaChars: number;
	readonly firstDeltaMs: number | null;
	readonly model: string | null;
	// response.completed: whether its output repeats what was streamed (store: false), its function
	// calls' names and usage.
	readonly completed: Readonly<Record<string, unknown>> | null;
	// An error inside the stream (`error`, `response.failed`): its field names.
	readonly failure: Readonly<Record<string, unknown>> | null;
}

// A function_call output item: its name, its namespace ("absent" without one) and its field names,
// never its arguments.
const callShape = (item: Record<string, unknown>): Record<string, unknown> => ({
	name: name(item.name),
	namespace:
		item.namespace === undefined ? "absent" : item.namespace === null ? null : name(item.namespace),
	fields: keysOf(item).map(name),
});

function completedShape(response: unknown): Record<string, unknown> {
	const record = isRecord(response) ? response : {};
	const output = Array.isArray(record.output) ? record.output.filter(isRecord) : [];
	let chars = 0;
	for (const item of output) {
		if (typeof item.arguments === "string") chars += item.arguments.length;
		for (const part of Array.isArray(item.content) ? item.content.filter(isRecord) : []) {
			if (typeof part.text === "string") chars += part.text.length;
		}
	}
	const usage = isRecord(record.usage) ? record.usage : undefined;
	const count = (value: unknown, key: string): number | null =>
		isRecord(value) && typeof value[key] === "number" ? value[key] : null;
	return {
		status: name(record.status),
		outputTypes: output.map((item) => name(item.type)),
		functionCalls: output.filter((item) => item.type === "function_call").map(callShape),
		repeatsOutput: chars > 0,
		outputChars: chars,
		fields: keysOf(record).map(name),
		usage: usage
			? {
					inputTokens: count(usage, "input_tokens"),
					outputTokens: count(usage, "output_tokens"),
					totalTokens: count(usage, "total_tokens"),
					cachedTokens: count(usage.input_tokens_details, "cached_tokens"),
					reasoningTokens: count(usage.output_tokens_details, "reasoning_tokens"),
				}
			: null,
	};
}

// Event types with their counts, delta sizes, the terminal event and any error event's shape.
export function eventStats(): {
	readonly add: (event: ResponseStreamEvent) => void;
	readonly summary: () => EventSummary;
} {
	const started = performance.now();
	const counts: Record<string, number> = {};
	let deltas = 0;
	let deltaChars = 0;
	let firstDeltaMs: number | null = null;
	let model: string | null = null;
	let completed: Record<string, unknown> | null = null;
	let failure: Record<string, unknown> | null = null;
	const add = (event: ResponseStreamEvent): void => {
		const record = event as unknown as Record<string, unknown>;
		const type = name(record.type);
		counts[type] = (counts[type] ?? 0) + 1;
		if (typeof record.delta === "string") {
			deltas++;
			deltaChars += record.delta.length;
			firstDeltaMs ??= Math.round(performance.now() - started);
		}
		const response = isRecord(record.response) ? record.response : undefined;
		if (typeof response?.model === "string") model = name(response.model);
		if (record.type === "response.completed") completed = completedShape(response);
		if (record.type === "error") failure = { event: type, fields: keysOf(record).map(name) };
		if (record.type === "response.failed") {
			failure = { event: type, fields: keysOf(response?.error).map(name) };
		}
	};
	const summary = (): EventSummary => ({
		counts: { ...counts },
		deltas,
		deltaChars,
		firstDeltaMs,
		model,
		completed,
		failure,
	});
	return { add, summary };
}

export interface ErrorRecord {
	readonly code: string;
	readonly plugin: string;
	readonly recovery: string;
	readonly status?: number;
	readonly apiCode?: string;
	readonly param?: string;
	readonly shape?: string;
	readonly detail?: string;
	readonly requestId?: string;
}

// SiwcError facts, never the issued client ID.
export function errorRecord(error: SiwcError): ErrorRecord {
	const { status, apiCode, param, shape, detail, requestId } = error.facts;
	return {
		code: error.code,
		plugin: error.plugin,
		recovery: error.recovery,
		...(status !== undefined && { status }),
		...(apiCode !== undefined && { apiCode: name(apiCode) }),
		...(param !== undefined && { param: name(param) }),
		...(shape !== undefined && { shape }),
		...(detail !== undefined && { detail: detailText(detail) }),
		...(requestId !== undefined && { requestId }),
	};
}

export type DraftOutcomeKind = "draft" | "invalid" | "refusal" | "incomplete" | "aborted" | "error";

export interface DraftRecord {
	readonly structure: Structure;
	readonly toolChoice: string | null;
	readonly outcome: DraftOutcomeKind;
	readonly ms: number;
	readonly via?: "text" | "tool";
	// The draft's sizes only.
	readonly draft?: Readonly<Record<string, number | boolean>>;
	readonly problems?: readonly string[];
	readonly reason?: string;
	readonly error?: ErrorRecord;
	readonly events: EventSummary;
}

function toolChoiceOf(job: DraftJob): string | null {
	const choice = buildRequest(job).tool_choice;
	if (typeof choice === "string") return choice;
	return isRecord(choice) ? `${name(choice.type)}:${name(choice.name)}` : null;
}

// One draft through the client (and so through the broker) as its content-free record. Only a
// SiwcError becomes a record; anything else is a bug and is thrown.
export async function draftOnce(
	client: OpenAI,
	job: DraftJob,
	signal?: AbortSignal,
): Promise<DraftRecord> {
	const stats = eventStats();
	const started = performance.now();
	const base = { structure: job.structure, toolChoice: toolChoiceOf(job) };
	const done = () => ({ ms: Math.round(performance.now() - started), events: stats.summary() });
	try {
		const outcome = await runDraft(client, job, { onEvent: stats.add, ...(signal && { signal }) });
		if (outcome.kind === "draft") {
			const { body, ownerNotes, needsOwnerInput, suspectedInstructions, contextRefs } =
				outcome.draft;
			const draft = {
				bodyChars: body.length,
				ownerNotesChars: ownerNotes.length,
				needsOwnerInput: needsOwnerInput.length,
				suspectedInstructions,
				contextRefs: contextRefs.length,
			};
			return { ...base, outcome: "draft", via: outcome.via, draft, ...done() };
		}
		if (outcome.kind === "invalid") {
			return { ...base, outcome: "invalid", problems: outcome.problems, ...done() };
		}
		if (outcome.kind === "incomplete") {
			return { ...base, outcome: "incomplete", reason: name(outcome.reason), ...done() };
		}
		return { ...base, outcome: outcome.kind, ...done() };
	} catch (error) {
		if (!(error instanceof SiwcError)) throw error;
		return { ...base, outcome: "error", error: errorRecord(error), ...done() };
	}
}

// One draft's limit, on the desktop and in the hub process.
export const DRAFT_TIMEOUT_MS = 120_000;
// A discovery or token request (src/auth.ts), and a revocation's three attempts with their backoff
// (src/session.ts).
const REQUEST_MS = 30_000;
const REVOKE_MS = 3 * REQUEST_MS + 3_000;
// The hub process's worst case: discovery, its draft (a refresh inside it included), its refresh,
// the revocation, then the check: the refresh tried again, a second revocation if that refresh
// worked, and the models call.
export const HUB_BUDGET_MS: number =
	REQUEST_MS +
	(DRAFT_TIMEOUT_MS + REQUEST_MS) +
	REQUEST_MS +
	REVOKE_MS +
	(REQUEST_MS + REVOKE_MS + REQUEST_MS);

// Refusals that name the refresh token itself as invalid. Expiry doesn't prove a revocation, and
// neither does reuse: a token rotated away is refused whether or not its session was revoked.
export const CONFIRMING: ReadonlySet<string> = new Set([
	"invalid_grant",
	"invalid_refresh_token",
	"refresh_token_invalidated",
]);

// A revoked refresh token, tried once more. A refresh that still works is revoked again at once,
// and its tokens are never used.
export async function probeRefresh(
	endpoints: Endpoints,
	clientId: string,
	refreshToken: string,
	fetcher: typeof fetch = fetch,
): Promise<Record<string, unknown>> {
	const form = {
		grant_type: "refresh_token",
		client_id: clientId,
		refresh_token: refreshToken,
		resource: RESOURCE,
	};
	let fresh: TokenResponse;
	try {
		fresh = await tokenRequest(endpoints.token, form, fetcher);
	} catch (error) {
		const facts = error instanceof SiwcError ? error.facts : {};
		return {
			accepted: false,
			code: error instanceof SiwcError ? error.code : "ERROR",
			...(facts.status !== undefined && { status: facts.status }),
			...(facts.apiCode !== undefined && { apiCode: name(facts.apiCode) }),
		};
	}
	const current = fresh.refreshToken ?? refreshToken;
	const again = await revokeRefreshToken(endpoints, clientId, current, fetcher);
	return { accepted: true, revokedAgain: again };
}

export type Revoked = "yes" | `no(${string})`;

// The endpoint's 200 alone proves nothing (Accounts and sessions: it also answers an already-invalid
// token), so a revocation counts only once the revoked refresh token is refused as invalid.
export function revocationVerdict(revoked: boolean, probe: unknown): Revoked {
	if (!revoked) return "no(revocation unconfirmed)";
	if (!isRecord(probe)) return "no(revocation unconfirmed: not tried again)";
	if (probe.accepted === true) return "no(the revoked refresh token still works)";
	const code = name(probe.code);
	const apiCode = probe.apiCode === undefined ? undefined : name(probe.apiCode);
	if (code === "REAUTH_REQUIRED" && apiCode !== undefined && CONFIRMING.has(apiCode)) return "yes";
	return `no(revocation unconfirmed: probe ${[code, apiCode].filter(Boolean).join(":")})`;
}

export interface Confirmation {
	// The revocation endpoint's 200, retries included.
	readonly revoked: boolean;
	// The refresh token tried once more; only after a 200, so a token kept for another try stays
	// the one that works.
	readonly probe: Readonly<Record<string, unknown>> | null;
	readonly verdict: Revoked;
}

export async function revokeAndConfirm(
	endpoints: Endpoints,
	clientId: string,
	refreshToken: string,
	fetcher: typeof fetch = fetch,
): Promise<Confirmation> {
	const revoked = await revokeRefreshToken(endpoints, clientId, refreshToken, fetcher);
	if (!revoked) return { revoked, probe: null, verdict: revocationVerdict(false, null) };
	const probe = await probeRefresh(endpoints, clientId, refreshToken, fetcher);
	return { revoked, probe, verdict: revocationVerdict(true, probe) };
}

// After a revocation: the revoked refresh token is tried once more (probeRefresh), and so is the
// access token, which the docs don't say revocation ends.
export async function afterRevocation(
	tokens: Pick<Tokens, "accessToken" | "refreshToken">,
	clientId: string,
	endpoints: Endpoints,
	apiOrigin: string,
	fetcher: typeof fetch = fetch,
	apiFetch: typeof fetch = fetch,
): Promise<Record<string, unknown>> {
	const refresh = await probeRefresh(endpoints, clientId, tokens.refreshToken, fetcher);
	const broker = createBroker({
		token: async () => tokens.accessToken,
		upstream: apiOrigin,
		fetch: apiFetch,
	});
	const models = await createClient(broker.fetch)
		.get("/models", { signal: AbortSignal.timeout(30_000) })
		.then(
			() => ({ status: 200 }),
			(error: unknown) => {
				const refused = classifyError(error);
				return { status: refused.facts.status ?? 0, code: refused.code };
			},
		);
	return { refresh, models };
}

// Revokes one refresh token the way Session.revoke() does, retries included; true when confirmed.
export function revokeRefreshToken(
	endpoints: Endpoints,
	clientId: string,
	refreshToken: string,
	fetcher: typeof fetch = fetch,
): Promise<boolean> {
	let held: Credential | null = {
		issuer: endpoints.issuer,
		clientId,
		subject: "",
		hostId: "",
		tokens: { accessToken: "", refreshToken, scopes: [], expiresAt: 0, savedAt: 0 },
	};
	const store: CredentialStore = {
		read: async () => held,
		write: async (next) => {
			held = next;
		},
	};
	return new Session(store, endpoints, { fetch: fetcher }).revoke();
}
