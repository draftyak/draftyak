export type EventReconnectStatus =
	| "idle"
	| "connecting"
	| "streaming"
	| "waiting"
	| "unavailable"
	| "closed";

export interface EventReconnectState {
	readonly status: EventReconnectStatus;
	readonly attempt: number;
	readonly delayMs: number | null;
}

export interface EventReconnectOptions {
	readonly run: (signal: AbortSignal, markReady: () => void) => Promise<void>;
	readonly onChange?: (state: EventReconnectState) => void;
}

export interface EventReconnectScheduler {
	getState(): EventReconnectState;
	start(): void;
	retry(): void;
	close(): Promise<void>;
}

interface ConnectionJob {
	readonly budget: object;
	readonly readyToken: object;
	readonly controller: AbortController;
	readonly settled: Promise<void>;
	readonly resolveSettled: () => void;
}

interface ConnectionTimer {
	readonly kind: "opening" | "backoff";
	readonly budget: object;
	readonly handle: ReturnType<typeof setTimeout>;
	readonly job?: ConnectionJob;
}

const OPEN_TIMEOUT_MS = 10_000;
const MAX_ATTEMPTS = 8;
const BACKOFF_MS = [250, 500, 1000, 2000, 4000, 8000, 8000] as const;

/**
 * Local scheduling for one caller subject. run must settle only after the complete
 * connection lifetime and cleanup. markReady is a local milestone supplied to that
 * attempt; its caller owns protocol validation. This module owns no socket or cursor.
 * delayMs is the selected backoff delay, not a continuously updated countdown.
 */
export function createEventReconnectScheduler(
	options: EventReconnectOptions,
): EventReconnectScheduler {
	const run = options.run;
	const onChange = options.onChange;
	let budget: object = {};
	let attempts = 0;
	let pendingRestart = false;
	let readyToken: object | undefined;
	let active: ConnectionJob | undefined;
	let timer: ConnectionTimer | undefined;
	let closed = false;
	let closing: Promise<void> | undefined;
	let state: EventReconnectState = Object.freeze({ status: "idle", attempt: 0, delayMs: null });

	function publish(status: EventReconnectStatus, delayMs: number | null = null): void {
		if (state.status === status && state.attempt === attempts && state.delayMs === delayMs) return;
		state = Object.freeze({ status, attempt: attempts, delayMs });
		if (closed || onChange === undefined) return;
		try {
			void Promise.resolve(onChange(state)).catch(() => {});
		} catch {
			// Observers cannot strand an attempt or its join.
		}
	}

	function clearTimer(): void {
		const previous = timer;
		timer = undefined;
		if (previous !== undefined) clearTimeout(previous.handle);
	}

	function waitBeforeNext(): void {
		if (closed || active !== undefined) return;
		if (attempts >= MAX_ATTEMPTS) {
			publish("unavailable");
			return;
		}
		const delay = BACKOFF_MS[attempts - 1];
		if (delay === undefined) return;
		let next!: ConnectionTimer;
		const handle = setTimeout(() => {
			if (timer !== next || closed || next.budget !== budget) return;
			timer = undefined;
			begin();
		}, delay);
		next = { kind: "backoff", budget, handle };
		timer = next;
		publish("waiting", delay);
	}

	function finish(job: ConnectionJob): void {
		if (active !== job) {
			job.resolveSettled();
			return;
		}
		if (timer?.kind === "opening" && timer.job === job) clearTimer();
		active = undefined;
		if (readyToken === job.readyToken) readyToken = undefined;
		try {
			if (closed) return;
			if (pendingRestart) {
				pendingRestart = false;
				begin();
			} else if (job.budget === budget) {
				waitBeforeNext();
			}
		} finally {
			job.resolveSettled();
		}
	}

	function openingDeadline(job: ConnectionJob): void {
		let deadline!: ConnectionTimer;
		const handle = setTimeout(() => {
			if (timer !== deadline || closed || deadline.budget !== budget) return;
			timer = undefined;
			if (active !== job || readyToken !== job.readyToken) return;
			readyToken = undefined;
			publish("waiting");
			job.controller.abort();
		}, OPEN_TIMEOUT_MS);
		deadline = { kind: "opening", budget: job.budget, handle, job };
		timer = deadline;
	}

	function markReady(job: ConnectionJob): void {
		if (closed || active !== job || job.budget !== budget || readyToken !== job.readyToken) return;
		if (timer?.kind === "opening" && timer.job === job) clearTimer();
		publish("streaming");
	}

	function begin(): void {
		if (closed || active !== undefined || timer !== undefined) return;
		if (attempts >= MAX_ATTEMPTS) {
			publish("unavailable");
			return;
		}
		let resolveSettled!: () => void;
		const settled = new Promise<void>((resolve) => {
			resolveSettled = resolve;
		});
		const job: ConnectionJob = {
			budget,
			readyToken: {},
			controller: new AbortController(),
			settled,
			resolveSettled,
		};
		attempts++;
		active = job;
		readyToken = job.readyToken;
		openingDeadline(job);
		publish("connecting");
		// A synchronous observer can close or replace this reserved attempt.
		if (closed || active !== job || job.budget !== budget || readyToken !== job.readyToken) {
			void Promise.resolve().then(() => finish(job));
			return;
		}
		let work: Promise<void>;
		try {
			work = run(job.controller.signal, () => markReady(job));
		} catch {
			work = Promise.reject();
		}
		void Promise.resolve(work).then(
			() => finish(job),
			() => finish(job),
		);
	}

	function start(): void {
		if (!closed && state.status === "idle") begin();
	}

	function retry(): void {
		if (closed) return;
		const old = active;
		clearTimer();
		budget = {};
		attempts = 0;
		readyToken = undefined;
		pendingRestart = old !== undefined;
		if (old !== undefined) {
			publish("waiting");
			old.controller.abort();
		} else {
			begin();
		}
	}

	function close(): Promise<void> {
		if (closing !== undefined) return closing;
		closed = true;
		budget = {};
		attempts = 0;
		pendingRestart = false;
		readyToken = undefined;
		clearTimer();
		closing = active?.settled ?? Promise.resolve();
		publish("closed");
		active?.controller.abort();
		return closing;
	}

	return Object.freeze({ getState: () => state, start, retry, close });
}
