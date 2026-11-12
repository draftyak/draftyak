import { expect, it } from "vitest";
import { exampleSnapshot, SNAPSHOT_IAT, scheduleAt } from "../scripts/vectors/snapshot.ts";
import { type Schedule, type SendSnapshotV1, sendWindow } from "../src/snapshot.ts";

function indirectSchedule(kind: "accessor" | "proxy", read: () => Schedule): SendSnapshotV1 {
	const snapshot = exampleSnapshot();
	if (kind === "proxy")
		return new Proxy(snapshot, {
			get(target, key, receiver) {
				return key === "schedule" ? read() : Reflect.get(target, key, receiver);
			},
		});
	Object.defineProperty(snapshot, "schedule", { enumerable: true, get: read });
	return snapshot;
}

it("preserves the ordinary immediate send window", () => {
	expect(sendWindow(exampleSnapshot(), SNAPSHOT_IAT)).toEqual({
		deliverBy: SNAPSHOT_IAT + 900_000,
	});
});

it("preserves the ordinary scheduled send window", () => {
	const schedule = scheduleAt(SNAPSHOT_IAT + 60_000);
	expect(sendWindow({ ...exampleSnapshot(), schedule }, SNAPSHOT_IAT)).toEqual({
		notBefore: schedule.notBefore,
		deliverBy: schedule.notBefore + 900_000,
	});
});

it.each(["accessor", "proxy"] as const)(
	"derives the validated immediate schedule without rereading the %s",
	(kind) => {
		let reads = 0;
		const unvalidated = {
			...scheduleAt(SNAPSHOT_IAT + 60_000),
			latenessSec: 1800,
		} as unknown as Schedule;
		const snapshot = indirectSchedule(kind, () => (++reads === 1 ? { kind: "now" } : unvalidated));
		expect(sendWindow(snapshot, SNAPSHOT_IAT)).toEqual({
			deliverBy: SNAPSHOT_IAT + 900_000,
		});
		expect(reads).toBe(1);
	},
);

it.each(["accessor", "proxy"] as const)(
	"keeps the validated scheduled window when the %s later returns now",
	(kind) => {
		let reads = 0;
		const schedule = scheduleAt(SNAPSHOT_IAT + 60_000);
		const snapshot = indirectSchedule(kind, () => (++reads === 1 ? schedule : { kind: "now" }));
		expect(sendWindow(snapshot, SNAPSHOT_IAT)).toEqual({
			notBefore: schedule.notBefore,
			deliverBy: schedule.notBefore + 900_000,
		});
		expect(reads).toBe(1);
	},
);

it.each(["accessor", "proxy"] as const)(
	"does not invoke a throwing %s after schedule validation",
	(kind) => {
		let reads = 0;
		const schedule = scheduleAt(SNAPSHOT_IAT + 60_000);
		const snapshot = indirectSchedule(kind, () => {
			if (++reads > 1) throw new Error("Synthetic schedule read after validation");
			return schedule;
		});
		expect(sendWindow(snapshot, SNAPSHOT_IAT)).toEqual({
			notBefore: schedule.notBefore,
			deliverBy: schedule.notBefore + 900_000,
		});
		expect(reads).toBe(1);
	},
);

it.each(["notBefore", "latenessSec"] as const)(
	"derives the window from the validated nested %s value",
	(property) => {
		let reads = 0;
		const schedule = scheduleAt(SNAPSHOT_IAT + 60_000);
		const original = schedule[property];
		const changed = property === "notBefore" ? original + 60_000 : 1800;
		Object.defineProperty(schedule, property, {
			enumerable: true,
			get: () => (++reads === 1 ? original : changed),
		});
		expect(sendWindow({ ...exampleSnapshot(), schedule }, SNAPSHOT_IAT)).toEqual({
			notBefore: SNAPSHOT_IAT + 60_000,
			deliverBy: SNAPSHOT_IAT + 60_000 + 900_000,
		});
		expect(reads).toBe(1);
	},
);
