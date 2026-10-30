import { Ulid } from "@draftyak/protocol/scalars";
import { fields } from "../jobs/values.ts";
import { MAX_WAIT_MS, nextTick } from "../kernel/clock.ts";
import { SchedulerError, type SchedulerErrorCode } from "./scheduler-ports.ts";

export const MAX_SKEW_MS = 120_000;
export const MIN_RETRY_MS = 1_000;
export const HOLD_RETRY_MS: number = MAX_WAIT_MS;
export const DIVERGENCE_MS = 5_000;
export const PRECLAIM_TIMEOUT_MS = 10_000;
export const PREFLIGHT_TIMEOUT_MS = 15_000;
export const CLAIM_TIMEOUT_MS = 5_000;
export const PREFLIGHT_LEAD_MS = 900_000;
export const DATE_RESOLUTION_MS = 1_000;
export const TICK_BUDGET_MS = 15_000;
export const SAMPLE_MAX_AGE_MS = 10_000;
export const PACING_MS: Readonly<{ email: number; chat: number }> = Object.freeze({
	email: 2_000,
	chat: 1_000,
});

/** Inert own data fields only, as jobs/values.ts fields(); no getter or proxy trap runs. */
export function snapshot(
	raw: unknown,
	required: readonly string[],
	optional: readonly string[] = [],
	code: SchedulerErrorCode = "INVALID_INPUT",
): Readonly<Record<string, unknown>> {
	try {
		return fields(raw, required, optional);
	} catch {
		throw new SchedulerError(code);
	}
}

export const isWallMs = (value: unknown): value is number =>
	typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
export const isMonoMs = (value: unknown): value is number =>
	typeof value === "number" && Number.isFinite(value) && value >= 0;
const isMicros = isWallMs;
const isUlid = (value: unknown): value is string =>
	typeof value === "string" && Ulid.safeParse(value).success;

export interface ClockReading {
	readonly wall: number;
	readonly mono: number;
}

/** |Δwall − Δmono| over 5,000 ms; an unusable reading counts as diverged. */
export function diverged(before: ClockReading, after: ClockReading): boolean {
	return !(Math.abs(after.wall - before.wall - (after.mono - before.mono)) <= DIVERGENCE_MS);
}

const IMF_FIXDATE =
	/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), [0-9]{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) [0-9]{4} [0-9]{2}:[0-9]{2}:[0-9]{2} GMT$/;
const MAX_DATE_MS = 8_640_000_000_000_000;

/** An exact IMF-fixdate: Date.parse normalises 31 Feb, hour 24 and second 60 and ignores the weekday. */
export function parseImfFixdate(header: unknown): number | undefined {
	if (typeof header !== "string" || header.length !== 29 || !IMF_FIXDATE.test(header))
		return undefined;
	const ms = Date.parse(header);
	if (!Number.isSafeInteger(ms) || ms < 0 || ms > MAX_DATE_MS) return undefined;
	return new Date(ms).toUTCString() === header ? ms : undefined;
}

export interface BrokerDateObservation {
	readonly header: string;
	readonly readId: string;
	readonly accountId: string;
	readonly requestWall: number;
	readonly requestMono: number;
	readonly responseWall: number;
	readonly responseMono: number;
}

export interface BrokerDateSample extends BrokerDateObservation {
	readonly dateMs: number;
}

const samples = new WeakSet<object>();
const OBSERVATION = [
	"header",
	"readId",
	"accountId",
	"requestWall",
	"requestMono",
	"responseWall",
	"responseMono",
];

/** The only constructor of a sample, for the broker's observation of a read's own Date header. */
export function observeBrokerDate(input: BrokerDateObservation): BrokerDateSample {
	const raw = snapshot(input, OBSERVATION, [], "SCHEDULER_DATA");
	const dateMs = parseImfFixdate(raw.header);
	if (
		dateMs === undefined ||
		!isUlid(raw.readId) ||
		!isUlid(raw.accountId) ||
		!isWallMs(raw.requestWall) ||
		!isWallMs(raw.responseWall) ||
		!isMonoMs(raw.requestMono) ||
		!isMonoMs(raw.responseMono)
	)
		throw new SchedulerError("SCHEDULER_DATA");
	const sample: BrokerDateSample = Object.freeze({
		header: raw.header as string,
		readId: raw.readId,
		accountId: raw.accountId,
		requestWall: raw.requestWall,
		requestMono: raw.requestMono,
		responseWall: raw.responseWall,
		responseMono: raw.responseMono,
		dateMs,
	});
	samples.add(sample);
	return sample;
}

export function isBrokerDateSample(value: unknown): value is BrokerDateSample {
	return typeof value === "object" && value !== null && samples.has(value);
}

