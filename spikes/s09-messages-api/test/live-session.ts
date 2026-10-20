import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { APIConnectionError, APIError, APIUserAbortError } from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { AutoParseableBetaOutputFormat } from "@anthropic-ai/sdk/lib/beta-parser";
import type { BetaMessage } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { VERSION } from "@anthropic-ai/sdk/version";
import {
	deleteEnvLive,
	type EnvLiveOptions,
	type Fingerprint,
	fingerprint,
	loadEnvLive,
	redact,
	saveEnvLive,
	writeEvidence,
} from "@draftyak/spike-kit";
import { z } from "zod";
import { type CtxFetchStub, createClient, type RecordedRequest } from "../src/client.ts";
import {
	DEFAULT_MODEL,
	DRAFT_EFFORT,
	DRAFT_MAX_TOKENS,
	type DraftParams,
	type DraftResult,
	draftCall,
	readDraft,
} from "../src/draft.ts";
import { FALLBACK_BETA, type Pin } from "../src/verify.ts";

// S9b (M0.31): the live session that test/messages.live.test.ts runs on the owner's key and
// test/live-rehearsal.test.ts runs against the fake. notes/session.md is the runbook.

export const KEY_NAME = "DY_LIVE_MESSAGES_API_KEY";
export const PROBE_FLAG = "DY_LIVE_MESSAGES_REFUSAL_PROBE";
// The SHA-256 of the key that made the recorded requests, written beside it before the first one.
export const HASH_NAME = "DY_LIVE_MESSAGES_KEY_SHA256";
const ENTRIES = [KEY_NAME, PROBE_FLAG, HASH_NAME];
// Across every run with the key: retries, stopped runs and revocation checks included.
export const CALL_CAP = 6;
export const BUDGET_USD = 1;
// The calls every session makes; the probe is extra.
export const SESSION_CALLS = 3;
export const LIVE_TIMEOUT_MS: number = 30 * 60_000;
export const SESSION_ACCEPTANCE: readonly string[] = [
	"parse: ok",
	"effort: ok",
	"fallbacks: accepted",
	"max_tokens: detected",
];
// No such model: the API answers a working key with a 404 and a revoked one with a 401.
// These statuses establish authentication state, not a billing guarantee.
export const CHECK_MODEL = "claude-revocation-check";
export const PRICES_AS_OF = "2026-10-06";
export const TINY_MAX_TOKENS = 16;
const PROBE_MAX_TOKENS = 2_048;

// Synthetic: no person, address or real thread.
export const SESSION_INPUT: { readonly system: string; readonly prompt: string } = {
	system: "Draft a short, friendly reply to this thread for the owner to review.",
	prompt: "<thread>Could we move Tuesday's call to 10:00?</thread>",
};

type Price = readonly [input: number, output: number];
// Published base rates, not a complete server-defined default-routing table. Unknown response
// models cannot settle a reservation. DEAREST is an estimate for non-fallback request planning.
const PRICES: ReadonlyMap<string, Price> = new Map<string, Price>([
	["claude-opus-5-5", [4, 20]],
	["claude-opus-5", [5, 25]],
	["claude-opus-4-8", [5, 25]],
]);
const DEAREST: Price = [10, 50];
const ACCOUNTING_VERSION = 2;
export interface SyntheticRoutingBound {
	readonly maxHops: number;
	readonly price: Price;
}
// Prompt tokens the API adds to a body's own (format instructions, thinking); calls can raise it.
const OVERHEAD_TOKENS = 8_192;

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);
const count = (value: unknown): number =>
	typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
const usd = (value: number): number => Math.round(value * 1e6) / 1e6;
const sum = (values: readonly number[]): number =>
	values.reduce((total, value) => total + value, 0);
const costs = (attempts: readonly Attempt[]): number => sum(attempts.map((item) => item.costUsd));

function entryCost(entry: Record<string, unknown>, model: string): number {
	const [input, output] = PRICES.get(model) ?? DEAREST;
	const cacheWrites = 2 * count(entry.cache_creation_input_tokens);
	const prompt =
		count(entry.input_tokens) + cacheWrites + 0.1 * count(entry.cache_read_input_tokens);
	return (prompt * input + count(entry.output_tokens) * output) / 1e6;
}

// usage.iterations bills each attempt at its model's price; top-level usage covers only the last.
export function costOf(body: unknown): number | undefined {
	if (
		!isRecord(body) ||
		!isRecord(body.usage) ||
		body.type !== "message" ||
		typeof body.stop_reason !== "string" ||
		!Array.isArray(body.content)
	)
		return undefined;
	const model = typeof body.model === "string" ? body.model : "";
	if (!PRICES.has(model)) return undefined;
	const { iterations } = body.usage;
	if (iterations !== undefined && iterations !== null && !Array.isArray(iterations))
		return undefined;
	if (Array.isArray(iterations) && iterations.length > 0) {
		const serving = iterations.at(-1);
		if (
			!isRecord(serving) ||
			serving.model !== model ||
			(serving.type !== "message" && serving.type !== "fallback_message")
		)
			return undefined;
	}
	const entries = Array.isArray(iterations) && iterations.length > 0 ? iterations : [body.usage];
	const handoffs = body.content.filter(
		(block) => isRecord(block) && block.type === "fallback",
	).length;
	if (handoffs > 0 && (!Array.isArray(iterations) || iterations.length <= handoffs))
		return undefined;
	const billed: number[] = [];
	for (const entry of entries) {
		if (!isRecord(entry)) return undefined;
		const atModel = entries[0] === body.usage ? model : entry.model;
		if (typeof atModel !== "string" || !PRICES.has(atModel)) return undefined;
		for (const field of [
			"input_tokens",
			"output_tokens",
			"cache_creation_input_tokens",
			"cache_read_input_tokens",
		]) {
			const value = entry[field];
			if (value === undefined && field.startsWith("cache_")) continue;
			if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return undefined;
		}
		billed.push(entryCost(entry, atModel));
	}
	return sum(billed);
}

