import type { EventFrame, EventsRequest } from "@draftyak/protocol/device-api";

/**
 * Transport for the generated API-local client and its ids-only event stream.
 * The host owns authentication, route admission and protocol frame validation.
 * This interface does not establish any of those properties by itself.
 */
export interface SpaPlatform {
	/** Settles only after this request's response or terminal cleanup is complete. */
	fetch(request: Request): Promise<Response>;
	/**
	 * Delivers already validated M1 frames. The promise covers the entire stream
	 * lifetime and its cleanup, including cancellation through signal.
	 */
	events(
		request: EventsRequest,
		signal: AbortSignal,
		receive: (frame: EventFrame) => void,
	): Promise<void>;
	/** Stops new work and joins every request, stream and handle owned by this adapter. */
	close(): Promise<void>;
}

/** Release browser entry points have no hub transport while browser login is unavailable. */
export function createUnavailableSpaPlatform(): SpaPlatform {
	const closed = Promise.resolve();
	return Object.freeze({
		async fetch(_request: Request): Promise<Response> {
			throw new Error("HUB_UNAVAILABLE");
		},
		async events(
			_request: EventsRequest,
			_signal: AbortSignal,
			_receive: (frame: EventFrame) => void,
		): Promise<void> {
			throw new Error("HUB_UNAVAILABLE");
		},
		close: () => closed,
	});
}
