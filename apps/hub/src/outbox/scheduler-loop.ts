import { types } from "node:util";
import { checkWait, type TimerClock } from "../kernel/clock.ts";
import { SchedulerError, type SchedulerGate } from "./scheduler-ports.ts";
import {
	type ClockReading,
	diverged,
	HOLD_RETRY_MS,
	isMonoMs,
	isWallMs,
	snapshot,
} from "./scheduler-rules.ts";
import { schedulingAvailable } from "./scheduler-time.ts";

export type TickReason = "start" | "resumed" | "wake" | "timer" | "divergence";

export interface TickContext {
	readonly reason: TickReason;
	/** Both clocks, read after the wait and validated. */
	readonly now: ClockReading;
	/** Aborted by stop(). */
	readonly signal: AbortSignal;
}

/** One tick's work; returns the next wait in whole ms, which the loop admits through checkWait. */
export type SchedulerTick = (context: TickContext) => number | Promise<number>;

export type SchedulerLoopError = "SCHEDULER_DATA" | "SCHEDULER_STORE";

export interface SchedulerLoopOptions {
	readonly clock: TimerClock;
	readonly gate: SchedulerGate;
	readonly tick: SchedulerTick;
	readonly onError?: (code: SchedulerLoopError) => void;
}

export interface SchedulerStatus {
	readonly state: "new" | "running" | "paused" | "stopped";
	readonly schedulingAvailable: boolean;
	readonly lastTickWall: number | null;
}

type Method = (...args: unknown[]) => unknown;
type Episode = "reading" | "result" | "store" | "wait";

// Reasons that arrive before a tick runs merge into the strongest one.
const PRIORITY: Readonly<Record<TickReason, number>> = Object.freeze({
	timer: 0,
	wake: 1,
	divergence: 2,
	resumed: 3,
	start: 4,
});

const EARLY_WAKES = 3;
// Native waits may complete up to one millisecond early.
const EARLY_SLACK_MS = 1;

const stronger = (a: TickReason, b: TickReason | undefined): TickReason =>
	b !== undefined && PRIORITY[b] > PRIORITY[a] ? b : a;

function callable(value: unknown): value is Method {
	return typeof value === "function" && !types.isProxy(value);
}

// A data-property method of a non-proxy object or its prototypes, pinned at construction.
function method(target: unknown, name: string): Method {
	let current = target;
	for (let depth = 0; depth < 16; depth++) {
		if (
			current === null ||
			(typeof current !== "object" && typeof current !== "function") ||
			types.isProxy(current)
		)
			break;
		const descriptor = Object.getOwnPropertyDescriptor(current, name);
		if (descriptor !== undefined) {
			const value: unknown = "value" in descriptor ? descriptor.value : undefined;
			if (!callable(value)) break;
			return (...args) => Reflect.apply(value, target, args);
		}
		current = Object.getPrototypeOf(current);
	}
	throw new SchedulerError("SCHEDULER_CONFIG");
}

/**
 * A store-independent tick loop on the injected clock: one tick at a time, every wait through
 * clock.after and checkWait, both clocks re-read after each wait, and the gate read at every
 * tick start. A wake or resume during a tick queues exactly one immediate re-tick.
 */
export class SchedulerLoop {
	readonly #wallMs: Method;
	readonly #monotonicMs: Method;
	readonly #after: Method;
	readonly #gate: Method;
	readonly #tick: Method;
	readonly #onError: Method | undefined;
	readonly #episodes = new Set<Episode>();
	#state: SchedulerStatus["state"] = "new";
	#reason: TickReason | undefined;
	// The reason of a tick that threw, run again after the retry wait rather than at once.
	#carried: TickReason | undefined;
	#early = 0;
	#wait: AbortController | undefined;
	#ticking: AbortController | undefined;
	#done: Promise<void> | undefined;
	#previous: ClockReading | undefined;
	#lastTickWall: number | null = null;

	constructor(options: SchedulerLoopOptions) {
		const { clock, gate, tick, onError } = snapshot(
			options,
			["clock", "gate", "tick"],
			["onError"],
			"SCHEDULER_CONFIG",
		);
		if (!callable(tick) || (onError !== undefined && !callable(onError)))
			throw new SchedulerError("SCHEDULER_CONFIG");
		this.#wallMs = method(clock, "wallMs");
		this.#monotonicMs = method(clock, "monotonicMs");
		this.#after = method(clock, "after");
		this.#gate = method(gate, "state");
		this.#tick = tick;
		this.#onError = onError;
	}