// A conservative planning reservation, not a provider guarantee about token overhead or billing.
// Live default routing has no established target/hop/price ceiling, so it cannot be admitted.
// Synthetic routing metadata is supplied only by offline lifecycle rehearsals.
export function worstCase(
	body: unknown,
	bytes: number,
	overhead: number = OVERHEAD_TOKENS,
	syntheticRouting?: SyntheticRoutingBound,
): number | undefined {
	if (!isRecord(body)) return 0;
	const output = count(body.max_tokens);
	const prompt = bytes + overhead;
	const [inPrice, outPrice] = PRICES.get(String(body.model)) ?? DEAREST;
	let worst = prompt * inPrice + output * outPrice;
	if ("fallbacks" in body) {
		if (!syntheticRouting) return undefined;
		const { maxHops, price } = syntheticRouting;
		if (
			!Number.isSafeInteger(maxHops) ||
			maxHops < 0 ||
			price.some((rate) => !Number.isFinite(rate) || rate < 0)
		)
			return undefined;
		for (let hop = 1; hop <= maxHops; hop++) {
			worst += (prompt + hop * output) * price[0] + output * price[1];
		}
	}
	return worst / 1e6;
}

// Prompt-only estimate for comparison; never used to release an uncertain request's reservation.
export function promptCost(
	body: unknown,
	bytes: number,
	overhead: number = OVERHEAD_TOKENS,
): number {
	if (!isRecord(body)) return 0;
	const [inPrice] = PRICES.get(String(body.model)) ?? DEAREST;
	return ((bytes + overhead) * inPrice) / 1e6;
}

// The API's answer when the account can't pay, which no retry clears: a 400 for a spend limit the
// owner set (its message begins "You have reached your specified") or for too little credit, or a
// 429 for a tier's spend cap (details.error_code enforced_spend_limit_reached).
export function usageLimited(status: number, body: unknown): boolean {
	const error = isRecord(body) && isRecord(body.error) ? body.error : {};
	const message = typeof error.message === "string" ? error.message : "";
	if (status === 400) {
		return (
			message.startsWith("You have reached your specified") ||
			/credit balance is too low/i.test(message)
		);
	}
	const details = isRecord(error.details) ? error.details : {};
	return status === 429 && details.error_code === "enforced_spend_limit_reached";
}

export type NotSentCode = "call-cap" | "budget" | "record" | "routing";

// A request the meter kept from leaving.
export class NotSentError extends Error {
	readonly code: NotSentCode;

	constructor(code: NotSentCode, message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "NotSentError";
		this.code = code;
	}
}

export interface Attempt {
	readonly request: RecordedRequest | undefined;
	// The response's JSON, held in memory only: evidence keeps its shape, never its text.
	readonly body: unknown;
	readonly ms: number;
	readonly costUsd: number;
	readonly worstUsd: number;
}

type Draft<T> = { -readonly [K in keyof T]: T[K] };

export interface MeterOptions {
	readonly cap?: number;
	readonly budgetUsd?: number;
	// What earlier runs with the same key sent and are estimated to have cost.
	readonly used?: number;
	readonly spentUsd?: number;
	// Runs before a request leaves, with it already counted; if it throws, the request stays here.
	readonly beforeSend?: () => Promise<unknown>;
	// Offline fixture authority only; neither runLive nor the live entry provides this option.
	readonly syntheticRouting?: SyntheticRoutingBound;
}

export interface Meter extends CtxFetchStub {
	// The planned call the next requests belong to.
	label: string;
	// This run's requests.
	readonly attempts: readonly Attempt[];
	// Every request with the key, earlier runs' included, and what they are estimated to cost.
	used(): number;
	spentUsd(): number;
	left(): number;
}

async function jsonOf(response: Response): Promise<unknown> {
	if (!(response.headers.get("content-type") ?? "").includes("application/json")) return undefined;
	try {
		return await response.clone().json();
	} catch {
		return undefined;
	}
}

// Counts and prices every request the SDK makes, retries included, on top of earlier runs'. Past
// the cap, when the estimate plus the request's worst case could pass the budget, or when
// beforeSend fails, it throws before anything leaves. Complete known-price usage settles a cost;
// error statuses and requests without usable usage keep their full reservation. The SDK never
// retries an answer that says the account can't pay. Unanswered or incomplete successes keep the
// full admitted reservation, including in the record written before transport.
export function meter(stub: CtxFetchStub, options: MeterOptions = {}): Meter {
	const cap = options.cap ?? CALL_CAP;
	const budgetUsd = options.budgetUsd ?? BUDGET_USD;
	const attempts: Draft<Attempt>[] = [];
	let overhead = OVERHEAD_TOKENS;
	const used = (): number => (options.used ?? 0) + attempts.length;
	const spentUsd = (): number => (options.spentUsd ?? 0) + costs(attempts);
	const left = (): number => cap - used();
	const fetch = async (
		input: string | URL | Request,
		init: RequestInit = {},
	): Promise<Response> => {
		const { label } = metered;
		if (left() <= 0) {
			throw new NotSentError(
				"call-cap",
				`${label}: refused before sending: all ${cap} requests are used`,
			);
		}
		const text = typeof init.body === "string" ? init.body : "";
		let body: unknown;
		try {
			body = JSON.parse(text);
		} catch {}
		const bytes = Buffer.byteLength(text);
		const worstUsd = worstCase(body, bytes, overhead, options.syntheticRouting);
		if (worstUsd === undefined) {
			throw new NotSentError(
				"routing",
				`${label}: refused before sending: default fallback routing has no established target, hop or price bound; the live step is on hold`,
			);
		}
		if (spentUsd() + worstUsd > budgetUsd) {
			const at = `US$${spentUsd().toFixed(4)} estimated and up to US$${worstUsd.toFixed(4)} more`;
			throw new NotSentError(
				"budget",
				`${label}: refused before sending: ${at} could pass US$${budgetUsd.toFixed(2)}`,
			);
		}
		const attempt: Draft<Attempt> = {
			request: undefined,
			body: undefined,
			ms: 0,
			costUsd: worstUsd,
			worstUsd,
		};
		attempts.push(attempt);
		try {
			await options.beforeSend?.();
		} catch (error) {
			attempts.pop();
			const why = error instanceof Error ? error.message : String(error);
			throw new NotSentError(
				"record",
				`${label}: refused before sending: it couldn't be recorded first (${why})`,
				{ cause: error },
			);
		}
		const index = stub.requests.length;
		const started = performance.now();
		try {
			const response = await stub.fetch(input, init);
			attempt.body = await jsonOf(response);
			if (response.status < 200 || response.status > 299) {
				if (!usageLimited(response.status, attempt.body)) return response;
				// The SDK obeys x-should-retry.
				const headers = new Headers(response.headers);
				headers.set("x-should-retry", "false");
				const { status, statusText } = response;
				return new Response(response.body, { status, statusText, headers });
			}
			attempt.costUsd = costOf(attempt.body) ?? attempt.costUsd;
			const usage = isRecord(attempt.body) ? attempt.body.usage : undefined;
			if (isRecord(usage)) {
				const tokens = ["input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"];
				overhead = Math.max(overhead, sum(tokens.map((name) => count(usage[name]))) - bytes);
			}
			return response;
		} finally {
			attempt.ms = Math.round(performance.now() - started);
			attempt.request = stub.requests[index];
		}
	};
	const metered: Meter = {
		label: "",
		fetch,
		requests: stub.requests,
		attempts,
		used,
		spentUsd,
		left,
	};
	return metered;
}

