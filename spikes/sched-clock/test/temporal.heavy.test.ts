// Plan section 3, Time zones: creating a schedule needs Temporal, which turns a wall time and IANA
// zone into UTC with disambiguation 'reject'. On each pinned Node: Temporal is there (typeof
// 'object', never 'function'), every DST gap and overlap in the three zones is rejected while
// ordinary times resolve, and every delay API fires at once past 2^31-1 ms. Recorded, with ICU and
// tzdata versions, in evidence/temporal-<target>.json.
import { afterAll, expect, it } from "vitest";
import { FROM_MS, shiftMinutes, TO_MS, wallCases, ZONES } from "./dst.ts";
import { probe, record, recording, selectedNodes, target } from "./nodes.ts";

const nodes = selectedNodes();
const passed: Record<string, unknown>[] = [];

// Two transitions a year: New York and London move by an hour, Lord Howe by 30 minutes.
const SHIFTS: Readonly<Record<string, readonly number[]>> = {
	"America/New_York": [60, -60, 60, -60],
	"Europe/London": [60, -60, 60, -60],
	"Australia/Lord_Howe": [-30, 30, -30, 30],
};

for (const { role, version } of nodes) {
	it(`Node ${version} (${role}): Temporal: present; reject throws for every DST gap and overlap`, async () => {
		const first = await probe(version, {
			zones: ZONES,
			fromMs: FROM_MS,
			toMs: TO_MS,
			timers: true,
		});
		expect(first.node.version).toBe(version);
		expect(first.temporal).toBe("object");

		const cases = wallCases(first.transitions);
		const { walls } = await probe(version, { walls: cases });
		expect(walls).toHaveLength(cases.length);
		const errors = { gap: new Set<string>(), fold: new Set<string>() };
		for (const [index, wall] of walls.entries()) {
			const { expected } = cases[index] ?? {};
			expect(wall.kind, `${wall.zone} ${wall.wall}`).toBe(expected);
			if (wall.kind === "unique") {
				expect(wall.reject).toBe(wall.compatible);
				expect([wall.earlier, wall.later]).toEqual([wall.compatible, wall.compatible]);
			} else {
				expect(wall.reject, `${wall.zone} ${wall.wall}`).toBeNull();
				errors[wall.kind].add(`${wall.error?.name}: ${wall.error?.message}`);
			}
		}
		// The same RangeError for both kinds: the hub tells a gap from a fold itself.
		expect([...errors.gap]).toEqual([...errors.fold]);
		expect([...errors.gap]).toHaveLength(1);
		expect([...errors.gap][0]).toMatch(/^RangeError: /);

		const zones = ZONES.map((zone) => {
			const own = first.transitions.filter((transition) => transition.zone === zone);
			expect(own.map(shiftMinutes), zone).toEqual(SHIFTS[zone]);
			const mine = walls.filter((wall) => wall.zone === zone);
			const count = (kind: string) => mine.filter((wall) => wall.kind === kind).length;
			return {
				zone,
				transitions: own.length,
				shiftsMinutes: own.map(shiftMinutes),
				gapWallsRejected: count("gap"),
				foldWallsRejected: count("fold"),
				uniqueWallsResolved: count("unique"),
			};
		});

		const [overflowed, honoured] = [first.timers.slice(0, -1), first.timers.at(-1)];
		expect(overflowed.map(({ api }) => api)).toHaveLength(5);
		for (const timer of overflowed) {
			expect(timer.firedMs, timer.api).not.toBeNull();
			expect(timer.firedMs ?? Number.POSITIVE_INFINITY, timer.api).toBeLessThan(1_000);
			expect(timer.overflowWarning, timer.api).toBe(true);
		}
		expect(honoured).toEqual({
			api: "setTimeout",
			delayMs: 2 ** 31 - 1,
			firedMs: null,
			overflowWarning: false,
		});

		passed.push({
			role,
			version,
			icuVersion: first.node.icu,
			tzVersion: first.node.tz,
			temporal: first.temporal,
			rejectError: [...errors.gap][0],
			zones,
			timers: first.timers,
		});
	});
}

// Only a run asked to record (DRAFTYAK_RECORD_EVIDENCE=1, or CI) in which every Node passed.
afterAll(async () => {
	if (!recording() || passed.length !== nodes.length) return;
	await record("temporal", {
		target,
		nodeSelection: process.env.DRAFTYAK_NODES || "both",
		from: new Date(FROM_MS).toISOString(),
		to: new Date(TO_MS).toISOString(),
		nodes: passed,
	});
});