/** True only for the sample minted for this read: same readId, requested after the read started. */
export function sampleOfRead(sample: unknown, readId: string, startedMono: number): boolean {
	return (
		isBrokerDateSample(sample) &&
		sample.readId === readId &&
		isMonoMs(startedMono) &&
		sample.requestMono >= startedMono
	);
}

export interface SecondClock {
	readonly low: number;
	readonly high: number;
}

/**
 * Conservative bounds of a right upstream's current time T, low ≤ T < high, from this
 * account's sample; undefined when the read took over 10 s or the sample or the readings cannot
 * bound it. high assumes the hub's wall or monotonic clock counted the time since the request: a
 * pause that stops both, such as a VM save and restore, lets high trail T.
 */
export function secondClock(
	sample: unknown,
	now: ClockReading,
	accountId: string,
): SecondClock | undefined {
	if (!isBrokerDateSample(sample) || sample.accountId !== accountId) return undefined;
	let reading: Readonly<Record<string, unknown>>;
	try {
		reading = fields(now, ["wall", "mono"]);
	} catch {
		return undefined;
	}
	const { wall, mono } = reading;
	if (!isWallMs(wall) || !isMonoMs(mono)) return undefined;
	const { requestWall, requestMono, responseWall, responseMono, dateMs } = sample;
	const sinceWall = wall - responseWall;
	const sinceMono = mono - responseMono;
	if (
		!(requestMono <= responseMono && responseMono <= mono) ||
		responseMono - requestMono > PRECLAIM_TIMEOUT_MS ||
		sinceMono > SAMPLE_MAX_AGE_MS ||
		Math.abs(responseWall - requestWall - (responseMono - requestMono)) > DIVERGENCE_MS ||
		Math.abs(sinceWall - sinceMono) > DIVERGENCE_MS
	)
		return undefined;
	// The header is whole seconds, written between request and response; the larger elapsed
	// time covers a monotonic clock paused by a short suspend.
	return Object.freeze({
		low: dateMs + Math.min(sinceMono, sinceWall),
		high: dateMs + DATE_RESOLUTION_MS + Math.max(mono - requestMono, wall - requestWall),
	});
}

const GMAIL_INTERNAL_DATE = /^(?:0|[1-9][0-9]{0,12})$/;
const SLACK_TS = /^(0|[1-9][0-9]{0,9})\.([0-9]{6})$/;
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

/** A provider timestamp as integer microseconds since the epoch; undefined when malformed. */
export function watermarkMicros(kind: "email" | "chat", text: unknown): number | undefined {
	if (typeof text !== "string") return undefined;
	let micros: bigint;
	if (kind === "email") {
		if (!GMAIL_INTERNAL_DATE.test(text)) return undefined;
		micros = BigInt(text) * 1_000n;
	} else if (kind === "chat") {
		const match = SLACK_TS.exec(text);
		const seconds = match?.[1];
		const fraction = match?.[2];
		if (seconds === undefined || fraction === undefined) return undefined;
		micros = BigInt(seconds) * 1_000_000n + BigInt(fraction);
	} else return undefined;
	return micros <= MAX_SAFE ? Number(micros) : undefined;
}

export interface SendWindowMs {
	readonly notBefore: number;
	readonly deliverBy: number;
}

export type ClaimCheck =
	| { readonly ok: true; readonly early: number; readonly late: number }
	| { readonly ok: false; readonly hold: "window" }
	| { readonly ok: false; readonly hold: "missed" }
	| { readonly ok: false; readonly hold: "early"; readonly retryInMs: number }
	| { readonly ok: false; readonly hold: "skew"; readonly retryInMs: number };

const WINDOW: ClaimCheck = Object.freeze({ ok: false, hold: "window" });
const MISSED: ClaimCheck = Object.freeze({ ok: false, hold: "missed" });
const SKEW: ClaimCheck = Object.freeze({ ok: false, hold: "skew", retryInMs: HOLD_RETRY_MS });

function windowOf(window: unknown): SendWindowMs | undefined {
	let raw: Readonly<Record<string, unknown>>;
	try {
		raw = fields(window, ["notBefore", "deliverBy"]);
	} catch {
		return undefined;
	}
	const { notBefore, deliverBy } = raw;
	if (!isWallMs(notBefore) || !isWallMs(deliverBy) || notBefore > deliverBy) return undefined;
	return { notBefore, deliverBy };
}

