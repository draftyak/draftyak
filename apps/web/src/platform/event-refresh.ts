import type { EventFrame } from "@draftyak/protocol/device-api";

export type EventRefreshStatus = "waiting" | "refreshing" | "current" | "unavailable" | "closed";

export interface EventRefreshState {
	readonly status: EventRefreshStatus;
	readonly cursor: string | null;
}

export interface EventRefreshOptions {
	readonly refetch: (signal: AbortSignal) => Promise<void>;
	readonly onChange?: (state: EventRefreshState) => void;
}

export interface EventRefreshCoordinator {
	getState(): EventRefreshState;
	receive(frame: EventFrame): void;
	disconnected(): void;
	retry(): void;
	close(): Promise<void>;
}

interface RefreshJob {
	readonly generation: object;
	readonly readyRequest: object;
	readonly controller: AbortController;
	readonly settled: Promise<void>;
	readonly resolveSettled: () => void;
}

/**
 * One caller subject and one in-memory resume position. Recreate on a subject change.
 * receive accepts an already protocol-validated frame; it does no wire decoding.
 * refetch must finish all relevant refreshes before resolving. Observer errors are contained.
 */
export function createEventRefreshCoordinator(
	options: EventRefreshOptions,
): EventRefreshCoordinator {
	const refetch = options.refetch;
	const onChange = options.onChange;
	let committedCursor: string | null = null;
	let latestCursor: string | null = null;
	let generation: object = {};
	let readyRequest: object = {};
	let ready = false;
	let dirty = false;
	let failed = false;
	let closed = false;
	let active: RefreshJob | undefined;
	let closing: Promise<void> | undefined;
	let state: EventRefreshState = Object.freeze({ status: "waiting", cursor: null });

	function publish(status: EventRefreshStatus): void {
		if (state.status === status && state.cursor === committedCursor) return;
		state = Object.freeze({ status, cursor: committedCursor });
		if (closed || onChange === undefined) return;
		try {
			void Promise.resolve(onChange(state)).catch(() => {});
		} catch {
			// An observer cannot change refresh completion or strand a join.
		}
	}

	function finish(job: RefreshJob, successful: boolean): void {
		if (active !== job) {
			job.resolveSettled();
			return;
		}
		active = undefined;
		try {
			if (!closed && job.generation === generation && ready) {
				if (!successful) {
					failed = job.readyRequest === readyRequest;
					dirty = true;
					if (failed) publish("unavailable");
				} else if (!dirty) {
					committedCursor = latestCursor;
					publish("current");
				}
			}
			pump();
		} finally {
			job.resolveSettled();
		}
	}

	function pump(): void {
		if (closed || !ready || failed || !dirty) return;
		if (active !== undefined) {
			publish("refreshing");
			return;
		}
		let resolveSettled!: () => void;
		const settled = new Promise<void>((resolve) => {
			resolveSettled = resolve;
		});
		const job: RefreshJob = {
			generation,
			readyRequest,
			controller: new AbortController(),
			settled,
			resolveSettled,
		};
		active = job;
		dirty = false;
		publish("refreshing");
		// Publishing can synchronously close, reset or disconnect this lifetime.
		if (closed || job.generation !== generation || !ready) {
			finish(job, false);
			return;
		}
		let work: Promise<void>;
		try {
			work = refetch(job.controller.signal);
		} catch {
			work = Promise.reject();
		}
		void Promise.resolve(work).then(
			() => finish(job, true),
			() => finish(job, false),
		);
	}

	function invalidate(status: "waiting" | "unavailable", clearCursor: boolean): void {
		const old = active;
		generation = {};
		ready = false;
		dirty = false;
		failed = false;
		latestCursor = null;
		if (clearCursor) committedCursor = null;
		publish(status);
		old?.controller.abort();
	}

	function receive(frame: EventFrame): void {
		if (closed) return;
		switch (frame.type) {
			case "reset":
				invalidate("waiting", true);
				return;
			case "ready":
				ready = true;
				readyRequest = {};
				failed = false;
				latestCursor = frame.cursor;
				dirty = true;
				pump();
				return;
			case "event":
				if (!ready) {
					invalidate("unavailable", false);
					return;
				}
				latestCursor = frame.cursor;
				dirty = true;
				pump();
				return;
			default:
				invalidate("unavailable", false);
		}
	}

	function disconnected(): void {
		if (!closed) invalidate("unavailable", false);
	}

	function retry(): void {
		if (closed || !ready || !failed) return;
		failed = false;
		dirty = true;
		pump();
	}

	function close(): Promise<void> {
		if (closing !== undefined) return closing;
		closed = true;
		generation = {};
		ready = false;
		dirty = false;
		failed = false;
		latestCursor = null;
		committedCursor = null;
		closing = active?.settled ?? Promise.resolve();
		publish("closed");
		active?.controller.abort();
		return closing;
	}

	return Object.freeze({ getState: () => state, receive, disconnected, retry, close });
}
