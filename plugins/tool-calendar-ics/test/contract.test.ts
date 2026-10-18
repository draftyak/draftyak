import { type CalendarFreebusyResult, toolKindsV1 } from "@draftyak/protocol/tool-v1/kinds";
import { describe, expect, it } from "vitest";
import { freeBusy } from "../src/index.ts";
import { toResult } from "../src/result.ts";
import { event, expectCode, feed, window } from "./helpers.ts";

describe("merged calendar.freebusy contract", () => {
	it("emits exact UTC milliseconds directly accepted by the shared result schema", () => {
		const result: CalendarFreebusyResult = freeBusy(
			feed(event("UID:numeric-wire", "DTSTART:20260101T010000Z", "DURATION:PT1H")),
			window,
			"UTC",
		);
		expect(result).toEqual({
			busy: [{ start: window.start + 3_600_000, end: window.start + 7_200_000, status: "busy" }],
		});
		expect(toolKindsV1["calendar.freebusy"].result.parse(result)).toEqual(result);
	});

	it.each([
		{ start: -1, end: window.end },
		{ start: window.start + 0.5, end: window.end },
		{ start: window.start, end: Number.MAX_SAFE_INTEGER + 1 },
		{ start: window.start, end: 8_640_000_000_000_001 },
		{ ...window, unknown: "PRIVATE_ARGUMENT_CANARY" },
	])("refuses invalid or unknown window data through the shared argument boundary", (bounds) => {
		expectCode(() => freeBusy(feed(), bounds, "UTC"), "INVALID_INPUT");
	});

	it.each(["UTC\n", "+01:00", "x".repeat(65)])(
		"refuses malformed owner timezone data conservatively",
		(zone) => {
			expect(() => freeBusy(feed(), window, zone)).toThrow();
		},
	);

	it("refuses a negative output instant rather than publishing an incompatible result", () => {
		expectCode(() => toResult([{ start: -1, end: 1, status: "busy" }]), "TOO_MANY_EVENTS");
	});
});
