import { canonicalize } from "../../src/jcs.ts";
import { renderLocalWallTime, resolveLocalTime, ScheduleError } from "../../src/schedule.ts";
import { contentHash, fingerprint, type SendSnapshotV1, sendWindow } from "../../src/snapshot.ts";
import type { VectorContext, VectorFile } from "../vectors.ts";
import { exampleSnapshot } from "./snapshot.ts";

export interface ResolutionCase {
	readonly id: string;
	readonly wall: string;
	readonly zone: string;
	readonly notBefore?: number;
	readonly localWallTime?: string;
	readonly error?: string;
}
export interface RenderingCase {
	readonly id: string;
	readonly notBefore: number;
	readonly zone: string;
	readonly localWallTime?: string;
	readonly mismatchedWallTime?: string;
	readonly error?: string;
}
export interface ScheduledSnapshotCase {
	readonly id: string;
	readonly snapshot: SendSnapshotV1;
	readonly iat: number;
	readonly contentHash: string;
	readonly fingerprint: string;
	readonly canonicalHex: string;
	readonly window: { readonly notBefore?: number; readonly deliverBy: number };
}
export function resolutionCases(): ResolutionCase[] {
	const cases: ResolutionCase[] = [];
	for (const [label, zone, gapDate, gapTimes, overlapDate, overlapTimes] of [
		[
			"new-york",
			"America/New_York",
			"2026-03-08",
			["02:00", "02:30", "02:59"],
			"2026-11-01",
			["01:00", "01:30", "01:59"],
		],
		[
			"london",
			"Europe/London",
			"2026-03-29",
			["01:00", "01:30", "01:59"],
			"2026-10-25",
			["01:00", "01:30", "01:59"],
		],
		[
			"lord-howe",
			"Australia/Lord_Howe",
			"2026-10-04",
			["02:00", "02:15", "02:29"],
			"2026-04-05",
			["01:30", "01:45", "01:59"],
		],
	] as const) {
		for (const time of gapTimes)
			cases.push({
				id: `${label}-gap-${time.replace(":", "")}`,
				wall: `${gapDate}T${time}`,
				zone,
				error: "NONEXISTENT_LOCAL_TIME",
			});
		for (const time of overlapTimes)
			cases.push({
				id: `${label}-overlap-${time.replace(":", "")}`,
				wall: `${overlapDate}T${time}`,
				zone,
				error: "AMBIGUOUS_LOCAL_TIME",
			});
	}
	// Expected UTC instants and offsets are explicit fixture facts, not resolver output.
	for (const [id, zone, wall, utc, offset] of [
		[
			"new-york-gap-before",
			"America/New_York",
			"2026-03-08T01:59",
			"2026-03-08T06:59:00Z",
			"-05:00",
		],
		[
			"new-york-gap-after",
			"America/New_York",
			"2026-03-08T03:00",
			"2026-03-08T07:00:00Z",
			"-04:00",
		],
		[
			"new-york-overlap-before",
			"America/New_York",
			"2026-11-01T00:59",
			"2026-11-01T04:59:00Z",
			"-04:00",
		],
		[
			"new-york-overlap-after",
			"America/New_York",
			"2026-11-01T02:00",
			"2026-11-01T07:00:00Z",
			"-05:00",
		],
		["london-gap-before", "Europe/London", "2026-03-29T00:59", "2026-03-29T00:59:00Z", "+00:00"],
		["london-gap-after", "Europe/London", "2026-03-29T02:00", "2026-03-29T01:00:00Z", "+01:00"],
		[
			"london-overlap-before",
			"Europe/London",
			"2026-10-25T00:59",
			"2026-10-24T23:59:00Z",
			"+01:00",
		],
		["london-overlap-after", "Europe/London", "2026-10-25T02:00", "2026-10-25T02:00:00Z", "+00:00"],
		[
			"lord-howe-gap-before",
			"Australia/Lord_Howe",
			"2026-10-04T01:59",
			"2026-10-03T15:29:00Z",
			"+10:30",
		],
		[
			"lord-howe-gap-after",
			"Australia/Lord_Howe",
			"2026-10-04T02:30",
			"2026-10-03T15:30:00Z",
			"+11:00",
		],
		[
			"lord-howe-overlap-before",
			"Australia/Lord_Howe",
			"2026-04-05T01:29",
			"2026-04-04T14:29:00Z",
			"+11:00",
		],
		[
			"lord-howe-overlap-after",
			"Australia/Lord_Howe",
			"2026-04-05T02:00",
			"2026-04-04T15:30:00Z",
			"+10:30",
		],
		["new-york-ordinary", "America/New_York", "2026-01-15T09:15", "2026-01-15T14:15:00Z", "-05:00"],
		["london-ordinary", "Europe/London", "2026-07-15T09:15", "2026-07-15T08:15:00Z", "+01:00"],
		[
			"lord-howe-ordinary",
			"Australia/Lord_Howe",
			"2026-07-15T09:15",
			"2026-07-14T22:45:00Z",
			"+10:30",
		],
		["leap-day", "UTC", "2028-02-29T00:00", "2028-02-29T00:00:00Z", "+00:00"],
		["upper-minute", "UTC", "9999-12-30T22:00", "9999-12-30T22:00:00Z", "+00:00"],
	] as const)
		cases.push({ id, zone, wall, notBefore: Date.parse(utc), localWallTime: `${wall}${offset}` });
	for (const [id, wall, zone] of [
		["invalid-day", "2026-02-29T12:00", "UTC"],
		["invalid-month", "2026-13-01T12:00", "UTC"],
		["hour-24", "2026-01-01T24:00", "UTC"],
		["seconds-not-input", "2026-01-01T12:00:00", "UTC"],
		["offset-not-input", "2026-01-01T12:00+00:00", "UTC"],
		["unknown-zone", "2026-01-01T12:00", "Invalid/Example"],
		["fixed-offset-not-zone", "2026-01-01T12:00", "+01:00"],
		["before-epoch", "1969-12-31T23:59", "UTC"],
		["unknown-sentinel", "2026-01-01T00:00", "Etc/Unknown"],
		["unknown-sentinel-lowercase", "2026-01-01T00:00", "etc/unknown"],
		["factory-placeholder", "2026-01-01T00:00", "Factory"],
		["factory-placeholder-lowercase", "2026-01-01T00:00", "factory"],
		["unrepresentable-offset", "1970-01-01T00:00", "Africa/Monrovia"],
		["above-upper-minute", "9999-12-30T22:01", "UTC"],
	] as const)
		cases.push({ id, wall, zone, error: "INVALID_INPUT" });
	return cases;
}
export function renderingCases(): RenderingCase[] {
	return [
		...resolutionCases()
			.filter((entry) => entry.notBefore !== undefined)
			.map((entry) => ({
				id: entry.id,
				notBefore: entry.notBefore as number,
				zone: entry.zone,
				localWallTime: entry.localWallTime,
				mismatchedWallTime: `${entry.localWallTime}CANARY_MISMATCH`,
			})),
		...(
			[
				[
					"new-york-fold-first",
					"2026-11-01T05:30:00Z",
					"America/New_York",
					"2026-11-01T01:30-04:00",
				],
				[
					"new-york-fold-second",
					"2026-11-01T06:30:00Z",
					"America/New_York",
					"2026-11-01T01:30-05:00",
				],
				["london-fold-first", "2026-10-25T00:30:00Z", "Europe/London", "2026-10-25T01:30+01:00"],
				["london-fold-second", "2026-10-25T01:30:00Z", "Europe/London", "2026-10-25T01:30+00:00"],
				[
					"lord-howe-fold-first",
					"2026-04-04T14:45:00Z",
					"Australia/Lord_Howe",
					"2026-04-05T01:45+11:00",
				],
				[
					"lord-howe-fold-second",
					"2026-04-04T15:15:00Z",
					"Australia/Lord_Howe",
					"2026-04-05T01:45+10:30",
				],
				[
					"upper-positive-zone",
					"9999-12-30T22:00:00.999Z",
					"Pacific/Kiritimati",
					"9999-12-31T12:00+14:00",
				],
				[
					"epoch-negative-zone",
					"1970-01-01T00:00:00Z",
					"America/New_York",
					"1969-12-31T19:00-05:00",
				],
			] as const
		).map(([id, utc, zone, localWallTime]) => ({
			id,
			notBefore: Date.parse(utc),
			zone,
			localWallTime,
			mismatchedWallTime: `${localWallTime}CANARY_MISMATCH`,
		})),
		...(["Etc/Unknown", "etc/unknown", "Factory", "factory"] as const).map((zone, index) => ({
			id: `placeholder-zone-${index}`,
			notBefore: 0,
			zone,
			error: "INVALID_INPUT",
		})),
		{
			id: "epoch",
			notBefore: 0,
			zone: "UTC",
			localWallTime: "1970-01-01T00:00+00:00",
			mismatchedWallTime: "1970-01-01T00:01+00:00",
		},
		{
			id: "minute-display-full-ms-instant",
			notBefore: 59_999,
			zone: "UTC",
			localWallTime: "1970-01-01T00:00+00:00",
			mismatchedWallTime: "1970-01-01T00:01+00:00",
		},
		{
			id: "upper-ms",
			notBefore: 253_402_207_200_999,
			zone: "UTC",
			localWallTime: "9999-12-30T22:00+00:00",
			mismatchedWallTime: "9999-12-30T22:01+00:00",
		},
		{ id: "above-upper-ms", notBefore: 253_402_207_201_000, zone: "UTC", error: "INVALID_INPUT" },
		{
			id: "above-temporal-range",
			notBefore: 9_007_199_254_740_991,
			zone: "UTC",
			error: "INVALID_INPUT",
		},
		{
			id: "historical-second-offset",
			notBefore: 0,
			zone: "Africa/Monrovia",
			error: "INVALID_INPUT",
		},
		{ id: "unknown-render-zone", notBefore: 0, zone: "Invalid/Example", error: "INVALID_INPUT" },
	];
}
export function scheduledSnapshotCases(): ScheduledSnapshotCase[] {
	const iat = Date.parse("2026-10-01T00:00:00Z");
	const notBefore = Date.parse("2026-10-31T00:00:00Z");
	const cases: ScheduledSnapshotCase[] = [];
	for (const [zone, localWallTime] of [
		["America/New_York", "2026-10-30T20:00-04:00"],
		["Europe/London", "2026-10-31T00:00+00:00"],
		["Australia/Lord_Howe", "2026-10-31T11:00+11:00"],
	] as const) {
		for (const latenessSec of [900, 3600, 14400, 86400] as const) {
			const snapshot: SendSnapshotV1 = {
				...exampleSnapshot(),
				schedule: {
					kind: "at",
					notBefore,
					zone,
					localWallTime,
					latenessSec,
					holdIfNewInbound: true,
				},
			};
			cases.push({
				id: `${zone.toLowerCase().replaceAll("/", "-")}-${latenessSec}`,
				snapshot,
				iat,
				contentHash: contentHash(snapshot),
				fingerprint: fingerprint(snapshot),
				canonicalHex: Buffer.from(canonicalize(snapshot)).toString("hex"),
				window: sendWindow(snapshot, iat),
			});
		}
	}
	return cases;
}
export const SCHEDULE_VECTOR_PRODUCER: Readonly<{ node: string; nodeTzdata: string }> =
	Object.freeze({ node: "26.12.0", nodeTzdata: "2026e" });

