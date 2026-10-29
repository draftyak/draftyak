import { describe, expect, it } from "vitest";
import type { TimerClock } from "../../src/kernel/clock.ts";
import {
	createHubLifecycle,
	HUB_DRAIN_MS,
	type HubLifecycle,
	HubLifecycleError,
	type HubLifecycleSession,
} from "../../src/lifecycle/state.ts";

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

/** The lifecycle waits only on promises and the manual clock, so one turn runs every reaction. */
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

async function rejection(promise: Promise<unknown>): Promise<string> {
	const error = await promise.then(
		() => undefined,
		(caught: unknown) => caught,
	);
	expect(error).toBeInstanceOf(HubLifecycleError);
	return (error as HubLifecycleError).code;
}

async function readyHub(): Promise<{
	clock: ReturnType<typeof manualClock>;
	hub: HubLifecycle;
	session: ReturnType<typeof fakeSession>;
}> {
	const clock = manualClock();
	const hub = createHubLifecycle({ clock });
	const session = fakeSession();
	expect(await hub.unlock(async () => session)).toBe(session);
	expect(hub.state).toBe("ready");
	return { clock, hub, session };
}

describe("the claim gate", () => {
	it("issues permits only while the hub is ready", async () => {
		const clock = manualClock();
		const hub = createHubLifecycle({ clock });
		expect(hub.state).toBe("locked");
		expect(refusal(() => hub.beginClaim())).toBe("HUB_LOCKED");

		const open = Promise.withResolvers<HubLifecycleSession>();
		const unlocking = hub.unlock(() => open.promise);
		expect(hub.state).toBe("opening");
		expect(refusal(() => hub.beginClaim())).toBe("HUB_LOCKED");
		open.resolve(fakeSession());
		await unlocking;
		expect(hub.state).toBe("ready");
		const first = hub.beginClaim();

		const entering = hub.enterMaintenance();
		expect(hub.state).toBe("maintenance");
		expect(refusal(() => hub.beginClaim())).toBe("HUB_MAINTENANCE");
		first.release();
		const lease = await entering;
		expect(hub.state).toBe("maintenance");
		expect(refusal(() => hub.beginClaim())).toBe("HUB_MAINTENANCE");
		lease.release();
		expect(hub.state).toBe("ready");

		const second = hub.beginClaim();
		const stopping = hub.stop("shutdown");
		expect(hub.state).toBe("stopping");
		expect(refusal(() => hub.beginClaim())).toBe("HUB_STOPPING");
		second.release();
		await stopping;
		expect(hub.state).toBe("stopped");
		expect(refusal(() => hub.beginClaim())).toBe("HUB_STOPPING");
	});
});

describe("unlocking", () => {
	it("returns to locked with a fixed code when the open fails, then unlocks again", async () => {
		const hub = createHubLifecycle({ clock: manualClock() });
		const failed = hub.unlock(async (): Promise<HubLifecycleSession> => {
			throw new Error("DYTEST-OPEN-FAILURE");
		});
		expect(hub.state).toBe("opening");
		expect(await rejection(failed)).toBe("HUB_UNLOCK_FAILED");
		expect(hub.state).toBe("locked");
		expect(refusal(() => hub.beginClaim())).toBe("HUB_LOCKED");

		const session = fakeSession();
		expect(await hub.unlock(async () => session)).toBe(session);
		expect(hub.state).toBe("ready");
		hub.beginClaim().release();
	});

	it("closes a session that opens after a stop began, and never becomes ready", async () => {
		const clock = manualClock();
		const hub = createHubLifecycle({ clock });
		const open = Promise.withResolvers<HubLifecycleSession>();
		const unlocking = watch(hub.unlock(() => open.promise));
		const stopping = watch(hub.stop("eof"));
		expect(hub.state).toBe("stopping");
		await settle();
		expect(stopping.settled).toBe(false);

		const seen: (string | undefined)[] = [];
		const session = fakeSession(() =>
			seen.push(
				hub.state,
				refusal(() => hub.beginClaim()),
			),
		);
		open.resolve(session);
		await settle();
		expect(session.closes).toBe(1);
		expect(seen).toEqual(["stopping", "HUB_STOPPING"]);
		expect(unlocking.error).toBeInstanceOf(HubLifecycleError);
		expect((unlocking.error as HubLifecycleError).code).toBe("HUB_STOPPING");
		expect(stopping.value).toEqual({ reason: "eof", drained: true, outstanding: 0, failures: 0 });
		expect(hub.state).toBe("stopped");
		expect(clock.waits).toEqual([]);
	});
});

