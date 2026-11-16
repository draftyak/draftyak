import { setTimeout as delay } from "node:timers/promises";
import { types } from "node:util";

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

/** Whole ms to the next tick, 0..MAX_WAIT_MS; a missing, non-number or non-finite time waits a full tick. */
export function nextTick(now: number, nextDue?: number): number {
	if (
		typeof now !== "number" ||
		typeof nextDue !== "number" ||
		!Number.isFinite(now) ||
		!Number.isFinite(nextDue)
	)
		return MAX_WAIT_MS;
	return Math.min(MAX_WAIT_MS, Math.max(0, Math.ceil(nextDue - now)));
}

export interface TimeoutSignal {
	readonly signal: AbortSignal;
	cancel(): void;
}

export type DeadlineResult<T> =
	| { readonly ok: true; readonly value: T }
	| { readonly ok: false; readonly reason: "timeout" | "aborted" | "failed" };

type Outcome = "timeout" | "aborted" | "failed";

const TIMED_OUT: DeadlineResult<never> = Object.freeze({ ok: false, reason: "timeout" });
const ABORTED: DeadlineResult<never> = Object.freeze({ ok: false, reason: "aborted" });
const FAILED: DeadlineResult<never> = Object.freeze({ ok: false, reason: "failed" });

const elapsed = (): DOMException => new DOMException("Clock deadline elapsed", "TimeoutError");

// The same admission as systemClock.after: a fresh native signal, so no caller listener runs.
function isolate(parent: AbortSignal | undefined): AbortSignal | undefined {
	if (parent === undefined) return undefined;
	try {
		return AbortSignal.any([parent]);
	} catch {
		throw new TypeError("Clock wait signal must be an AbortSignal");
	}
}

// One clock.after wait on a fresh signal, ended by the timer, the isolated parent or the
// returned disarm; whichever comes first wins and the others are ignored.
function arm(
	clock: TimerClock,
	wait: number,
	parent: AbortSignal | undefined,
	end: (outcome: Outcome, reason: unknown) => void,
): () => void {
	const timer = new AbortController();
	let open = true;
	function disarm(): void {
		if (!open) return;
		open = false;
		parent?.removeEventListener("abort", onAbort);
		timer.abort();
	}
	function finish(outcome: Outcome, reason?: unknown): void {
		if (!open) return;
		disarm();
		end(outcome, reason);
	}
	function onAbort(): void {
		finish("aborted", parent?.reason);
	}
	parent?.addEventListener("abort", onAbort, { once: true });
	try {
		clock.after(wait, timer.signal).then(
			() => finish("timeout"),
			() => finish("failed"),
		);
	} catch (error) {
		disarm();
		throw error;
	}
	return disarm;
}

/** Aborts after a bounded relative wait through clock.after; checkWait admission before any timer. */
export function timeoutSignal(clock: TimerClock, ms: number, parent?: AbortSignal): TimeoutSignal {
	const wait = checkWait(ms);
	const source = isolate(parent);
	const output = new AbortController();
	if (source?.aborted) {
		output.abort(source.reason);
		return Object.freeze({ signal: output.signal, cancel: () => undefined });
	}
	// A wait the clock cannot keep ends now, as if elapsed.
	const cancel = arm(clock, wait, source, (outcome, reason) =>
		output.abort(outcome === "aborted" ? reason : elapsed()),
	);
	return Object.freeze({ signal: output.signal, cancel });
}

/** Runs work under a bounded deadline; refuses synchronously before calling work or arming a timer. */
export function withDeadline<T>(
	clock: TimerClock,
	ms: number,
	work: (signal: AbortSignal) => PromiseLike<T> | T,
	parent?: AbortSignal,
): Promise<DeadlineResult<T>> {
	const wait = checkWait(ms);
	if (typeof work !== "function" || types.isProxy(work))
		throw new TypeError("Clock deadline work must be a function");
	const source = isolate(parent);
	if (source?.aborted) return Promise.resolve(ABORTED);
	const { promise, resolve } = Promise.withResolvers<DeadlineResult<T>>();
	const controller = new AbortController();
	const disarm = arm(clock, wait, source, (outcome, reason) => {
		controller.abort(outcome === "aborted" ? reason : elapsed());
		resolve(outcome === "aborted" ? ABORTED : outcome === "timeout" ? TIMED_OUT : FAILED);
	});
	let result: PromiseLike<T> | T;
	try {
		result = work(controller.signal);
	} catch {
		disarm();
		resolve(FAILED);
		return promise;
	}
	// Both handlers stay attached, so a result after the deadline is dropped, never unhandled.
	Promise.resolve(result).then(
		(value) => {
			disarm();
			resolve(Object.freeze({ ok: true as const, value: value as T }));
		},
		() => {
			disarm();
			resolve(FAILED);
		},
	);
	return promise;
}

const domExceptionName = Object.getOwnPropertyDescriptor(DOMException.prototype, "name")?.get;

function ownValue(target: object, key: string): unknown {
	const descriptor = Object.getOwnPropertyDescriptor(target, key);
	return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

/** True for Node's AbortError and DOMException AbortError/TimeoutError; never runs a proxy trap or caller getter. */
export function isAbortError(error: unknown): boolean {
	if (error === null || typeof error !== "object" || types.isProxy(error)) return false;
	let name: unknown;
	try {
		// The platform getter checks its own brand and reads nothing from the caller's object.
		name = domExceptionName === undefined ? undefined : Reflect.apply(domExceptionName, error, []);
	} catch {
		name = undefined;
	}
	if (name !== undefined) return name === "AbortError" || name === "TimeoutError";
	return (
		types.isNativeError(error) &&
		ownValue(error, "name") === "AbortError" &&
		ownValue(error, "code") === "ABORT_ERR"
	);
}