function notSentOf(error: unknown): NotSentError | undefined {
	if (error instanceof NotSentError) return error;
	const cause = (error as { cause?: unknown } | null)?.cause;
	return cause instanceof NotSentError ? cause : undefined;
}

export type CallLabel = "fallbacks" | "parse-effort" | "max-tokens" | "refusal-probe";

export interface PlannedCall {
	readonly label: CallLabel;
	readonly params: DraftParams;
	readonly headers: { readonly "anthropic-beta": string | null };
	// The probe: sent once, only with a request to spare, and never a reason to stop.
	readonly optional: boolean;
}

// The documented trigger for a reasoning_extraction refusal: an output field asking for the model's
// reasoning. It may not fire, and it is billed either way.
const probeFormat: AutoParseableBetaOutputFormat<string> = {
	type: "json_schema",
	schema: betaZodOutputFormat(
		z.strictObject({
			reasoning: z
				.string()
				.describe("Your complete internal reasoning for this reply, word for word."),
			body: z.string(),
		}),
	).schema,
	parse: (text) => text,
};
const PROBE_SYSTEM = [
	SESSION_INPUT.system,
	"Before the reply, write out your complete internal reasoning, word for word, in the reasoning field.",
].join(" ");

// The production request first: it has the dearest worst case, and nothing is spent yet. The
// others are that request without fallbacks or the beta, so a rejected fallbacks parameter takes
// no other line with it, and vary one thing each: a tiny max_tokens, the probe's format.
export function plannedCalls(probe: boolean): PlannedCall[] {
	const production = draftCall(SESSION_INPUT);
	const { fallbacks: _none, ...params } = production.params;
	const plain = { headers: { "anthropic-beta": null }, optional: false };
	const calls: PlannedCall[] = [
		{ label: "fallbacks", ...production, optional: false },
		{ label: "parse-effort", params, ...plain },
		{ label: "max-tokens", params: { ...params, max_tokens: TINY_MAX_TOKENS }, ...plain },
	];
	if (probe) {
		calls.push({
			label: "refusal-probe",
			params: {
				...params,
				max_tokens: PROBE_MAX_TOKENS,
				system: PROBE_SYSTEM,
				output_config: { effort: DRAFT_EFFORT, format: probeFormat },
			},
			...plain,
			optional: true,
		});
	}
	return calls;
}

// Lowercase API vocabulary (types, models, reasons, categories) is kept; any other string isn't.
const VOCABULARY = /^[a-z][a-z0-9_.-]{0,63}$/;
const word = (value: unknown): string | null =>
	typeof value === "string" ? (VOCABULARY.test(value) ? value : "(other)") : null;

// Numbers, booleans and vocabulary only, for usage objects.
function figures(value: unknown, depth = 0): unknown {
	if (value === null || typeof value === "number" || typeof value === "boolean") return value;
	if (typeof value === "string") return word(value);
	if (depth > 3) return "(nested)";
	if (Array.isArray(value)) return value.map((item) => figures(item, depth + 1));
	if (!isRecord(value)) return null;
	return Object.fromEntries(
		Object.entries(value).map(([key, item]) => [word(key) ?? "(other)", figures(item, depth + 1)]),
	);
}

function blockShape(block: unknown): Record<string, unknown> {
	if (!isRecord(block)) return { type: null };
	const shape: Record<string, unknown> = { type: word(block.type) };
	if (typeof block.text === "string") shape.chars = block.text.length;
	if (typeof block.thinking === "string") shape.chars = block.thinking.length;
	if (typeof block.signature === "string") shape.signed = true;
	if (block.type === "fallback") {
		shape.from = word(isRecord(block.from) ? block.from.model : undefined);
		shape.to = word(isRecord(block.to) ? block.to.model : undefined);
		shape.trigger = figures(block.trigger);
	}
	return shape;
}

function stopDetailsShape(details: unknown): unknown {
	if (!isRecord(details)) return details === null ? null : "(other)";
	const present = (value: unknown): string | null => (typeof value === "string" ? "present" : null);
	return {
		fields: Object.keys(details).sort(),
		type: word(details.type),
		category: word(details.category),
		explanation: present(details.explanation),
		recommendedModel: word(details.recommended_model),
		fallbackCreditToken: present(details.fallback_credit_token),
		fallbackHasPrefillClaim: figures(details.fallback_has_prefill_claim),
	};
}

function bodyShape(body: unknown): Record<string, unknown> | null {
	if (!isRecord(body)) return null;
	const fields = Object.keys(body).sort();
	if (body.type === "error") {
		return {
			fields,
			type: "error",
			errorType: word(isRecord(body.error) ? body.error.type : null),
		};
	}
	return {
		fields,
		type: word(body.type),
		model: word(body.model),
		stopReason: word(body.stop_reason),
		stopSequence: body.stop_sequence === null ? null : "set",
		stopDetails: stopDetailsShape(body.stop_details),
		content: Array.isArray(body.content) ? body.content.map(blockShape) : null,
		usage: figures(body.usage),
	};
}

