import { setTimeout as delay } from "node:timers/promises";

export interface Clock {
	wallMs(): number;
	monotonicMs(): number;
}

export interface TimerClock extends Clock {
	after(ms: number, signal?: AbortSignal): Promise<void>;
}

export const MAX_WAIT_MS = 15_000;

/** Refuse invalid relative waits before creating a native timer. */
export function checkWait(ms: number): number {
	if (!Number.isSafeInteger(ms) || ms < 0 || ms > MAX_WAIT_MS) {
		throw new RangeError("Clock wait must be whole milliseconds from 0 to 15000");
	}
	return ms;
}

export const systemClock: TimerClock = Object.freeze({
	wallMs: () => Date.now(),
	monotonicMs: () => performance.now(),
	after: (ms: number, signal?: AbortSignal) => {
		const wait = checkWait(ms);
		// Node arms the timer before it subscribes to the signal. Validate and isolate it first.
		let timerSignal: AbortSignal | undefined;
		if (signal !== undefined) {
			try {
				timerSignal = AbortSignal.any([signal]);
			} catch {
				throw new TypeError("Clock wait signal must be an AbortSignal");
			}
		}
		return delay(wait, undefined, { signal: timerSignal });
	},
});
