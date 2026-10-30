import { renderLocalWallTime } from "@draftyak/protocol/schedule";
import { Schedule } from "@draftyak/protocol/snapshot";
import { describe, expect, it, vi } from "vitest";
import { SchedulerError } from "../../src/outbox/scheduler-ports.ts";
import { scheduleAt, schedulingAvailable } from "../../src/outbox/scheduler-time.ts";

// spec/vectors/schedule/dst.json, copied as literals.
const refusals: readonly [id: string, wall: string, zone: string, code: string][] = [
	["new-york-gap-0200", "2026-03-08T02:00", "America/New_York", "NONEXISTENT_LOCAL_TIME"],
	["new-york-gap-0230", "2026-03-08T02:30", "America/New_York", "NONEXISTENT_LOCAL_TIME"],
	["new-york-gap-0259", "2026-03-08T02:59", "America/New_York", "NONEXISTENT_LOCAL_TIME"],
	["new-york-overlap-0100", "2026-11-01T01:00", "America/New_York", "AMBIGUOUS_LOCAL_TIME"],
	["new-york-overlap-0130", "2026-11-01T01:30", "America/New_York", "AMBIGUOUS_LOCAL_TIME"],
	["new-york-overlap-0159", "2026-11-01T01:59", "America/New_York", "AMBIGUOUS_LOCAL_TIME"],
	["london-gap-0100", "2026-03-29T01:00", "Europe/London", "NONEXISTENT_LOCAL_TIME"],
	["london-gap-0130", "2026-03-29T01:30", "Europe/London", "NONEXISTENT_LOCAL_TIME"],
	["london-gap-0159", "2026-03-29T01:59", "Europe/London", "NONEXISTENT_LOCAL_TIME"],
	["london-overlap-0100", "2026-10-25T01:00", "Europe/London", "AMBIGUOUS_LOCAL_TIME"],
	["london-overlap-0130", "2026-10-25T01:30", "Europe/London", "AMBIGUOUS_LOCAL_TIME"],
	["london-overlap-0159", "2026-10-25T01:59", "Europe/London", "AMBIGUOUS_LOCAL_TIME"],
	["lord-howe-gap-0200", "2026-10-04T02:00", "Australia/Lord_Howe", "NONEXISTENT_LOCAL_TIME"],
	["lord-howe-gap-0215", "2026-10-04T02:15", "Australia/Lord_Howe", "NONEXISTENT_LOCAL_TIME"],
	["lord-howe-gap-0229", "2026-10-04T02:29", "Australia/Lord_Howe", "NONEXISTENT_LOCAL_TIME"],
	["lord-howe-overlap-0130", "2026-04-05T01:30", "Australia/Lord_Howe", "AMBIGUOUS_LOCAL_TIME"],
	["lord-howe-overlap-0145", "2026-04-05T01:45", "Australia/Lord_Howe", "AMBIGUOUS_LOCAL_TIME"],
	["lord-howe-overlap-0159", "2026-04-05T01:59", "Australia/Lord_Howe", "AMBIGUOUS_LOCAL_TIME"],
	["invalid-day", "2026-02-29T12:00", "UTC", "INVALID_INPUT"],
	["invalid-month", "2026-13-01T12:00", "UTC", "INVALID_INPUT"],
	["hour-24", "2026-01-01T24:00", "UTC", "INVALID_INPUT"],
	["seconds-not-input", "2026-01-01T12:00:00", "UTC", "INVALID_INPUT"],
	["offset-not-input", "2026-01-01T12:00+00:00", "UTC", "INVALID_INPUT"],
	["unknown-zone", "2026-01-01T12:00", "Invalid/Example", "INVALID_INPUT"],
	["fixed-offset-not-zone", "2026-01-01T12:00", "+01:00", "INVALID_INPUT"],
	["before-epoch", "1969-12-31T23:59", "UTC", "INVALID_INPUT"],
	["unknown-sentinel", "2026-01-01T00:00", "Etc/Unknown", "INVALID_INPUT"],
	["unknown-sentinel-lowercase", "2026-01-01T00:00", "etc/unknown", "INVALID_INPUT"],
	["factory-placeholder", "2026-01-01T00:00", "Factory", "INVALID_INPUT"],
	["factory-placeholder-lowercase", "2026-01-01T00:00", "factory", "INVALID_INPUT"],
	["unrepresentable-offset", "1970-01-01T00:00", "Africa/Monrovia", "INVALID_INPUT"],
	["above-upper-minute", "9999-12-30T22:01", "UTC", "INVALID_INPUT"],
];