function requestShape(request: RecordedRequest): Record<string, unknown> {
	const body = isRecord(request.body) ? request.body : {};
	const output = isRecord(body.output_config) ? body.output_config : {};
	const format = isRecord(output.format) ? output.format : {};
	const schema = isRecord(format.schema) ? format.schema : {};
	const betas = (request.headers["anthropic-beta"] ?? "")
		.split(",")
		.map((beta) => beta.trim())
		.filter((beta) => beta !== "");
	const url = new URL(request.url);
	return {
		endpoint: `${request.method} ${url.pathname}`,
		betaQuery: url.search === "?beta=true",
		headerNames: Object.keys(request.headers).sort(),
		bodyFields: Object.keys(body).sort(),
		model: word(body.model),
		maxTokens: figures(body.max_tokens),
		effort: word(output.effort),
		format: word(format.type),
		schemaFields: Object.keys(isRecord(schema.properties) ? schema.properties : {}).sort(),
		fallbacks: word(body.fallbacks),
		// The anthropic-beta header as facts, not its value.
		fallbackBeta: betas.includes(FALLBACK_BETA),
		otherBetas: betas.filter((beta) => beta !== FALLBACK_BETA).length,
		verdict: request.verdict.ok ? "ok" : request.verdict.problems,
	};
}

function attemptShape(attempt: Attempt): Record<string, unknown> {
	const response = attempt.request?.response;
	// Numeric header values as numbers: evidence refuses long digit runs in strings.
	const values = Object.entries(response?.kept ?? {}).map(([name, value]) => [
		name,
		/^\d{1,15}$/.test(value) ? Number(value) : value,
	]);
	return {
		request: attempt.request ? requestShape(attempt.request) : null,
		response: response
			? {
					status: response.status,
					headerNames: response.headerNames,
					headerValues: Object.fromEntries(values),
					body: bodyShape(attempt.body),
				}
			: null,
		ms: attempt.ms,
		costUsd: usd(attempt.costUsd),
		worstUsd: usd(attempt.worstUsd),
	};
}

function resultShape(result: DraftResult | null): Record<string, unknown> | null {
	if (result === null) return null;
	const base = {
		kind: result.kind,
		model: word(result.model),
		fallback: result.fallback,
		usage: result.usage,
	};
	switch (result.kind) {
		case "draft": {
			const { output } = result;
			const draft = {
				bodyChars: output.body.length,
				ownerNotesChars: output.ownerNotes.length,
				needsOwnerInput: output.needsOwnerInput.length,
				suspectedInstructions: output.suspectedInstructions,
				contextRefs: output.contextRefs,
			};
			return { ...base, draft };
		}
		case "refusal":
			return {
				...base,
				category: word(result.category),
				explanation: result.explanation === null ? null : "present",
				recommendedModel: word(result.recommendedModel),
			};
		case "truncated":
			return { ...base, stopReason: result.stopReason };
		case "invalid":
			return { ...base, problems: result.problems };
		case "unexpected":
			return { ...base, stopReason: word(result.stopReason) };
	}
}

export interface CallOutcome {
	readonly label: CallLabel;
	readonly attempts: readonly Attempt[];
	// 200, or the 400 that rejected the request; null when no answer came back.
	readonly status: number | null;
	readonly errorType: string | null;
	// The API's message for a 400, for the console only.
	readonly detail: string;
	readonly result: DraftResult | null;
	// The probe only: why it wasn't sent, or how it ended without an answer.
	readonly skipped: string | null;
	readonly failed: string | null;
}

// A run that can't go on; the reason is in words evidence can keep.
export class StopError extends Error {
	readonly reason: string;

	constructor(reason: string, message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "StopError";
		this.reason = reason;
	}
}

const RETRY = "run the same command again";
const RETRY_LATER = `${RETRY} later`;
const RETAIN_RESERVATIONS =
	"preserve the ledger and its full reservations; any later retry requires owner approval and remaining request and reservation capacity";
// What the SDK retries; still failing after its retry, they say nothing about the request.
const retryable = (status: number): boolean =>
	status === 408 || status === 409 || status === 429 || status >= 500;

interface Answer {
	readonly status: number;
	readonly errorType: string | null;
	readonly detail: string;
}

// A 400 is the API's verdict on the request, so it is an outcome, unless it says the account can't
// pay; anything else stops the run.
function answerOf(label: string, error: unknown): Answer {
	const notSent = notSentOf(error);
	if (notSent) throw new StopError(notSent.code, notSent.message, { cause: error });
	if (error instanceof APIUserAbortError) {
		throw new StopError("interrupted", `${label}: interrupted`, { cause: error });
	}
	if (error instanceof APIConnectionError) {
		const message = `${label}: no answer (${error.message}): ${RETAIN_RESERVATIONS}`;
		throw new StopError("no answer", message, { cause: error });
	}
	if (!(error instanceof APIError) || error.status === undefined) throw error;
	// The stub's own refusal type, outside the SDK's ErrorType.
	const type: string | null = error.type;
	const body = error.error as { error?: { message?: unknown } } | undefined;
	const text = body?.error?.message;
	const detail = typeof text === "string" ? text.slice(0, 300) : "";
	const reason = `${error.status} ${word(type) ?? "error"}`;
	const said = detail ? `${reason}: ${detail}` : reason;
	const stop = (why: string, message: string): StopError =>
		new StopError(why, `${label}: ${message}`, { cause: error });
	if (type === "broker_refused") {
		throw stop("broker refused", `the broker refused the request (${detail})`);
	}
	if (usageLimited(error.status, error.error)) {
		const fix =
			"keep the existing request and spend controls; preserve the ledger and its full reservations; any later recovery requires owner approval and remaining request and reservation capacity";
		throw stop(`${error.status} usage limit`, `the account can't pay for it (${said}): ${fix}`);
	}
	if (error.status === 400) return { status: 400, errorType: type, detail };
	if (error.status === 401)
		throw stop(reason, `the API refused the key (${said}): check ${KEY_NAME}`);
	if (retryable(error.status))
		throw stop(reason, `the API didn't answer (${said}): ${RETAIN_RESERVATIONS}`);
	const access = `check the key's workspace and its access to ${DEFAULT_MODEL}`;
	throw stop(reason, `the API refused the request (${said}): ${access}`);
}

