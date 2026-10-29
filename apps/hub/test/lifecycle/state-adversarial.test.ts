import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import type { TimerClock } from "../../src/kernel/clock.ts";
import {
	createHubLifecycle,
	HUB_DRAIN_MS,
	type HubLifecycle,
	HubLifecycleError,
	type HubLifecycleSession,
} from "../../src/lifecycle/state.ts";

const CANARY = "DYTEST-PRIVATE-CANARY";

interface Wait {
	readonly ms: number;
	readonly signal: AbortSignal | undefined;
	fire(): void;
}

/** Timers end only when a test fires them; an abort rejects, as Node's timers do. */
function manualClock(): TimerClock & { readonly waits: Wait[] } {
	const waits: Wait[] = [];
	return {
		waits,
		wallMs: () => 0,
		monotonicMs: () => 0,
		after: (ms, signal) =>
			new Promise<void>((resolve, reject) => {
				waits.push({ ms, signal, fire: resolve });
				signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
			}),
	};
}

function fakeSession(onClose: () => void = () => {}): HubLifecycleSession & { closes: number } {
	const session = {
		closes: 0,
		close(): void {
			session.closes++;
			onClose();
		},
	};
	return session;
}

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function watch<T>(promise: Promise<T>): { settled: boolean; value?: T; error?: unknown } {
	const seen: { settled: boolean; value?: T; error?: unknown } = { settled: false };
	promise.then(
		(value) => Object.assign(seen, { settled: true, value }),
		(error: unknown) => Object.assign(seen, { settled: true, error }),
	);
	return seen;
}

function refusal(action: () => unknown): string | undefined {
	try {
		action();
	} catch (error) {
		expect(error).toBeInstanceOf(HubLifecycleError);
		return (error as HubLifecycleError).code;
	}
	return undefined;
}

async function caught(promise: Promise<unknown>): Promise<HubLifecycleError> {
	const error = await promise.then(
		() => undefined,
		(failure: unknown) => failure,
	);
	expect(error).toBeInstanceOf(HubLifecycleError);
	return error as HubLifecycleError;
}

async function readyHub(clock: TimerClock = manualClock()): Promise<{
	hub: HubLifecycle;
	session: ReturnType<typeof fakeSession>;
}> {
	const hub = createHubLifecycle({ clock });
	const session = fakeSession();
	await hub.unlock(async () => session);
	return { hub, session };
}

function expectNoCanary(value: unknown): void {
	for (const text of [inspect(value, { depth: 5, showHidden: true }), JSON.stringify(value)])
		expect(text).not.toContain(CANARY);
}

describe("content-free failures", () => {
	it.each([
		[
			"rejects with an error",
			async (): Promise<HubLifecycleSession> => Promise.reject(new Error(CANARY)),
		],
		["rejects with a string", async (): Promise<HubLifecycleSession> => Promise.reject(CANARY)],
		[
			"throws before returning a promise",
			(): Promise<HubLifecycleSession> => {
				throw new Error(CANARY);
			},
		],
	])("drops the detail of an open that %s", async (_name, open) => {
		const hub = createHubLifecycle({ clock: manualClock() });
		const error = await caught(hub.unlock(open));
		expect(error.code).toBe("HUB_UNLOCK_FAILED");
		expect(error.message).toBe("HUB_UNLOCK_FAILED");
		expect(error.name).toBe("HubLifecycleError");
		expect(error.cause).toBeUndefined();
		expect(error.stack).not.toContain(CANARY);
		expectNoCanary(error);
		expect(hub.state).toBe("locked");
	});

	it("counts step and session failures without their content", async () => {
		const hub = createHubLifecycle({ clock: manualClock() });
		const session = fakeSession(() => {
			throw new Error(CANARY);
		});
		await hub.unlock(async () => session);
		let later = false;
		hub.addStopStep(() => {
			later = true;
		});
		hub.addStopStep(() => {
			throw new Error(CANARY);
		});
		hub.addStopStep(() => Promise.reject(CANARY));
		const report = await hub.stop("fatal");
		expect(later).toBe(true);
		expect(session.closes).toBe(1);
		expect(hub.state).toBe("stopped");
		expect(JSON.stringify(report)).toBe(
			'{"reason":"fatal","drained":true,"outstanding":0,"failures":3}',
		);
		expectNoCanary(report);
	});
});

describe("stop reasons", () => {
	it.each([
		["an empty string", ""],
		["an uppercase token", "EOF"],
		["a leading digit", "1eof"],
		["a path", "/home/example/secret"],
		["spaces", "end of input"],
		["a trailing newline", "eof\n"],
		["a 33-character token", "a".repeat(33)],
		["an array", ["eof"]],
		["an object that prints as a token", { toString: (): string => "eof" }],
		["undefined", undefined],
	])("refuses %s and keeps the hub running", async (_name, reason) => {
		const clock = manualClock();
		const { hub, session } = await readyHub(clock);
		expect(() => hub.stop(reason as string)).toThrow(
			new TypeError("Stop reason must be a short lowercase token"),
		);
		expect(hub.state).toBe("ready");
		hub.beginClaim().release();
		await settle();
		expect(session.closes).toBe(0);
		expect(clock.waits).toEqual([]);
	});

	it.each(["a", "eof", "power-off", "a".repeat(32)])("accepts %s", async (reason) => {
		const { hub } = await readyHub();
		expect((await hub.stop(reason)).reason).toBe(reason);
	});
});

