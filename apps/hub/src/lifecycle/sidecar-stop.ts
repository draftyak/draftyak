import { types } from "node:util";
import { systemClock, type TimerClock } from "../kernel/clock.ts";
import type { SidecarInput, SidecarStop, SidecarStopReason } from "../kernel/sidecar-input.ts";
import { HUB_DRAIN_MS, type HubLifecycle, type HubStopReport } from "./state.ts";

/** The parent may terminate the hub after the same grace used for claim draining. */
export const SIDECAR_SHUTDOWN_MS: number = HUB_DRAIN_MS;

export type SidecarShutdownErrorCode =
	| "SIDECAR_SHUTDOWN_OPTIONS"
	| "SIDECAR_SHUTDOWN_BOUND"
	| "SIDECAR_SHUTDOWN_EXIT";

/** Fixed and content-free: input, service and exit-hook errors are never retained. */
export class SidecarShutdownError extends Error {
	readonly code: SidecarShutdownErrorCode;
	constructor(code: SidecarShutdownErrorCode) {
		super(code);
		this.name = "SidecarShutdownError";
		this.code = code;
	}
}

export interface SidecarShutdownReport {
	readonly reason: SidecarStopReason;
	readonly outcome: "clean" | "failed" | "deadline";
	readonly exitCode: 0 | 1;
}

export interface SidecarShutdownOptions {
	readonly input: Pick<SidecarInput, "terminal" | "closed">;
	readonly lifecycle: Pick<HubLifecycle, "stop">;
	readonly clock?: TimerClock;
	/** Requests process termination. Tests supply an owned sink instead of exiting. */
	readonly exit?: (code: 0 | 1) => void;
}

interface Binding {
	readonly lifecycle: SidecarShutdownOptions["lifecycle"];
	readonly clock: TimerClock;
	readonly exit: NonNullable<SidecarShutdownOptions["exit"]>;
	readonly done: Promise<SidecarShutdownReport>;
}

const bindings = new WeakMap<object, Binding>();
const exitProcess = (code: 0 | 1): void => process.exit(code);
const then = Promise.prototype.then;
const reasons = new Set<SidecarStopReason>(["shutdown", "eof", "fault", "cancelled", "disposed"]);

function observe<T, R>(
	promise: Promise<T>,
	resolve: (value: T) => R,
	reject: () => R,
): Promise<Awaited<R>> {
	return Reflect.apply(then, promise, [resolve, reject]) as Promise<Awaited<R>>;
}

function receiverPromise(value: unknown): value is Promise<unknown> {
	return (
		types.isPromise(value) &&
		Object.getPrototypeOf(value) === Promise.prototype &&
		!Object.hasOwn(value, "constructor")
	);
}

interface TerminalEvent {
	readonly reason: SidecarStopReason;
	readonly valid: boolean;
}

function terminalEvent(value: unknown): TerminalEvent {
	try {
		if (typeof value === "object" && value !== null) {
			const event = value as SidecarStop;
			const kind = event.kind;
			const reason = event.reason;
			const code = event.code;
			if (kind === "stop" && reasons.has(reason) && (reason === "fault" || code === undefined))
				return { reason, valid: true };
		}
	} catch {
		/* A malformed terminal value is a source fault, with no detail copied. */
	}
	return { reason: "fault", valid: false };
}

/**
 * Bind one native stdin receiver to one lifecycle. A terminal frame or EOF closes claim admission
 * before waiting for services and receiver cleanup. The asynchronous grace ends with a process-exit
 * request; it does not replace the desktop parent's native process containment or kill deadline.
 * Collaborators supply their native promises with the standard prototype and constructor intact.
 * Importing this module registers no listeners and never exits the process.
 */
