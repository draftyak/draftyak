import { readFileSync } from "node:fs";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RenderingCase } from "../../scripts/vectors/schedule.ts";
import { MAX_SCHEDULE_UTC_MS, renderLocalWallTime } from "../../src/schedule.ts";
import { startXcheck, type Xcheck } from "./xcheck.ts";

const document = JSON.parse(
	readFileSync(new URL("../../../../spec/vectors/schedule/dst.json", import.meta.url), "utf8"),
) as {
	readonly metadata: {
		readonly rust: {
			readonly jiff: string;
			readonly jiffTzdb: string;
			readonly expectedTzdata: string;
		};
	};
	readonly renderingCases: readonly RenderingCase[];
};

describe("cross-language schedule rendering", () => {
	let checker: Xcheck;
	let metadata: {
		readonly tzdataVersion: string | null;
		readonly jiffVersion: string;
		readonly jiffTzdbVersion: string;
	};
	beforeAll(async () => {
		checker = await startXcheck();
		const answer = await checker.run("schedule", { notBefore: 0, zone: "UTC" });
		expect(answer.jiffVersion).toBe(document.metadata.rust.jiff);
		expect(answer.jiffTzdbVersion).toBe(document.metadata.rust.jiffTzdb);
		expect(answer.tzdataVersion === null || typeof answer.tzdataVersion === "string").toBe(true);
		if (typeof answer.tzdataVersion === "string")
			expect(answer.tzdataVersion.length).toBeGreaterThan(0);
		metadata = {
			tzdataVersion: answer.tzdataVersion as string | null,
			jiffVersion: document.metadata.rust.jiff,
			jiffTzdbVersion: document.metadata.rust.jiffTzdb,
		};
		expect(answer).toEqual({ localWallTime: "1970-01-01T00:00+00:00", ...metadata });
		if (
			metadata.tzdataVersion !== process.versions.tz ||
			metadata.tzdataVersion !== document.metadata.rust.expectedTzdata
		)
			console.warn("Schedule tzdata versions differ; rendering answers must still agree");
	});
	afterAll(async () => {
		await checker?.close();
	});

	it("matches all shared rendering/refusal vectors and both display comparisons", {
		tags: ["requires:cargo"],
	}, async () => {
		expect(document.renderingCases).toHaveLength(36);
		for (const vector of document.renderingCases) {
			const fields = { notBefore: vector.notBefore, zone: vector.zone };
			const answer = await checker.run("schedule", fields);
			if (vector.error) {
				expect(answer, vector.id).toEqual({ error: vector.error });
				expect(() => renderLocalWallTime(vector.notBefore, vector.zone), vector.id).toThrowError(
					vector.error,
				);
				continue;
			}
			if (vector.localWallTime === undefined || vector.mismatchedWallTime === undefined)
				throw new Error(`Missing schedule rendering fixture: ${vector.id}`);
			// A tzdata version difference never bypasses either the golden or actual TS comparison.
			expect(renderLocalWallTime(vector.notBefore, vector.zone), vector.id).toBe(
				vector.localWallTime,
			);
			expect(answer, vector.id).toEqual({ localWallTime: vector.localWallTime, ...metadata });
			expect(
				await checker.run("schedule", { ...fields, localWallTime: vector.localWallTime }),
				vector.id,
			).toEqual({ localWallTime: vector.localWallTime, matches: true, ...metadata });
			expect(
				await checker.run("schedule", { ...fields, localWallTime: vector.mismatchedWallTime }),
				vector.id,
			).toEqual({ localWallTime: vector.localWallTime, matches: false, ...metadata });
		}
	});

	it("compares bounded reproducible full-millisecond instants in the retained zones", {
		tags: ["requires:cargo"],
	}, async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.integer({ min: Date.UTC(2026, 0, 1), max: Date.UTC(2029, 0, 1) - 1 }),
				fc.constantFrom("UTC", "America/New_York", "Europe/London", "Australia/Lord_Howe"),
				async (notBefore, zone) => {
					const localWallTime = renderLocalWallTime(notBefore, zone);
					expect(await checker.run("schedule", { notBefore, zone, localWallTime })).toEqual({
						localWallTime,
						matches: true,
						...metadata,
					});
				},
			),
			{ seed: 180018, numRuns: 32 },
		);
	});

	it("refuses malformed request fields without ending the checker", {
		tags: ["requires:cargo"],
	}, async () => {
		const cases: readonly [Readonly<Record<string, unknown>>, string][] = [
			[{ zone: "UTC" }, "notBefore is a nonnegative integer"],
			[{ notBefore: -1, zone: "UTC" }, "notBefore is a nonnegative integer"],
			[{ notBefore: 0.5, zone: "UTC" }, "notBefore is a nonnegative integer"],
			[{ notBefore: "0", zone: "UTC" }, "notBefore is a nonnegative integer"],
			[{ notBefore: null, zone: "UTC" }, "notBefore is a nonnegative integer"],
			[{ notBefore: 0 }, "zone is a string"],
			[{ notBefore: 0, zone: false }, "zone is a string"],
			[{ notBefore: 0, zone: "UTC", localWallTime: null }, "localWallTime is a string"],
			[{ notBefore: 0, zone: "UTC", localWallTime: 0 }, "localWallTime is a string"],
		];
		for (const [fields, fault] of cases) {
			await expect(checker.run("schedule", fields)).rejects.toThrow(fault);
			expect(await checker.run("schedule", { notBefore: 0, zone: "UTC" })).toEqual({
				localWallTime: "1970-01-01T00:00+00:00",
				...metadata,
			});
		}
	});

	it("validates the instant and zone before comparing an incorrect display", {
		tags: ["requires:cargo"],
	}, async () => {
		for (const fields of [
			{ notBefore: MAX_SCHEDULE_UTC_MS + 1, zone: "UTC" },
			{ notBefore: Number.MAX_SAFE_INTEGER, zone: "UTC" },
			{ notBefore: 0, zone: "" },
			{ notBefore: 0, zone: "UTC\n" },
			{ notBefore: 0, zone: "A".repeat(65) },
			{ notBefore: 0, zone: "Invalid/Example" },
			{ notBefore: 0, zone: "Factory" },
			{ notBefore: 0, zone: "Africa/Monrovia" },
		]) {
			expect(await checker.run("schedule", { ...fields, localWallTime: "" })).toEqual({
				error: "INVALID_INPUT",
			});
		}
		expect(await checker.run("schedule", { notBefore: 0, zone: "UTC", localWallTime: "" })).toEqual(
			{
				localWallTime: "1970-01-01T00:00+00:00",
				matches: false,
				...metadata,
			},
		);
	});
});