describe("the timer", () => {
	it.each([
		["undefined", undefined],
		["null", null],
		["an object without after", {}],
		["a non-function after", { after: 1 }],
	])("refuses %s as the clock", (_name, clock) => {
		expect(() => createHubLifecycle({ clock: clock as unknown as TimerClock })).toThrow(
			new TypeError("Hub lifecycle needs a timer clock"),
		);
	});

	it.each([
		["rejects", (): Promise<void> => Promise.reject(new Error(CANARY))],
		[
			"throws",
			(): Promise<void> => {
				throw new Error(CANARY);
			},
		],
	])("ends the drain when the timer %s", async (_name, after) => {
		const clock: TimerClock = { wallMs: () => 0, monotonicMs: () => 0, after };
		const { hub, session } = await readyHub(clock);
		const permit = hub.beginClaim();
		expect((await caught(hub.enterMaintenance())).code).toBe("HUB_BUSY");
		expect(hub.state).toBe("ready");
		const report = await hub.stop("eof");
		expect(report).toEqual({ reason: "eof", drained: false, outstanding: 1, failures: 0 });
		expect(session.closes).toBe(1);
		permit.release();
	});

	it("requests no timer when no permit is open", async () => {
		const clock = manualClock();
		const hub = createHubLifecycle({ clock });
		let steps = 0;
		hub.addStopStep(() => {
			steps++;
		});
		const stopping = watch(hub.stop("eof"));
		await settle();
		expect(clock.waits).toEqual([]);
		expect(stopping.value).toEqual({ reason: "eof", drained: true, outstanding: 0, failures: 0 });
		expect(steps).toBe(1);
		expect(hub.state).toBe("stopped");
	});

	it("counts each permit once, however often it is released", async () => {
		const clock = manualClock();
		const { hub } = await readyHub(clock);
		const first = hub.beginClaim();
		const second = hub.beginClaim();
		const stopping = watch(hub.stop("eof"));
		first.release();
		first.release();
		await settle();
		expect(stopping.settled).toBe(false);
		second.release();
		await settle();
		expect(stopping.value).toMatchObject({ drained: true, outstanding: 0 });
	});

	it("waits again for permits opened after an earlier drain ended", async () => {
		const clock = manualClock();
		const { hub } = await readyHub(clock);
		const first = hub.beginClaim();
		const entering = hub.enterMaintenance();
		first.release();
		(await entering).release();
		const second = hub.beginClaim();
		const stopping = watch(hub.stop("eof"));
		await settle();
		expect(stopping.settled).toBe(false);
		expect(clock.waits.map(({ ms }) => ms)).toEqual([HUB_DRAIN_MS, HUB_DRAIN_MS]);
		second.release();
		await settle();
		expect(stopping.value).toMatchObject({ drained: true, outstanding: 0 });
	});
});

