// Plan section 3, Clock rule: a scheduled claim needs min(hubNow, secondNow) >= notBefore and
// max(hubNow, secondNow) <= deliverBy, so a wrong or lying clock can only delay a send. Each
// property runs 10,000 cases.
import fc, { type IProperty } from "fast-check";
import { expect, it } from "vitest";
import {
	checkClaim,
	HOLD_RETRY_MS,
	MAX_SKEW_MS,
	MIN_RETRY_MS,
	secondNow,
	type Window,
} from "../src/claim.ts";
import { checkDelay, nextTick } from "../src/clock.ts";

const RUNS = 10_000;
const MINUTE = 60_000;
const DAY = 86_400_000;
const LATENESS_S = [900, 3_600, 14_400, 86_400];
const today = Date.UTC(2026, 9, 17);

it("keeps the plan's numbers: a skew over 2 min holds; held claims retry 1 to 15 s later", () => {
	expect([MAX_SKEW_MS, MIN_RETRY_MS, HOLD_RETRY_MS]).toEqual([120_000, 1_000, 15_000]);
});

// A window 1 min to 30 days ahead with an allowed lateness.
const windowArb = fc
	.record({
		notBefore: fc.integer({ min: today + MINUTE, max: today + 30 * DAY }),
		latenessS: fc.constantFrom(...LATENESS_S),
	})
	.map(
		({ notBefore, latenessS }): Window => ({ notBefore, deliverBy: notBefore + latenessS * 1_000 }),
	);
// A window and a true time: around notBefore or the default deliverBy, within days, or a
// millisecond either side of the window's own edges.
const pointArb = windowArb.chain((window) => {
	const lateness = window.deliverBy - window.notBefore;
	const offset = fc.oneof(
		fc.integer({ min: -2 * MINUTE, max: 2 * MINUTE }),
		fc.integer({ min: 13 * MINUTE, max: 17 * MINUTE }),
		fc.integer({ min: -DAY, max: 2 * DAY }),
		fc.constantFrom(-1, 0, lateness, lateness + 1),
	);
	return fc.tuple(
		fc.constant(window),
		offset.map((at) => window.notBefore + at),
	);
});
// A clock's error: within the skew limit, at either side of it, or anything up to two days.
const errorArb = fc.oneof(
	fc.integer({ min: -120_000, max: 120_000 }),
	fc.constantFrom(-120_001, -120_000, 120_000, 120_001),
	fc.integer({ min: -2 * DAY, max: 2 * DAY }),
);

function holds<Ts extends [unknown, ...unknown[]]>(property: IProperty<Ts>): void {
	const details = fc.check(property, { numRuns: RUNS });
	expect(details.failed, fc.defaultReportMessage(details)).toBe(false);
	expect(details.numRuns).toBe(RUNS);
}

const inside = ({ notBefore, deliverBy }: Window, now: number): boolean =>
	notBefore <= now && now <= deliverBy;

it("never claims early or late while either clock is right, however wrong the other is", () => {
	let claims = 0;
	holds(
		fc.property(pointArb, errorArb, fc.boolean(), ([window, now], error, hubRight) => {
			const claim = hubRight
				? checkClaim(window, now, now + error)
				: checkClaim(window, now + error, now);
			if (claim.ok) claims++;
			return !claim.ok || inside(window, now);
		}),
	);
	expect(claims).toBeGreaterThan(RUNS / 10);
});

it("never claims early or late while the two clocks bracket the true time", () => {
	const spread = fc.integer({ min: 0, max: 3 * MINUTE });
	holds(
		fc.property(pointArb, spread, spread, fc.boolean(), ([window, now], a, b, swap) => {
			const [hub, second] = swap ? [now + b, now - a] : [now - a, now + b];
			return !checkClaim(window, hub, second).ok || inside(window, now);
		}),
	);
});

it("only ever delays: two clocks claim no earlier and no later than either clock alone", () => {
	holds(
		fc.property(pointArb, errorArb, ([window, hub], error) => {
			const second = hub + error;
			if (!checkClaim(window, hub, second).ok) return true;
			return checkClaim(window, hub, hub).ok && checkClaim(window, second, second).ok;
		}),
	);
});

