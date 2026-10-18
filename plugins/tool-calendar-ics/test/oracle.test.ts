import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { freeBusy } from "../src/index.ts";
import { event, expectCode, feed } from "./helpers.ts";

interface Oracle {
	readonly id: string;
	readonly start: string;
	readonly rule: string;
	readonly times: readonly string[];
	readonly unsupported?: boolean;
	readonly date?: boolean;
}
const cases = JSON.parse(
	readFileSync(new URL("./fixtures/recurrence-oracles.json", import.meta.url), "utf8"),
) as Oracle[];
it("loads forty-five independently specified sets, with four explicitly refused forms", () => {
	expect(cases).toHaveLength(45);
	expect(cases.filter((item) => item.unsupported)).toHaveLength(4);
});
it.each(cases)(
	"matches or explicitly refuses independent $id golden",
	({ start, rule, times, unsupported, date }) => {
		const first = times[0],
			last = times.at(-1);
		if (!first || !last) throw new Error("empty oracle");
		const durationMs = date ? 86_400_000 : 1000;
		const read = () =>
			freeBusy(
				feed(
					event(
						"UID:oracle",
						`${date ? "DTSTART;VALUE=DATE" : "DTSTART"}:${start}`,
						date ? "DURATION:P1D" : "DURATION:PT1S",
						`RRULE:${rule}`,
					),
				),
				{ start: Date.parse(first) - 1, end: Date.parse(last) + durationMs + 1 },
				"UTC",
			);
		if (unsupported) {
			expectCode(read, "INVALID_FEED");
			return;
		}
		expect(read()).toEqual({
			busy: times.map((time) => ({
				start: Date.parse(time),
				end: Date.parse(time) + durationMs,
				status: "busy",
			})),
		});
	},
);