const resolved: readonly [
	id: string,
	wall: string,
	zone: string,
	notBefore: number,
	localWallTime: string,
][] = [
	[
		"new-york-gap-before",
		"2026-03-08T01:59",
		"America/New_York",
		1772953140000,
		"2026-03-08T01:59-05:00",
	],
	[
		"new-york-gap-after",
		"2026-03-08T03:00",
		"America/New_York",
		1772953200000,
		"2026-03-08T03:00-04:00",
	],
	[
		"new-york-overlap-before",
		"2026-11-01T00:59",
		"America/New_York",
		1793509140000,
		"2026-11-01T00:59-04:00",
	],
	[
		"new-york-overlap-after",
		"2026-11-01T02:00",
		"America/New_York",
		1793516400000,
		"2026-11-01T02:00-05:00",
	],
	[
		"london-gap-before",
		"2026-03-29T00:59",
		"Europe/London",
		1774745940000,
		"2026-03-29T00:59+00:00",
	],
	[
		"london-gap-after",
		"2026-03-29T02:00",
		"Europe/London",
		1774746000000,
		"2026-03-29T02:00+01:00",
	],
	[
		"london-overlap-before",
		"2026-10-25T00:59",
		"Europe/London",
		1792886340000,
		"2026-10-25T00:59+01:00",
	],
	[
		"london-overlap-after",
		"2026-10-25T02:00",
		"Europe/London",
		1792893600000,
		"2026-10-25T02:00+00:00",
	],
	[
		"lord-howe-gap-before",
		"2026-10-04T01:59",
		"Australia/Lord_Howe",
		1791041340000,
		"2026-10-04T01:59+10:30",
	],
	[
		"lord-howe-gap-after",
		"2026-10-04T02:30",
		"Australia/Lord_Howe",
		1791041400000,
		"2026-10-04T02:30+11:00",
	],
	[
		"lord-howe-overlap-before",
		"2026-04-05T01:29",
		"Australia/Lord_Howe",
		1775312940000,
		"2026-04-05T01:29+11:00",
	],
	[
		"lord-howe-overlap-after",
		"2026-04-05T02:00",
		"Australia/Lord_Howe",
		1775316600000,
		"2026-04-05T02:00+10:30",
	],
	[
		"new-york-ordinary",
		"2026-01-15T09:15",
		"America/New_York",
		1768486500000,
		"2026-01-15T09:15-05:00",
	],
	["london-ordinary", "2026-07-15T09:15", "Europe/London", 1784103300000, "2026-07-15T09:15+01:00"],
	[
		"lord-howe-ordinary",
		"2026-07-15T09:15",
		"Australia/Lord_Howe",
		1784069100000,
		"2026-07-15T09:15+10:30",
	],
	["leap-day", "2028-02-29T00:00", "UTC", 1835395200000, "2028-02-29T00:00+00:00"],
	["upper-minute", "9999-12-30T22:00", "UTC", 253402207200000, "9999-12-30T22:00+00:00"],
];

function refusedWith(code: string, run: () => unknown): void {
	let thrown: unknown;
	try {
		run();
	} catch (error) {
		thrown = error;
	}
	expect(thrown).toBeInstanceOf(SchedulerError);
	expect(thrown).toMatchObject({ name: "SchedulerError", code, message: code });
}