it("claims exactly inside the window, edges included, when both clocks are right", () => {
	holds(
		fc.property(
			pointArb,
			([window, now]) => checkClaim(window, now, now).ok === inside(window, now),
		),
	);
	for (const latenessS of LATENESS_S) {
		const notBefore = today + MINUTE;
		const window = { notBefore, deliverBy: notBefore + latenessS * 1_000 };
		const { deliverBy } = window;
		const at = (hub: number, second: number) => checkClaim(window, hub, second);
		expect(at(notBefore - 1, notBefore - 1)).toMatchObject({ ok: false, hold: "early" });
		expect(at(notBefore, notBefore)).toMatchObject({ ok: true });
		expect(at(deliverBy, deliverBy)).toMatchObject({ ok: true });
		expect(at(deliverBy + 1, deliverBy + 1)).toEqual({ ok: false, hold: "missed" });
		expect(at(notBefore + 1, notBefore)).toMatchObject({ ok: true, early: notBefore });
		expect(at(deliverBy - 1, deliverBy)).toMatchObject({ ok: true, late: deliverBy });
		expect(at(notBefore + 1, notBefore - 1)).toMatchObject({ ok: false, hold: "early" });
		expect(at(notBefore - 1, notBefore + 1)).toMatchObject({ ok: false, hold: "early" });
		expect(at(deliverBy - 1, deliverBy + 1)).toEqual({ ok: false, hold: "missed" });
		expect(at(deliverBy + 1, deliverBy - 1)).toEqual({ ok: false, hold: "missed" });
	}
});

it("holds for skew exactly when the clocks are more than 2 min apart", () => {
	holds(
		fc.property(pointArb, errorArb, ([window, hub], error) => {
			const claim = checkClaim(window, hub, hub + error);
			return (!claim.ok && claim.hold === "skew") === Math.abs(error) > 120_000;
		}),
	);
	const window = { notBefore: today, deliverBy: today + 15 * MINUTE };
	const hub = today + 5 * MINUTE;
	const skew = { ok: false, hold: "skew", retryInMs: 15_000 };
	expect(checkClaim(window, hub, hub + 120_000)).toMatchObject({ ok: true, late: hub + 120_000 });
	expect(checkClaim(window, hub, hub - 120_000)).toMatchObject({ ok: true, early: hub - 120_000 });
	expect(checkClaim(window, hub, hub + 120_001)).toEqual(skew);
	expect(checkClaim(window, hub, hub - 120_001)).toEqual(skew);
	expect(checkClaim(window, hub, Number.NaN)).toEqual(skew);
	expect(checkClaim(window, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY)).toEqual(skew);
});

it("never claims a window that isn't two safe integers in order", () => {
	const now = today + MINUTE;
	const windows: Window[] = [
		{ notBefore: Number.NaN, deliverBy: Number.NaN },
		{ notBefore: today, deliverBy: Number.POSITIVE_INFINITY },
		{ notBefore: Number.NEGATIVE_INFINITY, deliverBy: today + DAY },
		{ notBefore: today + 0.5, deliverBy: today + DAY },
		{ notBefore: today + DAY, deliverBy: today },
		{} as Window,
	];
	for (const window of windows) {
		expect(checkClaim(window, now, now), String(Object.values(window))).toEqual({
			ok: false,
			hold: "window",
		});
	}
});

it("says when to retry a held claim: early within 1 to 15 s, skew a tick later, missed never", () => {
	holds(
		fc.property(pointArb, errorArb, fc.boolean(), ([window, now], error, hubRight) => {
			const [hub, second] = hubRight ? [now, now + error] : [now + error, now];
			const claim = checkClaim(window, hub, second);
			if (claim.ok || claim.hold === "missed") return !("retryInMs" in claim);
			if (claim.hold === "skew") return claim.retryInMs === 15_000;
			if (claim.hold === "window") return false;
			// Back no sooner than the min clock reaches notBefore, unless a tick comes first.
			const early = Math.min(hub, second);
			return (
				claim.retryInMs >= 1_000 &&
				claim.retryInMs <= 15_000 &&
				claim.retryInMs <= Math.max(1_000, Math.ceil(window.notBefore - early)) &&
				(early + claim.retryInMs >= window.notBefore || claim.retryInMs === 15_000)
			);
		}),
	);
});

// The Date header has whole seconds and is written before the response travels, so secondNow lags
// a right upstream by less than 1 s plus the latency, and with a right hub clock that only delays.
it("reads the second clock from a Date header that lags its upstream and never leads it", () => {
	holds(
		fc.property(
			pointArb,
			fc.integer({ min: 0, max: 30_000 }),
			fc.integer({ min: 0, max: 10_000 }),
			fc.integer({ min: 0, max: DAY }),
			([window, now], latency, sinceRead, monoOrigin) => {
				const written = now - sinceRead - latency;
				const second = secondNow(
					new Date(written).toUTCString(),
					monoOrigin,
					monoOrigin + sinceRead,
				);
				const lag = now - second;
				const claim = checkClaim(window, now, second);
				const due = window.notBefore + 1_000 + latency <= now && now <= window.deliverBy;
				return (
					lag >= 0 &&
					lag < 1_000 + latency &&
					(!claim.ok || inside(window, now)) &&
					(claim.ok || !due)
				);
			},
		),
	);
	expect(secondNow("Sat, 17 Oct 2026 10:00:00 GMT", 5, 7)).toBe(Date.UTC(2026, 9, 17, 10) + 2);
	// Shaped like IMF-fixdate, but Date.parse would read another instant, or the weekday is wrong.
	for (const date of [
		"2026-10-17T12:00:00Z",
		"Invalid Date",
		"Tue, 31 Feb 2026 10:00:00 GMT",
		"Sun, 17 Oct 0000 10:00:00 GMT",
		"Sat, 17 Oct 2026 24:00:00 GMT",
		"Sat, 17 Oct 2026 23:59:60 GMT",
		"Fri, 17 Oct 2026 10:00:00 GMT",
	]) {
		expect(() => secondNow(date, 0, 0), date).toThrow(RangeError);
	}
});

