import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type {
	renderingCases,
	resolutionCases,
	scheduledSnapshotCases,
} from "../scripts/vectors/schedule.ts";
import { canonicalize } from "../src/jcs.ts";
import { MAX_SCHEDULE_UTC_MS, renderLocalWallTime, resolveLocalTime } from "../src/schedule.ts";
import { contentHash, fingerprint, Schedule, SendSnapshotV1, sendWindow } from "../src/snapshot.ts";

const document = JSON.parse(
	readFileSync(new URL("../../../spec/vectors/schedule/dst.json", import.meta.url), "utf8"),
) as {
	resolutionCases: ReturnType<typeof resolutionCases>;
	renderingCases: ReturnType<typeof renderingCases>;
	snapshots: ReturnType<typeof scheduledSnapshotCases>;
};
describe("strict schedule resolution and frozen minute display", () => {
	it("reaches schedule helpers through the declared package subpath", async () => {
		const schedule = await import("@draftyak/protocol/schedule");
		expect(schedule.resolveLocalTime).toBe(resolveLocalTime);
		expect(schedule.renderLocalWallTime).toBe(renderLocalWallTime);
	});
	for (const entry of document.resolutionCases) {
		it(`resolves/refuses ${entry.id}`, () => {
			if (entry.error)
				expect(() => resolveLocalTime(entry.wall, entry.zone)).toThrowError(
					expect.objectContaining({ code: entry.error, message: entry.error }),
				);
			else {
				expect(resolveLocalTime(entry.wall, entry.zone)).toBe(entry.notBefore);
				if (entry.notBefore === undefined) throw new Error("Missing fixture instant");
				expect(renderLocalWallTime(entry.notBefore, entry.zone)).toBe(entry.localWallTime);
			}
		});
	}
	for (const entry of document.renderingCases) {
		it(`renders/refuses ${entry.id}`, () => {
			if (entry.error)
				expect(() => renderLocalWallTime(entry.notBefore, entry.zone)).toThrowError(
					expect.objectContaining({ code: entry.error, message: entry.error }),
				);
			else expect(renderLocalWallTime(entry.notBefore, entry.zone)).toBe(entry.localWallTime);
		});
	}
	for (const entry of document.snapshots) {
		it(`binds thirty-day instant, display and lateness: ${entry.id}`, () => {
			const snapshot = SendSnapshotV1.parse(entry.snapshot);
			if (snapshot.schedule.kind !== "at") throw new Error("Missing scheduled fixture");
			expect(snapshot.schedule.notBefore - entry.iat).toBe(30 * 86400_000);
			expect(renderLocalWallTime(snapshot.schedule.notBefore, snapshot.schedule.zone)).toBe(
				snapshot.schedule.localWallTime,
			);
			expect(contentHash(snapshot)).toBe(entry.contentHash);
			expect(fingerprint(snapshot)).toBe(entry.fingerprint);
			expect(Buffer.from(canonicalize(snapshot)).toString("hex")).toBe(entry.canonicalHex);
			expect(sendWindow(snapshot, entry.iat)).toEqual(entry.window);
		});
	}
	it("keeps exact millisecond instants separate from minute display and refuses above the shared bound", () => {
		expect(MAX_SCHEDULE_UTC_MS).toBe(253_402_207_200_999);
		expect(renderLocalWallTime(MAX_SCHEDULE_UTC_MS, "UTC")).toBe("9999-12-30T22:00+00:00");
		expect(() => renderLocalWallTime(MAX_SCHEDULE_UTC_MS + 1, "UTC")).toThrowError("INVALID_INPUT");
		expect(renderLocalWallTime(59_999, "UTC")).toBe("1970-01-01T00:00+00:00");
		expect(resolveLocalTime("1970-01-01T00:00", "UTC")).toBe(0);
	});
	it("does not narrow the existing frozen Schedule scalar domain", () => {
		expect(
			Schedule.safeParse({
				kind: "at",
				notBefore: MAX_SCHEDULE_UTC_MS + 1,
				zone: "UTC",
				localWallTime: "9999-12-30T22:00+00:00",
				latenessSec: 900,
				holdIfNewInbound: false,
			}).success,
		).toBe(true);
	});
	it("reports unavailable Temporal without parsing or leaking a vendor error", () => {
		vi.stubGlobal("Temporal", undefined);
		try {
			expect(() => resolveLocalTime("2026-01-01T09:00", "UTC")).toThrowError(
				"SCHEDULING_UNAVAILABLE",
			);
			expect(() => renderLocalWallTime(0, "UTC")).toThrowError("SCHEDULING_UNAVAILABLE");
		} finally {
			vi.unstubAllGlobals();
		}
	});
	it("refuses nonprimitive values, huge strings and strict grammar aliases without caller hooks", () => {
		let hooks = 0;
		const hostile = new Proxy(
			{},
			{
				get() {
					hooks++;
					throw new Error("CANARY_PRIVATE_INPUT");
				},
			},
		);
		const boxed = {
			toString() {
				hooks++;
				throw new Error("CANARY_PRIVATE_INPUT");
			},
		};
		for (const wall of [
			hostile,
			boxed,
			"2026-01-01 09:00",
			"2026-01-01T09:00\n",
			"2026-01-01T09:00[UTC]",
			"x".repeat(100000),
		])
			expect(() => resolveLocalTime(wall as string, "UTC")).toThrowError("INVALID_INPUT");
		for (const zone of [
			hostile,
			boxed,
			"/UTC",
			"UTC/",
			"UTC\n",
			"A".repeat(65),
			"CANARY_PRIVATE_ZONE",
		]) {
			expect(() => resolveLocalTime("2026-01-01T09:00", zone as string)).toThrowError(
				"INVALID_INPUT",
			);
			expect(() => renderLocalWallTime(0, zone as string)).toThrowError("INVALID_INPUT");
		}
		for (const instant of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, hostile, boxed])
			expect(() => renderLocalWallTime(instant as number, "UTC")).toThrowError("INVALID_INPUT");
		expect(hooks).toBe(0);
	});
});