export function schedulerTimeCases(): void {
	describe("schedule time", () => {
		it.each(refusals)("refuses %s with its own code", (_id, wall, zone, code) => {
			refusedWith(code, () => scheduleAt({ wall, zone, latenessSec: 900, holdIfNewInbound: true }));
		});

		it.each(resolved)(
			"resolves %s to the vector instant and rendering",
			(_id, wall, zone, notBefore, localWallTime) => {
				for (const latenessSec of [900, 3600, 14400, 86400] as const) {
					const schedule = scheduleAt({ wall, zone, latenessSec, holdIfNewInbound: false });
					expect(schedule).toEqual({
						kind: "at",
						notBefore,
						zone,
						localWallTime,
						latenessSec,
						holdIfNewInbound: false,
					});
					expect(Object.isFrozen(schedule)).toBe(true);
					expect(Schedule.safeParse(schedule).success).toBe(true);
					expect(schedule.localWallTime).toBe(renderLocalWallTime(schedule.notBefore, zone));
				}
			},
		);

		it("takes only the frozen lateness set and a boolean hold flag", () => {
			const wall = "2026-01-15T09:15";
			const zone = "America/New_York";
			for (const latenessSec of [0, 1, 899, 901, 1800, 172800, 900.5, "900", null, Number.NaN])
				refusedWith("INVALID_INPUT", () =>
					scheduleAt({ wall, zone, latenessSec, holdIfNewInbound: true } as never),
				);
			for (const holdIfNewInbound of ["true", 1, null, undefined])
				refusedWith("INVALID_INPUT", () =>
					scheduleAt({ wall, zone, latenessSec: 900, holdIfNewInbound } as never),
				);
		});

		it("snapshots its input without running getters, coercion hooks or proxy traps", () => {
			let hooks = 0;
			const valid = {
				wall: "2026-01-15T09:15",
				zone: "UTC",
				latenessSec: 900,
				holdIfNewInbound: true,
			};
			const count = (): never => {
				hooks++;
				throw new Error("Synthetic hook ran");
			};
			const refused: unknown[] = [
				null,
				"2026-01-15T09:15",
				[valid.wall, valid.zone],
				{ ...valid, extra: 1 },
				{ wall: valid.wall, zone: valid.zone, latenessSec: 900 },
				Object.defineProperty({ ...valid }, "wall", { enumerable: true, get: count }),
				Object.defineProperty({ ...valid }, "zone", { enumerable: false, value: "UTC" }),
				new Proxy(valid, { get: count, ownKeys: count, getOwnPropertyDescriptor: count }),
				{ ...valid, wall: { toString: count } },
				{ ...valid, zone: { [Symbol.toPrimitive]: count } },
			];
			for (const input of refused) refusedWith("INVALID_INPUT", () => scheduleAt(input as never));
			expect(hooks).toBe(0);
			expect(scheduleAt(valid as never)).toMatchObject({ notBefore: Date.UTC(2026, 0, 15, 9, 15) });
		});

		it("fails new schedules with SCHEDULING_UNAVAILABLE while Temporal is missing", () => {
			expect(schedulingAvailable()).toBe(true);
			vi.stubGlobal("Temporal", undefined);
			try {
				expect(schedulingAvailable()).toBe(false);
				refusedWith("SCHEDULING_UNAVAILABLE", () =>
					scheduleAt({
						wall: "2026-01-15T09:15",
						zone: "America/New_York",
						latenessSec: 900,
						holdIfNewInbound: true,
					}),
				);
				// DST classification needs Temporal too; it is never guessed without it.
				refusedWith("SCHEDULING_UNAVAILABLE", () =>
					scheduleAt({
						wall: "2026-03-08T02:30",
						zone: "America/New_York",
						latenessSec: 900,
						holdIfNewInbound: true,
					}),
				);
			} finally {
				vi.unstubAllGlobals();
			}
			expect(schedulingAvailable()).toBe(true);
		});

		it("reports an unreadable Temporal as unavailable, ignoring its alleged refusal code", () => {
			const original = Object.getOwnPropertyDescriptor(globalThis, "Temporal");
			Object.defineProperty(globalThis, "Temporal", {
				configurable: true,
				get: () => {
					throw Object.assign(new Error("Synthetic Temporal failure"), {
						code: "AMBIGUOUS_LOCAL_TIME",
					});
				},
			});
			try {
				expect(schedulingAvailable()).toBe(false);
				refusedWith("SCHEDULING_UNAVAILABLE", () =>
					scheduleAt({
						wall: "2026-01-15T09:15",
						zone: "UTC",
						latenessSec: 900,
						holdIfNewInbound: true,
					}),
				);
			} finally {
				if (original === undefined) Reflect.deleteProperty(globalThis, "Temporal");
				else Object.defineProperty(globalThis, "Temporal", original);
			}
			expect(schedulingAvailable()).toBe(true);
		});

		it("takes a refusal code only from the schedule helpers' own errors", () => {
			const original = Object.getOwnPropertyDescriptor(globalThis, "Temporal");
			const real: unknown = Reflect.get(globalThis, "Temporal");
			let reads = 0;
			// The availability check gets the real Temporal; later reads throw a foreign coded error.
			Object.defineProperty(globalThis, "Temporal", {
				configurable: true,
				get: () => {
					if (++reads === 1) return real;
					throw Object.assign(new Error("Synthetic Temporal failure"), {
						code: "AMBIGUOUS_LOCAL_TIME",
					});
				},
			});
			try {
				refusedWith("INVALID_INPUT", () =>
					scheduleAt({
						wall: "2026-01-15T09:15",
						zone: "UTC",
						latenessSec: 900,
						holdIfNewInbound: true,
					}),
				);
				expect(reads).toBe(2);
			} finally {
				if (original === undefined) Reflect.deleteProperty(globalThis, "Temporal");
				else Object.defineProperty(globalThis, "Temporal", original);
			}
			expect(schedulingAvailable()).toBe(true);
		});

		it("reports a Temporal that cannot render as unavailable", () => {
			vi.stubGlobal("Temporal", {});
			try {
				expect(schedulingAvailable()).toBe(false);
				refusedWith("SCHEDULING_UNAVAILABLE", () =>
					scheduleAt({
						wall: "2026-01-15T09:15",
						zone: "UTC",
						latenessSec: 900,
						holdIfNewInbound: true,
					}),
				);
			} finally {
				vi.unstubAllGlobals();
			}
		});

		it("refuses with SCHEDULING_UNAVAILABLE before it reads the input", () => {
			const malformed: unknown[] = [
				null,
				{
					wall: "2026-01-15T09:15",
					zone: "UTC",
					latenessSec: 900,
					holdIfNewInbound: true,
					extra: 1,
				},
			];
			for (const temporal of [undefined, {}]) {
				vi.stubGlobal("Temporal", temporal);
				try {
					expect(schedulingAvailable()).toBe(false);
					for (const input of malformed)
						refusedWith("SCHEDULING_UNAVAILABLE", () => scheduleAt(input as never));
				} finally {
					vi.unstubAllGlobals();
				}
			}
			expect(schedulingAvailable()).toBe(true);
		});
	});
}
