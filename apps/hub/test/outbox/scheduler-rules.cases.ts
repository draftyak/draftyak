import fc, { type IProperty } from "fast-check";
import { describe, expect, it } from "vitest";
import { checkWait, MAX_WAIT_MS } from "../../src/kernel/clock.ts";
import {
	CLAIM_TIMEOUT_MS,
	type ClockReading,
	checkClaimWindow,
	DATE_RESOLUTION_MS,
	DIVERGENCE_MS,
	decidePreclaim,
	diverged,
	HOLD_RETRY_MS,
	type HoldClock,
	isBrokerDateSample,
	MAX_SKEW_MS,
	MIN_RETRY_MS,
	observeBrokerDate,
	PACING_MS,
	type PlanRow,
	PRECLAIM_TIMEOUT_MS,
	PREFLIGHT_LEAD_MS,
	PREFLIGHT_TIMEOUT_MS,
	type PreclaimInput,
	type PreclaimVerdict,
	parseImfFixdate,
	planTick,
	rowWaitMs,
	SAMPLE_MAX_AGE_MS,
	type SendWindowMs,
	sampleOfRead,
	secondClock,
	TICK_BUDGET_MS,
	watermarkMicros,
} from "../../src/outbox/scheduler-rules.ts";
import {
	ACCOUNT_A,
	ACCOUNT_B,
	noHolds,
	OUTBOX_1,
	observe,
	READ_1,
	READ_2,
	ulidFor,
} from "./scheduler-fixture.ts";

const RUNS = 10_000;
const MINUTE = 60_000;
const DAY = 86_400_000;
const LATENESS_S = [900, 3_600, 14_400, 86_400];
const today = Date.UTC(2026, 9, 17);

const at = (window: SendWindowMs, hub: number, second: number) =>
	checkClaimWindow(window, hub, second);

// A window 1 min to 30 days ahead with an allowed lateness.
const windowArb = fc
	.record({
		notBefore: fc.integer({ min: today + MINUTE, max: today + 30 * DAY }),
		latenessS: fc.constantFrom(...LATENESS_S),
	})
	.map(
		({ notBefore, latenessS }): SendWindowMs => ({
			notBefore,
			deliverBy: notBefore + latenessS * 1_000,
		}),
	);
// A window and a true time: around notBefore or deliverBy, within days, or at the edges.
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
		offset.map((ms) => window.notBefore + ms),
	);
});
// A clock's error: within the skew limit, at either side of it, or up to two days.
const errorArb = fc.oneof(
	fc.integer({ min: -120_000, max: 120_000 }),
	fc.constantFrom(-120_001, -120_000, 120_000, 120_001),
	fc.integer({ min: -2 * DAY, max: 2 * DAY }),
);

function holds<Ts extends [unknown, ...unknown[]]>(property: IProperty<Ts>, runs = RUNS): void {
	const details = fc.check(property, { numRuns: runs });
	expect(details.failed, fc.defaultReportMessage(details)).toBe(false);
	expect(details.numRuns).toBe(runs);
}

const inside = ({ notBefore, deliverBy }: SendWindowMs, now: number): boolean =>
	notBefore <= now && now <= deliverBy;

interface Read {
	readonly requestTrue: number;
	readonly latency: number;
	readonly written: number;
	readonly hubError: number;
	readonly upstreamError: number;
	readonly readId?: string;
	readonly accountId?: string;
}

// One read against an upstream off by upstreamError, decided right at the response; the hub's
// monotonic clock is right and its wall clock is off by hubError.
function readAt({
	requestTrue,
	latency,
	written,
	hubError,
	upstreamError,
	readId = READ_1,
	accountId = ACCOUNT_A,
}: Read) {
	const sample = observe(
		Math.floor(written + upstreamError),
		{
			requestWall: requestTrue + hubError,
			requestMono: requestTrue,
			responseWall: requestTrue + latency + hubError,
			responseMono: requestTrue + latency,
		},
		readId,
		accountId,
	);
	const now: ClockReading = {
		wall: requestTrue + latency + hubError,
		mono: requestTrue + latency,
	};
	return { sample, now };
}

const base = (window: SendWindowMs, hubNow: number): PreclaimInput => ({
	window,
	hubNow,
	immediate: false,
	second: { low: hubNow, high: hubNow + 1_000 },
	sampleUsable: true,
	accountMode: "full",
	observation: { complete: true, facts: "unchanged", newestInbound: null },
	holdIfNewInbound: true,
	watermark: 1_729_584_000_000_000,
});

