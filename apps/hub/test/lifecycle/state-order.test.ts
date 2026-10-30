import { describe, expect, it } from "vitest";
import type { TimerClock } from "../../src/kernel/clock.ts";
import {
	createHubLifecycle,
	HUB_DRAIN_MS,
	type HubLifecycleSession,
	type HubStopReport,
} from "../../src/lifecycle/state.ts";

function manualClock(): TimerClock & {
	readonly waits: { ms: number; signal: AbortSignal | undefined; fire(): void }[];
} {
	const waits: { ms: number; signal: AbortSignal | undefined; fire(): void }[] = [];
	return {
		waits,
		wallMs: () => 0,
		monotonicMs: () => 0,
		after: (ms, signal) => {
			const { promise, resolve, reject } = Promise.withResolvers<void>();
			waits.push({ ms, signal, fire: resolve });
			signal?.addEventListener("abort", () => reject(new Error("DYTEST-TIMER-ABORTED")), {
				once: true,
			});
			return promise;
		},
	};
}

describe("lifecycle operation order", () => {
	it("marks opening before the opener runs and refuses a synchronous nested unlock", async () => {
		const clock = manualClock();
		const hub = createHubLifecycle({ clock });
		const opening = Promise.withResolvers<HubLifecycleSession>();
		const session: HubLifecycleSession = { close: () => undefined };
		let observedState: string | undefined;
		let nestedOpens = 0;
		let nested: Promise<unknown> | undefined;
		const unlocking = hub.unlock(() => {
			observedState = hub.state;
			nested = hub
				.unlock(async () => {
					nestedOpens++;
					return session;
				})
				.catch((error: unknown) => error);
			return opening.promise;
		});
		void unlocking.catch(() => undefined);

		expect(observedState).toBe("opening");
		expect(hub.state).toBe("opening");
		await expect(nested).resolves.toMatchObject({ code: "HUB_UNLOCKED" });
		expect(nestedOpens).toBe(0);
		opening.resolve(session);
		await expect(unlocking).resolves.toBe(session);
		await hub.stop("shutdown");
		expect(clock.waits).toEqual([]);
	});

	it("keeps the gate closed when the opener synchronously stops the hub", async () => {
		const clock = manualClock();
		const hub = createHubLifecycle({ clock });
		const states: string[] = [];
		let opens = 0;
		let closes = 0;
		let stopping: Promise<HubStopReport> | undefined;
		let nested: Promise<unknown> | undefined;
		const session: HubLifecycleSession = {
			close: () => {
				closes++;
				states.push(hub.state);
			},
		};
		const unlocking = hub.unlock(() => {
			opens++;
			states.push(hub.state);
			stopping = hub.stop("eof");
			states.push(hub.state);
			expect(() => hub.beginClaim()).toThrow("HUB_STOPPING");
			nested = hub
				.unlock(async () => {
					opens++;
					return session;
				})
				.catch((error: unknown) => error);
			return Promise.resolve(session);
		});

		await expect(unlocking).rejects.toMatchObject({ code: "HUB_STOPPING" });
		await expect(nested).resolves.toMatchObject({ code: "HUB_STOPPING" });
		await expect(stopping).resolves.toEqual({
			reason: "eof",
			drained: true,
			outstanding: 0,
			failures: 0,
		});
		expect(states).toEqual(["opening", "stopping", "stopping"]);
		expect(hub.state).toBe("stopped");
		expect(() => hub.beginClaim()).toThrow("HUB_STOPPING");
		expect(opens).toBe(1);
		expect(closes).toBe(1);
		expect(clock.waits).toEqual([]);
	});

	it("captures the drain result before a stop step releases an outstanding permit", async () => {
		const clock = manualClock();
		const hub = createHubLifecycle({ clock });
		let closes = 0;
		await hub.unlock(async () => ({ close: () => void closes++ }));
		const permit = hub.beginClaim();
		let steps = 0;
		hub.addStopStep(() => {
			steps++;
			permit.release();
		});
		const stopping = hub.stop("shutdown");
		expect(clock.waits.map(({ ms }) => ms)).toEqual([HUB_DRAIN_MS]);
		expect(steps).toBe(0);
		expect(closes).toBe(0);

		clock.waits[0]?.fire();
		const report = await stopping;
		expect(report).toEqual({
			reason: "shutdown",
			drained: false,
			outstanding: 1,
			failures: 0,
		});
		expect(steps).toBe(1);
		expect(closes).toBe(1);
		expect(clock.waits[0]?.signal?.aborted).toBe(true);
		permit.release();
		expect(await hub.stopped).toBe(report);
		expect(report).toMatchObject({ drained: false, outstanding: 1 });
	});
});
