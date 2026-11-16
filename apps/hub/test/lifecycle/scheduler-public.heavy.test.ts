import { expect, it } from "vitest";
import { FakeClock, settle } from "../kernel/fake-clock.ts";

it("gates and awaits the actual scheduler through the compiled public factories", async () => {
	const hub: typeof import("../../src/index.ts") = await import(
		new URL("../../dist/index.mjs", import.meta.url).href
	);
	const clock = new FakeClock();
	const lifecycle = hub.createHubLifecycle({ clock });
	const ticking = Promise.withResolvers<number>();
	const closing = Promise.withResolvers<void>();
	const order: string[] = [];
	let signal: AbortSignal | undefined;
	let reported = false;
	const loop = hub.createLifecycleScheduler({
		lifecycle,
		clock,
		async tick(context) {
			signal = context.signal;
			order.push(`tick-${context.reason}`);
			try {
				return await ticking.promise;
			} finally {
				order.push("tick-settled");
			}
		},
	});
	const stopLoop = loop.stop;
	const stopped = lifecycle.stopped.then(() => {
		reported = true;
		order.push("stopped");
	});
	try {
		await settle();
		expect(lifecycle.state).toBe("locked");
		expect(loop.status().state).toBe("paused");
		expect(order).toEqual([]);
		await lifecycle.unlock(async () => ({
			async close() {
				order.push("session-close");
				await closing.promise;
				order.push("session-closed");
			},
		}));
		await settle();
		expect(order).toEqual([]);
		loop.wake();
		await settle();
		expect(order).toEqual(["tick-start"]);
		expect(loop.status().state).toBe("running");
		expect(signal?.aborted).toBe(false);

		const stopping = lifecycle.stop("shutdown");
		await settle();
		expect(lifecycle.state).toBe("stopping");
		expect(signal?.aborted).toBe(true);
		expect(reported).toBe(false);
		expect(order).toEqual(["tick-start"]);

		ticking.resolve(15_000);
		await settle();
		expect(order).toEqual(["tick-start", "tick-settled", "session-close"]);
		expect(lifecycle.state).toBe("stopping");
		expect(reported).toBe(false);
		closing.resolve();
		expect(await stopping).toEqual({
			reason: "shutdown",
			drained: true,
			outstanding: 0,
			failures: 0,
		});
		await stopped;
		expect(order).toEqual([
			"tick-start",
			"tick-settled",
			"session-close",
			"session-closed",
			"stopped",
		]);
		expect(loop.status().state).toBe("stopped");
		expect(lifecycle.state).toBe("stopped");
	} finally {
		ticking.resolve(15_000);
		closing.resolve();
		await Reflect.apply(stopLoop, loop, []);
		await lifecycle.stop("shutdown");
		await stopped;
	}
});
