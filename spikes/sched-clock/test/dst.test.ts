// The jiff heavy test's comparison, on a made-up disagreement: one side moves Europe/London's
// spring transition a week later. Its differences must be listed for M1, not fail the run.
import { expect, it } from "vitest";
import {
	type Answers,
	allTransitions,
	differences,
	instantCases,
	offsetMinutes,
	unexpectedKinds,
	wallCases,
} from "./dst.ts";
import type { Kind, Transition } from "./temporal-probe.ts";

const MINUTE = 60_000;

const london = (at: string, offsetBefore: string, offsetAfter: string): Transition => ({
	zone: "Europe/London",
	epochMs: Date.parse(at),
	offsetBefore,
	offsetAfter,
});

// What a time zone library with exactly these transitions answers, from the offsets alone.
function answers(
	transitions: readonly Transition[],
	walls: readonly { zone: string; wall: string }[],
	instants: readonly { zone: string; epochMs: number }[],
): Answers {
	const offsetAt = (ms: number): string =>
		transitions.reduce(
			(offset, t) => (ms >= t.epochMs ? t.offsetAfter : offset),
			transitions[0]?.offsetBefore ?? "+00:00",
		);
	const offsets = [...new Set(transitions.flatMap((t) => [t.offsetBefore, t.offsetAfter]))];
	return {
		transitions,
		walls: walls.map(({ zone, wall }) => {
			const local = Date.parse(`${wall}:00Z`);
			const at = (offset: string) => local - offsetMinutes(offset) * MINUTE;
			const valid = offsets.filter((offset) => offsetAt(at(offset)) === offset).map(at);
			const [earlier, later] =
				valid.length > 0
					? [Math.min(...valid), Math.max(...valid)]
					: [Math.min(...offsets.map(at)), Math.max(...offsets.map(at))];
			const kind: Kind = valid.length === 1 ? "unique" : valid.length > 1 ? "fold" : "gap";
			const compatible = kind === "gap" ? later : earlier;
			return {
				zone,
				wall,
				kind,
				compatible,
				earlier,
				later,
				reject: kind === "unique" ? earlier : null,
			};
		}),
		instants: instants.map(({ zone, epochMs }) => {
			const offset = offsetAt(epochMs);
			const local = new Date(epochMs + offsetMinutes(offset) * MINUTE).toISOString().slice(0, 16);
			return { zone, epochMs, localWallTime: `${local}${offset}`, offset };
		}),
	};
}

it("lists a transition only one side has, and every case around it, instead of failing", () => {
	const autumn = london("2026-10-25T01:00:00Z", "+01:00", "+00:00");
	const jiff = [london("2026-03-29T01:00:00Z", "+00:00", "+01:00"), autumn];
	const node = [london("2026-04-05T01:00:00Z", "+00:00", "+01:00"), autumn];
	const all = allTransitions(jiff, node, jiff);
	expect(all.map((t) => new Date(t.epochMs).toISOString().slice(0, 10))).toEqual([
		"2026-03-29",
		"2026-04-05",
		"2026-10-25",
	]);
	const walls = wallCases(all);
	const instants = instantCases(all);
	const ours = answers(jiff, walls, instants);
	const theirs = answers(node, walls, instants);

	// Each side's kinds hold for its own transitions; the union's would fail jiff on April 5.
	expect(unexpectedKinds(jiff, ours.walls)).toEqual([]);
	expect(unexpectedKinds(node, theirs.walls)).toEqual([]);
	expect(unexpectedKinds(all, ours.walls).map(({ wall }) => wall)).toEqual([
		"2026-04-05T01:00",
		"2026-04-05T01:30",
		"2026-04-05T01:59",
	]);

	expect(differences("26.5.1", ours, ours)).toEqual([]);
	const listed = differences("26.5.1", theirs, ours);
	expect(listed.filter(({ field }) => field === "transition")).toEqual([
		{
			node: "26.5.1",
			zone: "Europe/London",
			at: jiff[0]?.epochMs,
			field: "transition",
			temporal: false,
			jiff: true,
		},
		{
			node: "26.5.1",
			zone: "Europe/London",
			at: node[0]?.epochMs,
			field: "transition",
			temporal: true,
			jiff: false,
		},
	]);
	// The gap minutes differ in kind; everything between the two spring dates in offset; nothing
	// around the shared autumn transition.
	const days = listed.map(({ at }) =>
		typeof at === "string" ? at.slice(0, 10) : new Date(at).toISOString().slice(0, 10),
	);
	expect(days.every((day) => day >= "2026-03-28" && day <= "2026-04-05")).toBe(true);
	const gapKinds = listed.filter(({ field, temporal }) => field === "kind" && temporal === "gap");
	expect(gapKinds.map(({ at }) => at)).toEqual([
		"2026-04-05T01:00",
		"2026-04-05T01:30",
		"2026-04-05T01:59",
	]);
});