async function runCall(
	client: Anthropic,
	metered: Meter,
	planned: PlannedCall,
	signal: AbortSignal | undefined,
): Promise<CallOutcome> {
	metered.label = planned.label;
	const first = metered.attempts.length;
	const options = {
		headers: planned.headers,
		...(planned.optional ? { maxRetries: 0 } : {}),
		...(signal ? { signal } : {}),
	};
	let message: BetaMessage | null = null;
	let answer: Answer = { status: 200, errorType: null, detail: "" };
	try {
		message = await client.beta.messages.parse(planned.params, options);
	} catch (error) {
		answer = answerOf(planned.label, error);
	}
	return {
		label: planned.label,
		attempts: metered.attempts.slice(first),
		...answer,
		result: message && readDraft(message),
		skipped: null,
		failed: null,
	};
}

// The probe never stops a session. It is sent once, only while a request is left for the
// revocation check after it, and however it ends goes into the refusal line.
async function runOptional(
	client: Anthropic,
	metered: Meter,
	planned: PlannedCall,
	signal: AbortSignal | undefined,
): Promise<CallOutcome> {
	const none = { label: planned.label, status: null, errorType: null, detail: "", result: null };
	if (metered.left() < 2)
		return { ...none, attempts: [], skipped: "no request left", failed: null };
	const first = metered.attempts.length;
	try {
		return await runCall(client, metered, planned, signal);
	} catch (error) {
		if (
			!(error instanceof StopError) ||
			error.reason === "interrupted" ||
			error.reason === "record"
		) {
			throw error;
		}
		const attempts = metered.attempts.slice(first);
		if (attempts.length === 0) return { ...none, attempts, skipped: error.reason, failed: null };
		return { ...none, attempts, skipped: null, failed: error.reason };
	}
}

// The calls in order. A call that can't be answered throws a StopError; the probe never does.
export async function runSession(
	client: Anthropic,
	metered: Meter,
	calls: readonly PlannedCall[],
	options: { readonly signal?: AbortSignal; readonly onCall?: (outcome: CallOutcome) => void } = {},
): Promise<CallOutcome[]> {
	const outcomes: CallOutcome[] = [];
	for (const planned of calls) {
		const run = planned.optional ? runOptional : runCall;
		const outcome = await run(client, metered, planned, options.signal);
		outcomes.push(outcome);
		options.onCall?.(outcome);
	}
	return outcomes;
}

function why(outcome: CallOutcome): string {
	const { result } = outcome;
	if (result === null) return outcome.failed ?? `${outcome.status} ${outcome.errorType ?? "error"}`;
	if (result.kind === "truncated" || result.kind === "unexpected") {
		return `${result.kind}, ${result.stopReason}`;
	}
	return result.kind;
}

// The backlog's acceptance lines (M0.31), then the refusal line.
export function acceptance(outcomes: readonly CallOutcome[]): string[] {
	const find = (label: CallLabel): CallOutcome => {
		const outcome = outcomes.find((item) => item.label === label);
		if (!outcome) throw new Error(`the session has no ${label} call`);
		return outcome;
	};
	const [plain, fallbacks, tiny] = [find("parse-effort"), find("fallbacks"), find("max-tokens")];
	const probe = outcomes.find((item) => item.label === "refusal-probe");
	const truncated = tiny.result?.kind === "truncated" && tiny.result.stopReason === "max_tokens";
	let refusal = "refusal: from the documentation";
	if (probe?.skipped) {
		refusal = `refusal: from the documentation (probe not run: ${probe.skipped})`;
	} else if (probe?.result?.kind === "refusal") {
		refusal = `refusal: probed (${probe.result.category ?? "no category"})`;
	} else if (probe?.result) {
		refusal = `refusal: probed, not triggered (${why(probe)})`;
	} else if (probe) {
		refusal = `refusal: probe failed (${why(probe)})`;
	}
	return [
		plain.result?.kind === "draft" ? "parse: ok" : `parse: failed (${why(plain)})`,
		plain.status === 200 ? "effort: ok" : `effort: rejected (${why(plain)})`,
		fallbacks.status === 200 ? "fallbacks: accepted" : `fallbacks: rejected (${why(fallbacks)})`,
		truncated ? "max_tokens: detected" : `max_tokens: not detected (${why(tiny)})`,
		refusal,
	];
}

function callLine(outcome: CallOutcome): string {
	if (outcome.skipped) return `${outcome.label}: not sent (${outcome.skipped})`;
	const { attempts, result } = outcome;
	const ms = sum(attempts.map((attempt) => attempt.ms));
	const answer = result ? `${outcome.status} ${result.kind} from ${result.model}` : why(outcome);
	const detail = outcome.detail ? ` (${outcome.detail})` : "";
	const tries = `${attempts.length} attempt${attempts.length === 1 ? "" : "s"}`;
	const cost = costs(attempts).toFixed(4);
	return `${outcome.label}: ${answer}${detail}, ${tries}, ${(ms / 1000).toFixed(1)} s, US$${cost}`;
}

function callShape(outcome: CallOutcome): Record<string, unknown> {
	return {
		label: outcome.label,
		status: outcome.status,
		errorType: word(outcome.errorType),
		skipped: outcome.skipped,
		failed: outcome.failed,
		costUsd: usd(costs(outcome.attempts)),
		attempts: outcome.attempts.map(attemptShape),
		result: resultShape(outcome.result),
	};
}

const notSet = (error: unknown, name: string): boolean =>
	error instanceof Error && error.message.startsWith("not set in ") && error.message.includes(name);

// A .env.live entry's value, or null when it holds none.
function entry(name: string, options: EnvLiveOptions = {}): string | null {
	try {
		return loadEnvLive([name], options)[name]?.reveal() ?? null;
	} catch (error) {
		if (notSet(error, name)) return null;
		throw error;
	}
}

