// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEventReconnectScheduler } from "../../src/platform/event-reconnect.ts";

type Scheduler = ReturnType<typeof createEventReconnectScheduler>;
type State = ReturnType<Scheduler["getState"]>;

const backoffs = [250, 500, 1000, 2000, 4000, 8000, 8000] as const;
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
	for (let turn = 0; turn < 12; turn++) await Promise.resolve();
}

function fixture(onChange?: (state: State) => void | Promise<void>) {
	const jobs: Array<
		ReturnType<typeof deferred> & {
			readonly signal: AbortSignal;
			readonly markReady: () => void;
		}
	> = [];
	const notifications: State[] = [];
	const run = vi.fn((signal: AbortSignal, markReady: () => void) => {
		const job = { ...deferred(), signal, markReady };
		jobs.push(job);
		return job.promise;
	});
	const scheduler = createEventReconnectScheduler({
		run,
		onChange: (state) => {
			notifications.push(state);
			return onChange?.(state);
		},
	});
	cleanup.push(async () => {
		const closing = scheduler.close();
		for (const job of jobs) job.resolve();
		await flush();
		await closing;
	});
	return { scheduler, jobs, notifications, run };
}

function jobAt(jobs: ReturnType<typeof fixture>["jobs"], at: number) {
	const job = jobs[at];
	if (!job) throw new Error("DYTEST missing connection run");
	return job;
}

beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(async () => {
	try {
		for (const close of cleanup.splice(0)) await close();
	} finally {
		vi.clearAllTimers();
		vi.useRealTimers();
	}
});

