import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ResolutionCase } from "../../scripts/vectors/schedule.ts";
import { MAX_SCHEDULE_UTC_MS, renderLocalWallTime, resolveLocalTime } from "../../src/schedule.ts";
import { startXcheck, type Xcheck } from "./xcheck.ts";

interface PlainWall {
	toZonedDateTime(
		zone: string,
		options: { disambiguation: "earlier" | "later" | "compatible" | "reject" },
	): ZonedWall;
	equals(other: PlainWall): boolean;
}
interface ZonedWall {
	readonly epochMilliseconds: number;
	readonly offsetNanoseconds: number;
	toPlainDateTime(): PlainWall;
	getTimeZoneTransition(direction: "next"): ZonedWall | null;
	subtract(duration: { nanoseconds: number }): ZonedWall;
}
interface TemporalApi {
	readonly PlainDateTime: { from(text: string, options: { overflow: "reject" }): PlainWall };
	readonly Instant: {
		fromEpochMilliseconds(instant: number): { toZonedDateTimeISO(zone: string): ZonedWall };
	};
}
interface TransitionFact {
	readonly epochMs: number;
	readonly offsetBeforeSeconds: number;
	readonly offsetAfterSeconds: number;
}
interface Versions {
	readonly tzdataVersion: string | null;
	readonly jiffVersion: string;
	readonly jiffTzdbVersion: string;
}

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
	readonly resolutionCases: readonly ResolutionCase[];
};
const zones = ["UTC", "America/New_York", "Europe/London", "Australia/Lord_Howe"] as const;
const from = Date.UTC(2026, 0, 1);
const to = Date.UTC(2028, 0, 1);
const maximumWindow = 3 * 366 * 86_400_000;

function temporal(): TemporalApi {
	const api = Reflect.get(globalThis, "Temporal") as TemporalApi | undefined;
	if (api === undefined) throw new Error("Actual Temporal is required for schedule comparisons");
	return api;
}

// These are direct Temporal queries, not a separate timezone or resolution implementation.
function inverseFacts(wall: string, zone: string) {
	const plain = temporal().PlainDateTime.from(wall, { overflow: "reject" });
	const earlier = plain.toZonedDateTime(zone, { disambiguation: "earlier" });
	const later = plain.toZonedDateTime(zone, { disambiguation: "later" });
	const compatible = plain.toZonedDateTime(zone, { disambiguation: "compatible" });
	const kind =
		earlier.epochMilliseconds === later.epochMilliseconds
			? "unique"
			: plain.equals(earlier.toPlainDateTime())
				? "fold"
				: "gap";
	let reject: number | null = null;
	if (kind === "unique")
		reject = plain.toZonedDateTime(zone, { disambiguation: "reject" }).epochMilliseconds;
	else expect(() => plain.toZonedDateTime(zone, { disambiguation: "reject" })).toThrow(RangeError);
	return {
		kind,
		compatible: compatible.epochMilliseconds,
		earlier: earlier.epochMilliseconds,
		later: later.epochMilliseconds,
		reject,
	};
}

function transitionFacts(zone: string): TransitionFact[] {
	const result: TransitionFact[] = [];
	let current = temporal().Instant.fromEpochMilliseconds(from).toZonedDateTimeISO(zone);
	for (let next = current.getTimeZoneTransition("next"); next; ) {
		if (next.epochMilliseconds >= to) break;
		expect(next.epochMilliseconds).toBeGreaterThan(current.epochMilliseconds);
		expect(next.epochMilliseconds).toBeGreaterThan(from);
		const offsetBeforeSeconds = next.subtract({ nanoseconds: 1 }).offsetNanoseconds / 1e9;
		const offsetAfterSeconds = next.offsetNanoseconds / 1e9;
		expect(Number.isInteger(offsetBeforeSeconds)).toBe(true);
		expect(Number.isInteger(offsetAfterSeconds)).toBe(true);
		expect(offsetBeforeSeconds).not.toBe(offsetAfterSeconds);
		result.push({ epochMs: next.epochMilliseconds, offsetBeforeSeconds, offsetAfterSeconds });
		if (result.length > 32) throw new Error("Temporal transition result bound exceeded");
		current = next;
		next = current.getTimeZoneTransition("next");
	}
	return result;
}

