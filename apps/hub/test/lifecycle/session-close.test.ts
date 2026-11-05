import { describe, expect, it } from "vitest";
import type { TimerClock } from "../../src/kernel/clock.ts";
import {
	createHubLifecycle,
	HubLifecycleError,
	type HubLifecycleSession,
} from "../../src/lifecycle/state.ts";

const clock: TimerClock = {
	wallMs: () => 0,
	monotonicMs: () => 0,
	after: async () => {
		throw new Error("DYTEST-UNEXPECTED-DRAIN");
	},
};
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe("asynchronous session close", () => {
	it.each(["ready", "opening"] as const)(
		"keeps the claim gate closed and stop pending until the %s session closes",
		async (initialState) => {
			const hub = createHubLifecycle({ clock });
			const closing = Promise.withResolvers<void>();
			let closes = 0;
			const session: HubLifecycleSession = {
				close: () => {
					closes++;
					return closing.promise;
				},
			};
			const opening = Promise.withResolvers<HubLifecycleSession>();
			const unlocking = hub.unlock(() => opening.promise);
			if (initialState === "ready") {
				opening.resolve(session);
				await unlocking;
			}

			const stopping = hub.stop("shutdown");
			let stopped = false;
			void hub.stopped.then(() => {
				stopped = true;
			});
			if (initialState === "opening") {
				const refused = expect(unlocking).rejects.toMatchObject({ code: "HUB_STOPPING" });
				opening.resolve(session);
				await refused;
			}
			await settle();
			expect(closes).toBe(1);
			expect(stopped).toBe(false);
			expect(hub.state).toBe("stopping");
			expect(hub.stop("eof")).toBe(stopping);
			expect(() => hub.beginClaim()).toThrow(new HubLifecycleError("HUB_STOPPING"));

			closing.resolve();
			expect(await stopping).toEqual({
				reason: "shutdown",
				drained: true,
				outstanding: 0,
				failures: 0,
			});
			expect(stopped).toBe(true);
			expect(hub.state).toBe("stopped");
			expect(closes).toBe(1);
		},
	);

	it.each(["ready", "opening"] as const)(
		"counts a rejected close from the %s session without exposing its detail",
		async (initialState) => {
			const hub = createHubLifecycle({ clock });
			const closing = Promise.withResolvers<void>();
			let closes = 0;
			const session: HubLifecycleSession = {
				close: () => {
					closes++;
					return closing.promise;
				},
			};
			const opening = Promise.withResolvers<HubLifecycleSession>();
			const unlocking = hub.unlock(() => opening.promise);
			if (initialState === "ready") {
				opening.resolve(session);
				await unlocking;
			}
			hub.addStopStep(() => Promise.reject(new Error("DYTEST-STEP-FAILURE")));
			const stopping = hub.stop("fatal");
			if (initialState === "opening") {
				const refused = expect(unlocking).rejects.toMatchObject({ code: "HUB_STOPPING" });
				opening.resolve(session);
				await refused;
			}
			await settle();
			expect(closes).toBe(1);
			expect(hub.state).toBe("stopping");
			closing.reject(new Error("DYTEST-PRIVATE-CLOSE-CANARY"));
			const report = await stopping;
			expect(report).toEqual({ reason: "fatal", drained: true, outstanding: 0, failures: 2 });
			expect(JSON.stringify(report)).not.toContain("DYTEST-PRIVATE-CLOSE-CANARY");
			expect(hub.state).toBe("stopped");
			expect(hub.stop("shutdown")).toBe(stopping);
			expect(closes).toBe(1);
		},
	);
});
