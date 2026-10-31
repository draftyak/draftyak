import { describe, expect, it } from "vitest";
import { decidePreclaim, secondClock } from "../../src/outbox/scheduler-rules.ts";
import { ACCOUNT_A, observe } from "./scheduler-fixture.ts";

const REQUEST = Date.UTC(2026, 9, 17, 10);

describe("scheduler per-interval second clock", () => {
	it.each([
		{
			name: "read suspend followed by a backward wall correction",
			readWall: 8_000,
			readMono: 3_100,
			sinceWall: -2_900,
			sinceMono: 2_000,
			deliverBy: 6_100,
		},
		{
			name: "backward wall correction followed by a monotonic pause",
			readWall: 3_100,
			readMono: 8_000,
			sinceWall: 2_000,
			sinceMono: 0,
			deliverBy: 9_000,
		},
	])(
		"refuses a late claim after $name",
		({ readWall, readMono, sinceWall, sinceMono, deliverBy }) => {
			const sample = observe(REQUEST, {
				requestWall: REQUEST,
				requestMono: 5_000,
				responseWall: REQUEST + readWall,
				responseMono: 5_000 + readMono,
			});
			const now = { wall: REQUEST + readWall + sinceWall, mono: 5_000 + readMono + sinceMono };
			const second = secondClock(sample, now, ACCOUNT_A);
			const upstreamNow = REQUEST + 10_000;
			expect(upstreamNow).toBeGreaterThan(REQUEST + deliverBy);
			expect(
				decidePreclaim({
					window: { notBefore: REQUEST - 5_000, deliverBy: REQUEST + deliverBy },
					hubNow: now.wall,
					immediate: false,
					second,
					sampleUsable: true,
					accountMode: "full",
					observation: { complete: true, facts: "unchanged", newestInbound: null },
					holdIfNewInbound: false,
					watermark: null,
				}),
			).toEqual({ kind: "void", reason: "missed" });
			expect(second).toEqual({
				low: REQUEST + Math.min(sinceWall, sinceMono),
				high: REQUEST + 11_000,
			});
			expect(second?.low).toBeLessThanOrEqual(upstreamNow);
			expect(second?.high).toBeGreaterThan(upstreamNow);
		},
	);

	it("bounds elapsed time when the counting clock changes at the response", () => {
		for (const readLoss of [1, 2_000, 4_999, 5_000]) {
			for (const afterLoss of [1, 2_000, 4_999, 5_000]) {
				const sample = observe(REQUEST, {
					requestWall: REQUEST,
					requestMono: 5_000,
					responseWall: REQUEST + 8_000,
					responseMono: 13_000 - readLoss,
				});
				const second = secondClock(
					sample,
					{
						wall: REQUEST + 10_000 - afterLoss,
						mono: 15_000 - readLoss,
					},
					ACCOUNT_A,
				);
				expect(second?.low).toBeLessThanOrEqual(REQUEST + 10_000);
				expect(second?.high).toBeGreaterThan(REQUEST + 10_000);
			}
		}
	});
});
