// A prototype of M2a's kernel/clock.ts (plan section 3, Scheduler): one injected clock with
// separate wall and monotonic sources. after(ms) is the only wait outbox code may use, and it
// refuses anything over 15 s, so no timer is ever derived from notBefore: Node fires a delay over
// 2^31-1 ms (about 24.9 days) after 1 ms instead (test/timers.test.ts).
import { setTimeout as delay } from "node:timers/promises";

export const MAX_AFTER_MS = 15_000;

export interface Clock {
	// UTC epoch milliseconds as the OS reports them; they can jump either way.
	readonly wallNow: () => number;
	// Milliseconds that never go backwards; they pause while Linux is suspended.
	readonly monoNow: () => number;
	// Throws a RangeError, before any timer exists, unless 0 <= ms <= 15,000 and ms is whole.
	readonly after: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export function checkDelay(ms: number): number {
	if (!Number.isSafeInteger(ms) || ms < 0 || ms > MAX_AFTER_MS) {
		throw new RangeError(`clock.after takes whole milliseconds from 0 to ${MAX_AFTER_MS}: ${ms}`);
	}
	return ms;
}

export const systemClock: Clock = {
	wallNow: () => Date.now(),
	monoNow: () => performance.now(),
	after: (ms, signal) => delay(checkDelay(ms), undefined, { signal }),
};

// The scheduler's next tick: 15 s, or sooner when a row needs it, never before. nextDue is the
// earliest time a live row needs a tick: its not_before or, once a claim on it was held or its
// pre-claim read failed, its retry time (claim.ts), so a held row never ticks again at once. A
// past nextDue ticks at once; a missing or non-finite one waits a full tick.
export function nextTick(now: number, nextDue?: number): number {
	if (nextDue === undefined || !Number.isFinite(nextDue) || !Number.isFinite(now)) {
		return MAX_AFTER_MS;
	}
	return Math.min(MAX_AFTER_MS, Math.max(0, Math.ceil(nextDue - now)));
}