describe("cross-language schedule inverse and transition facts", () => {
	let checker: Xcheck;
	let metadata: Versions;
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
			console.warn(
				"Schedule tzdata versions differ; inverse and transition facts must still agree",
			);
	});
	afterAll(async () => {
		await checker?.close();
	});

	it("compares all 49 inverse vectors, all disambiguations and strict scheduling refusals", {
		tags: ["requires:cargo"],
	}, async () => {
		expect(document.resolutionCases).toHaveLength(49);
		for (const vector of document.resolutionCases) {
			const answer = await checker.run("scheduleResolve", { wall: vector.wall, zone: vector.zone });
			if (vector.error === "INVALID_INPUT") {
				expect(answer, vector.id).toEqual({ error: "INVALID_INPUT" });
				expect(() => resolveLocalTime(vector.wall, vector.zone), vector.id).toThrowError(
					"INVALID_INPUT",
				);
				continue;
			}
			const facts = inverseFacts(vector.wall, vector.zone);
			expect(answer, vector.id).toEqual({ ...facts, ...metadata });
			for (const instant of [facts.compatible, facts.earlier, facts.later]) {
				expect(Number.isSafeInteger(instant), vector.id).toBe(true);
				expect(instant, vector.id).toBeGreaterThanOrEqual(0);
				expect(instant, vector.id).toBeLessThanOrEqual(MAX_SCHEDULE_UTC_MS);
				expect(() => renderLocalWallTime(instant, vector.zone), vector.id).not.toThrow();
			}
			if (vector.error) {
				expect(facts.kind, vector.id).toBe(
					vector.error === "NONEXISTENT_LOCAL_TIME" ? "gap" : "fold",
				);
				expect(facts.reject, vector.id).toBeNull();
				expect(facts.compatible, vector.id).toBe(
					facts.kind === "gap" ? facts.later : facts.earlier,
				);
				expect(() => resolveLocalTime(vector.wall, vector.zone), vector.id).toThrowError(
					vector.error,
				);
			} else {
				expect(facts.kind, vector.id).toBe("unique");
				expect(facts.reject, vector.id).toBe(vector.notBefore);
				expect(facts.earlier, vector.id).toBe(vector.notBefore);
				expect(facts.later, vector.id).toBe(vector.notBefore);
				expect(facts.compatible, vector.id).toBe(vector.notBefore);
				expect(resolveLocalTime(vector.wall, vector.zone), vector.id).toBe(vector.notBefore);
				expect(renderLocalWallTime(facts.earlier, vector.zone), vector.id).toBe(
					vector.localWallTime,
				);
			}
		}
	});

	it("refuses inverse grammar, selected-instant and zone domain violations with fixed answers", {
		tags: ["requires:cargo"],
	}, async () => {
		for (const [wall, zone] of [
			["1970-01-01T00:00", "Asia/Tokyo"],
			["1969-12-31T23:59", "UTC"],
			["9999-12-30T22:01", "UTC"],
			["0000-01-01T00:00", "UTC"],
			["2026-01-01 09:00", "UTC"],
			["2026-01-01T09:00\n", "UTC"],
			["2026-01-01T09:00[UTC]", "UTC"],
			["x".repeat(100_000), "UTC"],
			["2026-01-01T09:00", "A".repeat(100_000)],
			["2026-01-01T09:00", "UTC\n"],
			["2026-01-01T09:00", "Invalid/CANARY_PRIVATE_ZONE"],
			["1970-01-01T00:00", "Africa/Monrovia"],
		] as const)
			expect(await checker.run("scheduleResolve", { wall, zone })).toEqual({
				error: "INVALID_INPUT",
			});
		for (const [wall, zone] of [
			["1970-01-01T00:00", "UTC"],
			["1970-01-01T09:00", "Asia/Tokyo"],
			["1969-12-31T19:00", "America/New_York"],
		] as const) {
			const facts = inverseFacts(wall, zone);
			expect(facts).toEqual({ kind: "unique", compatible: 0, earlier: 0, later: 0, reject: 0 });
			expect(await checker.run("scheduleResolve", { wall, zone })).toEqual({
				...facts,
				...metadata,
			});
		}
	});

	it("matches actual Temporal transition instants and both offsets over the retained window", {
		tags: ["requires:cargo"],
	}, async () => {
		let transitions = 0;
		for (const zone of zones) {
			const expected = transitionFacts(zone);
			expect(expected, zone).toHaveLength(zone === "UTC" ? 0 : 4);
			expect(await checker.run("scheduleTransitions", { zone, from, to }), zone).toEqual({
				transitions: expected,
				...metadata,
			});
			expect(expected.length).toBeLessThanOrEqual(32);
			transitions += expected.length;
		}
		expect(transitions).toBe(12);
	});

	it("treats both exact transition endpoints as excluded without losing adjacent instants", {
		tags: ["requires:cargo"],
	}, async () => {
		for (const zone of zones)
			for (const transition of transitionFacts(zone)) {
				const at = transition.epochMs;
				for (const [lower, upper, expected] of [
					[at - 1, at + 1, [transition]],
					[at - 1, at, []],
					[at, at + 1, []],
				] as const)
					expect(
						await checker.run("scheduleTransitions", { zone, from: lower, to: upper }),
						`${zone}:${lower}:${upper}`,
					).toEqual({ transitions: expected, ...metadata });
			}
	});

	it("enforces transition duration, endpoint and zone bounds with fixed refusals", {
		tags: ["requires:cargo"],
	}, async () => {
		for (const fields of [
			{ zone: "UTC", from: 0, to: maximumWindow },
			{ zone: "UTC", from: MAX_SCHEDULE_UTC_MS - 1, to: MAX_SCHEDULE_UTC_MS },
		])
			expect(await checker.run("scheduleTransitions", fields)).toEqual({
				transitions: [],
				...metadata,
			});
		for (const fields of [
			{ zone: "UTC", from, to: from },
			{ zone: "UTC", from: to, to: from },
			{ zone: "UTC", from: 0, to: maximumWindow + 1 },
			{ zone: "UTC", from: 0, to: Number.MAX_SAFE_INTEGER },
			{ zone: "UTC", from: MAX_SCHEDULE_UTC_MS, to: MAX_SCHEDULE_UTC_MS + 1 },
			{ zone: "Factory", from, to },
			{ zone: "Etc/Unknown", from, to },
			{ zone: "+01:00", from, to },
			{ zone: "UTC\n", from, to },
			{ zone: "A".repeat(100_000), from, to },
			{ zone: "Invalid/CANARY_PRIVATE_ZONE", from, to },
			{ zone: "Africa/Monrovia", from: 0, to: 86_400_000 },
		])
			expect(await checker.run("scheduleTransitions", fields)).toEqual({ error: "INVALID_INPUT" });
	});

	it("keeps malformed fields separate from domain refusals and recovers after each fault", {
		tags: ["requires:cargo"],
	}, async () => {
		const cases: readonly [string, Readonly<Record<string, unknown>>, string][] = [
			["scheduleResolve", { zone: "UTC" }, "wall is a string"],
			["scheduleResolve", { wall: null, zone: "UTC" }, "wall is a string"],
			["scheduleResolve", { wall: "2026-01-01T00:00" }, "zone is a string"],
			["scheduleResolve", { wall: "2026-01-01T00:00", zone: false }, "zone is a string"],
			["scheduleTransitions", { zone: "UTC", to }, "from is a nonnegative integer"],
			["scheduleTransitions", { zone: "UTC", from: -1, to }, "from is a nonnegative integer"],
			["scheduleTransitions", { zone: "UTC", from: 0.5, to }, "from is a nonnegative integer"],
			["scheduleTransitions", { zone: "UTC", from: "0", to }, "from is a nonnegative integer"],
			["scheduleTransitions", { zone: "UTC", from }, "to is a nonnegative integer"],
			["scheduleTransitions", { zone: "UTC", from, to: null }, "to is a nonnegative integer"],
			["scheduleTransitions", { zone: "UTC", from, to: -1 }, "to is a nonnegative integer"],
			["scheduleTransitions", { from, to }, "zone is a string"],
			["scheduleTransitions", { zone: [], from, to }, "zone is a string"],
		];
		for (const [command, fields, fault] of cases) {
			await expect(checker.run(command, fields)).rejects.toThrow(fault);
			expect(await checker.run("scheduleTransitions", { zone: "UTC", from, to })).toEqual({
				transitions: [],
				...metadata,
			});
		}
	});
});
