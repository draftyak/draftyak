import { types } from "node:util";
import type { TimerClock } from "../kernel/clock.ts";
import {
	SchedulerLoop,
	type SchedulerLoopError,
	type SchedulerTick,
} from "../outbox/scheduler-loop.ts";
import { SchedulerError } from "../outbox/scheduler-ports.ts";
import { snapshot } from "../outbox/scheduler-rules.ts";
import type { HubLifecycle } from "./state.ts";

export interface LifecycleSchedulerOptions {
	readonly lifecycle: HubLifecycle;
	readonly clock: TimerClock;
	readonly tick: SchedulerTick;
	readonly onError?: (code: SchedulerLoopError) => void;
}

interface Binding {
	readonly clock: unknown;
	readonly tick: unknown;
	readonly onError: unknown;
	readonly loop: SchedulerLoop;
}

const bindings = new WeakMap<object, Binding>();
const registering = new WeakSet<object>();
const start = SchedulerLoop.prototype.start;
const stop = SchedulerLoop.prototype.stop;
const then = Promise.prototype.then;
const ignore = (): void => {};

function observeInvalidRegistration(value: unknown): void {
	if (
		types.isPromise(value) &&
		Object.getPrototypeOf(value) === Promise.prototype &&
		!Object.hasOwn(value, "constructor")
	)
		Reflect.apply(then, value, [ignore, ignore]);
}

/**
 * Start one loop behind the hub's lifecycle gate and register its awaited stop before any tick.
 * Only ready admits a tick; locked, opening, maintenance, stopping and stopped remain paused.
 * The caller explicitly wakes the loop after an owner-authorized lifecycle transition. This does
 * not unlock the hub, acquire a claim permit, clear stored holds or grant send authority.
 *
 * The actual lifecycle supplies an own state getter and an own addStopStep data method. Both are
 * captured once; the registrar synchronously returns undefined. Collaborator prototypes and native
 * promise constructors remain intact. Configuration and registration failures refuse with SCHEDULER_CONFIG;
 * repeating an identical binding returns the same loop, and different collaborators refuse with
 * SCHEDULER_STATE. A stopped loop is never restarted by repeating the factory call.
 */
export function createLifecycleScheduler(options: LifecycleSchedulerOptions): SchedulerLoop {
	const captured = snapshot(
		options,
		["lifecycle", "clock", "tick"],
		["onError"],
		"SCHEDULER_CONFIG",
	);
	const { lifecycle, clock, tick, onError } = captured;
	if (typeof lifecycle !== "object" || lifecycle === null || types.isProxy(lifecycle))
		throw new SchedulerError("SCHEDULER_CONFIG");
	const prior = bindings.get(lifecycle);
	if (prior !== undefined) {
		if (prior.clock !== clock || prior.tick !== tick || prior.onError !== onError)
			throw new SchedulerError("SCHEDULER_STATE");
		return prior.loop;
	}
	if (registering.has(lifecycle)) throw new SchedulerError("SCHEDULER_STATE");

	let loop: SchedulerLoop;
	try {
		const prototype: unknown = Object.getPrototypeOf(lifecycle);
		if (prototype !== Object.prototype && prototype !== null)
			throw new SchedulerError("SCHEDULER_CONFIG");
		const state = Object.getOwnPropertyDescriptor(lifecycle, "state");
		const step = Object.getOwnPropertyDescriptor(lifecycle, "addStopStep");
		const readState: unknown = state?.get;
		const addStopStep: unknown = step !== undefined && "value" in step ? step.value : undefined;
		if (
			typeof readState !== "function" ||
			types.isProxy(readState) ||
			state?.set !== undefined ||
			typeof addStopStep !== "function" ||
			types.isProxy(addStopStep) ||
			types.isAsyncFunction(addStopStep)
		)
			throw new SchedulerError("SCHEDULER_CONFIG");
		loop = new SchedulerLoop({
			clock: clock as TimerClock,
			tick: tick as SchedulerTick,
			onError: onError as LifecycleSchedulerOptions["onError"],
			gate: {
				state: () => {
					try {
						return Reflect.apply(readState, lifecycle, []) === "ready" ? "running" : "paused";
					} catch {
						return "paused";
					}
				},
			},
		});
		registering.add(lifecycle);
		try {
			const registered: unknown = Reflect.apply(addStopStep, lifecycle, [
				() => Reflect.apply(stop, loop, []),
			]);
			if (registered !== undefined) {
				observeInvalidRegistration(registered);
				throw new SchedulerError("SCHEDULER_CONFIG");
			}
			Reflect.apply(start, loop, []);
		} finally {
			registering.delete(lifecycle);
		}
	} catch {
		// A registration error can contain service details; expose only the fixed refusal code.
		throw new SchedulerError("SCHEDULER_CONFIG");
	}
	bindings.set(lifecycle, { clock, tick, onError, loop });
	return loop;
}
