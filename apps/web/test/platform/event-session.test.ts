// @vitest-environment node
import { EventFrame, type EventsRequest } from "@draftyak/protocol/device-api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEventSession } from "../../src/platform/event-session.ts";

type Session = ReturnType<typeof createEventSession>;
type State = ReturnType<Session["getState"]>;
const cleanup: Array<() => Promise<void>> = [];

function deferred() {
	let resolve!: () => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<void>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}

async function flush(): Promise<void> {
	for (let turn = 0; turn < 20; turn++) await Promise.resolve();
}

const ready = (cursor: string) => EventFrame.parse({ type: "ready", cursor });
const event = (cursor: string) =>
	EventFrame.parse({
		type: "event",
		cursor,
		kind: "message.changed",
		ids: ["00000000000000000000000001"],
	});

function fixture(onChange?: (state: State) => void | Promise<void>) {
	const streams: Array<
		ReturnType<typeof deferred> & {
			request: EventsRequest;
			signal: AbortSignal;
			receive: (frame: EventFrame) => void;
		}
	> = [];
	const refreshes: Array<ReturnType<typeof deferred> & { signal: AbortSignal }> = [];
	const notifications: State[] = [];
	const events = vi.fn(
		(request: EventsRequest, signal: AbortSignal, receive: (frame: EventFrame) => void) => {
			const job = { ...deferred(), request, signal, receive };
			streams.push(job);
			return job.promise;
		},
	);
	const refetch = vi.fn((signal: AbortSignal) => {
		const job = { ...deferred(), signal };
		refreshes.push(job);
		return job.promise;
	});
	const session = createEventSession({
		platform: { events },
		refetch,
		onChange: (state) => {
			notifications.push(state);
			return onChange?.(state);
		},
	});
	cleanup.push(async () => {
		const closing = session.close();
		for (const job of streams) job.resolve();
		for (const job of refreshes) job.resolve();
		await closing;
	});
	return { session, streams, refreshes, notifications, events, refetch };
}

function at<T>(values: readonly T[], index: number): T {
	const value = values[index];
	if (value === undefined) throw new Error("DYTEST expected pending operation");
	return value;
}

beforeEach(() => vi.useFakeTimers());
afterEach(async () => {
	try {
		for (const close of cleanup.splice(0)) await close();
	} finally {
		vi.clearAllTimers();
		vi.useRealTimers();
	}
});

