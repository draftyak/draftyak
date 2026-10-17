import { setTimeout as delay } from "node:timers/promises";
import { rawTarget, splitTarget } from "./target.ts";

/** Where a fake's time comes from: UTC milliseconds. */
export interface Clock {
	now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

export interface ManualClock extends Clock {
	set(ms: number): void;
	advance(ms: number): void;
}

/** A clock that moves only when the test moves it. */
export function manualClock(start: number): ManualClock {
	let now = start;
	return {
		now: () => now,
		set: (ms) => {
			now = ms;
		},
		advance: (ms) => {
			now += ms;
		},
	};
}

// 10000-01-01T00:00:00Z: an IMF-fixdate has a four-digit year.
const END_OF_HTTP_DATES = 253_402_300_800_000;

/** RFC 9110's IMF-fixdate, the form of `Date`, `Last-Modified` and `Retry-After`. */
export function httpDate(ms: number): string {
	if (!(ms >= 0 && ms < END_OF_HTTP_DATES)) {
		throw new RangeError(`an HTTP date needs UTC milliseconds from 1970 to 9999: ${ms}`);
	}
	return new Date(ms).toUTCString();
}

// A Node timer's longest delay; a longer one fires after 1 ms.
const MAX_DELAY_MS = 2 ** 31 - 1;

/** Throws a RangeError unless `ms` is whole milliseconds a Node timer can wait, or Infinity. */
export function checkDelay(name: string, ms: number): void {
	if (ms === Infinity || (Number.isInteger(ms) && ms >= 0 && ms <= MAX_DELAY_MS)) return;
	throw new RangeError(`${name} must be whole milliseconds from 0 to 2^31 - 1, or Infinity: ${ms}`);
}

/** Waits like a slow server, Infinity until aborted; an abort rejects with the signal's reason. */
export async function wait(ms: number, signal?: AbortSignal): Promise<void> {
	checkDelay("wait", ms);
	try {
		// A live timer keeps the process up, as a hung server's socket would.
		do await delay(Math.min(ms, MAX_DELAY_MS), undefined, { signal });
		while (ms === Infinity);
	} catch (error) {
		signal?.throwIfAborted();
		throw error;
	}
}

export interface FaultScope {
	/** Only requests with this method; any method when absent. */
	readonly method?: string;
	/** Only this exact raw path, or raw paths the pattern finds; any path when absent. */
	readonly path?: string | RegExp;
	/** How many matching requests it applies to: 1 by default, Infinity for every one. */
	readonly times?: number;
	/** Let the app answer first, so the request takes effect before the fault hits. */
	readonly after?: boolean;
}

export type Fault = FaultScope &
	(
		| { readonly kind: "rate-limit"; readonly retryAfter: number | { readonly at: number } }
		| { readonly kind: "server-error"; readonly status?: number }
		| { readonly kind: "latency"; readonly ms: number }
		| { readonly kind: "drop" }
	);

/** A scripted dropped connection: the socket closes without a response. */
export class DroppedConnectionError extends Error {
	override name = "DroppedConnectionError";
	readonly code = "ECONNRESET";
}

export interface Faults {
	readonly clock: Clock;
	/** Scripts faults; each request takes the first one that matches and has uses left. */
	add(...faults: Fault[]): void;
	/** The scripted faults with uses left, `times` counting what is left. */
	pending(): Fault[];
	clear(): void;
	/** Runs one request through its fault, if any, and stamps `Date` from the clock. */
	run(request: Request, app: (request: Request) => Promise<Response>): Promise<Response>;
}

const errorResponse = (status: number, error: string, headers: Record<string, string> = {}) =>
	Response.json({ error }, { status, headers });

// Delay-seconds, or an HTTP date for {at}.
function retryAfterValue(retryAfter: number | { readonly at: number }): string {
	if (typeof retryAfter !== "number") return httpDate(retryAfter.at);
	const seconds = Math.ceil(retryAfter);
	if (Number.isSafeInteger(seconds) && seconds >= 0) return String(seconds);
	throw new RangeError(`retryAfter must be seconds from 0, or {at: utcMs}: ${retryAfter}`);
}

// Throws a RangeError for a fault that couldn't run as scripted.
function checkFault(fault: Fault): void {
	const times = fault.times ?? 1;
	if (!(times > 0 && (Number.isInteger(times) || times === Infinity))) {
		throw new RangeError(`fault times must be a positive integer or Infinity: ${times}`);
	}
	if (fault.kind === "rate-limit") retryAfterValue(fault.retryAfter);
	if (fault.kind === "latency") checkDelay("latency ms", fault.ms);
	if (fault.kind === "server-error") {
		const status = fault.status ?? 503;
		if (!(Number.isInteger(status) && status >= 500 && status <= 599)) {
			throw new RangeError(`server-error status must be 5xx: ${status}`);
		}
	}
}

export function createFaults(options: { readonly clock?: Clock } = {}): Faults {
	const clock = options.clock ?? systemClock;
	let queue: { fault: Fault; left: number }[] = [];

	const take = (request: Request): Fault | undefined => {
		const { path } = splitTarget(rawTarget(request));
		const entry = queue.find(({ fault }) => {
			if (fault.method !== undefined && fault.method.toUpperCase() !== request.method) return false;
			if (fault.path === undefined) return true;
			return typeof fault.path === "string" ? fault.path === path : path.search(fault.path) !== -1;
		});
		if (entry === undefined) return undefined;
		entry.left -= 1;
		if (entry.left === 0) queue = queue.filter((other) => other !== entry);
		return entry.fault;
	};

	const stamp = (response: Response): Response => {
		const headers = new Headers(response.headers);
		headers.set("Date", httpDate(clock.now()));
		const { status, statusText } = response;
		return new Response(response.body, { status, statusText, headers });
	};

	return {
		clock,
		add(...faults) {
			faults.forEach(checkFault);
			queue.push(...faults.map((fault) => ({ fault, left: fault.times ?? 1 })));
		},
		pending: () => queue.map(({ fault, left }) => ({ ...fault, times: left })),
		clear() {
			queue = [];
		},
		async run(request, app) {
			const fault = take(request);
			const answered = fault?.after ? await app(request) : undefined;
			const answer = async (): Promise<Response> => answered ?? (await app(request));
			switch (fault?.kind) {
				case undefined:
					return stamp(await answer());
				case "latency":
					await wait(fault.ms, request.signal);
					return stamp(await answer());
				case "drop":
					throw new DroppedConnectionError("connection dropped by a scripted fault");
				case "rate-limit": {
					const headers = { "Retry-After": retryAfterValue(fault.retryAfter) };
					return stamp(errorResponse(429, "rate_limited", headers));
				}
				case "server-error":
					return stamp(errorResponse(fault.status ?? 503, "server_error"));
			}
		},
	};
}