export function schedulerRulesCases(): void {
	describe("scheduler rules", () => {
		it("keeps the plan's numbers: a skew over 2 min holds; held claims retry 1 to 15 s later", () => {
			expect([MAX_SKEW_MS, MIN_RETRY_MS, HOLD_RETRY_MS]).toEqual([120_000, 1_000, 15_000]);
			expect([
				DIVERGENCE_MS,
				PRECLAIM_TIMEOUT_MS,
				PREFLIGHT_TIMEOUT_MS,
				CLAIM_TIMEOUT_MS,
				PREFLIGHT_LEAD_MS,
				DATE_RESOLUTION_MS,
				TICK_BUDGET_MS,
				SAMPLE_MAX_AGE_MS,
			]).toEqual([5_000, 10_000, 15_000, 5_000, 900_000, 1_000, 15_000, 10_000]);
			expect(HOLD_RETRY_MS).toBe(MAX_WAIT_MS);
			expect(PACING_MS).toEqual({ email: 2_000, chat: 1_000 });
			expect(Object.isFrozen(PACING_MS)).toBe(true);
		});

		it("never claims early or late while either clock is right, however wrong the other is", () => {
			let claims = 0;
			holds(
				fc.property(pointArb, errorArb, fc.boolean(), ([window, now], error, hubRight) => {
					const claim = hubRight ? at(window, now, now + error) : at(window, now + error, now);
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
					return !at(window, hub, second).ok || inside(window, now);
				}),
			);
		});

		it("only ever delays: two clocks claim no earlier and no later than either clock alone", () => {
			holds(
				fc.property(pointArb, errorArb, ([window, hub], error) => {
					const second = hub + error;
					if (!at(window, hub, second).ok) return true;
					return at(window, hub, hub).ok && at(window, second, second).ok;
				}),
			);
		});

		it("claims exactly inside the window, edges included, when both clocks are right", () => {
			holds(
				fc.property(pointArb, ([window, now]) => at(window, now, now).ok === inside(window, now)),
			);
			for (const latenessS of LATENESS_S) {
				const notBefore = today + MINUTE;
				const window = { notBefore, deliverBy: notBefore + latenessS * 1_000 };
				const { deliverBy } = window;
				expect(at(window, notBefore - 1, notBefore - 1)).toMatchObject({
					ok: false,
					hold: "early",
				});
				expect(at(window, notBefore, notBefore)).toMatchObject({ ok: true });
				expect(at(window, deliverBy, deliverBy)).toMatchObject({ ok: true });
				expect(at(window, deliverBy + 1, deliverBy + 1)).toEqual({ ok: false, hold: "missed" });
				expect(at(window, notBefore + 1, notBefore)).toMatchObject({ ok: true, early: notBefore });
				expect(at(window, deliverBy - 1, deliverBy)).toMatchObject({ ok: true, late: deliverBy });
				expect(at(window, notBefore + 1, notBefore - 1)).toMatchObject({
					ok: false,
					hold: "early",
				});
				expect(at(window, notBefore - 1, notBefore + 1)).toMatchObject({
					ok: false,
					hold: "early",
				});
				expect(at(window, deliverBy - 1, deliverBy + 1)).toEqual({ ok: false, hold: "missed" });
				expect(at(window, deliverBy + 1, deliverBy - 1)).toEqual({ ok: false, hold: "missed" });
				// Fractional bounds widen to whole ms: early rounds down and late rounds up.
				expect(
					checkClaimWindow(window, notBefore + 10, {
						low: notBefore + 9.5,
						high: notBefore + 10.25,
					}),
				).toEqual({ ok: true, early: notBefore + 9, late: notBefore + 11 });
			}
		});

		it("holds for skew exactly when the clocks are more than 2 min apart", () => {
			holds(
				fc.property(pointArb, errorArb, ([window, hub], error) => {
					const claim = at(window, hub, hub + error);
					return (!claim.ok && claim.hold === "skew") === Math.abs(error) > 120_000;
				}),
			);
			const window = { notBefore: today, deliverBy: today + 15 * MINUTE };
			const hub = today + 5 * MINUTE;
			const skew = { ok: false, hold: "skew", retryInMs: 15_000 };
			expect(at(window, hub, hub + 120_000)).toMatchObject({ ok: true, late: hub + 120_000 });
			expect(at(window, hub, hub - 120_000)).toMatchObject({ ok: true, early: hub - 120_000 });
			expect(at(window, hub, hub + 120_001)).toEqual(skew);
			expect(at(window, hub, hub - 120_001)).toEqual(skew);
			expect(at(window, hub, Number.NaN)).toEqual(skew);
			expect(at(window, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY)).toEqual(skew);
			expect(checkClaimWindow(window, hub, undefined)).toEqual(skew);
			expect(checkClaimWindow(window, hub, { low: hub + 1, high: hub })).toEqual(skew);
			expect(checkClaimWindow(window, hub, { low: hub, high: Number.NaN })).toEqual(skew);
			expect(checkClaimWindow(window, hub, { low: Number.NEGATIVE_INFINITY, high: hub })).toEqual(
				skew,
			);
			expect(checkClaimWindow(window, hub, { low: hub, high: Number.POSITIVE_INFINITY })).toEqual(
				skew,
			);
			let hooks = 0;
			const read = (): number => {
				hooks++;
				return hub;
			};
			for (const second of [
				{ low: hub, high: hub, extra: 1 },
				Object.defineProperty({ low: hub }, "high", { enumerable: true, get: read }),
				new Proxy({ low: hub, high: hub }, { get: read }),
			])
				expect(checkClaimWindow(window, hub, second as never)).toEqual(skew);
			expect(hooks).toBe(0);
		});

		it("never claims a window that isn't two safe integers in order", () => {
			const now = today + MINUTE;
			const windows: unknown[] = [
				{ notBefore: Number.NaN, deliverBy: Number.NaN },
				{ notBefore: today, deliverBy: Number.POSITIVE_INFINITY },
				{ notBefore: Number.NEGATIVE_INFINITY, deliverBy: today + DAY },
				{ notBefore: today + 0.5, deliverBy: today + DAY },
				{ notBefore: today + DAY, deliverBy: today },
				{},
				{ notBefore: -1, deliverBy: today },
				{ notBefore: String(today), deliverBy: today + DAY },
				{ notBefore: today, deliverBy: today + DAY, extra: 1 },
				Object.defineProperty({ deliverBy: today + DAY }, "notBefore", {
					enumerable: true,
					get: () => today,
				}),
				new Proxy({ notBefore: today, deliverBy: today + DAY }, {}),
				null,
				undefined,
				[today, today + DAY],
			];
			for (const window of windows) {
				expect(checkClaimWindow(window, now, now), String(window)).toEqual({
					ok: false,
					hold: "window",
				});
			}
			expect(checkClaimWindow({ notBefore: now, deliverBy: now }, now, now)).toMatchObject({
				ok: true,
			});
		});

		it("returns frozen checks, including the shared refusals", () => {
			const window = { notBefore: today + MINUTE, deliverBy: today + 16 * MINUTE };
			const { notBefore, deliverBy } = window;
			const checks = [
				at(window, notBefore, notBefore),
				at(window, notBefore - 1, notBefore - 1),
				at(window, deliverBy + 1, deliverBy + 1),
				checkClaimWindow(null, notBefore, notBefore),
				checkClaimWindow(window, notBefore, undefined),
			];
			expect(checks.map((check) => (check.ok ? "ok" : check.hold))).toEqual([
				"ok",
				"early",
				"missed",
				"window",
				"skew",
			]);
			for (const check of checks) expect(Object.isFrozen(check)).toBe(true);
		});

		it("says when to retry a held claim: early within 1 to 15 s, skew a tick later, missed never", () => {
			holds(
				fc.property(pointArb, errorArb, fc.boolean(), ([window, now], error, hubRight) => {
					const [hub, second] = hubRight ? [now, now + error] : [now + error, now];
					const claim = at(window, hub, second);
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

		// The Date header has whole seconds and is written during the read, so the interval's low
		// end lags a right upstream by less than 1 s plus the read, and its high end never trails it.
		it("bounds a right upstream from its own Date header and claims only inside the window", () => {
			holds(
				fc.property(
					pointArb,
					fc.integer({ min: 0, max: 10_000 }),
					fc.integer({ min: 0, max: 10_000 }),
					fc.double({ min: 0, max: 1, noNaN: true }),
					([window, now], latency, age, where) => {
						const requestTrue = now - age - latency;
						const written = requestTrue + Math.floor(where * latency);
						const sample = observe(Math.floor(written), {
							requestWall: requestTrue,
							requestMono: requestTrue,
							responseWall: requestTrue + latency,
							responseMono: requestTrue + latency,
						});
						const second = secondClock(sample, { wall: now, mono: now }, ACCOUNT_A);
						if (second === undefined) return false;
						const claim = checkClaimWindow(window, now, second);
						const due =
							window.notBefore + 1_000 + latency <= now &&
							now <= window.deliverBy - 1_000 - latency;
						return (
							second.low <= now &&
							now < second.high &&
							now - second.low < 1_000 + latency &&
							(!claim.ok || inside(window, now)) &&
							(claim.ok || !due)
						);
					},
				),
			);
			expect(parseImfFixdate("Sat, 17 Oct 2026 10:00:00 GMT")).toBe(Date.UTC(2026, 9, 17, 10));
			const times = { requestWall: 7_000, requestMono: 3, responseWall: 7_002, responseMono: 5 };
			const sample = observe("Sat, 17 Oct 2026 10:00:00 GMT", times);
			expect(secondClock(sample, { wall: 7_004, mono: 7 }, ACCOUNT_A)).toEqual({
				low: Date.UTC(2026, 9, 17, 10) + 2,
				high: Date.UTC(2026, 9, 17, 10) + 1_004,
			});
			// Shaped like IMF-fixdate, but Date.parse would read another instant, or the weekday is wrong.
			for (const date of [
				"2026-10-17T12:00:00Z",
				"Invalid Date",
				"Tue, 31 Feb 2026 10:00:00 GMT",
				"Sun, 17 Oct 0000 10:00:00 GMT",
				"Sat, 17 Oct 2026 24:00:00 GMT",
				"Sat, 17 Oct 2026 23:59:60 GMT",
				"Fri, 17 Oct 2026 10:00:00 GMT",
				"Sat, 17 Oct 2026 10:00:00 UTC",
				"sat, 17 Oct 2026 10:00:00 GMT",
				" Sat, 17 Oct 2026 10:00:00 GMT",
				"Sat, 17 Oct 2026 10:00:00 GMT ",
				"Sat, 7 Oct 2026 10:00:00 GMT",
				"Wed, 31 Dec 1969 23:59:59 GMT",
				"Sat, 17 Oct 2026 10:00:00 +0000",
				`Sat, 17 Oct 2026 10:00:00 GMT${"x".repeat(100_000)}`,
			]) {
				expect(parseImfFixdate(date), date).toBeUndefined();
				expect(() => observe(date, times), date).toThrowError(
					expect.objectContaining({ code: "SCHEDULER_DATA" }),
				);
			}
			for (const value of [undefined, null, 0, Date.UTC(2026, 9, 17), new String("x"), {}])
				expect(parseImfFixdate(value)).toBeUndefined();
			expect(parseImfFixdate("Thu, 01 Jan 1970 00:00:00 GMT")).toBe(0);
			expect(parseImfFixdate("Fri, 31 Dec 9999 23:59:59 GMT")).toBe(253_402_300_799_000);
		});

		it("bounds a right upstream for any read up to 10 s, read age, truncation and short monotonic pause", () => {
			holds(
				fc.property(
					fc.integer({ min: today, max: today + 30 * DAY }),
					fc.integer({ min: 0, max: 30_000 }),
					fc.double({ min: 0, max: 1, noNaN: true }),
					fc.integer({ min: 0, max: 10_000 }),
					fc.integer({ min: 0, max: 5_000 }),
					fc.integer({ min: 0, max: 5_000 }),
					fc.integer({ min: -2 * DAY, max: 2 * DAY }),
					fc.integer({ min: 0, max: DAY }).map((ms) => ms + 0.25),
					(requestTrue, latency, where, monoAge, pauseSince, pauseRead, wallError, origin) => {
						const readPause = Math.min(pauseRead, latency);
						const since = monoAge + pauseSince;
						const nowTrue = requestTrue + latency + since;
						const written = requestTrue + Math.floor(where * latency);
						const sample = observe(written, {
							requestWall: requestTrue + wallError,
							requestMono: origin,
							responseWall: requestTrue + latency + wallError,
							responseMono: origin + latency - readPause,
						});
						const second = secondClock(
							sample,
							{ wall: nowTrue + wallError, mono: origin + latency - readPause + monoAge },
							ACCOUNT_A,
						);
						// A read over 10 s on the monotonic clock bounds nothing.
						if (latency - readPause > PRECLAIM_TIMEOUT_MS) return second === undefined;
						return second !== undefined && second.low <= nowTrue && nowTrue < second.high;
					},
				),
			);
		});

		it("claims every attempt outside the early-missed margin with both clocks right", () => {
			const attemptArb = windowArb.chain((window) =>
				fc.tuple(
					fc.constant(window),
					fc.integer({ min: 0, max: 10_000 }),
					fc.double({ min: 0, max: 1, noNaN: true }),
					fc.oneof(
						fc.integer({ min: -15_000, max: 25_000 }).map((ms) => window.notBefore + ms),
						fc.integer({ min: -25_000, max: 15_000 }).map((ms) => window.deliverBy + ms),
						fc.integer({ min: window.notBefore, max: window.deliverBy }),
					),
				),
			);
			let claims = 0;
			holds(
				fc.property(attemptArb, ([window, latency, where, now]) => {
					const requestTrue = now - latency;
					const { sample } = readAt({
						requestTrue,
						latency,
						written: requestTrue + Math.floor(where * latency),
						hubError: 0,
						upstreamError: 0,
					});
					const verdict = decidePreclaim({
						...base(window, now),
						second: secondClock(sample, { wall: now, mono: now }, ACCOUNT_A),
					});
					if (verdict.kind === "claim") claims++;
					if (now < window.notBefore) return verdict.kind === "hold" && verdict.hold === "early";
					if (now > window.deliverBy) return verdict.kind === "void" && verdict.reason === "missed";
					if (
						window.notBefore + 1_000 + latency <= now &&
						now <= window.deliverBy - 1_000 - latency
					)
						return verdict.kind === "claim";
					return (
						verdict.kind === "claim" ||
						(verdict.kind === "hold" && verdict.hold === "early") ||
						(verdict.kind === "void" && verdict.reason === "missed")
					);
				}),
			);
			expect(claims).toBeGreaterThan(RUNS / 4);
		});

		it("holds the clock instead of voiding as missed when the pre-claim read took over 10 s", () => {
			const window = { notBefore: today + MINUTE, deliverBy: today + MINUTE + 900_000 };
			const now = window.notBefore + 100_000;
			const decide = (latency: number): PreclaimVerdict => {
				const { sample, now: after } = readAt({
					requestTrue: now - latency,
					latency,
					written: now,
					hubError: 0,
					upstreamError: 0,
				});
				return decidePreclaim({
					...base(window, after.wall),
					second: secondClock(sample, after, ACCOUNT_A),
				});
			};
			const clockHold = { kind: "hold", hold: "clock", scope: "account", retryInMs: 15_000 };
			expect(decide(10_000)).toEqual({ kind: "claim", early: now, late: now + 11_000 });
			expect(decide(10_001)).toEqual(clockHold);
			// Bounded by the whole read, a 900 s read would put high past deliverBy: missed for good.
			expect(decide(900_000)).toEqual(clockHold);
		});

		it("mints a frozen branded sample only from a complete broker observation", () => {
			const times = { requestWall: 10, requestMono: 1.5, responseWall: 20, responseMono: 11.5 };
			const sample = observe("Sat, 17 Oct 2026 10:00:00 GMT", times);
			expect(sample).toEqual({
				header: "Sat, 17 Oct 2026 10:00:00 GMT",
				readId: READ_1,
				accountId: ACCOUNT_A,
				...times,
				dateMs: Date.UTC(2026, 9, 17, 10),
			});
			expect(Object.isFrozen(sample)).toBe(true);
			expect(isBrokerDateSample(sample)).toBe(true);
			for (const copy of [
				{ ...sample },
				Object.freeze({ ...sample }),
				structuredClone(sample),
				Object.create(sample),
			])
				expect(isBrokerDateSample(copy)).toBe(false);
			let hooks = 0;
			const valid = { header: sample.header, readId: READ_1, accountId: ACCOUNT_A, ...times };
			const refused: unknown[] = [
				{ ...valid, readId: "read-1" },
				{ ...valid, accountId: READ_1.toLowerCase() },
				{ ...valid, requestWall: 10.5 },
				{ ...valid, responseWall: -1 },
				{ ...valid, requestMono: Number.NaN },
				{ ...valid, responseMono: Number.POSITIVE_INFINITY },
				{ ...valid, responseMono: -1 },
				{ ...valid, dateMs: 0 },
				{ header: valid.header, readId: READ_1, accountId: ACCOUNT_A },
				Object.defineProperty({ ...valid }, "header", {
					enumerable: true,
					get: () => {
						hooks++;
						return valid.header;
					},
				}),
				new Proxy(valid, {
					get: () => {
						hooks++;
						return undefined;
					},
				}),
				null,
			];
			for (const input of refused)
				expect(() => observeBrokerDate(input as never)).toThrowError(
					expect.objectContaining({ name: "SchedulerError", code: "SCHEDULER_DATA" }),
				);
			expect(hooks).toBe(0);
		});

		it("binds a sample to its own read: same read id, requested after the read started", () => {
			const times = { requestWall: 100, requestMono: 50, responseWall: 150, responseMono: 100 };
			const own = observe(today, times, READ_1, ACCOUNT_A);
			const concurrent = observe(today, times, READ_2, ACCOUNT_B);
			expect(sampleOfRead(own, READ_1, 50)).toBe(true);
			expect(sampleOfRead(own, READ_1, 49.5)).toBe(true);
			expect(sampleOfRead(own, READ_1, 50.5)).toBe(false);
			expect(sampleOfRead(concurrent, READ_1, 50)).toBe(false);
			expect(sampleOfRead(undefined, READ_1, 50)).toBe(false);
			// A read start that is not a monotonic reading binds nothing and is never coerced.
			let hooks = 0;
			const coerced = {
				valueOf: () => {
					hooks++;
					return 0;
				},
			};
			for (const started of [Number.NaN, -1, Number.NEGATIVE_INFINITY, "50", coerced])
				expect(sampleOfRead(own, READ_1, started as number)).toBe(false);
			expect(hooks).toBe(0);
			const now = { wall: 200, mono: 150 };
			expect(secondClock(own, now, ACCOUNT_A)).toBeDefined();
			expect(secondClock(own, now, ACCOUNT_B)).toBeUndefined();
			expect(secondClock(concurrent, now, ACCOUNT_A)).toBeUndefined();
			// Look-alikes carry every field, frozen or not, but the broker never minted them.
			for (const copy of [{ ...own }, Object.freeze({ ...own })]) {
				expect(sampleOfRead(copy, READ_1, 50)).toBe(false);
				expect(secondClock(copy, now, ACCOUNT_A)).toBeUndefined();
			}
		});

		it("refuses a sample whose read is stale, out of order or disagrees with the wall clock", () => {
			const dateMs = Date.UTC(2026, 9, 17, 10);
			const sample = (
				requestMono: number,
				responseMono: number,
				requestWall = 0,
				responseWall = 0,
			) => observe(dateMs, { requestWall, requestMono, responseWall, responseMono });
			const ok = sample(0, 1_000, 0, 1_000);
			expect(secondClock(ok, { wall: 11_000, mono: 11_000 }, ACCOUNT_A)).toEqual({
				low: dateMs + 10_000,
				high: dateMs + 12_000,
			});
			// Hub clocks that disagree within 5 s: low takes the smaller elapsed time, high the larger.
			for (const now of [
				{ wall: 6_000, mono: 9_000 },
				{ wall: 9_000, mono: 6_000 },
			]) {
				const bounds = secondClock(ok, now, ACCOUNT_A);
				expect(bounds).toEqual({ low: dateMs + 5_000, high: dateMs + 10_000 });
				expect(Object.isFrozen(bounds)).toBe(true);
			}
			const cases: [string, ReturnType<typeof sample>, ClockReading, boolean][] = [
				["age 10,001", ok, { wall: 11_001, mono: 11_001 }, false],
				["response after now", ok, { wall: 999, mono: 999 }, false],
				[
					"response before request",
					sample(1_000, 0, 0, 1_000),
					{ wall: 1_000, mono: 1_000 },
					false,
				],
				["read 10,000", sample(0, 10_000, 0, 10_000), { wall: 10_000, mono: 10_000 }, true],
				["read 10,001", sample(0, 10_001, 0, 10_001), { wall: 10_001, mono: 10_001 }, false],
				[
					"read 10,000.25",
					sample(0.5, 10_000.75, 0, 10_000),
					{ wall: 10_000, mono: 10_000.75 },
					false,
				],
				["read wall +5,000", sample(0, 1_000, 0, 6_000), { wall: 6_000, mono: 1_000 }, true],
				["read wall +5,001", sample(0, 1_000, 0, 6_001), { wall: 6_001, mono: 1_000 }, false],
				["read wall -5,001", sample(0, 10_000, 0, 4_999), { wall: 4_999, mono: 10_000 }, false],
				["since wall +5,000", ok, { wall: 7_000, mono: 2_000 }, true],
				["since wall +5,001", ok, { wall: 7_001, mono: 2_000 }, false],
				["since wall -5,001", ok, { wall: 1_000, mono: 6_001 }, false],
				["fractional wall", ok, { wall: 2_000.5, mono: 2_000 }, false],
				["negative mono", ok, { wall: 2_000, mono: -1 }, false],
				["NaN wall", ok, { wall: Number.NaN, mono: 2_000 }, false],
			];
			for (const [name, value, now, usable] of cases)
				expect(secondClock(value, now, ACCOUNT_A) !== undefined, name).toBe(usable);
			let hooks = 0;
			const coerced = {
				valueOf: () => {
					hooks++;
					return 2_000;
				},
			};
			for (const now of [
				{ wall: 2_000, mono: 2_000, extra: 1 },
				{ wall: 2_000, mono: "2000" },
				{ wall: 2_000, mono: coerced },
				Object.defineProperty({ mono: 2_000 }, "wall", { enumerable: true, get: () => 2_000 }),
				new Proxy({ wall: 2_000, mono: 2_000 }, {}),
				null,
			])
				expect(secondClock(ok, now as never, ACCOUNT_A)).toBeUndefined();
			expect(hooks).toBe(0);
		});

		it("parses provider watermarks as integer microseconds without float rounding", () => {
			const table: [kind: "email" | "chat", text: unknown, micros: number | undefined][] = [
				["email", "1729584000000", 1_729_584_000_000_000],
				["email", "1729584000001", 1_729_584_000_001_000],
				["email", "0", 0],
				["email", "9007199254740", 9_007_199_254_740_000],
				["email", "9007199254741", undefined],
				["email", "9999999999999", undefined],
				["email", "01729584000000", undefined],
				["email", "17295840000001", undefined],
				["email", "1729584000.000001", undefined],
				["email", "-1", undefined],
				["email", "+1", undefined],
				["email", "1e12", undefined],
				["email", " 1", undefined],
				["email", "", undefined],
				["chat", "1729584000.000001", 1_729_584_000_000_001],
				["chat", "1729584000.000002", 1_729_584_000_000_002],
				["chat", "1729584000.999999", 1_729_584_000_999_999],
				["chat", "0.000000", 0],
				["chat", "8999999999.999999", 8_999_999_999_999_999],
				["chat", "8999999999.999998", 8_999_999_999_999_998],
				["chat", "9007199254.740991", 9_007_199_254_740_991],
				["chat", "9007199254.740992", undefined],
				["chat", "9999999999.999999", undefined],
				["chat", "1729584000.00001", undefined],
				["chat", "1729584000.0000001", undefined],
				["chat", "01729584000.000001", undefined],
				["chat", "1729584000", undefined],
				["chat", "1729584000000", undefined],
				["chat", "17295840000.000001", undefined],
				["chat", "-1.000000", undefined],
				["chat", "1729584000.000001 ", undefined],
				["chat", 1_729_584_000.5, undefined],
				["email", 1_729_584_000_000, undefined],
				["email", null, undefined],
				["chat", new String("1729584000.000001"), undefined],
				["sms" as "chat", "1729584000.000001", undefined],
				["sms" as "chat", "1729584000000", undefined],
			];
			for (const [kind, text, micros] of table)
				expect(watermarkMicros(kind, text), `${kind} ${String(text)}`).toBe(micros);
			// Number() reads these two as one double.
			expect(Number("8999999999.999999")).toBe(Number("8999999999.999998"));
		});

		it("decides pre-claim checks in plan order", () => {
			const window = { notBefore: today + MINUTE, deliverBy: today + MINUTE + 900_000 };
			const now = window.notBefore + 5_000;
			const input = base(window, now);
			const verdict = (patch: Partial<PreclaimInput>): PreclaimVerdict =>
				decidePreclaim({ ...input, ...patch });
			const readHold = { kind: "hold", hold: "read", scope: "item", retryInMs: 15_000 };
			const clockHold = { kind: "hold", hold: "clock", scope: "account", retryInMs: 15_000 };
			const accountHold = { kind: "hold", hold: "account", scope: "item", retryInMs: 15_000 };
			const readOnly = { kind: "cancel", reason: "read_only" };
			const incomplete = { complete: false, facts: "unknown", newestInbound: null } as const;
			expect(verdict({})).toEqual({ kind: "claim", early: now, late: now + 1_000 });
			expect(
				verdict({ window: { notBefore: 2, deliverBy: 1 }, accountMode: "unavailable" }),
			).toEqual({ kind: "refuse", code: "window" });
			expect(verdict({ window: { notBefore: 2, deliverBy: 1 }, accountMode: "read_only" })).toEqual(
				{ kind: "refuse", code: "window" },
			);
			// A read_only account ends the item for good, whatever the read and the clocks say, so a
			// switch back to full never claims on the approval given before the switch.
			expect(verdict({ accountMode: "read_only", observation: undefined })).toEqual(readOnly);
			expect(verdict({ accountMode: "read_only", immediate: true })).toEqual(readOnly);
			expect(
				verdict({ accountMode: "read_only", second: { low: now, high: window.deliverBy + 1 } }),
			).toEqual(readOnly);
			expect(verdict({ accountMode: "unavailable", immediate: true })).toEqual(accountHold);
			expect(verdict({ accountMode: "unavailable", observation: undefined })).toEqual(accountHold);
			expect(verdict({ accountMode: "FULL" as "full" })).toEqual(accountHold);
			expect(verdict({ observation: undefined, sampleUsable: false })).toEqual(readHold);
			expect(
				verdict({
					observation: { complete: false, facts: "changed", newestInbound: 1_729_584_000_000_001 },
				}),
			).toEqual({ kind: "void", reason: "channel_changed" });
			expect(
				verdict({
					observation: { ...incomplete, newestInbound: 1_729_584_000_000_001 },
					sampleUsable: false,
				}),
			).toEqual({ kind: "void", reason: "new_reply" });
			expect(verdict({ observation: incomplete, sampleUsable: false })).toEqual(readHold);
			expect(
				verdict({ observation: { complete: true, facts: "unknown", newestInbound: null } }),
			).toEqual(readHold);
			expect(
				verdict({ observation: { complete: false, facts: "unchanged", newestInbound: null } }),
			).toEqual(readHold);
			expect(verdict({ sampleUsable: false, second: { low: 0, high: 1 } })).toEqual(clockHold);
			expect(verdict({ second: undefined })).toEqual(clockHold);
			expect(verdict({ second: { low: now - 120_001, high: now - 120_001 } })).toEqual({
				kind: "hold",
				hold: "skew",
				scope: "account",
				retryInMs: 15_000,
			});
			expect(verdict({ second: { low: now, high: window.deliverBy + 1 } })).toEqual({
				kind: "void",
				reason: "missed",
			});
			expect(verdict({ second: { low: window.notBefore - 2_500, high: now } })).toEqual({
				kind: "hold",
				hold: "early",
				scope: "item",
				retryInMs: 2_500,
			});
			// An immediate first claim reads nothing and runs on the hub clock alone.
			const immediate = {
				immediate: true,
				observation: undefined,
				sampleUsable: false,
				second: undefined,
			};
			expect(verdict(immediate)).toEqual({ kind: "claim", early: now, late: now });
			expect(verdict({ ...immediate, hubNow: window.notBefore - 400 })).toEqual({
				kind: "hold",
				hold: "early",
				scope: "item",
				retryInMs: 1_000,
			});
			expect(verdict({ ...immediate, hubNow: window.deliverBy + 1 })).toEqual({
				kind: "void",
				reason: "missed",
			});
			// Every verdict is frozen, including the shared refusal and void verdicts.
			const patches: Partial<PreclaimInput>[] = [
				{},
				{ window: { notBefore: 2, deliverBy: 1 } },
				{ accountMode: "unavailable" },
				{ accountMode: "read_only" },
				{ observation: { complete: true, facts: "changed", newestInbound: null } },
				{
					observation: { complete: true, facts: "unchanged", newestInbound: 1_729_584_000_000_001 },
				},
				{ second: { low: now, high: window.deliverBy + 1 } },
			];
			expect(patches.map((patch) => verdict(patch).kind)).toEqual([
				"claim",
				"refuse",
				"hold",
				"cancel",
				"void",
				"void",
				"void",
			]);
			for (const patch of patches) expect(Object.isFrozen(verdict(patch))).toBe(true);
		});

		it("voids for a new reply only past the stored watermark, in each provider's units", () => {
			const window = { notBefore: today + MINUTE, deliverBy: today + MINUTE + 900_000 };
			const now = window.notBefore + 5_000;
			const reply = (
				kind: "email" | "chat",
				stored: number | null,
				observed: string | null,
				holdIfNewInbound = true,
				complete = true,
			) => {
				const newestInbound = observed === null ? null : watermarkMicros(kind, observed);
				return decidePreclaim({
					...base(window, now),
					watermark: stored,
					holdIfNewInbound,
					// A malformed observed value is a failed read.
					observation:
						newestInbound === undefined
							? undefined
							: { complete, facts: "unchanged", newestInbound },
				}).kind;
			};
			expect(reply("email", 1_729_584_000_000_000, "1729584000001")).toBe("void");
			expect(reply("email", 1_729_584_000_000_000, "1729584000000")).toBe("claim");
			expect(reply("chat", 1_729_584_000_000_001, "1729584000.000002")).toBe("void");
			expect(reply("chat", 1_729_584_000_000_001, "1729584000.000001")).toBe("claim");
			expect(reply("chat", null, "1729584000.000001")).toBe("void");
			// With no stored watermark every inbound reply is new, even one at the epoch.
			expect(reply("chat", null, "0.000000")).toBe("void");
			expect(reply("email", null, "0")).toBe("void");
			expect(reply("email", null, null)).toBe("claim");
			expect(reply("email", 1_729_584_000_000_000, "1729584000001", false)).toBe("claim");
			expect(reply("email", 1_729_584_000_000_000, "1729584000001", true, false)).toBe("void");
			expect(reply("email", 1_729_584_000_000_000, "1729584000.000001")).toBe("hold");
		});

		it("refuses malformed pre-claim input instead of deciding on it", () => {
			const window = { notBefore: today, deliverBy: today + 900_000 };
			const input = base(window, today + 1_000);
			let hooks = 0;
			const refused: unknown[] = [
				{ ...input, immediate: "false" },
				{ ...input, sampleUsable: 1 },
				{ ...input, holdIfNewInbound: undefined },
				{ ...input, watermark: 1.5 },
				{ ...input, watermark: -1 },
				{ ...input, watermark: "1729584000000000" },
				{ ...input, observation: { complete: true, facts: "same", newestInbound: null } },
				{ ...input, observation: { complete: "yes", facts: "unchanged", newestInbound: null } },
				{ ...input, observation: { complete: true, facts: "unchanged", newestInbound: 0.5 } },
				{ ...input, observation: { complete: true, facts: "unchanged" } },
				{
					...input,
					observation: { complete: true, facts: "unchanged", newestInbound: null, extra: 1 },
				},
				{ ...input, observation: null },
				{ ...input, second: { low: "1", high: 2 } },
				{ ...input, second: { low: 1, high: "2" } },
				{ ...input, second: { low: 1 } },
				{ ...input, second: { low: 1, high: 2, extra: 3 } },
				{
					...input,
					second: Object.defineProperty({ low: 1 }, "high", {
						enumerable: true,
						get: () => {
							hooks++;
							return 2;
						},
					}),
				},
				{
					...input,
					second: new Proxy(
						{ low: 1, high: 2 },
						{
							get: () => {
								hooks++;
								return 2;
							},
						},
					),
				},
				{ ...input, extra: true },
				(({ watermark: _, ...rest }) => rest)(input),
				Object.defineProperty({ ...input }, "hubNow", {
					enumerable: true,
					get: () => {
						hooks++;
						return today;
					},
				}),
				new Proxy(input, {
					ownKeys: () => {
						hooks++;
						return [];
					},
				}),
			];
			for (const value of refused)
				expect(() => decidePreclaim(value as PreclaimInput)).toThrowError(
					expect.objectContaining({ code: "INVALID_INPUT", message: "INVALID_INPUT" }),
				);
			expect(hooks).toBe(0);
		});

		it("never lets an observation turn a hold or void into a claim, or move early and late", () => {
			const inputArb = fc
				.tuple(
					pointArb,
					errorArb,
					fc.boolean(),
					fc.boolean(),
					fc.constantFrom("full", "read_only", "unavailable"),
					fc.constantFrom("unchanged", "changed", "unknown"),
					fc.boolean(),
					fc.option(fc.integer({ min: 0, max: 2_000_000 }), { nil: null }),
					fc.option(fc.integer({ min: 0, max: 2_000_000 }), { nil: null }),
					fc.boolean(),
				)
				.map(
					([
						[window, hubNow],
						error,
						immediate,
						sampleUsable,
						accountMode,
						facts,
						complete,
						newestInbound,
						watermark,
						holdIfNewInbound,
					]): PreclaimInput => ({
						window,
						hubNow,
						immediate,
						second: { low: hubNow + error, high: hubNow + error + 1_000 },
						sampleUsable,
						accountMode,
						observation: { complete, facts, newestInbound },
						holdIfNewInbound,
						watermark,
					}),
				);
			holds(
				fc.property(inputArb, (input) => {
					const before = decidePreclaim(input);
					// Only read_only cancels, whatever the read and the clocks say.
					if ((before.kind === "cancel") !== (input.accountMode === "read_only")) return false;
					const observation = input.observation ?? {
						complete: true,
						facts: "unchanged",
						newestInbound: null,
					};
					const newer = Math.max(observation.newestInbound ?? 0, input.watermark ?? 0) + 1;
					const variants: PreclaimInput[] = [
						{ ...input, observation: { ...observation, facts: "changed" } },
						{ ...input, observation: { ...observation, newestInbound: newer } },
						{ ...input, observation: { ...observation, complete: false } },
						{ ...input, observation: undefined },
					];
					const clocks = checkClaimWindow(
						input.window,
						input.hubNow,
						input.immediate ? input.hubNow : input.second,
					);
					return variants.every((variant) => {
						const after = decidePreclaim(variant);
						if (after.kind !== "claim") return true;
						return (
							before.kind === "claim" &&
							after.early === before.early &&
							after.late === before.late &&
							clocks.ok &&
							clocks.early === after.early &&
							clocks.late === after.late
						);
					});
				}),
			);
		});

		it("marks a divergence only when wall and monotonic elapsed differ by over 5,000 ms", () => {
			const before = { wall: today, mono: 100.5 };
			const after = (wall: number, mono: number) => ({ wall: today + wall, mono: 100.5 + mono });
			expect(diverged(before, after(20_000, 15_000))).toBe(false);
			expect(diverged(before, after(20_001, 15_000))).toBe(true);
			expect(diverged(before, after(10_000, 15_000))).toBe(false);
			expect(diverged(before, after(9_999, 15_000))).toBe(true);
			expect(diverged(before, after(-86_400_000, 15_000))).toBe(true);
			expect(diverged(before, after(15_000, 15_000.25))).toBe(false);
			expect(diverged(before, after(Number.NaN, 15_000))).toBe(true);
		});

		it("ticks through rows 2^31-2, 2^31-1, 2^31 ms and 30 days ahead, eligible exactly at notBefore", () => {
			const aheads = [2 ** 31 - 2, 2 ** 31 - 1, 2 ** 31, 30 * DAY];
			const rowAt = (ahead: number, index: number): PlanRow => ({
				id: ulidFor(index),
				accountId: ACCOUNT_A,
				kind: "email",
				pacingKey: ACCOUNT_A,
				state: "SCHEDULED",
				notBefore: today + ahead,
				deliverBy: today + ahead + 900_000,
			});
			for (const [index, ahead] of aheads.entries()) {
				const rows = [rowAt(ahead, index)];
				let now: ClockReading = { wall: today, mono: 5_000.5 };
				let ticks = 0;
				let longest = 0;
				for (;;) {
					const plan = planTick(rows, noHolds, now);
					if (plan.eligible.length > 0) break;
					const wait = checkWait(plan.waitMs);
					longest = Math.max(longest, wait);
					now = { wall: now.wall + wait, mono: now.mono + wait };
					ticks++;
				}
				expect(now.wall).toBe(today + ahead);
				expect(ticks).toBe(Math.ceil(ahead / 15_000));
				expect(longest).toBe(15_000);
			}
			// All four together: each still becomes eligible exactly at its own notBefore.
			let rows = aheads.map(rowAt);
			let now: ClockReading = { wall: today, mono: 5_000.5 };
			const eligibleAt: number[] = [];
			while (rows.length > 0) {
				const plan = planTick(rows, noHolds, now);
				for (const row of plan.eligible) eligibleAt.push(now.wall - row.notBefore);
				rows = rows.filter((row) => !plan.eligible.includes(row));
				const wait = checkWait(planTick(rows, noHolds, now).waitMs);
				now = { wall: now.wall + wait, mono: now.mono + wait };
			}
			expect(eligibleAt).toEqual([0, 0, 0, 0]);
		});

		it("orders eligible rows immediate first, then notBefore, then id, and waits 0 while any is", () => {
			const now = { wall: today + DAY, mono: 1_000 };
			const row = (id: number, state: PlanRow["state"], notBefore: number): PlanRow => ({
				id: ulidFor(id),
				accountId: ACCOUNT_A,
				kind: "chat",
				pacingKey: `${ACCOUNT_A}:C1`,
				state,
				notBefore,
				deliverBy: today + 2 * DAY,
			});
			const rows = [
				row(5, "SCHEDULED", today + 10),
				row(4, "RETRY_WAIT", today + 5),
				row(3, "APPROVED", today + 20),
				row(2, "SCHEDULED", today + 10),
				row(1, "APPROVED", today + 30),
				row(0, "SCHEDULED", today + DAY + 1),
			];
			const plan = planTick(rows, noHolds, now);
			expect(plan.eligible.map((entry) => entry.id)).toEqual(
				[3, 1, 4, 2, 5].map((id) => ulidFor(id)),
			);
			expect(plan.waitMs).toBe(0);
			expect(Object.isFrozen(plan) && Object.isFrozen(plan.eligible)).toBe(true);
			expect(planTick([row(0, "SCHEDULED", today + DAY + 1)], noHolds, now).waitMs).toBe(1);
			expect(planTick([], noHolds, now)).toEqual({ eligible: [], waitMs: 15_000 });
		});

		it("waits for item, account and pacing holds on the monotonic clock only", () => {
			const row: PlanRow = {
				id: OUTBOX_1,
				accountId: ACCOUNT_A,
				kind: "email",
				pacingKey: ACCOUNT_A,
				state: "APPROVED",
				notBefore: today,
				deliverBy: today + DAY,
			};
			const mono = 50_000.5;
			const clock = (item?: number, account?: number, pacing?: number): HoldClock => ({
				itemRetryMono: (id) => (id === row.id ? item : undefined),
				accountRetryMono: (id) => (id === row.accountId ? account : undefined),
				pacingReleaseMono: (key) => (key === row.pacingKey ? pacing : undefined),
			});
			const wait = (holds: HoldClock, wall = today + 1_000) =>
				rowWaitMs(row, holds, { wall, mono });
			expect(wait(noHolds)).toBe(0);
			expect(wait(clock(mono + 2_500))).toBe(2_500);
			expect(wait(clock(undefined, mono + 10_000))).toBe(10_000);
			expect(wait(clock(undefined, undefined, mono + 999.75))).toBe(1_000);
			expect(wait(clock(mono + 2_000, mono + 9_000, mono + 4_000))).toBe(9_000);
			expect(wait(clock(mono))).toBe(0);
			expect(wait(clock(mono - 1))).toBe(0);
			expect(wait(clock(mono + 30_000))).toBe(15_000);
			// A wall jump of a day either way neither shortens nor stretches a hold.
			expect(wait(clock(mono + 2_500), today + DAY - 1)).toBe(2_500);
			expect(wait(clock(mono + 2_500), today - DAY + 15_000)).toBe(15_000);
			expect(wait(clock(mono + 2_500), today - 1_000)).toBe(2_500);
			// An unreadable retry time never makes a row eligible.
			expect(wait(clock(Number.NaN))).toBe(15_000);
			expect(wait(clock("0" as unknown as number))).toBe(15_000);
		});

		it("never makes a row eligible past deliverBy or with a malformed window", () => {
			const now = { wall: today + 1_000, mono: 0 };
			const row = (notBefore: number, deliverBy: number): PlanRow => ({
				id: OUTBOX_1,
				accountId: ACCOUNT_A,
				kind: "email",
				pacingKey: ACCOUNT_A,
				state: "SCHEDULED",
				notBefore,
				deliverBy,
			});
			expect(rowWaitMs(row(today, today + 1_000), noHolds, now)).toBe(0);
			expect(rowWaitMs(row(today, today + 999), noHolds, now)).toBe(15_000);
			for (const [notBefore, deliverBy] of [
				[Number.NaN, today + DAY],
				[today, Number.NaN],
				[today + 0.5, today + DAY],
				[today, today + DAY + 0.5],
				[today, String(today + DAY)],
				[today + DAY, today],
				// Reversed but not yet past deliverBy: still a malformed window.
				[today + 2_000, today + 1_500],
				[-1, today + DAY],
			])
				expect(rowWaitMs(row(notBefore as number, deliverBy as number), noHolds, now)).toBe(15_000);
		});

		it("makes at most one pre-claim read per tick for a held item, never claiming early or late", () => {
			checkSchedulerSimulation(1_000);
		});
	});
}

// The scheduler around the claim on simulated true time t: the hub's wall clock and the
// upstream's clock each off by a fixed error, the hub's monotonic clock right. Each read takes
// `latency` ms, fails where `fails` says, and carries the upstream's Date header written halfway,
// decided at the response. Holds count on the monotonic clock in rowWaitMs; the sweep ends the
// item once the hub clock passes deliverBy.
function simulate(
	window: SendWindowMs,
	start: number,
	[hubError, upstreamError]: readonly [number, number],
	latency: number,
	fails: readonly boolean[],
): { readonly reads: number; readonly claimedAt?: number } {
	const spinning = 10 + (window.deliverBy - window.notBefore) / 1_000;
	const row: PlanRow = {
		id: OUTBOX_1,
		accountId: ACCOUNT_A,
		kind: "email",
		pacingKey: ACCOUNT_A,
		state: "SCHEDULED",
		...window,
	};
	let itemRetry: number | undefined;
	let accountRetry: number | undefined;
	const holdClock: HoldClock = {
		itemRetryMono: () => itemRetry,
		accountRetryMono: () => accountRetry,
		pacingReleaseMono: () => undefined,
	};
	let t = start - hubError;
	let reads = 0;
	for (;;) {
		const now = { wall: t + hubError, mono: t };
		if (now.wall > window.deliverBy || reads > spinning) return { reads };
		const wait = rowWaitMs(row, holdClock, now);
		if (wait > 0) {
			t += checkWait(wait);
			continue;
		}
		const readId = ulidFor(reads);
		const failed = fails[reads++] === true;
		const { sample, now: after } = readAt({
			requestTrue: t,
			latency,
			written: t + latency / 2,
			hubError,
			upstreamError,
			readId,
		});
		t += latency;
		const verdict = decidePreclaim({
			window,
			hubNow: after.wall,
			immediate: false,
			second: secondClock(sample, after, ACCOUNT_A),
			sampleUsable: sampleOfRead(sample, readId, now.mono),
			accountMode: "full",
			observation: failed ? undefined : { complete: true, facts: "unchanged", newestInbound: null },
			holdIfNewInbound: true,
			watermark: null,
		});
		if (verdict.kind === "claim") return { reads, claimedAt: t };
		if (verdict.kind !== "hold") return { reads };
		if (verdict.scope === "account") accountRetry = after.mono + verdict.retryInMs;
		else itemRetry = after.mono + verdict.retryInMs;
	}
}

/** The kept scheduler simulation, through the real tick selection, Date binding and decisions. */
export function checkSchedulerSimulation(runs: number): void {
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
				const { reads, claimedAt } = simulate(
					window,
					window.notBefore + startOffset,
					clocks,
					latency,
					fails,
				);
				const [hubError, upstreamError] = clocks;
				const apart = Math.abs(hubError - upstreamError);
				const ticks = Math.floor(lateness / 15_000);
				// Either right clock keeps the claim inside the window: no documented lag.
				if (
					claimedAt !== undefined &&
					(hubError === 0 || upstreamError === 0) &&
					!inside(window, claimedAt)
				)
					return false;
				if (reads > 4 + ticks) return false;
				if (apart > 121_000 + latency) return claimedAt === undefined && reads <= 1 + ticks;
				if (apart <= 120_000 - 1_000 - latency && !fails.includes(true) && startOffset < 0)
					return claimedAt !== undefined && reads <= 4 + 120_000 / 15_000;
				return true;
			},
		),
		runs,
	);
}