export function bindSidecarShutdown(
	options: SidecarShutdownOptions,
): Promise<SidecarShutdownReport> {
	let input: SidecarShutdownOptions["input"];
	let lifecycle: SidecarShutdownOptions["lifecycle"];
	let clock: TimerClock;
	let exit: Binding["exit"];
	let stop: HubLifecycle["stop"];
	let after: TimerClock["after"];
	let terminalInput: Promise<SidecarStop>;
	let closedInput: Promise<void>;
	try {
		input = options.input;
		lifecycle = options.lifecycle;
		const requestedClock = options.clock;
		const requestedExit = options.exit;
		clock = requestedClock === undefined ? systemClock : requestedClock;
		exit = requestedExit === undefined ? exitProcess : requestedExit;
		if (
			typeof input !== "object" ||
			input === null ||
			typeof lifecycle !== "object" ||
			lifecycle === null ||
			typeof clock !== "object" ||
			clock === null ||
			typeof exit !== "function"
		)
			throw new Error();
		stop = lifecycle.stop;
		after = clock.after;
		if (typeof stop !== "function" || typeof after !== "function") throw new Error();
		terminalInput = input.terminal;
		closedInput = input.closed;
		if (!receiverPromise(terminalInput) || !receiverPromise(closedInput)) throw new Error();
	} catch {
		throw new SidecarShutdownError("SIDECAR_SHUTDOWN_OPTIONS");
	}
	const prior = bindings.get(input);
	if (prior !== undefined) {
		if (prior.lifecycle !== lifecycle || prior.clock !== clock || prior.exit !== exit)
			throw new SidecarShutdownError("SIDECAR_SHUTDOWN_BOUND");
		return prior.done;
	}

	const pending = Promise.withResolvers<SidecarShutdownReport>();
	bindings.set(input, { lifecycle, clock, exit, done: pending.promise });
	let closed = Promise.resolve(false);
	const shutdown = async (event: TerminalEvent): Promise<SidecarShutdownReport> => {
		const timer = new AbortController();
		let stopping: Promise<boolean>;
		try {
			// stop closes the claim gate synchronously, before a timer or another await can run.
			const requested = Reflect.apply(stop, lifecycle, [event.reason]);
			if (!types.isPromise(requested)) throw new Error();
			stopping = observe(
				requested,
				(report: HubStopReport) => {
					try {
						const reason = report.reason;
						const drained = report.drained;
						const outstanding = report.outstanding;
						const failures = report.failures;
						return (
							(reason === "eof" || reason === "shutdown") &&
							drained === true &&
							outstanding === 0 &&
							failures === 0
						);
					} catch {
						return false;
					}
				},
				() => false,
			);
		} catch {
			stopping = Promise.resolve(false);
		}
		const completed = Promise.all([stopping, closed]).then(
			([stopped, cleaned]): SidecarShutdownReport["outcome"] =>
				event.valid && (event.reason === "eof" || event.reason === "shutdown") && stopped && cleaned
					? "clean"
					: "failed",
		);
		let deadline: Promise<SidecarShutdownReport["outcome"]>;
		try {
			deadline = observe(
				Reflect.apply(after, clock, [SIDECAR_SHUTDOWN_MS, timer.signal]),
				() => "deadline" as const,
				() => "failed" as const,
			);
		} catch {
			deadline = Promise.resolve("failed");
		}
		const outcome = await Promise.race([completed, deadline]);
		timer.abort();
		const report: SidecarShutdownReport = Object.freeze({
			reason: event.reason,
			outcome,
			exitCode: outcome === "clean" ? 0 : 1,
		});
		try {
			exit(report.exitCode);
		} catch {
			throw new SidecarShutdownError("SIDECAR_SHUTDOWN_EXIT");
		}
		return report;
	};
	const fault = (): Promise<SidecarShutdownReport> => shutdown({ reason: "fault", valid: false });
	const run = (): Promise<SidecarShutdownReport> => {
		try {
			closed = observe(
				closedInput,
				() => true,
				() => false,
			);
			return observe(terminalInput, (value) => shutdown(terminalEvent(value)), fault);
		} catch {
			// Promise observation failure also closes the gate before requesting a failed exit.
			return fault();
		}
	};
	void run().then(pending.resolve, pending.reject);
	return pending.promise;
}
