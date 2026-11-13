import { isPromise } from "node:util/types";

export type PluginCallKind = "call" | "sync" | "lookup" | "calendar.freebusy";
export interface PluginCallWatch<T> {
	readonly terminal: Promise<T>;
	readonly drained: Promise<void>;
	close(): Promise<void>;
}
export class PluginCallWatchdogError extends Error {
	override readonly name = "PluginCallWatchdogError";
	readonly code = "PLUGIN_CALL_WATCHDOG_FAILED";
	constructor() {
		super("Plugin call watchdog failed");
	}
}

const signalOf = Object.getOwnPropertyDescriptor(AbortController.prototype, "signal")!.get!;
const aborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted")!.get!;
const abort = AbortController.prototype.abort;
const add = EventTarget.prototype.addEventListener;
const remove = EventTarget.prototype.removeEventListener;
const then = Promise.prototype.then;
const GRACE_MS = 5_000;
function budget(kind: PluginCallKind): number {
	switch (kind) {
		case "call":
			return 30_000;
		case "sync":
			return 120_000;
		case "lookup":
			return 5_000;
		case "calendar.freebusy":
			return 15_000;
		default:
			throw new PluginCallWatchdogError();
	}
}

/**
 * Internal resource monitor. The runtime enrolls at an actual ready call's start.
 * Inputs must be its original controller and terminal RPC promise, never an abort race.
 * shutdown must stop that call's original process and return its physical close promise;
 * it must not wait on this watch's drain. Types do not establish invocation authority.
 */
export function watchPluginCall<T>(
	controller: AbortController,
	terminal: Promise<T>,
	kind: PluginCallKind,
	shutdown: () => Promise<unknown>,
): PluginCallWatch<T> {
	const milliseconds = budget(kind);
	if (!isPromise(terminal) || typeof shutdown !== "function") throw new PluginCallWatchdogError();
	let signal: AbortSignal;
	try {
		signal = signalOf.call(controller) as AbortSignal;
		aborted.call(signal);
	} catch {
		throw new PluginCallWatchdogError();
	}
	const deadline = performance.now() + milliseconds;
	let budgetTimer: ReturnType<typeof setTimeout> | undefined;
	let graceTimer: ReturnType<typeof setTimeout> | undefined;
	let graceDeadline = 0;
	let answered = false;
	let closed = false;
	let cancelled = false;
	let shutdownPending = false;
	let failed = false;
	let finished = false;
	let resolveDrain!: () => void;
	let rejectDrain!: (error: PluginCallWatchdogError) => void;
	const drained = new Promise<void>((resolve, reject) => {
		resolveDrain = resolve;
		rejectDrain = reject;
	});
	void Promise.allSettled([drained]);

	function fence(): void {
		clearTimeout(budgetTimer);
		clearTimeout(graceTimer);
		budgetTimer = undefined;
		graceTimer = undefined;
		remove.call(signal, "abort", onAbort);
	}
	function finish(): void {
		if (finished || !answered || shutdownPending) return;
		fence();
		finished = true;
		if (failed) rejectDrain(new PluginCallWatchdogError());
		else resolveDrain();
	}
	function onAnswered(): void {
		answered = true;
		fence();
		finish();
	}
	function graceWake(): void {
		graceTimer = undefined;
		if (answered || closed) return;
		const remaining = graceDeadline - performance.now();
		if (remaining > 0) {
			graceTimer = setTimeout(graceWake, remaining);
			return;
		}
		fence();
		// Own the pending work before invoking a callback that may synchronously reenter.
		shutdownPending = true;
		const original = Promise.resolve().then(() => {
			if (answered || closed) return;
			const result = shutdown();
			if (!isPromise(result) || result === drained) throw new PluginCallWatchdogError();
			return result;
		});
		void Promise.allSettled([
			then.call(
				original,
				() => {
					shutdownPending = false;
					finish();
				},
				() => {
					failed = true;
					shutdownPending = false;
					finish();
				},
			),
		]);
	}
	function startGrace(): void {
		if (answered || closed || cancelled) return;
		cancelled = true;
		clearTimeout(budgetTimer);
		budgetTimer = undefined;
		graceDeadline = performance.now() + GRACE_MS;
		graceTimer = setTimeout(graceWake, GRACE_MS);
	}
	function onAbort(): void {
		startGrace();
	}
	function budgetWake(): void {
		budgetTimer = undefined;
		if (answered || closed) return;
		const remaining = deadline - performance.now();
		if (remaining > 0) {
			budgetTimer = setTimeout(budgetWake, remaining);
			return;
		}
		// Arm grace first: abort listeners can answer or close this watch synchronously.
		startGrace();
		try {
			abort.call(controller, new Error("Plugin call timed out"));
		} catch {
			failed = true;
			finish();
		}
	}
	function close(): Promise<void> {
		closed = true;
		fence();
		finish();
		return drained;
	}
	const watch = Object.freeze({ terminal, drained, close });
	// Both outcomes are answers. Enroll before any cancellation callback or timer can run.
	void Promise.allSettled([then.call(terminal, onAnswered, onAnswered)]);
	add.call(signal, "abort", onAbort, { once: true });
	// A prior abort has no historical timestamp here: grace starts at immediate enrollment.
	if (aborted.call(signal)) startGrace();
	else budgetTimer = setTimeout(budgetWake, milliseconds);
	return watch;
}