describe("event session", () => {
	it("resumes from the committed cursor at the next actual attempt", async () => {
		const { session, streams, refreshes, refetch } = fixture();
		const initial = session.getState();
		expect(Object.isFrozen(initial)).toBe(true);
		expect(session.getState()).toBe(initial);
		session.start();
		expect(streams).toHaveLength(1);
		expect(at(streams, 0).request).toEqual({ after: null });
		expect(Object.isFrozen(at(streams, 0).request)).toBe(true);
		expect(refetch).not.toHaveBeenCalled();
		at(streams, 0).receive(ready("DYTEST-committed"));
		at(refreshes, 0).resolve();
		await flush();
		expect(session.getState().refresh.cursor).toBe("DYTEST-committed");
		at(streams, 0).resolve();
		await flush();
		await vi.advanceTimersByTimeAsync(250);
		expect(streams).toHaveLength(2);
		expect(at(streams, 1).request).toEqual({ after: "DYTEST-committed" });
	});

	it("retries failed data refresh without replacing a healthy event stream", async () => {
		const { session, streams, refreshes, events } = fixture();
		session.start();
		at(streams, 0).receive(ready("DYTEST-head"));
		at(refreshes, 0).resolve();
		await flush();
		at(streams, 0).receive(event("DYTEST-tail"));
		at(refreshes, 1).reject(new Error("DYTEST query failed"));
		await flush();
		expect(session.getState().connection.status).toBe("streaming");
		expect(session.getState().refresh).toEqual({ status: "unavailable", cursor: "DYTEST-head" });
		session.retry();
		expect(events).toHaveBeenCalledTimes(1);
		expect(at(streams, 0).signal.aborted).toBe(false);
		expect(refreshes).toHaveLength(3);
		at(refreshes, 2).resolve();
		await flush();
		expect(session.getState().refresh).toEqual({ status: "current", cursor: "DYTEST-tail" });
	});

	it("never resumes past an event whose data refresh did not finish", async () => {
		const { session, streams, refreshes } = fixture();
		session.start();
		const old = at(streams, 0);
		old.receive(ready("DYTEST-committed"));
		at(refreshes, 0).resolve();
		await flush();
		old.receive(event("DYTEST-unrefreshed-tail"));
		old.resolve();
		await flush();
		expect(at(refreshes, 1).signal.aborted).toBe(true);
		expect(session.getState().refresh.cursor).toBe("DYTEST-committed");
		await vi.advanceTimersByTimeAsync(250);
		expect(at(streams, 1).request).toEqual({ after: "DYTEST-committed" });
		at(streams, 1).receive(ready("DYTEST-new-head"));
		expect(refreshes).toHaveLength(2);
		at(refreshes, 1).resolve();
		await flush();
		expect(refreshes).toHaveLength(3);
		expect(session.getState().refresh.cursor).toBe("DYTEST-committed");
		at(refreshes, 2).resolve();
		await flush();
		expect(session.getState().refresh.cursor).toBe("DYTEST-new-head");
	});

	it("resets the cursor, fences late frames and joins both old lifetimes before refreshing anew", async () => {
		const { session, streams, refreshes } = fixture();
		session.start();
		const old = at(streams, 0);
		old.receive(ready("DYTEST-old"));
		at(refreshes, 0).resolve();
		await flush();
		old.receive(event("DYTEST-abandoned"));
		old.receive(EventFrame.parse({ type: "reset", reason: "epoch_changed" }));
		expect(old.signal.aborted).toBe(true);
		expect(at(refreshes, 1).signal.aborted).toBe(true);
		expect(session.getState().refresh.cursor).toBeNull();
		old.receive(ready("DYTEST-late"));
		old.receive(event("DYTEST-later"));
		await vi.advanceTimersByTimeAsync(20_000);
		expect(streams).toHaveLength(1);
		expect(refreshes).toHaveLength(2);
		old.resolve();
		await flush();
		await vi.advanceTimersByTimeAsync(250);
		expect(streams).toHaveLength(2);
		expect(at(streams, 1).request).toEqual({ after: null });
		at(streams, 1).receive(ready("DYTEST-new"));
		expect(refreshes).toHaveLength(2);
		at(refreshes, 1).resolve();
		await flush();
		expect(refreshes).toHaveLength(3);
		expect(session.getState().refresh.cursor).toBeNull();
		at(refreshes, 2).resolve();
		await flush();
		expect(session.getState().refresh).toEqual({ status: "current", cursor: "DYTEST-new" });
	});

	it("cancels timed-out opening work and ignores late readiness until actual stream cleanup settles", async () => {
		const { session, streams, refreshes } = fixture();
		session.start();
		const old = at(streams, 0);
		await vi.advanceTimersByTimeAsync(10_000);
		expect(old.signal.aborted).toBe(true);
		old.receive(ready("DYTEST-too-late"));
		await vi.advanceTimersByTimeAsync(20_000);
		expect(streams).toHaveLength(1);
		expect(refreshes).toHaveLength(0);
		old.resolve();
		await flush();
		await vi.advanceTimersByTimeAsync(250);
		expect(streams).toHaveLength(2);
		expect(at(streams, 1).request).toEqual({ after: null });
	});

	it("fences a reset before observers can reenter old readiness or request a new stream", async () => {
		let resetting = false;
		let reentered = false;
		let current!: ReturnType<typeof fixture>;
		current = fixture((state) => {
			if (resetting && !reentered && state.refresh.status === "waiting") {
				reentered = true;
				at(current.streams, 0).receive(ready("DYTEST-reentrant-old-stream"));
				current.session.retry();
			}
		});
		current.session.start();
		at(current.streams, 0).receive(ready("DYTEST-original"));
		at(current.refreshes, 0).resolve();
		await flush();
		resetting = true;
		at(current.streams, 0).receive(EventFrame.parse({ type: "reset", reason: "resync_required" }));
		expect(reentered).toBe(true);
		expect(current.refreshes).toHaveLength(1);
		expect(current.streams).toHaveLength(1);
		expect(current.session.getState().refresh.cursor).toBeNull();
		expect(at(current.streams, 0).signal.aborted).toBe(true);
		at(current.streams, 0).resolve();
		await flush();
		expect(current.streams).toHaveLength(2);
		expect(at(current.streams, 1).request).toEqual({ after: null });
	});

	it("closes once, joins stream plus data refresh and prevents later notifications or work", async () => {
		const { session, streams, refreshes, notifications } = fixture();
		session.start();
		const stream = at(streams, 0);
		stream.receive(ready("DYTEST-head"));
		const reentrant: Array<Promise<void>> = [];
		stream.signal.addEventListener("abort", () => reentrant.push(session.close()), { once: true });
		at(refreshes, 0).signal.addEventListener("abort", () => reentrant.push(session.close()), {
			once: true,
		});
		const closing = session.close();
		const notices = notifications.length;
		expect(session.close()).toBe(closing);
		expect(reentrant).toHaveLength(2);
		for (const result of reentrant) expect(result).toBe(closing);
		expect(stream.signal.aborted).toBe(true);
		expect(at(refreshes, 0).signal.aborted).toBe(true);
		expect(session.getState().connection.status).toBe("closed");
		expect(session.getState().refresh).toEqual({ status: "closed", cursor: null });
		let settled = false;
		void closing.then(() => {
			settled = true;
		});
		stream.receive(ready("DYTEST-stale"));
		session.start();
		session.retry();
		await flush();
		expect(settled).toBe(false);
		stream.resolve();
		await flush();
		expect(settled).toBe(false);
		at(refreshes, 0).resolve();
		await closing;
		expect(settled).toBe(true);
		expect(notifications).toHaveLength(notices);
		expect(streams).toHaveLength(1);
		expect(refreshes).toHaveLength(1);
	});

	it("does not begin a refresh after synchronous readiness notifies an observer that closes", async () => {
		const stream = deferred();
		const refetch = vi.fn(async () => {});
		let session!: Session;
		let closing: Promise<void> | undefined;
		session = createEventSession({
			platform: {
				events: (_request, _signal, receive) => {
					receive(ready("DYTEST-sync-ready"));
					return stream.promise;
				},
			},
			refetch,
			onChange: (state) => {
				if (state.connection.status === "streaming") closing = session.close();
			},
		});
		cleanup.push(async () => {
			const joined = session.close();
			stream.resolve();
			await joined;
		});
		session.start();
		expect(closing).toBeDefined();
		expect(refetch).not.toHaveBeenCalled();
		let settled = false;
		void closing?.then(() => {
			settled = true;
		});
		await flush();
		expect(settled).toBe(false);
		stream.resolve();
		await closing;
		expect(settled).toBe(true);
	});

	it("contains rejected observer notifications while keeping the actual stream and refresh live", async () => {
		const { session, streams, refreshes } = fixture(async () => {
			throw new Error("DYTEST observer rejected");
		});
		session.start();
		at(streams, 0).receive(ready("DYTEST-observed"));
		at(refreshes, 0).resolve();
		await flush();
		expect(session.getState().connection.status).toBe("streaming");
		expect(session.getState().refresh).toEqual({ status: "current", cursor: "DYTEST-observed" });
	});
});