// The scheduler around the claim, on simulated true time t: the hub's and the upstream's clocks
// each off by a fixed error. The hub starts ticking at hub time `start`; each pre-claim read takes
// `latency` ms, fails where `fails` says so, and carries the upstream's Date header, written
// halfway and cut to whole seconds (secondNow right after the response). A held row counts from
// its retry time in nextTick, and the tick's sweep ends the item once the hub clock passes
// deliverBy. A read a second over the whole window ends the run too, so a retry that comes back at
// once fails the bounds below instead of spinning.
function schedule(
	window: Window,
	start: number,
	[hubError, upstreamError]: readonly [number, number],
	latency: number,
	fails: readonly boolean[],
): { readonly reads: number; readonly claimedAt?: number } {
	const spinning = 10 + (window.deliverBy - window.notBefore) / 1_000;
	let t = start - hubError;
	let retryAt = Number.NEGATIVE_INFINITY;
	let reads = 0;
	for (;;) {
		if (t + hubError > window.deliverBy || reads > spinning) return { reads };
		if (t + hubError >= Math.max(window.notBefore, retryAt)) {
			const written = t + latency / 2 + upstreamError;
			t += latency;
			const hub = t + hubError;
			if (fails[reads++]) {
				retryAt = hub + HOLD_RETRY_MS;
			} else {
				const claim = checkClaim(window, hub, Math.floor(written / 1_000) * 1_000);
				if (claim.ok) return { reads, claimedAt: t };
				if (claim.hold === "missed" || claim.hold === "window") return { reads };
				retryAt = hub + claim.retryInMs;
			}
		}
		t += checkDelay(nextTick(t + hubError, Math.max(window.notBefore, retryAt)));
	}
}

it("makes at most one pre-claim read per tick for a held item, never claiming early or late", () => {
	const clocksArb = fc.oneof(
		fc.tuple(fc.constant(0), errorArb),
		fc.tuple(errorArb, fc.constant(0)),
		fc.tuple(errorArb, errorArb),
	);
	// The hub starts before notBefore, or comes up anywhere in or just after the window.
	const startArb = windowArb.chain((window) => {
		const lateness = window.deliverBy - window.notBefore;
		const offset = fc.integer({ min: -MINUTE, max: lateness + MINUTE });
		return fc.tuple(fc.constant(window), fc.oneof(fc.constant(-MINUTE), offset));
	});
	holds(
		fc.property(
			startArb,
			clocksArb,
			fc.integer({ min: 0, max: 10_000 }),
			fc.array(fc.boolean(), { maxLength: 20 }),
			([window, startOffset], clocks, latency, fails) => {
				const lateness = window.deliverBy - window.notBefore;
				const { reads, claimedAt } = schedule(
					window,
					window.notBefore + startOffset,
					clocks,
					latency,
					fails,
				);
				const [hubError, upstreamError] = clocks;
				const apart = Math.abs(hubError - upstreamError);
				const ticks = Math.floor(lateness / 15_000);
				if (claimedAt !== undefined) {
					if ((hubError === 0 || upstreamError === 0) && claimedAt < window.notBefore) return false;
					if (hubError === 0 && claimedAt > window.deliverBy) return false;
					// A slow hub lets the Date header's lag through: late by less than 1 s plus latency.
					if (upstreamError === 0 && claimedAt >= window.deliverBy + 1_000 + latency) return false;
				}
				// Each attempt falls within the window by the hub clock; only the Date header's whole
				// seconds bring a retry under 15 s, at most three times.
				if (reads > 4 + ticks) return false;
				if (apart >= 120_000 + 1_000 + latency)
					return claimedAt === undefined && reads <= 1 + ticks;
				if (apart <= 120_000 - 1_000 - latency && !fails.includes(true) && startOffset < 0) {
					return claimedAt !== undefined && reads <= 4 + 120_000 / 15_000;
				}
				return true;
			},
		),
	);
});
