// A prototype of the scheduled claim's clock rule (plan section 3): a claim or retry needs
// min(hubNow, secondNow) >= notBefore and max(hubNow, secondNow) <= deliverBy, so a wrong or lying
// clock can only delay a send. The claim's SQL takes the min as :early and the max as :late.
import { MAX_AFTER_MS } from "./clock.ts";

export const MAX_SKEW_MS = 120_000;
// A held claim is retried after retryInMs, never at once: an early hold no sooner than 1 s, as a
// Date header has whole seconds; a skew hold, like a failed pre-claim read, after a full tick.
export const MIN_RETRY_MS = 1_000;
export const HOLD_RETRY_MS: number = MAX_AFTER_MS;

export interface Window {
	readonly notBefore: number;
	readonly deliverBy: number;
}

export type Claim =
	| { readonly ok: true; readonly early: number; readonly late: number }
	// Never claimable: past deliverBy (NEEDS_REAPPROVAL, missed), or not two safe integers in order.
	| { readonly ok: false; readonly hold: "missed" }
	| { readonly ok: false; readonly hold: "window" }
	| { readonly ok: false; readonly hold: "early"; readonly retryInMs: number }
	| { readonly ok: false; readonly hold: "skew"; readonly retryInMs: number };

export function checkClaim(window: Window, hubNow: number, secondNow: number): Claim {
	const { notBefore, deliverBy } = window;
	if (
		!Number.isSafeInteger(notBefore) ||
		!Number.isSafeInteger(deliverBy) ||
		notBefore > deliverBy
	) {
		return { ok: false, hold: "window" };
	}
	// Skew over 2 min, or an unreadable clock, holds the account's claims (and alerts once).
	if (!(Math.abs(hubNow - secondNow) <= MAX_SKEW_MS)) {
		return { ok: false, hold: "skew", retryInMs: HOLD_RETRY_MS };
	}
	const early = Math.min(hubNow, secondNow);
	const late = Math.max(hubNow, secondNow);
	if (late > deliverBy) return { ok: false, hold: "missed" };
	if (early < notBefore) {
		const wait = Math.max(MIN_RETRY_MS, Math.ceil(notBefore - early));
		return { ok: false, hold: "early", retryInMs: Math.min(HOLD_RETRY_MS, wait) };
	}
	return { ok: true, early, late };
}

const IMF_FIXDATE =
	/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/;

// The second clock: the Date header of the claim's own pre-claim read as the broker observed it,
// plus monotonic time since; plugins never supply it. Whole seconds, so it lags its upstream.
// Date.parse turns impossible dates (31 Feb, hour 24, second 60) into other instants and ignores
// the weekday, so the header must also be what its own instant prints.
export function secondNow(date: string, monoAtResponse: number, monoNow: number): number {
	const at = IMF_FIXDATE.test(date) ? Date.parse(date) : Number.NaN;
	if (Number.isNaN(at) || new Date(at).toUTCString() !== date) {
		throw new RangeError("the pre-claim read has no valid IMF-fixdate Date header");
	}
	return at + (monoNow - monoAtResponse);
}
