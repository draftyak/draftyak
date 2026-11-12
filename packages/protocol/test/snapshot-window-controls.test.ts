import { expect, it } from "vitest";
import { exampleSnapshot, SNAPSHOT_IAT, scheduleAt } from "../scripts/vectors/snapshot.ts";
import { type Schedule, type ScheduleAt, SendSnapshotV1, sendWindow } from "../src/snapshot.ts";

const at = (latenessSec: 900 | 3600 | 14400 | 86400 = 900): ScheduleAt =>
	scheduleAt(SNAPSHOT_IAT + 60_000, "UTC", latenessSec);
const withSchedule = (schedule: Schedule): SendSnapshotV1 => ({ ...exampleSnapshot(), schedule });

it.each([0, SNAPSHOT_IAT, Number.MAX_SAFE_INTEGER - 900_000])(
	"projects an immediate schema fixture at the safe instant %s",
	(iat) => {
		const snapshot = SendSnapshotV1.parse(exampleSnapshot());
		const window = sendWindow(snapshot, iat);
		expect(window).toEqual({ deliverBy: iat + 900_000 });
		expect(Object.hasOwn(window, "notBefore")).toBe(false);
	},
);

it.each([900, 3600, 14400, 86400] as const)(
	"projects the exact scheduled millisecond window for lateness %s",
	(latenessSec) => {
		const snapshot = SendSnapshotV1.parse(withSchedule(at(latenessSec)));
		for (const iat of [0, SNAPSHOT_IAT, Number.MAX_SAFE_INTEGER])
			expect(sendWindow(snapshot, iat)).toEqual({
				notBefore: SNAPSHOT_IAT + 60_000,
				deliverBy: SNAPSHOT_IAT + 60_000 + latenessSec * 1000,
			});
	},
);

it.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
	"refuses the invalid input instant %s with the public snapshot code",
	(iat) => {
		expect(() => sendWindow(exampleSnapshot(), iat)).toThrow(
			expect.objectContaining({ code: "SNAPSHOT_INVALID", message: "SNAPSHOT_INVALID" }),
		);
	},
);

it("validates the complete snapshot rather than accepting a well-shaped schedule alone", () => {
	const base = exampleSnapshot();
	for (const input of [
		{ ...base, epoch: -1 },
		{ ...base, body: { ...base.body, text: "DYTEST\rINVALID" } },
		{ ...base, source: { ...base.source, authors: [] } },
		{ ...base, schedule: { kind: "now", notBefore: 0 } },
		{ ...base, schedule: { ...at(), latenessSec: 1 } },
	]) {
		expect(SendSnapshotV1.safeParse(input).success).toBe(false);
		expect(() => sendWindow(input as SendSnapshotV1, 0)).toThrow(
			expect.objectContaining({ code: "SNAPSHOT_INVALID" }),
		);
	}
});

it.each([900, 3600, 14400, 86400] as const)(
	"accepts the last safe scheduled result and refuses its next millisecond for lateness %s",
	(latenessSec) => {
		const schedule = at(latenessSec);
		const notBefore = Number.MAX_SAFE_INTEGER - latenessSec * 1000;
		// M1.8 validates display syntax; matching the instant to it belongs to schedule resolution.
		const boundary = withSchedule({ ...schedule, kind: "at", notBefore });
		expect(SendSnapshotV1.safeParse(boundary).success).toBe(true);
		expect(sendWindow(boundary, 0)).toEqual({ notBefore, deliverBy: Number.MAX_SAFE_INTEGER });
		expect(() =>
			sendWindow(withSchedule({ ...schedule, kind: "at", notBefore: notBefore + 1 }), 0),
		).toThrow(expect.objectContaining({ code: "SNAPSHOT_WINDOW_OVERFLOW" }));
	},
);

it("refuses the first overflowing immediate result", () => {
	expect(() => sendWindow(exampleSnapshot(), Number.MAX_SAFE_INTEGER - 900_000 + 1)).toThrow(
		expect.objectContaining({ code: "SNAPSHOT_WINDOW_OVERFLOW" }),
	);
});