describe("maintenance and stop", () => {
	it("ends both waits on one release and refuses maintenance once stopping", async () => {
		const clock = manualClock();
		const { hub, session } = await readyHub(clock);
		const permit = hub.beginClaim();
		const entering = watch(hub.enterMaintenance());
		const stopping = watch(hub.stop("shutdown"));
		await settle();
		expect(clock.waits.map(({ ms }) => ms)).toEqual([HUB_DRAIN_MS, HUB_DRAIN_MS]);

		permit.release();
		await settle();
		expect(entering.error).toBeInstanceOf(HubLifecycleError);
		expect((entering.error as HubLifecycleError).code).toBe("HUB_STOPPING");
		expect(stopping.value).toEqual({
			reason: "shutdown",
			drained: true,
			outstanding: 0,
			failures: 0,
		});
		expect(clock.waits.every(({ signal }) => signal?.aborted)).toBe(true);
		expect(session.closes).toBe(1);
	});

	it("stays stopping when the maintenance wait gives up during a stop", async () => {
		const clock = manualClock();
		const { hub } = await readyHub(clock);
		hub.beginClaim();
		const entering = watch(hub.enterMaintenance());
		const stopping = watch(hub.stop("shutdown"));
		await settle();
		clock.waits[0]?.fire();
		await settle();
		expect((entering.error as HubLifecycleError).code).toBe("HUB_STOPPING");
		expect(hub.state).toBe("stopping");
		expect(refusal(() => hub.beginClaim())).toBe("HUB_STOPPING");
		expect(stopping.settled).toBe(false);

		clock.waits[1]?.fire();
		await settle();
		expect(stopping.value).toMatchObject({ drained: false, outstanding: 1 });
		expect(hub.state).toBe("stopped");
	});

	it("keeps the gate shut when a lease is released after a stop", async () => {
		const { hub } = await readyHub();
		const lease = await hub.enterMaintenance();
		await hub.stop("shutdown");
		lease.release();
		expect(hub.state).toBe("stopped");
		expect(refusal(() => hub.beginClaim())).toBe("HUB_STOPPING");
	});

	it("does not end a later maintenance when an earlier lease is released again", async () => {
		const { hub } = await readyHub();
		const earlier = await hub.enterMaintenance();
		earlier.release();
		const later = await hub.enterMaintenance();
		earlier.release();
		expect(hub.state).toBe("maintenance");
		expect(refusal(() => hub.beginClaim())).toBe("HUB_MAINTENANCE");
		later.release();
		expect(hub.state).toBe("ready");
	});

	it.each([
		["locked", "HUB_LOCKED"],
		["maintenance", "HUB_MAINTENANCE"],
		["stopped", "HUB_STOPPING"],
	])("refuses maintenance while %s", async (state, code) => {
		const hub = createHubLifecycle({ clock: manualClock() });
		if (state !== "locked") await hub.unlock(async () => fakeSession());
		if (state === "maintenance") await hub.enterMaintenance();
		if (state === "stopped") await hub.stop("eof");
		expect(hub.state).toBe(state);
		expect((await caught(hub.enterMaintenance())).code).toBe(code);
		expect(hub.state).toBe(state);
	});
});

describe("unlock and stop", () => {
	it("refuses a second unlock without opening again", async () => {
		const hub = createHubLifecycle({ clock: manualClock() });
		let opens = 0;
		const open = async (): Promise<HubLifecycleSession> => {
			opens++;
			return fakeSession();
		};
		const first = hub.unlock(open);
		expect((await caught(hub.unlock(open))).code).toBe("HUB_UNLOCKED");
		await first;
		expect((await caught(hub.unlock(open))).code).toBe("HUB_UNLOCKED");
		const lease = await hub.enterMaintenance();
		expect((await caught(hub.unlock(open))).code).toBe("HUB_UNLOCKED");
		lease.release();
		expect(opens).toBe(1);
		expect(hub.state).toBe("ready");
	});

	it("never opens once a stop began", async () => {
		const hub = createHubLifecycle({ clock: manualClock() });
		const step = Promise.withResolvers<void>();
		hub.addStopStep(() => step.promise);
		const stopping = hub.stop("eof");
		let opens = 0;
		const open = async (): Promise<HubLifecycleSession> => {
			opens++;
			return fakeSession();
		};
		expect(hub.state).toBe("stopping");
		expect((await caught(hub.unlock(open))).code).toBe("HUB_STOPPING");
		step.resolve();
		await stopping;
		expect((await caught(hub.unlock(open))).code).toBe("HUB_STOPPING");
		expect(opens).toBe(0);
		expect(hub.state).toBe("stopped");
	});

	it("stays stopping when the open fails after a stop began", async () => {
		const hub = createHubLifecycle({ clock: manualClock() });
		const open = Promise.withResolvers<HubLifecycleSession>();
		const step = Promise.withResolvers<void>();
		hub.addStopStep(() => step.promise);
		const unlocking = watch(hub.unlock(() => open.promise));
		const stopping = watch(hub.stop("eof"));
		open.reject(new Error(CANARY));
		await settle();
		expect((unlocking.error as HubLifecycleError).code).toBe("HUB_UNLOCK_FAILED");
		expect(hub.state).toBe("stopping");
		expect(refusal(() => hub.beginClaim())).toBe("HUB_STOPPING");

		step.resolve();
		await settle();
		expect(stopping.value).toEqual({ reason: "eof", drained: true, outstanding: 0, failures: 0 });
		expect(hub.state).toBe("stopped");
	});

	it("refuses stop steps once stopping", async () => {
		const { hub } = await readyHub();
		const permit = hub.beginClaim();
		const stopping = hub.stop("eof");
		let ran = false;
		expect(
			refusal(() =>
				hub.addStopStep(() => {
					ran = true;
				}),
			),
		).toBe("HUB_STOPPING");
		permit.release();
		await stopping;
		expect(ran).toBe(false);
	});
});

describe("frozen surfaces", () => {
	it("freezes the lifecycle, its permits, leases and reports", async () => {
		const { hub } = await readyHub();
		expect(Object.isFrozen(hub)).toBe(true);
		const permit = hub.beginClaim();
		expect(Object.isFrozen(permit)).toBe(true);
		permit.release();
		const lease = await hub.enterMaintenance();
		expect(Object.isFrozen(lease)).toBe(true);
		lease.release();
		expect(Object.isFrozen(await hub.stop("eof"))).toBe(true);
	});
});
