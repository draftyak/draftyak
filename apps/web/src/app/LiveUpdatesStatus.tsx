import type { ReactElement } from "react";
import type { EventSessionState } from "../platform/event-session.ts";

export interface LiveUpdatesStatusProps {
	readonly state: EventSessionState;
	readonly retry: () => void | Promise<void>;
}

function connectionText(state: EventSessionState): string {
	switch (state.connection.status) {
		case "idle":
			return "Live updates have not started.";
		case "connecting":
			return "Connecting live updates.";
		case "streaming":
			return "Live update stream connected.";
		case "waiting":
			return state.connection.delayMs === null
				? "Live updates paused."
				: "Reconnecting live updates.";
		case "unavailable":
			return "Live update connection unavailable.";
		case "closed":
			return "Live updates closed.";
	}
}

function freshnessText(state: EventSessionState): string {
	switch (state.refresh.status) {
		case "waiting":
			return "Waiting for a live update refresh.";
		case "refreshing":
			return "Refreshing data.";
		case "current":
			return state.connection.status === "streaming"
				? "Live updates current."
				: "Waiting for live updates to resume.";
		case "unavailable":
			return "Live update refresh unavailable.";
		case "closed":
			return "Live updates closed.";
	}
}

function retryIntent(retry: LiveUpdatesStatusProps["retry"]): void {
	try {
		void Promise.resolve(retry()).catch(() => {});
	} catch {
		// The session owns recovery and its next actual state.
	}
}

/** Presents one actual session's connection and refresh state without exposing its cursor. */
export function LiveUpdatesStatus({ state, retry }: LiveUpdatesStatusProps): ReactElement {
	if (state.connection.status === "closed" || state.refresh.status === "closed") {
		return (
			<section aria-label="Live updates">
				<p role="status">Live updates closed.</p>
			</section>
		);
	}
	const canRetry =
		state.connection.status === "waiting" ||
		state.connection.status === "unavailable" ||
		state.refresh.status === "unavailable";
	return (
		<section aria-label="Live updates">
			<p role={state.connection.status === "unavailable" ? "alert" : "status"}>
				{connectionText(state)}
			</p>
			<p role={state.refresh.status === "unavailable" ? "alert" : "status"}>
				{freshnessText(state)}
			</p>
			{canRetry && (
				<button type="button" onClick={() => retryIntent(retry)}>
					Retry updates
				</button>
			)}
		</section>
	);
}