	/** Runs the "start" tick at once; SCHEDULER_STATE once started or stopped. */
	start(): void {
		if (this.#state !== "new") throw new SchedulerError("SCHEDULER_STATE");
		this.#state = "running";
		this.#reason = "start";
		this.#done = this.#run();
	}

	/** An immediate "resumed" tick; the shell clears hold retry times on it. */
	resumed(): void {
		this.#nudge("resumed");
	}

	wake(): void {
		this.#nudge("wake");
	}

	/** Idempotent; aborts the wait and the tick signal and resolves once the tick settles. */
	stop(): Promise<void> {
		if (this.#state !== "stopped") {
			this.#state = "stopped";
			this.#wait?.abort();
			this.#ticking?.abort();
		}
		return this.#done ?? Promise.resolve();
	}

	[Symbol.asyncDispose](): Promise<void> {
		return this.stop();
	}

	status(): SchedulerStatus {
		return Object.freeze({
			state: this.#state,
			schedulingAvailable: schedulingAvailable(),
			lastTickWall: this.#lastTickWall,
		});
	}

	#nudge(reason: TickReason): void {
		if (this.#state === "new" || this.#state === "stopped") return;
		this.#merge(reason);
		this.#wait?.abort();
	}

	#merge(reason: TickReason): void {
		this.#reason = stronger(reason, this.#reason);
	}

	#enter(state: "running" | "paused"): boolean {
		if (this.#state === "stopped") return false;
		this.#state = state;
		return true;
	}

	async #run(): Promise<void> {
		await Promise.resolve();
		while (this.#state !== "stopped") {
			const now = this.#read();
			if (now === undefined) {
				this.#report("reading", "SCHEDULER_DATA");
				await this.#sleep(HOLD_RETRY_MS);
				continue;
			}
			this.#episodes.delete("reading");
			if (!this.#open()) {
				if (this.#enter("paused")) await this.#sleep(HOLD_RETRY_MS);
				continue;
			}
			if (!this.#enter("running")) break;
			const next = await this.#tickOnce(now);
			if (next === undefined) break;
			await this.#sleep(this.#reason === undefined ? next : 0);
		}
	}

	#read(): ClockReading | undefined {
		let wall: unknown;
		let mono: unknown;
		try {
			wall = this.#wallMs();
			mono = this.#monotonicMs();
		} catch {
			return undefined;
		}
		if (!isWallMs(wall) || !isMonoMs(mono)) return undefined;
		const now: ClockReading = Object.freeze({ wall, mono });
		const previous = this.#previous;
		// A reading behind the last one is refused once and becomes the baseline, so one far-ahead
		// reading cannot stall the loop.
		this.#previous = now;
		if (previous === undefined) return now;
		if (mono < previous.mono) return undefined;
		if (diverged(previous, now)) this.#merge("divergence");
		return now;
	}

	#mono(): number {
		try {
			const mono = this.#monotonicMs();
			return isMonoMs(mono) ? mono : Number.NaN;
		} catch {
			return Number.NaN;
		}
	}

	#open(): boolean {
		try {
			return this.#gate() === "running";
		} catch {
			return false;
		}
	}

	async #tickOnce(now: ClockReading): Promise<number | undefined> {
		const reason = stronger(this.#reason ?? "timer", this.#carried);
		this.#reason = undefined;
		this.#carried = undefined;
		const controller = new AbortController();
		this.#ticking = controller;
		this.#lastTickWall = now.wall;
		const tick = this.#tick;
		let result: unknown;
		let threw = false;
		try {
			result = await tick(Object.freeze({ reason, now, signal: controller.signal }));
		} catch {
			threw = true;
		} finally {
			this.#ticking = undefined;
		}
		if (this.#state === "stopped") return undefined;
		if (threw) {
			this.#carried = reason;
			this.#report("store", "SCHEDULER_STORE");
			return HOLD_RETRY_MS;
		}
		this.#episodes.delete("store");
		try {
			const wait = checkWait(result as number);
			this.#episodes.delete("result");
			return wait;
		} catch {
			this.#report("result", "SCHEDULER_DATA");
			return HOLD_RETRY_MS;
		}
	}

	async #sleep(ms: number): Promise<void> {
		if (this.#state === "stopped") return;
		const controller = new AbortController();
		this.#wait = controller;
		const aborted = new Promise<boolean>((resolve) =>
			controller.signal.addEventListener("abort", () => resolve(false), { once: true }),
		);
		try {
			const started = this.#mono();
			const pending = this.#after(ms, controller.signal);
			if (!types.isPromise(pending)) throw new SchedulerError("SCHEDULER_DATA");
			if (await Promise.race([pending.then(() => true), aborted])) {
				const elapsed = this.#mono() - started;
				if (elapsed >= ms - EARLY_SLACK_MS && (ms === 0 || elapsed > 0)) {
					this.#early = 0;
					this.#episodes.delete("wait");
				} else if (++this.#early >= EARLY_WAKES) throw new SchedulerError("SCHEDULER_DATA");
			}
		} catch {
			// A clock that cannot wait, or keeps ending waits early, parks the loop until wake, resume
			// or stop, so it never spins.
			if (!controller.signal.aborted) {
				this.#report("wait", "SCHEDULER_DATA");
				await aborted;
			}
		} finally {
			if (this.#wait === controller) this.#wait = undefined;
		}
	}

	#report(episode: Episode, code: SchedulerLoopError): void {
		if (this.#episodes.has(episode)) return;
		this.#episodes.add(episode);
		const onError = this.#onError;
		try {
			onError?.(code);
		} catch {
			// A failing listener never stops the loop.
		}
	}
}
