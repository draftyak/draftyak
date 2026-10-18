import { toolKindsV1 } from "@draftyak/protocol/tool-v1/kinds";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { freeBusy, mergeBusy } from "../src/index.ts";
import { canary, event, feed, privateFields, stamp, window } from "./helpers.ts";

describe("free/busy properties", () => {
	const interval = fc.record({
		minute: fc.integer({ min: -120, max: 7 * 24 * 60 + 120 }),
		duration: fc.integer({ min: 1, max: 180 }),
		tentative: fc.boolean(),
	});
	it("keeps outputs sorted, separated, bounded and content-free (100 runs)", () => {
		fc.assert(
			fc.property(fc.array(interval, { maxLength: 30 }), (items) => {
				const bytes = feed(
					...items.map((item, i) =>
						event(
							`UID:property-${i}`,
							`DTSTART:${stamp(window.start + item.minute * 60_000)}`,
							`DURATION:PT${item.duration}M`,
							`STATUS:${item.tentative ? "TENTATIVE" : "CONFIRMED"}`,
							...privateFields,
						),
					),
				);
				const result = freeBusy(bytes, window, "UTC");
				expect(toolKindsV1["calendar.freebusy"].result.parse(result)).toEqual(result);
				expect(result.busy.length).toBeLessThanOrEqual(200);
				let previousEnd = Number.NEGATIVE_INFINITY;
				for (const busy of result.busy) {
					const start = busy.start;
					const end = busy.end;
					expect(start).toBeGreaterThanOrEqual(window.start);
					expect(end).toBeLessThanOrEqual(window.end);
					expect(start).toBeLessThan(end);
					expect(start).toBeGreaterThan(previousEnd);
					previousEnd = end;
				}
				expect(JSON.stringify(result)).not.toContain(canary);
			}),
			{ numRuns: 100, seed: 7_109 },
		);
	});

	it("merge preserves union membership and promotes busy on contact (100 runs)", () => {
		fc.assert(
			fc.property(fc.array(interval, { maxLength: 30 }), (items) => {
				const source = items.map((item) => ({
					start: item.minute,
					end: item.minute + item.duration,
					status: item.tentative ? ("tentative" as const) : ("busy" as const),
				}));
				const merged = mergeBusy(source);
				expect(mergeBusy(merged)).toEqual(merged);
				for (const original of source) {
					const covering = merged.find(
						(item) => item.start <= original.start && item.end >= original.end,
					);
					expect(covering).toBeDefined();
					if (original.status === "busy") expect(covering?.status).toBe("busy");
				}
				for (let i = 1; i < merged.length; i++) {
					expect(merged[i]?.start).toBeGreaterThan(merged[i - 1]?.end ?? 0);
				}
			}),
			{ numRuns: 100, seed: 7_110 },
		);
	});
});