describe("bounded event reconnect scheduler", () => {
	it("spends eight total runs despite every run becoming ready, then needs explicit retry", async () => {
		const { scheduler, jobs } = fixture();
		expect(scheduler.getState()).toEqual({ status: "idle", attempt: 0, delayMs: null });
		expect(jobs).toHaveLength(0);
		expect(vi.getTimerCount()).toBe(0);
		scheduler.start();
		scheduler.start();
		await flush();
		for (let attempt = 1; attempt <= 8; attempt++) {
			expect(jobs).toHaveLength(attempt);
			expect(scheduler.getState()).toEqual({ status: "connecting", attempt, delayMs: null });
			expect(vi.getTimerCount()).toBe(1);
			const job = jobAt(jobs, attempt - 1);
			job.markReady();
			job.markReady();
			expect(scheduler.getState()).toEqual({ status: "streaming", attempt, delayMs: null });
			expect(vi.getTimerCount()).toBe(0);
			scheduler.start();
			job.resolve();
			await flush();
			if (attempt === 8) break;
			const delay = backoffs[attempt - 1];
			if (delay === undefined) throw new Error("DYTEST missing literal retry delay");
			expect(scheduler.getState()).toEqual({ status: "waiting", attempt, delayMs: delay });
			expect(vi.getTimerCount()).toBe(1);
			scheduler.start();
			expect(jobs).toHaveLength(attempt);
			await vi.advanceTimersByTimeAsync(delay - 1);
			expect(jobs).toHaveLength(attempt);
			await vi.advanceTimersByTimeAsync(1);
		}
		expect(scheduler.getState()).toEqual({ status: "unavailable", attempt: 8, delayMs: null });
		expect(vi.getTimerCount()).toBe(0);
		scheduler.start();
		await vi.advanceTimersByTimeAsync(60_000);
		expect(jobs).toHaveLength(8);
		scheduler.retry();
		await flush();
		expect(jobs).toHaveLength(9);
		expect(scheduler.getState()).toEqual({ status: "connecting", attempt: 1, delayMs: null });
	});

	it("lets readiness cancel only the opening deadline while the connection lifetime stays pending", async () => {
		const { scheduler, jobs } = fixture();
		scheduler.start();
		await flush();
		const job = jobAt(jobs, 0);
		await vi.advanceTimersByTimeAsync(9_999);
		expect(job.signal.aborted).toBe(false);
		job.markReady();
		expect(scheduler.getState()).toEqual({ status: "streaming", attempt: 1, delayMs: null });
		expect(vi.getTimerCount()).toBe(0);
		await vi.advanceTimersByTimeAsync(60_000);
		expect(jobs).toHaveLength(1);
		expect(job.signal.aborted).toBe(false);
		job.resolve();
		await flush();
		expect(scheduler.getState()).toEqual({ status: "waiting", attempt: 1, delayMs: 250 });
		expect(vi.getTimerCount()).toBe(1);
	});

	it("times out at ten seconds but joins an ignored abort before arming its backoff", async () => {
		const { scheduler, jobs } = fixture();
		scheduler.start();
		await flush();
		const old = jobAt(jobs, 0);
		await vi.advanceTimersByTimeAsync(9_999);
		expect(old.signal.aborted).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		expect(old.signal.aborted).toBe(true);
		expect(scheduler.getState()).toEqual({ status: "waiting", attempt: 1, delayMs: null });
		expect(vi.getTimerCount()).toBe(0);
		old.markReady();
		await vi.advanceTimersByTimeAsync(80_000);
		expect(jobs).toHaveLength(1);
		expect(scheduler.getState()).toEqual({ status: "waiting", attempt: 1, delayMs: null });
		old.resolve();
		await flush();
		expect(scheduler.getState()).toEqual({ status: "waiting", attempt: 1, delayMs: 250 });
		expect(vi.getTimerCount()).toBe(1);
		await vi.advanceTimersByTimeAsync(249);
		expect(jobs).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(jobs).toHaveLength(2);
		old.markReady();
		expect(scheduler.getState()).toEqual({ status: "connecting", attempt: 2, delayMs: null });
		expect(vi.getTimerCount()).toBe(1);
	});

	it("coalesces pending explicit retries, fences old readiness and joins before one fresh budget", async () => {
		const { scheduler, jobs } = fixture();
		scheduler.start();
		await flush();
		const old = jobAt(jobs, 0);
		old.markReady();
		scheduler.retry();
		scheduler.retry();
		scheduler.retry();
		expect(old.signal.aborted).toBe(true);
		expect(scheduler.getState()).toEqual({ status: "waiting", attempt: 0, delayMs: null });
		expect(vi.getTimerCount()).toBe(0);
		old.markReady();
		await vi.advanceTimersByTimeAsync(40_000);
		expect(jobs).toHaveLength(1);
		old.reject(new Error("DYTEST old lifetime cleanup rejected"));
		await flush();
		expect(jobs).toHaveLength(2);
		expect(jobAt(jobs, 1).signal).not.toBe(old.signal);
		expect(scheduler.getState()).toEqual({ status: "connecting", attempt: 1, delayMs: null });
		expect(vi.getTimerCount()).toBe(1);
		const replacement = jobAt(jobs, 1);
		scheduler.retry();
		scheduler.retry();
		expect(replacement.signal.aborted).toBe(true);
		expect(scheduler.getState()).toEqual({ status: "waiting", attempt: 0, delayMs: null });
		expect(jobs).toHaveLength(2);
		replacement.resolve();
		await flush();
		expect(jobs).toHaveLength(3);
		expect(scheduler.getState()).toEqual({ status: "connecting", attempt: 1, delayMs: null });
	});

	it("cancels a backoff for immediate retry and prevents the old timer or ready callback from reviving", async () => {
		const { scheduler, jobs } = fixture();
		scheduler.start();
		await flush();
		const old = jobAt(jobs, 0);
		old.markReady();
		old.resolve();
		await flush();
		expect(scheduler.getState()).toEqual({ status: "waiting", attempt: 1, delayMs: 250 });
		old.markReady();
		expect(scheduler.getState()).toEqual({ status: "waiting", attempt: 1, delayMs: 250 });
		expect(vi.getTimerCount()).toBe(1);
		scheduler.retry();
		await flush();
		expect(jobs).toHaveLength(2);
		expect(scheduler.getState()).toEqual({ status: "connecting", attempt: 1, delayMs: null });
		expect(vi.getTimerCount()).toBe(1);
		jobAt(jobs, 1).markReady();
		old.markReady();
		await vi.advanceTimersByTimeAsync(20_000);
		expect(jobs).toHaveLength(2);
		expect(scheduler.getState()).toEqual({ status: "streaming", attempt: 1, delayMs: null });
		expect(vi.getTimerCount()).toBe(0);
	});

	it("closes synchronously, joins actual pending cleanup, and ignores every late entry point", async () => {
		const { scheduler, jobs, notifications, run } = fixture();
		scheduler.start();
		await flush();
		const old = jobAt(jobs, 0);
		const closing = scheduler.close();
		const noticeCount = notifications.length;
		expect(scheduler.close()).toBe(closing);
		expect(scheduler.getState()).toMatchObject({ status: "closed", delayMs: null });
		expect(old.signal.aborted).toBe(true);
		expect(vi.getTimerCount()).toBe(0);
		let settled = false;
		void closing.then(() => {
			settled = true;
		});
		old.markReady();
		scheduler.start();
		scheduler.retry();
		await vi.advanceTimersByTimeAsync(60_000);
		expect(settled).toBe(false);
		expect(run).toHaveBeenCalledTimes(1);
		old.reject(new Error("DYTEST closed connection cleanup rejected"));
		await closing;
		expect(settled).toBe(true);
		expect(notifications).toHaveLength(noticeCount);
		expect(scheduler.getState()).toMatchObject({ status: "closed", delayMs: null });
	});

	it("cancels backoff and never starts a run after close", async () => {
		const { scheduler, jobs } = fixture();
		scheduler.start();
		await flush();
		jobAt(jobs, 0).resolve();
		await flush();
		expect(vi.getTimerCount()).toBe(1);
		const closing = scheduler.close();
		expect(vi.getTimerCount()).toBe(0);
		await closing;
		await vi.advanceTimersByTimeAsync(60_000);
		expect(jobs).toHaveLength(1);
		expect(scheduler.getState().status).toBe("closed");
	});

	it("does not invoke run when a connecting observer closes the reserved job", async () => {
		let closing: Promise<void> | undefined;
		let current!: ReturnType<typeof fixture>;
		current = fixture((state) => {
			if (state.status === "connecting") closing = current.scheduler.close();
		});
		current.scheduler.start();
		await flush();
		expect(closing).toBeDefined();
		expect(current.run).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
		await closing;
		expect(current.scheduler.getState().status).toBe("closed");
	});

	it("retries from a connecting observer without invoking the fenced reserved run", async () => {
		let retried = false;
		let current!: ReturnType<typeof fixture>;
		current = fixture((state) => {
			if (!retried && state.status === "connecting") {
				retried = true;
				current.scheduler.retry();
			}
		});
		current.scheduler.start();
		await flush();
		expect(retried).toBe(true);
		expect(current.jobs).toHaveLength(1);
		expect(jobAt(current.jobs, 0).signal.aborted).toBe(false);
		expect(current.scheduler.getState()).toEqual({
			status: "connecting",
			attempt: 1,
			delayMs: null,
		});
		expect(vi.getTimerCount()).toBe(1);
	});

	it("reserves a backoff before notifying an observer that closes it", async () => {
		let closing: Promise<void> | undefined;
		let current!: ReturnType<typeof fixture>;
		current = fixture((state) => {
			if (state.status === "waiting" && state.delayMs !== null) closing = current.scheduler.close();
		});
		current.scheduler.start();
		await flush();
		jobAt(current.jobs, 0).resolve();
		await flush();
		expect(closing).toBeDefined();
		expect(vi.getTimerCount()).toBe(0);
		await closing;
		await vi.advanceTimersByTimeAsync(60_000);
		expect(current.jobs).toHaveLength(1);
		expect(current.scheduler.getState().status).toBe("closed");
	});

	it("reserves a backoff before an observer replaces it with one immediate budget", async () => {
		let retried = false;
		let current!: ReturnType<typeof fixture>;
		current = fixture((state) => {
			if (!retried && state.status === "waiting" && state.delayMs !== null) {
				retried = true;
				current.scheduler.retry();
			}
		});
		current.scheduler.start();
		await flush();
		jobAt(current.jobs, 0).resolve();
		await flush();
		expect(retried).toBe(true);
		expect(current.jobs).toHaveLength(2);
		expect(current.scheduler.getState()).toEqual({
			status: "connecting",
			attempt: 1,
			delayMs: null,
		});
		expect(vi.getTimerCount()).toBe(1);
		jobAt(current.jobs, 1).markReady();
		await vi.advanceTimersByTimeAsync(20_000);
		expect(current.jobs).toHaveLength(2);
	});

	it("contains observer exceptions through opening, readiness and subsequent backoff", async () => {
		const { scheduler, jobs } = fixture(() => {
			throw new Error("DYTEST observer failure");
		});
		expect(() => scheduler.start()).not.toThrow();
		await flush();
		expect(() => jobAt(jobs, 0).markReady()).not.toThrow();
		jobAt(jobs, 0).resolve();
		await flush();
		expect(scheduler.getState()).toEqual({ status: "waiting", attempt: 1, delayMs: 250 });
		expect(vi.getTimerCount()).toBe(1);
		await vi.advanceTimersByTimeAsync(250);
		expect(jobs).toHaveLength(2);
	});

	it("contains asynchronous observer rejections without suppressing runner errors", async () => {
		const { scheduler, jobs } = fixture(async () => {
			throw new Error("DYTEST asynchronous observer failure");
		});
		scheduler.start();
		await flush();
		expect(jobs).toHaveLength(1);
		jobAt(jobs, 0).markReady();
		await flush();
		expect(scheduler.getState()).toEqual({ status: "streaming", attempt: 1, delayMs: null });
		jobAt(jobs, 0).resolve();
		await flush();
		expect(scheduler.getState()).toEqual({ status: "waiting", attempt: 1, delayMs: 250 });
		await vi.advanceTimersByTimeAsync(250);
		expect(jobs).toHaveLength(2);
	});

	it("contains a synchronous run throw and clears its opening timer before backoff", async () => {
		const run = vi.fn(() => {
			throw new Error("DYTEST run failed before returning");
		});
		const scheduler = createEventReconnectScheduler({ run });
		cleanup.push(() => scheduler.close());
		expect(() => scheduler.start()).not.toThrow();
		await flush();
		expect(scheduler.getState()).toEqual({ status: "waiting", attempt: 1, delayMs: 250 });
		expect(vi.getTimerCount()).toBe(1);
		await vi.advanceTimersByTimeAsync(250);
		expect(run).toHaveBeenCalledTimes(2);
		expect(scheduler.getState()).toEqual({ status: "waiting", attempt: 2, delayMs: 500 });
		expect(vi.getTimerCount()).toBe(1);
	});

	it("honors synchronous readiness and joins when its observer closes before run returns", async () => {
		const operation = deferred();
		let scheduler!: Scheduler;
		let closing: Promise<void> | undefined;
		let signal: AbortSignal | undefined;
		scheduler = createEventReconnectScheduler({
			run: (currentSignal, markReady) => {
				signal = currentSignal;
				markReady();
				return operation.promise;
			},
			onChange: (state) => {
				if (state.status === "streaming") closing = scheduler.close();
			},
		});
		cleanup.push(async () => {
			const joined = scheduler.close();
			operation.resolve();
			await joined;
		});
		scheduler.start();
		await flush();
		expect(closing).toBeDefined();
		expect(scheduler.close()).toBe(closing);
		expect(signal?.aborted).toBe(true);
		expect(vi.getTimerCount()).toBe(0);
		let settled = false;
		void closing?.then(() => {
			settled = true;
		});
		await flush();
		expect(settled).toBe(false);
		operation.resolve();
		await closing;
		expect(settled).toBe(true);
		expect(scheduler.getState().status).toBe("closed");
	});

	it("joins pending work when the run callback itself closes the scheduler", async () => {
		const operation = deferred();
		let scheduler!: Scheduler;
		let closing: Promise<void> | undefined;
		const run = vi.fn(() => {
			closing = scheduler.close();
			return operation.promise;
		});
		scheduler = createEventReconnectScheduler({ run });
		cleanup.push(async () => {
			const joined = scheduler.close();
			operation.resolve();
			await joined;
		});
		scheduler.start();
		await flush();
		expect(run).toHaveBeenCalledTimes(1);
		expect(closing).toBeDefined();
		expect(scheduler.close()).toBe(closing);
		expect(vi.getTimerCount()).toBe(0);
		let settled = false;
		void closing?.then(() => {
			settled = true;
		});
		await flush();
		expect(settled).toBe(false);
		operation.resolve();
		await closing;
		expect(settled).toBe(true);
		expect(scheduler.getState().status).toBe("closed");
	});
});
