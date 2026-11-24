import type { TimerClock } from "../kernel/clock.ts";

/** How long a stop or a maintenance request waits for open claim permits. */
export const HUB_DRAIN_MS = 10_000;

export type HubState = "locked" | "opening" | "ready" | "maintenance" | "stopping" | "stopped";
export type HubLifecycleErrorCode =
	| "HUB_LOCKED"
	| "HUB_MAINTENANCE"
	| "HUB_STOPPING"
	| "HUB_BUSY"
	| "HUB_UNLOCKED"
	| "HUB_UNLOCK_FAILED";

/** Fixed and content-free: no cause, path or service detail is carried. */
export class HubLifecycleError extends Error {
	readonly code: HubLifecycleErrorCode;
	constructor(code: HubLifecycleErrorCode) {
		super(code);
		this.name = "HubLifecycleError";
		this.code = code;
	}
}

/** The opened hub services; the lifecycle closes them once, after the drain and the stop steps. */
export interface HubLifecycleSession {
	close(): void | Promise<void>;
}
/** Taken before a claim transaction and held until the attempt's outcome is durable. */
export interface ClaimPermit {
	release(): void;
}
export interface MaintenanceLease {
	release(): void;
}
export interface HubStopReport {
	readonly reason: string;
	readonly drained: boolean;
	readonly outstanding: number;
	readonly failures: number;
}
export interface HubLifecycle {
	readonly state: HubState;
	unlock<Session extends HubLifecycleSession>(open: () => Promise<Session>): Promise<Session>;
	beginClaim(): ClaimPermit;
	enterMaintenance(): Promise<MaintenanceLease>;
	addStopStep(step: () => void | Promise<void>): void;
	stop(reason: string): Promise<HubStopReport>;
	readonly stopped: Promise<HubStopReport>;
}

const STOP_REASON = /^[a-z][a-z0-9-]{0,31}$/;
const refusals: Readonly<Record<Exclude<HubState, "ready">, HubLifecycleErrorCode>> = {
	locked: "HUB_LOCKED",
	opening: "HUB_LOCKED",
	maintenance: "HUB_MAINTENANCE",
	stopping: "HUB_STOPPING",
	stopped: "HUB_STOPPING",
};

/**
 * Only a ready hub issues claim permits. Maintenance and stop close the gate first, then wait up
 * to HUB_DRAIN_MS for the permits already issued.
 */
export function createHubLifecycle(options: { readonly clock: TimerClock }): HubLifecycle {
	const clock = options.clock;
	if (typeof clock?.after !== "function") throw new TypeError("Hub lifecycle needs a timer clock");
	let state: HubState = "locked";
	let session: HubLifecycleSession | undefined;
	let openAttempt: Promise<unknown> | undefined;
	let idle: PromiseWithResolvers<void> | undefined;
	const permits = new Set<ClaimPermit>();
	const steps: (() => void | Promise<void>)[] = [];
	const { promise: stopped, resolve: finish } = Promise.withResolvers<HubStopReport>();
	const stopping = (): boolean => state === "stopping" || state === "stopped";
	const refuse = (code: HubLifecycleErrorCode): never => {
		throw new HubLifecycleError(code);
	};
	const gate = (): void => {
		if (state !== "ready") refuse(refusals[state]);
	};

	async function drain(): Promise<void> {
		if (permits.size === 0) return;
		idle ??= Promise.withResolvers<void>();
		const timer = new AbortController();
		try {
			await Promise.race([idle.promise, clock.after(HUB_DRAIN_MS, timer.signal)]);
		} catch {
			// A failed timer ends the wait, as the bound does.
		} finally {
			timer.abort();
		}
	}

	async function unlock<Session extends HubLifecycleSession>(
		open: () => Promise<Session>,
	): Promise<Session> {
		if (state !== "locked") refuse(stopping() ? "HUB_STOPPING" : "HUB_UNLOCKED");
		state = "opening";
		const attempt = (async () => (session = await open()))();
		openAttempt = attempt.catch(() => undefined);
		let opened: Session;
		try {
			opened = await attempt;
		} catch {
			if (state === "opening") state = "locked";
			throw new HubLifecycleError("HUB_UNLOCK_FAILED");
		}
		// A stop that began while opening closes this session; the hub never becomes ready.
		if (state !== "opening") refuse("HUB_STOPPING");
		state = "ready";
		return opened;
	}

	function beginClaim(): ClaimPermit {
		gate();
		const permit: ClaimPermit = Object.freeze({
			release: (): void => {
				permits.delete(permit);
				if (permits.size === 0) {
					idle?.resolve();
					idle = undefined;
				}
			},
		});
		permits.add(permit);
		return permit;
	}

	async function enterMaintenance(): Promise<MaintenanceLease> {
		gate();
		state = "maintenance";
		await drain();
		if (state !== "maintenance") refuse("HUB_STOPPING");
		if (permits.size > 0) {
			state = "ready";
			refuse("HUB_BUSY");
		}
		let held = true;
		return Object.freeze({
			release: (): void => {
				if (held && state === "maintenance") state = "ready";
				held = false;
			},
		});
	}

	function addStopStep(step: () => void | Promise<void>): void {
		if (stopping()) refuse("HUB_STOPPING");
		steps.push(step);
	}

	async function run(reason: string): Promise<void> {
		await drain();
		const outstanding = permits.size;
		let failures = 0;
		for (const step of steps.toReversed()) {
			try {
				await step();
			} catch {
				failures++;
			}
		}
		await openAttempt;
		try {
			await session?.close();
		} catch {
			failures++;
		}
		state = "stopped";
		finish(Object.freeze({ reason, drained: outstanding === 0, outstanding, failures }));
	}

	/** The first reason wins; every later call returns the same report. */
	function stop(reason: string): Promise<HubStopReport> {
		if (typeof reason !== "string" || !STOP_REASON.test(reason))
			throw new TypeError("Stop reason must be a short lowercase token");
		if (!stopping()) {
			state = "stopping";
			void run(reason);
		}
		return stopped;
	}

	return Object.freeze({
		get state(): HubState {
			return state;
		},
		unlock,
		beginClaim,
		enterMaintenance,
		addStopStep,
		stop,
		stopped,
	});
}