describe("the bounded drain", () => {
	it("ends when the last permit is released and aborts its timer", async () => {
		const { clock, hub, session } = await readyHub();
		const first = hub.beginClaim();
		const second = hub.beginClaim();
		const order: string[] = [];
		hub.addStopStep(() => {
			order.push("step");
		});
		const stopping = watch(hub.stop("shutdown"));
		await settle();
		expect(clock.waits.map(({ ms }) => ms)).toEqual([HUB_DRAIN_MS]);
		expect(stopping.settled).toBe(false);

		first.release();
		await settle();
		expect(stopping.settled).toBe(false);
		expect(order).toEqual([]);
		expect(session.closes).toBe(0);

		second.release();
		await settle();
		expect(stopping.value).toEqual({
			reason: "shutdown",
			drained: true,
			outstanding: 0,
			failures: 0,
		});
		expect(clock.waits[0]?.signal?.aborted).toBe(true);
		expect(order).toEqual(["step"]);
		expect(session.closes).toBe(1);
	});

	it("gives up at exactly ten seconds and reports the permits still outstanding", async () => {
		const { clock, hub, session } = await readyHub();
		hub.beginClaim();
		hub.beginClaim();
		hub.beginClaim().release();
		const stopping = watch(hub.stop("eof"));
		await settle();
		expect(HUB_DRAIN_MS).toBe(10_000);
		expect(clock.waits.map(({ ms }) => ms)).toEqual([10_000]);
		expect(stopping.settled).toBe(false);
		expect(session.closes).toBe(0);

		clock.waits[0]?.fire();
		await settle();
		expect(stopping.value).toEqual({ reason: "eof", drained: false, outstanding: 2, failures: 0 });
		expect(session.closes).toBe(1);
		expect(hub.state).toBe("stopped");
	});

	it("ignores permits released after the stop", async () => {
		const { clock, hub, session } = await readyHub();
		const permits = [hub.beginClaim(), hub.beginClaim()];
		const stopping = hub.stop("eof");
		await settle();
		clock.waits[0]?.fire();
		const report = await stopping;
		expect(report.outstanding).toBe(2);

		for (const permit of permits) {
			permit.release();
			permit.release();
		}
		await settle();
		expect(await hub.stopped).toBe(report);
		expect(report).toEqual({ reason: "eof", drained: false, outstanding: 2, failures: 0 });
		expect(hub.state).toBe("stopped");
		expect(refusal(() => hub.beginClaim())).toBe("HUB_STOPPING");
		expect(session.closes).toBe(1);
		expect(clock.waits).toHaveLength(1);
	});
});

describe("maintenance", () => {
	it("blocks permits, waits for open ones, then returns to ready", async () => {
		const { clock, hub } = await readyHub();
		const permit = hub.beginClaim();
		const entering = watch(hub.enterMaintenance());
		expect(hub.state).toBe("maintenance");
		expect(refusal(() => hub.beginClaim())).toBe("HUB_MAINTENANCE");
		await settle();
		expect(clock.waits.map(({ ms }) => ms)).toEqual([HUB_DRAIN_MS]);
		expect(entering.settled).toBe(false);

		permit.release();
		await settle();
		expect(clock.waits[0]?.signal?.aborted).toBe(true);
		const lease = entering.value;
		expect(lease).toBeDefined();
		expect(hub.state).toBe("maintenance");
		expect(refusal(() => hub.beginClaim())).toBe("HUB_MAINTENANCE");

		lease?.release();
		expect(hub.state).toBe("ready");
		hub.beginClaim().release();
		lease?.release();
		expect(hub.state).toBe("ready");
	});

	it("returns to ready with HUB_BUSY when permits remain after ten seconds", async () => {
		const { clock, hub, session } = await readyHub();
		const permit = hub.beginClaim();
		const entering = hub.enterMaintenance();
		await settle();
		expect(clock.waits.map(({ ms }) => ms)).toEqual([10_000]);
		clock.waits[0]?.fire();
		expect(await rejection(entering)).toBe("HUB_BUSY");
		expect(hub.state).toBe("ready");

		// The permit is still open, so a stop waits for it.
		hub.beginClaim().release();
		const stopping = watch(hub.stop("shutdown"));
		await settle();
		expect(stopping.settled).toBe(false);
		permit.release();
		await settle();
		expect(stopping.value).toMatchObject({ drained: true, outstanding: 0 });
		expect(session.closes).toBe(1);
	});
});

describe("stopping", () => {
	it("is idempotent and keeps the first reason", async () => {
		const { hub, session } = await readyHub();
		let steps = 0;
		hub.addStopStep(() => {
			steps++;
		});
		const first = hub.stop("eof");
		expect(hub.stop("shutdown")).toBe(first);
		expect(hub.stopped).toBe(first);
		const report = await first;
		expect(report).toEqual({ reason: "eof", drained: true, outstanding: 0, failures: 0 });
		expect(hub.stop("fatal")).toBe(first);
		await settle();
		expect(steps).toBe(1);
		expect(session.closes).toBe(1);
		expect(hub.state).toBe("stopped");
	});

	it("runs every stop step newest first, despite failures, then closes the session", async () => {
		const order: string[] = [];
		const clock = manualClock();
		const hub = createHubLifecycle({ clock });
		const session = fakeSession(() => order.push("close"));
		await hub.unlock(async () => session);
		hub.addStopStep(() => {
			order.push("first");
		});
		hub.addStopStep(() => {
			order.push("second");
			throw new Error("DYTEST-STEP-FAILURE");
		});
		hub.addStopStep(async () => {
			order.push("third");
			throw new Error("DYTEST-STEP-FAILURE");
		});
		hub.addStopStep(async () => {
			await settle();
			order.push("fourth");
		});
		const report = await hub.stop("shutdown");
		expect(order).toEqual(["fourth", "third", "second", "first", "close"]);
		expect(report).toEqual({ reason: "shutdown", drained: true, outstanding: 0, failures: 2 });
		expect(session.closes).toBe(1);
	});
});