// The owner's opt-in for the refusal probe: DY_LIVE_MESSAGES_REFUSAL_PROBE=yes in .env.live.
export function refusalProbe(options: EnvLiveOptions = {}): boolean {
	const value = entry(PROBE_FLAG, options);
	if (value === null) return false;
	if (value !== "yes" && value !== "no") throw new Error(`${PROBE_FLAG} in .env.live is yes or no`);
	return value === "yes";
}

export function anthropicVariables(env: NodeJS.ProcessEnv = process.env): string[] {
	return Object.keys(env)
		.filter((name) => name.toUpperCase().startsWith("ANTHROPIC_"))
		.sort();
}

// The entries that hold a value: what deleteEnvLive will remove, empty lines aside.
function setEntries(names: readonly string[], options: EnvLiveOptions = {}): string[] {
	return names.filter((name) => entry(name, options) !== null);
}

interface Recorded {
	readonly step: "session" | "stopped";
	readonly fingerprint: Fingerprint;
	readonly data: Record<string, unknown>;
	readonly session: Record<string, unknown>;
	readonly stops: readonly Record<string, unknown>[];
	// Every request made with the key so far: the session runs' and the revocation checks'.
	readonly calls: number;
	readonly checks: number;
	readonly costUsd: number;
	readonly revoked: boolean;
	// A stopped session that can't go on: the cap or the cost guard stopped it, or too few
	// requests are left for another run.
	readonly ended: boolean;
}

function readRecorded(file: string): Recorded | null {
	if (!existsSync(file)) return null;
	const refused = new Error(`${file} isn't an S9b session record: move it away for a new session`);
	let json: unknown;
	try {
		json = JSON.parse(readFileSync(file, "utf8"));
	} catch {
		throw refused;
	}
	if (!isRecord(json) || !isRecord(json.fingerprint) || !isRecord(json.data)) throw refused;
	const { data } = json;
	const session = isRecord(data.session) ? data.session : {};
	const { step, calls, costUsd, revoked } = session;
	const accountedUsd = session.accountedUsd;
	if (
		session.accountingVersion !== ACCOUNTING_VERSION ||
		typeof accountedUsd !== "number" ||
		!Number.isFinite(accountedUsd) ||
		accountedUsd < 0
	) {
		throw new Error(
			`${file} has no durable reservation accounting: preserve the record and ask the owner to revoke the key; do not reset its costs`,
		);
	}
	if (data.revocation !== null && !isRecord(data.revocation)) throw refused;
	const checks = isRecord(data.revocation) ? data.revocation.checks : 0;
	const stops: unknown[] | null = Array.isArray(data.stops) ? data.stops : null;
	if (step !== "session" && step !== "stopped") throw refused;
	if (revoked !== "no" && revoked !== "yes") throw refused;
	if (
		typeof calls !== "number" ||
		!Number.isSafeInteger(calls) ||
		calls < 0 ||
		typeof costUsd !== "number" ||
		!Number.isFinite(costUsd) ||
		costUsd < 0
	)
		throw refused;
	if (
		typeof checks !== "number" ||
		!Number.isSafeInteger(checks) ||
		checks < 0 ||
		stops === null ||
		!stops.every(isRecord)
	)
		throw refused;
	const used = calls + checks;
	if (!Number.isSafeInteger(used) || used < 0) throw refused;
	const last = stops.at(-1)?.stop;
	const limited = last === "budget" || last === "call-cap";
	return {
		step,
		fingerprint: json.fingerprint as unknown as Fingerprint,
		data,
		session,
		stops,
		calls: used,
		checks,
		costUsd: Math.max(costUsd, accountedUsd),
		revoked: revoked === "yes",
		ended: step === "stopped" && (limited || CALL_CAP - used < SESSION_CALLS),
	};
}

export interface LiveOptions {
	// evidence/live.json; it also says which step is due.
	readonly file: string;
	// The ctx.fetch stub for a pin: liveStub live, the fake's in the rehearsal.
	readonly openStub: (pin: Pin) => Promise<CtxFetchStub>;
	readonly env?: NodeJS.ProcessEnv;
	readonly envLive?: EnvLiveOptions;
	readonly fingerprint?: () => Promise<Fingerprint>;
	readonly signal?: AbortSignal;
	readonly log?: (line: string) => void;
}

export type LiveOutcome =
	| { readonly step: "skipped"; readonly reason: string }
	| {
			readonly step: "session" | "revocation";
			readonly lines: readonly string[];
			readonly acceptance: readonly string[];
			readonly file: string;
	  };

type Say = (line: string) => void;

const NEXT_REVOKE = "next: revoke the key in the Claude Console, then run the same command again";
const NEW_SESSION = `a new session (move evidence/live.json away and delete ${HASH_NAME} first)`;
const NEXT_DECIDE = `next: not every acceptance line passed: the owner decides between keeping this session for ADR 0011 (then revoke the key and run the same command again) and ${NEW_SESSION}`;
const NEXT_NOT_RUN =
	"next: the session didn't finish: ADR 0011 records S9b as not run, unless the owner allows a new session with a new key (move evidence/live.json away first)";

const messageOf = (error: unknown): string =>
	error instanceof Error ? error.message : String(error);

