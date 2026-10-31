import { MAX_WAIT_MS, type TimerClock } from "../../kernel/clock.ts";

function reading(clock: TimerClock): number {
	try {
		const now = clock.monotonicMs();
		return typeof now === "number" && Number.isFinite(now) ? now : Number.NaN;
	} catch {
		return Number.NaN;
	}
}

/**
 * True once `ms` of the clock's monotonic time has passed, false when `signal` aborts first. Waits
 * longer than MAX_WAIT_MS loop on bounded waits and recheck the monotonic time; an unreadable
 * clock or a failed wait counts as elapsed, so every deadline fails closed.
 */
export async function sleep(clock: TimerClock, ms: number, signal: AbortSignal): Promise<boolean> {
	const start = reading(clock);
	for (;;) {
		if (signal.aborted) return false;
		const remaining = Math.ceil(start + ms - reading(clock));
		if (!(remaining > 0)) return true;
		try {
			await clock.after(Math.min(remaining, MAX_WAIT_MS), signal);
		} catch {
			return !signal.aborted;
		}
	}
}

export interface Timer {
	cancel(): void;
}

/** Runs `fire` once after `ms`, unless cancelled or `signal` aborts first. */
export function schedule(
	clock: TimerClock,
	ms: number,
	signal: AbortSignal,
	fire: () => void,
): Timer {
	const controller = new AbortController();
	const combined = AbortSignal.any([signal, controller.signal]);
	void sleep(clock, ms, combined).then((elapsed) => {
		if (!elapsed || combined.aborted) return;
		controller.abort();
		try {
			fire();
		} catch {
			/* A deadline action never escapes as an unhandled rejection. */
		}
	});
	return { cancel: () => controller.abort() };
}

/** True when `promise` settles within `ms`; its outcome is otherwise ignored. */
export async function within(
	clock: TimerClock,
	ms: number,
	promise: Promise<unknown>,
): Promise<boolean> {
	const controller = new AbortController();
	const settled = promise.then(
		() => true,
		() => true,
	);
	try {
		return await Promise.race([settled, sleep(clock, ms, controller.signal).then(() => false)]);
	} finally {
		controller.abort();
	}
}
