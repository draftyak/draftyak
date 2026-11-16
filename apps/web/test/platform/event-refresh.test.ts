// @vitest-environment node
import { EventFrame } from "@draftyak/protocol/device-api";
import { describe, expect, it, vi } from "vitest";
import {
	createEventRefreshCoordinator,
	type EventRefreshState,
} from "../../src/platform/event-refresh.ts";

function deferred() {
	let resolve!: () => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<void>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

async function flush(): Promise<void> {
	for (let turn = 0; turn < 12; turn++) await Promise.resolve();
}

const ready = (cursor: string): EventFrame => EventFrame.parse({ type: "ready", cursor });
const event = (cursor: string): EventFrame =>
	EventFrame.parse({
		type: "event",
		cursor,
		kind: "message.changed",
		ids: ["00000000000000000000000001"],
	});

function fixture() {
	const jobs: Array<ReturnType<typeof deferred> & { signal: AbortSignal }> = [];
	const snapshots: EventRefreshState[] = [];
	const refetch = vi.fn((signal: AbortSignal) => {
		const job = { ...deferred(), signal };
		jobs.push(job);
		return job.promise;
	});
	const coordinator = createEventRefreshCoordinator({
		refetch,
		onChange: (state) => snapshots.push(state),
	});
	return { coordinator, jobs, snapshots, refetch };
}

describe("event refresh coordinator", () => {
	it("waits for ready and commits its cursor only after the initial refresh finishes", async () => {
		const { coordinator, jobs, refetch } = fixture();
		const initial = coordinator.getState();
		expect(initial).toEqual({ status: "waiting", cursor: null });
		expect(Object.isFrozen(initial)).toBe(true);
		expect(coordinator.getState()).toBe(initial);
		expect(refetch).not.toHaveBeenCalled();
		coordinator.receive(ready("DYTEST-head"));
		await flush();
		expect(jobs).toHaveLength(1);
		expect(coordinator.getState()).toEqual({ status: "refreshing", cursor: null });
		jobs[0]?.resolve();
		await flush();
		expect(coordinator.getState()).toEqual({ status: "current", cursor: "DYTEST-head" });
		await coordinator.close();
	});

	it("coalesces a burst without overlapping refreshes or committing an unrefreshed tail", async () => {
		const { coordinator, jobs } = fixture();
		coordinator.receive(ready("DYTEST-head"));
		await flush();
		for (let value = 1; value <= 500; value++) coordinator.receive(event(`DYTEST-${value}`));
		await flush();
		expect(jobs).toHaveLength(1);
		expect(coordinator.getState().cursor).toBeNull();
		jobs[0]?.resolve();
		await flush();
		expect(jobs).toHaveLength(2);
		expect(coordinator.getState().cursor).toBeNull();
		jobs[1]?.resolve();
		await flush();
		expect(coordinator.getState()).toEqual({ status: "current", cursor: "DYTEST-500" });
		expect(jobs).toHaveLength(2);
		await coordinator.close();
	});

	it("accepts a repeated canonical ready watermark as another full refresh", async () => {
		const { coordinator, jobs } = fixture();
		coordinator.receive(ready(""));
		await flush();
		coordinator.receive(ready("DYTEST-later-head"));
		expect(jobs).toHaveLength(1);
		jobs[0]?.resolve();
		await flush();
		expect(jobs).toHaveLength(2);
		jobs[1]?.resolve();
		await flush();
		expect(coordinator.getState()).toEqual({ status: "current", cursor: "DYTEST-later-head" });
		await coordinator.close();
	});

	it("retains the committed cursor on failure and waits for an explicit retry", async () => {
		const { coordinator, jobs } = fixture();
		coordinator.receive(ready("DYTEST-committed"));
		await flush();
		jobs[0]?.resolve();
		await flush();
		coordinator.receive(event("DYTEST-failed"));
		await flush();
		jobs[1]?.reject(new Error("DYTEST refetch failure"));
		await flush();
		expect(coordinator.getState()).toEqual({ status: "unavailable", cursor: "DYTEST-committed" });
		coordinator.receive(event("DYTEST-pending"));
		await flush();
		expect(jobs).toHaveLength(2);
		coordinator.retry();
		await flush();
		expect(jobs).toHaveLength(3);
		jobs[2]?.resolve();
		await flush();
		expect(coordinator.getState()).toEqual({ status: "current", cursor: "DYTEST-pending" });
		await coordinator.close();
	});

	it("contains synchronous refresh failure without exposing its error as state", async () => {
		const refetch = vi.fn(() => {
			throw new Error("DYTEST private failure detail");
		});
		const coordinator = createEventRefreshCoordinator({ refetch });
		expect(() => coordinator.receive(ready("DYTEST-head"))).not.toThrow();
		await flush();
		expect(coordinator.getState()).toEqual({ status: "unavailable", cursor: null });
		await expect(coordinator.close()).resolves.toBeUndefined();
	});

	it("recovers a failed refresh when a new ready watermark arrives", async () => {
		const { coordinator, jobs } = fixture();
		coordinator.receive(ready("DYTEST-failed-head"));
		jobs[0]?.reject(new Error("DYTEST initial refresh failed"));
		await flush();
		expect(coordinator.getState()).toEqual({ status: "unavailable", cursor: null });
		coordinator.receive(ready("DYTEST-recovered-head"));
		expect(jobs).toHaveLength(2);
		jobs[1]?.resolve();
		await flush();
		expect(coordinator.getState()).toEqual({ status: "current", cursor: "DYTEST-recovered-head" });
		await coordinator.close();
	});

	it("keeps a newer ready refresh queued when the older refresh fails", async () => {
		const { coordinator, jobs } = fixture();
		coordinator.receive(ready("DYTEST-old-head"));
		coordinator.receive(ready("DYTEST-new-head"));
		expect(jobs).toHaveLength(1);
		jobs[0]?.reject(new Error("DYTEST older refresh failed"));
		await flush();
		expect(jobs).toHaveLength(2);
		expect(coordinator.getState().cursor).toBeNull();
		jobs[1]?.resolve();
		await flush();
		expect(coordinator.getState()).toEqual({ status: "current", cursor: "DYTEST-new-head" });
		await coordinator.close();
	});

	it("does not retry a failed refresh merely because an ordinary event was queued", async () => {
		const { coordinator, jobs } = fixture();
		coordinator.receive(ready("DYTEST-head"));
		coordinator.receive(event("DYTEST-queued-event"));
		jobs[0]?.reject(new Error("DYTEST refresh failed with pending event"));
		await flush();
		expect(jobs).toHaveLength(1);
		expect(coordinator.getState()).toEqual({ status: "unavailable", cursor: null });
		coordinator.retry();
		expect(jobs).toHaveLength(2);
		jobs[1]?.resolve();
		await flush();
		expect(coordinator.getState()).toEqual({ status: "current", cursor: "DYTEST-queued-event" });
		await coordinator.close();
	});

	it.each(["cursor_expired", "epoch_changed", "resync_required"] as const)(
		"clears %s cursors and fences an old refresh before the new ready stream",
		async (reason) => {
			const { coordinator, jobs, snapshots } = fixture();
			coordinator.receive(ready("DYTEST-old"));
			await flush();
			jobs[0]?.resolve();
			await flush();
			coordinator.receive(event("DYTEST-abandoned-tail"));
			await flush();
			const priorNotifications = snapshots.length;
			coordinator.receive(EventFrame.parse({ type: "reset", reason }));
			expect(jobs[1]?.signal.aborted).toBe(true);
			expect(coordinator.getState().cursor).toBeNull();
			coordinator.receive(ready("DYTEST-new"));
			await flush();
			expect(jobs).toHaveLength(2);
			jobs[1]?.resolve();
			await flush();
			expect(jobs).toHaveLength(3);
			expect(coordinator.getState().cursor).toBeNull();
			jobs[2]?.resolve();
			await flush();
			expect(coordinator.getState()).toEqual({ status: "current", cursor: "DYTEST-new" });
			expect(
				snapshots
					.slice(priorNotifications)
					.some(
						(state) => state.cursor === "DYTEST-abandoned-tail" || state.cursor === "DYTEST-old",
					),
			).toBe(false);
			await coordinator.close();
		},
	);

	it("does not publish an in-flight cursor after disconnect and serializes reconnect refresh", async () => {
		const { coordinator, jobs } = fixture();
		coordinator.receive(ready("DYTEST-committed"));
		await flush();
		jobs[0]?.resolve();
		await flush();
		coordinator.receive(event("DYTEST-lost"));
		await flush();
		coordinator.disconnected();
		expect(jobs[1]?.signal.aborted).toBe(true);
		expect(coordinator.getState()).toEqual({ status: "unavailable", cursor: "DYTEST-committed" });
		coordinator.receive(ready("DYTEST-reconnected"));
		await flush();
		expect(jobs).toHaveLength(2);
		jobs[1]?.reject(new Error("DYTEST old connection failed late"));
		await flush();
		expect(jobs).toHaveLength(3);
		jobs[2]?.resolve();
		await flush();
		expect(coordinator.getState()).toEqual({ status: "current", cursor: "DYTEST-reconnected" });
		await coordinator.close();
	});

	it("requires ready before events and again after reset", async () => {
		const { coordinator, jobs, refetch } = fixture();
		coordinator.receive(event("DYTEST-no-ready"));
		await flush();
		expect(refetch).not.toHaveBeenCalled();
		expect(coordinator.getState()).toEqual({ status: "unavailable", cursor: null });
		coordinator.receive(ready("DYTEST-valid"));
		await flush();
		jobs[0]?.resolve();
		await flush();
		coordinator.receive(EventFrame.parse({ type: "reset", reason: "resync_required" }));
		coordinator.receive(event("DYTEST-invalid-after-reset"));
		await flush();
		expect(jobs).toHaveLength(1);
		expect(coordinator.getState()).toEqual({ status: "unavailable", cursor: null });
		await coordinator.close();
	});

	it("joins ignored cancellation on close, erases its cursor and never revives notifications", async () => {
		const { coordinator, jobs, snapshots, refetch } = fixture();
		coordinator.receive(ready("DYTEST-head"));
		await flush();
		const notifications = snapshots.length;
		const closing = coordinator.close();
		expect(coordinator.close()).toBe(closing);
		expect(jobs[0]?.signal.aborted).toBe(true);
		expect(coordinator.getState()).toEqual({ status: "closed", cursor: null });
		let settled = false;
		void closing.then(() => {
			settled = true;
		});
		coordinator.receive(ready("DYTEST-late"));
		coordinator.receive(event("DYTEST-late-event"));
		coordinator.disconnected();
		coordinator.retry();
		await flush();
		expect(settled).toBe(false);
		expect(refetch).toHaveBeenCalledTimes(1);
		jobs[0]?.resolve();
		await closing;
		await flush();
		expect(settled).toBe(true);
		expect(snapshots).toHaveLength(notifications);
		expect(coordinator.getState()).toEqual({ status: "closed", cursor: null });
	});

	it("contains an outstanding rejection when closing", async () => {
		const { coordinator, jobs } = fixture();
		coordinator.receive(ready("DYTEST-head"));
		await flush();
		const closing = coordinator.close();
		jobs[0]?.reject(new Error("DYTEST closed operation failed"));
		await expect(closing).resolves.toBeUndefined();
		expect(coordinator.getState()).toEqual({ status: "closed", cursor: null });
	});

	it("does not start work after an observer closes during a state notification", async () => {
		const operation = deferred();
		let observerClosed = false;
		let workAfterClose = 0;
		let closing: Promise<void> | undefined;
		let coordinator!: ReturnType<typeof createEventRefreshCoordinator>;
		coordinator = createEventRefreshCoordinator({
			refetch: () => {
				if (observerClosed) workAfterClose++;
				return operation.promise;
			},
			onChange: (state) => {
				if (state.status === "refreshing") {
					observerClosed = true;
					closing = coordinator.close();
				}
			},
		});
		coordinator.receive(ready("DYTEST-reentrant"));
		await flush();
		operation.resolve();
		await closing;
		await coordinator.close();
		expect(observerClosed).toBe(true);
		expect(workAfterClose).toBe(0);
		expect(coordinator.getState()).toEqual({ status: "closed", cursor: null });
	});

	it("contains observer exceptions while completing the actual refresh", async () => {
		const operation = deferred();
		const refetch = vi.fn(() => operation.promise);
		const coordinator = createEventRefreshCoordinator({
			refetch,
			onChange: () => {
				throw new Error("DYTEST observer failure");
			},
		});
		expect(() => coordinator.receive(ready("DYTEST-head"))).not.toThrow();
		await flush();
		expect(refetch).toHaveBeenCalledTimes(1);
		operation.resolve();
		await flush();
		expect(coordinator.getState()).toEqual({ status: "current", cursor: "DYTEST-head" });
		await coordinator.close();
	});

	it("joins refresh work when the refresh callback itself closes the coordinator", async () => {
		const operation = deferred();
		let closing: Promise<void> | undefined;
		let coordinator!: ReturnType<typeof createEventRefreshCoordinator>;
		coordinator = createEventRefreshCoordinator({
			refetch: () => {
				closing = coordinator.close();
				return operation.promise;
			},
		});
		coordinator.receive(ready("DYTEST-close-during-refetch"));
		expect(closing).toBeDefined();
		expect(coordinator.close()).toBe(closing);
		let settled = false;
		void closing?.then(() => {
			settled = true;
		});
		await flush();
		expect(settled).toBe(false);
		operation.resolve();
		await closing;
		expect(settled).toBe(true);
		expect(coordinator.getState()).toEqual({ status: "closed", cursor: null });
	});

	it("contains asynchronous observer rejections without stopping refreshes", async () => {
		const operation = deferred();
		const observer = vi.fn(async () => {
			throw new Error("DYTEST async observer failure");
		});
		const coordinator = createEventRefreshCoordinator({
			refetch: () => operation.promise,
			onChange: observer,
		});
		coordinator.receive(ready("DYTEST-async-observer"));
		await flush();
		operation.resolve();
		await flush();
		expect(coordinator.getState()).toEqual({ status: "current", cursor: "DYTEST-async-observer" });
		expect(observer).toHaveBeenCalledTimes(2);
		await coordinator.close();
	});
});
