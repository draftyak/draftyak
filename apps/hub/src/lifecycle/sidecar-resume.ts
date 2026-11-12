import { types } from "node:util";
import type { SidecarInput, SidecarStop } from "../kernel/sidecar-input.ts";
import { SchedulerLoop } from "../outbox/scheduler-loop.ts";

export type SidecarResumeCode =
	| "SIDECAR_RESUME_OPTIONS"
	| "SIDECAR_RESUME_BOUND"
	| "SIDECAR_RESUME_STREAM";

export class SidecarResumeError extends Error {
	readonly code: SidecarResumeCode;
	constructor(code: SidecarResumeCode) {
		super(code);
		this.name = "SidecarResumeError";
		this.code = code;
	}
}

type ResumeInput = Pick<SidecarInput, "state" | "nextControl" | "terminal" | "closed">;
type Method = (...args: unknown[]) => unknown;
interface Binding {
	readonly scheduler: SchedulerLoop;
	readonly done: Promise<void>;
}

const bindings = new WeakMap<object, Binding>();
const then = Promise.prototype.then;
const resumed = SchedulerLoop.prototype.resumed;
const status = SchedulerLoop.prototype.status;
const ignore = (): void => {};

function descriptor(input: object, name: string): PropertyDescriptor {
	let current: object | null = input;
	for (let depth = 0; current !== null && depth < 16; depth++) {
		if (types.isProxy(current)) break;
		const found = Object.getOwnPropertyDescriptor(current, name);
		if (found !== undefined) return found;
		current = Object.getPrototypeOf(current);
	}
	throw new SidecarResumeError("SIDECAR_RESUME_OPTIONS");
}

function nativePromise(value: unknown): Promise<unknown> {
	if (
		!types.isPromise(value) ||
		Object.getPrototypeOf(value) !== Promise.prototype ||
		Object.hasOwn(value, "constructor")
	)
		throw new SidecarResumeError("SIDECAR_RESUME_OPTIONS");
	// Observe a native promise without consulting a replaceable own then property.
	return new Promise((resolve, reject) => Reflect.apply(then, value, [resolve, reject]));
}

function stopReason(reason: unknown): boolean {
	return (
		reason === "shutdown" ||
		reason === "eof" ||
		reason === "fault" ||
		reason === "cancelled" ||
		reason === "disposed"
	);
}

function terminalStop(value: unknown): value is SidecarStop {
	if (typeof value !== "object" || value === null || types.isProxy(value)) return false;
	const { kind, reason } = value as Partial<SidecarStop>;
	return kind === "stop" && stopReason(reason);
}

/**
 * Give one control consumer to a started SchedulerLoop. Native resume frames only nudge that loop;
 * its existing gate still admits every tick. This does not start or stop the scheduler, clear stored
 * holds, or own lifecycle drain. The lifecycle must separately stop the loop when input terminates.
 *
 * Bind the actual receiver while its methods/prototype and native promise constructors are intact.
 * Repeating the same input/loop binding returns the same promise; another loop is refused. Completion
 * waits for terminal input and actual receiver cleanup. Failures expose a fixed code, never input data.
 */
export function bindSidecarResumes(input: ResumeInput, scheduler: SchedulerLoop): Promise<void> {
	try {
		if (typeof input !== "object" || input === null || types.isProxy(input))
			throw new SidecarResumeError("SIDECAR_RESUME_OPTIONS");
		const prior = bindings.get(input);
		if (prior !== undefined) {
			if (prior.scheduler !== scheduler) throw new SidecarResumeError("SIDECAR_RESUME_BOUND");
			return prior.done;
		}
		// Calling the captured concrete method checks the loop's private brand without invoking hooks.
		const state = Reflect.apply(status, scheduler, []).state;
		if (state !== "running" && state !== "paused")
			throw new SidecarResumeError("SIDECAR_RESUME_OPTIONS");
		const next = descriptor(input, "nextControl").value as unknown;
		const readState = descriptor(input, "state").get;
		const terminalValue = Object.getOwnPropertyDescriptor(input, "terminal")?.value as unknown;
		const closedValue = Object.getOwnPropertyDescriptor(input, "closed")?.value as unknown;
		if (
			typeof next !== "function" ||
			types.isProxy(next) ||
			typeof readState !== "function" ||
			types.isProxy(readState)
		)
			throw new SidecarResumeError("SIDECAR_RESUME_OPTIONS");
		const done = Promise.withResolvers<void>();
		// Install ownership before observing promises or calling any receiver method.
		bindings.set(input, { scheduler, done: done.promise });
		void done.promise.catch(ignore);
		try {
			let ended = false;
			const terminal = nativePromise(terminalValue).then((stop) => {
				ended = true;
				if (!terminalStop(stop)) throw new SidecarResumeError("SIDECAR_RESUME_STREAM");
			});
			void terminal.catch(() => {
				ended = true;
			});
			const closed = nativePromise(closedValue);
			void closed.catch(ignore);
			const completed = async (): Promise<void> => {
				await terminal;
				await closed;
			};
			const active = (): boolean => {
				const current: unknown = Reflect.apply(readState, input, []);
				if (current === "closing" || current === "closed") return false;
				if (
					current !== "awaiting-initial" &&
					current !== "initial-available" &&
					current !== "initial-taken"
				)
					throw new SidecarResumeError("SIDECAR_RESUME_STREAM");
				return true;
			};
			const run = async (): Promise<void> => {
				while (!ended && active()) {
					const pending = nativePromise(Reflect.apply(next as Method, input, []));
					// The receiver settles its sole pending control when it becomes terminal.
					const control = await pending;
					// A same-buffer terminal frame can follow a resolved resume before this reaction runs.
					if (ended || !active()) break;
					if (typeof control !== "object" || control === null || types.isProxy(control))
						throw new SidecarResumeError("SIDECAR_RESUME_STREAM");
					const kind: unknown = (control as { readonly kind?: unknown }).kind;
					if (kind === "stop") {
						if (!stopReason((control as Partial<SidecarStop>).reason))
							throw new SidecarResumeError("SIDECAR_RESUME_STREAM");
						break;
					}
					if (kind !== "resumed") throw new SidecarResumeError("SIDECAR_RESUME_STREAM");
					Reflect.apply(resumed, scheduler, []);
				}
				await completed();
			};
			// One lifetime race also observes a terminal failure if a broken control never settles.
			void Promise.race([run(), completed()]).then(done.resolve, () =>
				done.reject(new SidecarResumeError("SIDECAR_RESUME_STREAM")),
			);
		} catch {
			done.reject(new SidecarResumeError("SIDECAR_RESUME_OPTIONS"));
		}
		return done.promise;
	} catch (error) {
		if (error instanceof SidecarResumeError) throw error;
		throw new SidecarResumeError("SIDECAR_RESUME_OPTIONS");
	}
}