export function generate(context: VectorContext): VectorFile[] {
	const check = context.check === true;
	if (
		!check &&
		(process.versions.node !== SCHEDULE_VECTOR_PRODUCER.node ||
			process.versions.tz !== SCHEDULE_VECTOR_PRODUCER.nodeTzdata)
	)
		throw new Error("Schedule vector producer refused");
	// Refuse to generate a contradictory fixture; this is TS evidence, not native agreement.
	for (const entry of resolutionCases()) {
		try {
			const instant = resolveLocalTime(entry.wall, entry.zone);
			if (entry.error || instant !== entry.notBefore) throw new Error("Schedule fixture mismatch");
		} catch (error) {
			if (!(error instanceof ScheduleError) || error.code !== entry.error) throw error;
		}
	}
	for (const entry of renderingCases()) {
		try {
			if (renderLocalWallTime(entry.notBefore, entry.zone) !== entry.localWallTime || entry.error)
				throw new Error("Schedule fixture mismatch");
		} catch (error) {
			if (!(error instanceof ScheduleError) || error.code !== entry.error) throw error;
		}
	}
	return [
		{
			path: "schedule/dst.json",
			content: {
				format: "draftyak.vectors.schedule.v1",
				description:
					"Explicit wall/instant/display fixtures. Native rendering and hash verification must run independently; generation alone establishes no cross-language agreement.",
				metadata: {
					// Check recomputes semantics against the complete canonical producer record.
					// Writing is permitted only on that producer and records its actual versions.
					node: check ? SCHEDULE_VECTOR_PRODUCER.node : process.versions.node,
					nodeTzdata: check ? SCHEDULE_VECTOR_PRODUCER.nodeTzdata : process.versions.tz,
					rust: {
						jiff: "0.2.38",
						jiffCore: "0.1.1",
						jiffTzdb: "0.1.9",
						expectedTzdata: "2026e",
					},
				},
				resolutionCases: resolutionCases(),
				renderingCases: renderingCases(),
				snapshots: scheduledSnapshotCases(),
			},
		},
	];
}