function boundsOf(second: unknown): SecondClock | undefined {
	if (typeof second === "number") return { low: second, high: second };
	try {
		const { low, high } = fields(second, ["low", "high"]);
		return typeof low === "number" && typeof high === "number" ? { low, high } : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Two clocks: min(hub, low) ≥ notBefore and max(hub, high) ≤ deliverBy. A malformed window
 * refuses first; an unreadable clock or skew over 2 min holds; past deliverBy is missed.
 */
export function checkClaimWindow(
	window: unknown,
	hubNow: number,
	second: SecondClock | number | undefined,
): ClaimCheck {
	const range = windowOf(window);
	if (range === undefined) return WINDOW;
	const clock = boundsOf(second);
	if (
		typeof hubNow !== "number" ||
		!Number.isFinite(hubNow) ||
		clock === undefined ||
		!Number.isFinite(clock.low) ||
		!Number.isFinite(clock.high) ||
		clock.low > clock.high ||
		!(hubNow >= clock.low - MAX_SKEW_MS && hubNow <= clock.high + MAX_SKEW_MS)
	)
		return SKEW;
	const early = Math.min(hubNow, clock.low);
	const late = Math.max(hubNow, clock.high);
	if (late > range.deliverBy) return MISSED;
	if (early < range.notBefore) {
		const retryInMs = Math.min(
			HOLD_RETRY_MS,
			Math.max(MIN_RETRY_MS, Math.ceil(range.notBefore - early)),
		);
		return Object.freeze({ ok: false, hold: "early", retryInMs });
	}
	return Object.freeze({ ok: true, early: Math.floor(early), late: Math.ceil(late) });
}

export interface PreclaimObservationFacts {
	readonly complete: boolean;
	readonly facts: "unchanged" | "changed" | "unknown";
	/** watermarkMicros of the observed newest inbound message. */
	readonly newestInbound: number | null;
}

export interface PreclaimInput {
	readonly window: unknown;
	readonly hubNow: number;
	/** An APPROVED item's first claim: the hub clock alone, no read. */
	readonly immediate: boolean;
	readonly second: SecondClock | undefined;
	readonly sampleUsable: boolean;
	readonly accountMode: AccountModeView;
	/** Undefined for a failed, aborted, stale or unparseable read. */
	readonly observation: PreclaimObservationFacts | undefined;
	readonly holdIfNewInbound: boolean;
	readonly watermark: number | null;
}

export type AccountModeView = "full" | "read_only" | "unavailable";

export type PreclaimVerdict =
	| { readonly kind: "claim"; readonly early: number; readonly late: number }
	| { readonly kind: "void"; readonly reason: "missed" | "new_reply" | "channel_changed" }
	/** Final: the caller cancels the item (CANCELLED), as a switch to read_only does. */
	| { readonly kind: "cancel"; readonly reason: "read_only" }
	| {
			readonly kind: "hold";
			readonly hold: "early" | "skew" | "clock" | "read" | "account";
			readonly scope: "item" | "account";
			readonly retryInMs: number;
	  }
	| { readonly kind: "refuse"; readonly code: "window" };

const PRECLAIM = [
	"window",
	"hubNow",
	"immediate",
	"second",
	"sampleUsable",
	"accountMode",
	"observation",
	"holdIfNewInbound",
	"watermark",
];
const FACTS: readonly unknown[] = ["unchanged", "changed", "unknown"];
const REFUSE: PreclaimVerdict = Object.freeze({ kind: "refuse", code: "window" });
const NEW_REPLY: PreclaimVerdict = Object.freeze({ kind: "void", reason: "new_reply" });
const CHANNEL_CHANGED: PreclaimVerdict = Object.freeze({ kind: "void", reason: "channel_changed" });
const VOID_MISSED: PreclaimVerdict = Object.freeze({ kind: "void", reason: "missed" });
const CANCEL_READ_ONLY: PreclaimVerdict = Object.freeze({ kind: "cancel", reason: "read_only" });

const hold = (
	kind: "early" | "skew" | "clock" | "read" | "account",
	scope: "item" | "account",
	retryInMs: number,
): PreclaimVerdict => Object.freeze({ kind: "hold", hold: kind, scope, retryInMs });

function observationOf(value: unknown): PreclaimObservationFacts | undefined {
	if (value === undefined) return undefined;
	const raw = snapshot(value, ["complete", "facts", "newestInbound"]);
	if (
		typeof raw.complete !== "boolean" ||
		!FACTS.includes(raw.facts) ||
		!(raw.newestInbound === null || isMicros(raw.newestInbound))
	)
		throw new SchedulerError("INVALID_INPUT");
	return raw as unknown as PreclaimObservationFacts;
}

/**
 * The checks M2.7 owns before a claim, in order. An observation can only hold or void, never
 * admit a claim the clocks refuse.
 */
export function decidePreclaim(input: PreclaimInput): PreclaimVerdict {
	const raw = snapshot(input, PRECLAIM);
	const second = raw.second === undefined ? undefined : snapshot(raw.second, ["low", "high"]);
	if (
		typeof raw.immediate !== "boolean" ||
		typeof raw.sampleUsable !== "boolean" ||
		typeof raw.holdIfNewInbound !== "boolean" ||
		!(raw.watermark === null || isMicros(raw.watermark)) ||
		(second !== undefined && (typeof second.low !== "number" || typeof second.high !== "number"))
	)
		throw new SchedulerError("INVALID_INPUT");
	const observation = observationOf(raw.observation);
	if (windowOf(raw.window) === undefined) return REFUSE;
	if (raw.accountMode === "read_only") return CANCEL_READ_ONLY;
	if (raw.accountMode !== "full") return hold("account", "item", HOLD_RETRY_MS);
	if (!raw.immediate) {
		if (observation === undefined) return hold("read", "item", HOLD_RETRY_MS);
		if (observation.facts === "changed") return CHANNEL_CHANGED;
		// A reply already seen past the watermark is conclusive, even from an incomplete read.
		if (
			raw.holdIfNewInbound &&
			observation.newestInbound !== null &&
			(raw.watermark === null || observation.newestInbound > (raw.watermark as number))
		)
			return NEW_REPLY;
		if (!observation.complete || observation.facts === "unknown")
			return hold("read", "item", HOLD_RETRY_MS);
		if (!raw.sampleUsable || second === undefined) return hold("clock", "account", HOLD_RETRY_MS);
	}
	const hubNow = raw.hubNow as number;
	const check = checkClaimWindow(
		raw.window,
		hubNow,
		raw.immediate ? hubNow : (second as unknown as SecondClock),
	);
	if (check.ok) return Object.freeze({ kind: "claim", early: check.early, late: check.late });
	switch (check.hold) {
		case "window":
			return REFUSE;
		case "missed":
			return VOID_MISSED;
		case "early":
			return hold("early", "item", check.retryInMs);
		case "skew":
			return hold("skew", "account", check.retryInMs);
	}
}

export interface PlanRow {
	readonly id: string;
	readonly accountId: string;
	readonly kind: "email" | "chat";
	/** The account for email; the account and the frozen channel for chat. */
	readonly pacingKey: string;
	readonly state: "APPROVED" | "SCHEDULED" | "RETRY_WAIT";
	/** The effective window, as ClaimRequest.window. */
	readonly notBefore: number;
	readonly deliverBy: number;
}

/** Monotonic retry and release times; a wall jump neither shortens nor stretches a hold. */
export interface HoldClock {
	itemRetryMono(id: string): number | undefined;
	accountRetryMono(accountId: string): number | undefined;
	pacingReleaseMono(key: string): number | undefined;
}

export interface TickPlan {
	/** APPROVED first, then notBefore, then id. */
	readonly eligible: readonly PlanRow[];
	/** 0 while a row is eligible; plan again after acting on them. */
	readonly waitMs: number;
}

/**
 * Wait for one row: max(nextTick(wall, notBefore), nextTick(mono, each retry or release)), 0
 * when eligible. A malformed window or one past deliverBy by the hub clock never becomes
 * eligible; the sweep ends it.
 */
export function rowWaitMs(row: PlanRow, holds: HoldClock, now: ClockReading): number {
	const { notBefore, deliverBy } = row;
	if (
		!isWallMs(notBefore) ||
		!isWallMs(deliverBy) ||
		notBefore > deliverBy ||
		!(now.wall <= deliverBy)
	)
		return MAX_WAIT_MS;
	let wait = nextTick(now.wall, notBefore);
	for (const at of [
		holds.itemRetryMono(row.id),
		holds.accountRetryMono(row.accountId),
		holds.pacingReleaseMono(row.pacingKey),
	])
		if (at !== undefined) wait = Math.max(wait, nextTick(now.mono, at));
	return wait;
}

function dueOrder(a: PlanRow, b: PlanRow): number {
	const immediate = Number(b.state === "APPROVED") - Number(a.state === "APPROVED");
	if (immediate !== 0) return immediate;
	if (a.notBefore !== b.notBefore) return a.notBefore - b.notBefore;
	return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function planTick(rows: readonly PlanRow[], holds: HoldClock, now: ClockReading): TickPlan {
	const eligible: PlanRow[] = [];
	let waitMs = MAX_WAIT_MS;
	for (const row of rows) {
		const wait = rowWaitMs(row, holds, now);
		if (wait === 0) eligible.push(row);
		waitMs = Math.min(waitMs, wait);
	}
	eligible.sort(dueOrder);
	return Object.freeze({ eligible: Object.freeze(eligible), waitMs });
}
