import type { EventFrame } from "@draftyak/protocol/device-api";
import { createEventReconnectScheduler, type EventReconnectState } from "./event-reconnect.ts";
import { createEventRefreshCoordinator, type EventRefreshState } from "./event-refresh.ts";
import type { SpaPlatform } from "./spa-platform.ts";

export interface EventSessionState {
	readonly connection: EventReconnectState;
	readonly refresh: EventRefreshState;
}

export interface EventSessionOptions {
	readonly platform: Pick<SpaPlatform, "events">;
	readonly refetch: (signal: AbortSignal) => Promise<void>;
	readonly onChange?: (state: EventSessionState) => void;
}

export interface EventSession {
	getState(): EventSessionState;
	start(): void;
	retry(): void;
	close(): Promise<void>;
}

interface StreamAttempt {
	readonly controller: AbortController;
	readonly signal: AbortSignal;
	active: boolean;
	resetting: boolean;
}

/**
 * Coordinates one subject's validated event stream and relevant data refreshes.
 * Recreate on an account, device or hub change. The caller owns the platform;
 * closing this session joins only its stream and refresh work, not the platform.
 */
export function createEventSession(options: EventSessionOptions): EventSession {
	const platform = options.platform;
	const refetch = options.refetch;
	const onChange = options.onChange;
	let closed = false;
	let closing: Promise<void> | undefined;
	let currentAttempt: StreamAttempt | undefined;
	const refresh = createEventRefreshCoordinator({
		refetch(signal) {
			if (closed) return Promise.reject();
			return refetch(signal);
		},
		onChange: publish,
	});
	const connection = createEventReconnectScheduler({ run, onChange: publish });
	let state: EventSessionState = Object.freeze({
		connection: connection.getState(),
		refresh: refresh.getState(),
	});

	function publish(): void {
		const nextConnection = connection.getState();
		const nextRefresh = refresh.getState();
		if (state.connection === nextConnection && state.refresh === nextRefresh) return;
		state = Object.freeze({ connection: nextConnection, refresh: nextRefresh });
		if (closed || onChange === undefined) return;
		try {
			void Promise.resolve(onChange(state)).catch(() => {});
		} catch {
			// Observers cannot replace or strand either underlying lifetime.
		}
	}

	function isLive(attempt: StreamAttempt): boolean {
		return (
			!closed &&
			currentAttempt === attempt &&
			attempt.active &&
			!attempt.resetting &&
			!attempt.signal.aborted &&
			!attempt.controller.signal.aborted
		);
	}

	async function run(signal: AbortSignal, markReady: () => void): Promise<void> {
		if (closed || signal.aborted) return;
		const attempt: StreamAttempt = {
			controller: new AbortController(),
			signal,
			active: true,
			resetting: false,
		};
		currentAttempt = attempt;
		function abort(): void {
			attempt.active = false;
			if (!closed && currentAttempt === attempt) refresh.disconnected();
			attempt.controller.abort();
		}
		function receive(frame: EventFrame): void {
			if (!isLive(attempt)) return;
			if (frame.type === "ready") {
				markReady();
				// A streaming-state observer may have closed or replaced this attempt.
				if (!isLive(attempt)) return;
			}
			if (frame.type === "reset") {
				// Reserve the fence before refresh observers can reenter retry or receive.
				attempt.resetting = true;
				try {
					refresh.receive(frame);
				} finally {
					attempt.active = false;
					attempt.controller.abort();
				}
				return;
			}
			refresh.receive(frame);
		}
		signal.addEventListener("abort", abort, { once: true });
		try {
			if (signal.aborted) abort();
			if (!isLive(attempt)) return;
			const request = Object.freeze({ after: refresh.getState().cursor });
			// The host promise covers stream cleanup, even when cancellation is ignored.
			await platform.events(request, attempt.controller.signal, receive);
		} finally {
			attempt.active = false;
			signal.removeEventListener("abort", abort);
			attempt.controller.abort();
			if (!closed && currentAttempt === attempt) refresh.disconnected();
			if (currentAttempt === attempt) currentAttempt = undefined;
		}
	}

	function start(): void {
		if (!closed) connection.start();
	}

	function retry(): void {
		if (closed) return;
		if (
			currentAttempt !== undefined &&
			isLive(currentAttempt) &&
			connection.getState().status === "streaming"
		) {
			refresh.retry();
		} else {
			connection.retry();
		}
	}

	function close(): Promise<void> {
		if (closing !== undefined) return closing;
		let resolveClosing!: () => void;
		let rejectClosing!: (reason: unknown) => void;
		closing = new Promise<void>((resolve, reject) => {
			resolveClosing = resolve;
			rejectClosing = reject;
		});
		closed = true;
		// Reserve the shared join before abort listeners or refetch code can reenter.
		const connectionClosing = connection.close();
		const refreshClosing = refresh.close();
		publish();
		void Promise.allSettled([connectionClosing, refreshClosing]).then((results) => {
			const failure = results.find((result) => result.status === "rejected");
			if (failure?.status === "rejected") rejectClosing(failure.reason);
			else resolveClosing();
		});
		return closing;
	}

	return Object.freeze({ getState: () => state, start, retry, close });
}