// Step 1. Every request is counted in evidence/live.json before it leaves, so a run that stops, or
// dies, leaves its requests and their estimate to the next run, which starts the session over
// within what is left. The key's hash goes into .env.live after the first record.
async function session(
	stub: CtxFetchStub,
	recorded: Recorded | null,
	key: KeyMark,
	options: LiveOptions,
	say: Say,
	makeMeter: typeof meter,
) {
	const spikeDir = path.dirname(path.dirname(options.file));
	const print = await (options.fingerprint ?? (() => fingerprint({ cwd: spikeDir })))();
	if (print.dirty !== false) {
		const dirty = String(print.dirty);
		throw new Error(
			`live evidence comes from a clean tree: commit or stash first (dirty: ${dirty})`,
		);
	}
	const probe = refusalProbe(options.envLive);
	const earlier = recorded ?? { calls: 0, costUsd: 0, stops: [] };
	const calls = plannedCalls(probe);
	const ranAt = new Date().toISOString();
	const record = (data: Record<string, unknown>): Promise<string> =>
		writeEvidence(options.file, redact(data), { fingerprint: print });
	const summary = (step: "session" | "stopped") => ({
		step,
		ranAt,
		sdk: VERSION,
		model: DEFAULT_MODEL,
		effort: DRAFT_EFFORT,
		maxTokens: DRAFT_MAX_TOKENS,
		callCap: CALL_CAP,
		calls: metered.used(),
		budgetUsd: BUDGET_USD,
		costUsd: usd(metered.spentUsd()),
		accountingVersion: ACCOUNTING_VERSION,
		accountedUsd: metered.spentUsd(),
		pricesAsOf: PRICES_AS_OF,
		refusalProbe: probe ? "allowed" : "not allowed",
		revoked: "no",
	});
	// This run while it hasn't finished: "interrupted" until it says why it stopped.
	const stopped = (stop: string) => {
		const run = {
			ranAt,
			calls: metered.attempts.length,
			costUsd: usd(costs(metered.attempts)),
			call: metered.label,
			stop,
		};
		const data = { session: summary("stopped"), stops: [...earlier.stops, run] };
		return { ...data, acceptance: [], calls: [], revocation: null };
	};
	const metered = makeMeter(stub, {
		used: earlier.calls,
		spentUsd: earlier.costUsd,
		beforeSend: async () => {
			await record(stopped("interrupted"));
			if (key.marked) return;
			saveEnvLive(HASH_NAME, key.hash, options.envLive);
			key.marked = true;
		},
	});
	const client = createClient(metered, { maxRetries: 1 });
	const plan = probe ? "with the refusal probe" : "refusal probe from the documentation";
	const left = `${metered.left()} of ${CALL_CAP} requests left`;
	say(`S9b live session: ${calls.length} calls (${plan}), ${left}, budget US$${BUDGET_USD}`);
	let outcomes: CallOutcome[];
	try {
		outcomes = await runSession(client, metered, calls, {
			...(options.signal ? { signal: options.signal } : {}),
			onCall: (outcome) => say(callLine(outcome)),
		});
	} catch (error) {
		const reason = error instanceof StopError ? error.reason : "error";
		const limited = reason === "budget" || reason === "call-cap";
		const kept = reason !== "record" && (metered.attempts.length > 0 || limited);
		try {
			if (kept) await record(stopped(reason));
		} catch (failure) {
			throw new Error(`${messageOf(error)}; recording the stop failed too: ${messageOf(failure)}`, {
				cause: error,
			});
		}
		if (!(error instanceof StopError)) throw error;
		const spent = `US$${metered.spentUsd().toFixed(4)} estimated`;
		const where = kept ? `, recorded in ${options.file}` : "";
		const state = `${metered.used()} of ${CALL_CAP} requests used, ${spent}${where}`;
		// As readRecorded will see it: the next run is the revocation check.
		const ends = kept && (limited || metered.left() < SESSION_CALLS);
		const next = ends ? `; the session can't go on: ${NEXT_REVOKE.slice("next: ".length)}` : "";
		throw new Error(`${error.message} (${state})${next}`, { cause: error });
	}
	const lines = acceptance(outcomes);
	for (const line of lines) say(line);
	const runs = earlier.stops.length;
	const before =
		runs > 0 ? ` (${earlier.calls} in ${runs} stopped run${runs === 1 ? "" : "s"})` : "";
	const spent = `estimated US$${metered.spentUsd().toFixed(4)} of US$${BUDGET_USD}`;
	say(`calls: ${metered.used()} of ${CALL_CAP}${before}; ${spent}`);
	const file = await record({
		session: summary("session"),
		stops: earlier.stops,
		acceptance: lines,
		calls: outcomes.map(callShape),
		revocation: null,
	});
	say(`evidence: ${file}`);
	const passed = SESSION_ACCEPTANCE.every((line, index) => lines[index] === line);
	say(passed ? NEXT_REVOKE : NEXT_DECIDE);
	return { step: "session" as const, acceptance: lines, file };
}

// Step 2, run once the owner has revoked the key: one status request with the session's own key
// must get the API's 401 authentication_error; any other 401 proves nothing. Each check counts
// toward the 6 requests and is recorded before it is sent, as session requests are. After that
// 401, revoked: yes is recorded first and the DY_LIVE_* entries are deleted after, so a failed
// write leaves them for the next run; nothing is taken on trust.
async function revocation(
	stub: CtxFetchStub,
	recorded: Recorded,
	options: LiveOptions,
	say: Say,
	makeMeter: typeof meter,
) {
	const left = CALL_CAP - recorded.calls;
	let accountedUsd = recorded.costUsd;
	if (recorded.step === "stopped") {
		const spent = `US$${recorded.costUsd.toFixed(4)} estimated`;
		say(
			`the recorded session stopped and can't go on: ${left} of ${CALL_CAP} requests left, ${spent}`,
		);
	}
	const record = (outcome: Record<string, unknown>, revoked: boolean): Promise<string> => {
		const session = {
			...recorded.session,
			costUsd: usd(accountedUsd),
			accountedUsd,
			revoked: revoked ? "yes" : "no",
		};
		const data = { ...recorded.data, session, revocation: outcome };
		return writeEvidence(options.file, redact(data), { fingerprint: recorded.fingerprint });
	};
	let check = `not run: all ${CALL_CAP} calls are used`;
	let checks = recorded.checks;
	if (left > 0) {
		// "interrupted" until the check has an answer.
		const pending = () => ({
			checkedAt: new Date().toISOString(),
			check: "interrupted",
			checks: recorded.checks + metered.attempts.length,
			deleted: [],
		});
		const metered = makeMeter(stub, {
			used: recorded.calls,
			spentUsd: recorded.costUsd,
			beforeSend: () => {
				accountedUsd = metered.spentUsd();
				return record(pending(), false);
			},
		});
		metered.label = "revocation check";
		const client = createClient(metered, { maxRetries: 0 });
		const { params } = draftCall({ ...SESSION_INPUT, model: CHECK_MODEL });
		const signal = options.signal ? { signal: options.signal } : {};
		try {
			await client.beta.messages.parse(
				{ ...params, max_tokens: 1 },
				{ headers: { "anthropic-beta": null }, ...signal },
			);
			check = "200";
		} catch (error) {
			const notSent = notSentOf(error);
			if (notSent?.code === "record") throw new Error(notSent.message, { cause: error });
			if (notSent) check = `not run: ${notSent.code}`;
			else if (error instanceof APIUserAbortError) check = "interrupted";
			else if (error instanceof APIConnectionError) check = "no answer";
			else if (error instanceof APIError && error.status !== undefined) {
				// The stub's own refusal type, outside the SDK's ErrorType.
				const type: string | null = error.type;
				check =
					type === "broker_refused" ? "broker refused" : `${error.status} ${word(type) ?? "error"}`;
			} else throw error;
		}
		accountedUsd = metered.spentUsd();
		checks += metered.attempts.length;
	}
	say(`revocation check: ${check}`);
	if (checks === recorded.checks) {
		throw new Error(
			`the key can't be checked (${check}): once the owner confirms the revocation, delete the entries as notes/session.md shows and record it in ADR 0011`,
		);
	}
	const revoked = check === "401 authentication_error";
	const deleted = revoked ? setEntries(ENTRIES, options.envLive) : [];
	const file = await record(
		{ checkedAt: new Date().toISOString(), check, checks, deleted },
		revoked,
	);
	if (!revoked) {
		const status = Number.parseInt(check, 10);
		if (Number.isNaN(status) || retryable(status) || status === 401) {
			throw new Error(`the revocation check got no verdict (${check}): ${RETRY_LATER}`);
		}
		throw new Error(
			`the key still works (${check}): revoke it in the Claude Console, then run this again`,
		);
	}
	deleteEnvLive(ENTRIES, options.envLive);
	say(`deleted from .env.live: ${deleted.join(", ") || "nothing"}`);
	say("revoked: yes");
	say(`evidence: ${file}`);
	if (recorded.step === "stopped") say(NEXT_NOT_RUN);
	return { step: "revocation" as const, acceptance: ["revoked: yes"], file };
}