type Mutation = (input: SendSnapshotV1, original: Schedule) => void;
function changesAfterSchedule(initial: Schedule, mutate: Mutation): SendSnapshotV1 {
	const input = withSchedule(initial);
	const source = input.source;
	let changed = false;
	Object.defineProperty(input, "source", {
		enumerable: true,
		get() {
			if (!changed) {
				changed = true;
				mutate(input, initial);
			}
			return source;
		},
	});
	return input;
}

const mutations: readonly [string, () => Schedule, Mutation][] = [
	[
		"now replaced with an unvalidated scheduled form",
		() => ({ kind: "now" }),
		(input) => {
			Reflect.set(input, "schedule", { ...at(), notBefore: 1 });
		},
	],
	[
		"scheduled form replaced with now",
		() => at(),
		(input) => {
			Reflect.set(input, "schedule", { kind: "now" });
		},
	],
	[
		"scheduled instant changed to a negative value",
		() => at(),
		(_input, original) => {
			Reflect.set(original, "notBefore", -10_000_000);
		},
	],
	[
		"lateness changed outside its validated enum",
		() => at(),
		(_input, original) => {
			Reflect.set(original, "latenessSec", 999.5);
		},
	],
	[
		"schedule access poisoned after its validation",
		() => at(),
		(input) => {
			Object.defineProperty(input, "schedule", {
				get() {
					throw new Error("DYTEST-POST-SCHEMA-SCHEDULE");
				},
			});
		},
	],
];

it.each(mutations)("uses the schema projection after %s", (_label, initial, mutate) => {
	// Fresh equivalent inputs separate schema evaluation from the exported projection call.
	const validated = SendSnapshotV1.parse(changesAfterSchedule(initial(), mutate));
	const expected = sendWindow(validated, SNAPSHOT_IAT);
	expect(sendWindow(changesAfterSchedule(initial(), mutate), SNAPSHOT_IAT)).toEqual(expected);
});

it("introduces no proxy schedule reads beyond those used by schema projection", () => {
	function fixture() {
		const target = withSchedule(at());
		let sourceSeen = false;
		let laterReads = 0;
		const input = new Proxy(target, {
			get(object, name, receiver) {
				if (name === "source") sourceSeen = true;
				if (name === "schedule" && sourceSeen) {
					laterReads++;
					return { kind: "now" };
				}
				return Reflect.get(object, name, receiver);
			},
		});
		return { input, reads: () => laterReads };
	}
	const schemaInput = fixture();
	const validated = SendSnapshotV1.parse(schemaInput.input);
	const projectedInput = fixture();
	expect(sendWindow(projectedInput.input, SNAPSHOT_IAT)).toEqual(
		sendWindow(validated, SNAPSHOT_IAT),
	);
	expect(projectedInput.reads()).toBe(schemaInput.reads());
});

it("supports frozen caller records and does not retain mutable caller or result state", () => {
	const original = at();
	const input = withSchedule(original);
	const first = sendWindow(input, SNAPSHOT_IAT);
	Reflect.set(original, "notBefore", SNAPSHOT_IAT + 120_000);
	expect(first).toEqual({ notBefore: SNAPSHOT_IAT + 60_000, deliverBy: SNAPSHOT_IAT + 960_000 });
	const second = sendWindow(input, SNAPSHOT_IAT);
	expect(second).toEqual({
		notBefore: SNAPSHOT_IAT + 120_000,
		deliverBy: SNAPSHOT_IAT + 1_020_000,
	});
	Reflect.set(first, "deliverBy", 0);
	expect(sendWindow(input, SNAPSHOT_IAT)).toEqual(second);
	const frozen = Object.freeze(withSchedule(Object.freeze({ kind: "now" })));
	expect(sendWindow(frozen, SNAPSHOT_IAT)).toEqual({ deliverBy: SNAPSHOT_IAT + 900_000 });
});
