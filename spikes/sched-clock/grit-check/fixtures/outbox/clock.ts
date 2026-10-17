// The sanctioned shape: waits through the injected clock, and names that only look like timers.
import { mkdir } from "node:fs/promises";
import { stamp } from "./timers.ts";

interface Clock {
	readonly after: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export async function tick(clock: Clock, wait: number, handle: number, signal: AbortSignal) {
	await clock.after(Math.min(15_000, wait), signal);
	clearTimeout(handle);
	const setTimeoutLike = "wait with clock.after, never setTimeout";
	const controller = new AbortController();
	const files = await import("node:fs/promises");
	void [mkdir, stamp, setTimeoutLike, controller, files];
}