type Due = "session" | "revocation" | "done";

function dueOf(recorded: Recorded | null): Due {
	if (recorded === null) return "session";
	if (recorded.revoked) return "done";
	return recorded.step === "session" || recorded.ended ? "revocation" : "session";
}

function waiting(recorded: Recorded | null, due: Due): string {
	if (due === "done") return "the recorded session's key is revoked";
	if (due === "revocation") return "the recorded session awaits its revocation check";
	return recorded ? "the recorded session stopped and can run again" : "no session run";
}

interface KeyMark {
	readonly hash: string;
	// .env.live holds the hash.
	marked: boolean;
}

// The hash in .env.live ties the key to the record: a run stops before sending anything when the
// key has made requests but the record is gone (another checkout, git clean or stash), when the key
// has changed, or when a revocation check can't be tied to the session's key.
function keyMark(recorded: Recorded | null, due: Due, options: LiveOptions): KeyMark {
	const key = loadEnvLive([KEY_NAME], options.envLive)[KEY_NAME].reveal();
	const hash = createHash("sha256").update(key).digest("hex");
	const mark = entry(HASH_NAME, options.envLive);
	const runbook = "see spikes/s09-messages-api/notes/session.md";
	if (mark !== null && mark !== hash) {
		throw new Error(
			`${KEY_NAME} isn't the key that made the recorded requests (${HASH_NAME} in .env.live): ${runbook}`,
		);
	}
	if (mark !== null && recorded === null) {
		throw new Error(
			`${options.file} is missing, but the key has made requests (${HASH_NAME} in .env.live): run the command from the checkout that holds the record; ${runbook}`,
		);
	}
	if (mark === null && due === "revocation") {
		throw new Error(
			`the key can't be tied to the recorded session (${HASH_NAME} isn't in .env.live): ${runbook}`,
		);
	}
	return { hash, marked: mark !== null };
}

// One command for every step; evidence/live.json says which is due. With none, or a stopped session
// that can go on, a session runs; with a finished or ended one, the revocation check; once it
// records revoked: yes, nothing. No key: a skip.
export async function runLive(options: LiveOptions): Promise<LiveOutcome> {
	return runLiveWithMeter(options, meter);
}

// Offline tests alone provide a bounded fake routing policy. No live CLI/configuration reads it.
export async function runRehearsal(
	options: LiveOptions,
	makeMeter: typeof meter,
): Promise<LiveOutcome> {
	return runLiveWithMeter(options, makeMeter);
}

async function runLiveWithMeter(
	options: LiveOptions,
	makeMeter: typeof meter,
): Promise<LiveOutcome> {
	const recorded = readRecorded(options.file);
	const due = dueOf(recorded);
	let stub: CtxFetchStub;
	try {
		stub = await options.openStub({
			model: due === "session" ? DEFAULT_MODEL : CHECK_MODEL,
			effort: DRAFT_EFFORT,
		});
	} catch (error) {
		if (!notSet(error, KEY_NAME)) throw error;
		const reason = `${KEY_NAME} is not in .env.live: ${waiting(recorded, due)} (spikes/s09-messages-api/notes/session.md)`;
		return { step: "skipped", reason };
	}
	if (due === "done") {
		throw new Error(
			`${options.file} records revoked: yes, but .env.live still holds ${KEY_NAME}: if it is the revoked key, delete it as notes/session.md shows; for a new session, move ${options.file} away first`,
		);
	}
	const env = options.env ?? process.env;
	const set = anthropicVariables(env);
	if (set.length > 0) {
		const reason =
			"the SDK reads ANTHROPIC_* variables, and the broker refuses the headers they add";
		throw new Error(`unset ${set.join(", ")} first: ${reason}`);
	}
	if (env.DRAFTYAK_RECORD_EVIDENCE !== "1") {
		throw new Error("set DRAFTYAK_RECORD_EVIDENCE=1: a live run always records its evidence");
	}
	const key = keyMark(recorded, due, options);
	const lines: string[] = [];
	const say = (line: string): void => {
		lines.push(line);
		options.log?.(line);
	};
	const done =
		due === "revocation" && recorded
			? await revocation(stub, recorded, options, say, makeMeter)
			: await session(stub, recorded, key, options, say, makeMeter);
	return { ...done, lines };
}
