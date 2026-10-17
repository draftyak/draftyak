// The DST cases both heavy tests ask about, derived from the transitions with plain arithmetic, so
// no time zone library chooses its own questions, and the comparison of Temporal's answers with
// jiff's.
import type { Kind, Rendered, Resolved, Transition } from "./temporal-probe.ts";

// Plan section 13, DST: three zones, one of them with Lord Howe's 30-minute shift.
export const ZONES: readonly string[] = [
	"America/New_York",
	"Europe/London",
	"Australia/Lord_Howe",
];
export const FROM_MS: number = Date.UTC(2026, 0, 1);
export const TO_MS: number = Date.UTC(2028, 0, 1);
// Plan section 3: lateness 15 min by default, or 1 h, 4 h or 24 h.
export const LATENESS_S: readonly number[] = [900, 3_600, 14_400, 86_400];

const MINUTE = 60_000;
const DAY = 86_400_000;

export function offsetMinutes(offset: string): number {
	const match = /^([+-])(\d{2}):(\d{2})$/.exec(offset);
	if (match === null) throw new Error(`not a ±HH:MM offset: ${offset}`);
	return (match[1] === "-" ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3]));
}

// The wall clock's minutes moved by a transition: positive for a gap, negative for a fold.
export const shiftMinutes = ({ offsetBefore, offsetAfter }: Transition): number =>
	offsetMinutes(offsetAfter) - offsetMinutes(offsetBefore);

export interface WallCase {
	readonly zone: string;
	readonly wall: string;
	readonly expected: Kind;
}

const wallTime = (ms: number): string => new Date(ms).toISOString().slice(0, 16);

// Around each transition: the minute before the gap or fold, its first, middle and last minutes,
// the first minute after it, and noon the day before.
export function wallCases(transitions: readonly Transition[]): WallCase[] {
	return transitions.flatMap((transition) => {
		const { zone, epochMs, offsetBefore, offsetAfter } = transition;
		const shift = shiftMinutes(transition);
		const kind: Kind = shift > 0 ? "gap" : "fold";
		const first =
			epochMs + Math.min(offsetMinutes(offsetBefore), offsetMinutes(offsetAfter)) * MINUTE;
		const span = Math.abs(shift) * MINUTE;
		const at = (ms: number, expected: Kind): WallCase => ({ zone, wall: wallTime(ms), expected });
		return [
			at(first - MINUTE, "unique"),
			at(first, kind),
			at(first + span / 2, kind),
			at(first + span - MINUTE, kind),
			at(first + span, "unique"),
			{ zone, wall: `${wallTime(first - DAY).slice(0, 10)}T12:00`, expected: "unique" },
		];
	});
}

// Instants to render as localWallTime: the transition and a minute either side, and a window
// starting 30 min before it, ending at each lateness.
export function instantCases(
	transitions: readonly Transition[],
): { zone: string; epochMs: number }[] {
	return transitions.flatMap(({ zone, epochMs }) => {
		const notBefore = epochMs - 30 * MINUTE;
		const around = [epochMs - MINUTE, epochMs, epochMs + MINUTE];
		const deliverBy = LATENESS_S.map((seconds) => notBefore + seconds * 1_000);
		return [notBefore, ...around, ...deliverBy].map((ms) => ({ zone, epochMs: ms }));
	});
}

const transitionKey = (t: Transition): string =>
	`${t.zone} ${t.epochMs} ${t.offsetBefore} ${t.offsetAfter}`;

// Every transition any side found, so a transition only one side has still gets its cases asked.
export function allTransitions(...sides: readonly (readonly Transition[])[]): Transition[] {
	const unique = new Map(sides.flat().map((t) => [transitionKey(t), t]));
	return [...unique.values()].toSorted(
		(a, b) => a.zone.localeCompare(b.zone) || a.epochMs - b.epochMs,
	);
}

// One side's answers: its transitions, and its answers to the same wall cases and instants, in order.
export interface Answers {
	readonly transitions: readonly Transition[];
	readonly walls: readonly Omit<Resolved, "error">[];
	readonly instants: readonly Rendered[];
}

export interface Difference {
	readonly node: string;
	readonly zone: string;
	readonly at: string | number;
	readonly field: string;
	readonly temporal: unknown;
	readonly jiff: unknown;
}

// Each way a Node's Temporal answers differ from jiff's: a transition only one of them has, then
// every field of every wall case and instant.
export function differences(node: string, temporal: Answers, jiff: Answers): Difference[] {
	const found: Difference[] = [];
	const compare = (zone: string, at: string | number, fields: Record<string, unknown[]>) => {
		for (const [field, [theirs, ours]] of Object.entries(fields)) {
			if (theirs !== ours) found.push({ node, zone, at, field, temporal: theirs, jiff: ours });
		}
	};
	const theirs = new Set(temporal.transitions.map(transitionKey));
	const ours = new Set(jiff.transitions.map(transitionKey));
	for (const t of allTransitions(temporal.transitions, jiff.transitions)) {
		const key = transitionKey(t);
		compare(t.zone, t.epochMs, { transition: [theirs.has(key), ours.has(key)] });
	}
	if (temporal.walls.length !== jiff.walls.length) throw new Error("answers to other wall cases");
	if (temporal.instants.length !== jiff.instants.length)
		throw new Error("answers to other instants");
	for (const [index, wall] of jiff.walls.entries()) {
		const other = temporal.walls[index];
		compare(wall.zone, wall.wall, {
			kind: [other?.kind, wall.kind],
			compatible: [other?.compatible, wall.compatible],
			earlier: [other?.earlier, wall.earlier],
			later: [other?.later, wall.later],
			reject: [other?.reject, wall.reject],
		});
	}
	for (const [index, instant] of jiff.instants.entries()) {
		const other = temporal.instants[index];
		compare(instant.zone, instant.epochMs, {
			localWallTime: [other?.localWallTime, instant.localWallTime],
			offset: [other?.offset, instant.offset],
		});
	}
	return found;
}

// The cases around a side's own transitions on which its answered kind isn't the derived one.
export function unexpectedKinds(
	transitions: readonly Transition[],
	walls: readonly Pick<Resolved, "zone" | "wall" | "kind">[],
): (WallCase & { readonly kind?: Kind })[] {
	const kinds = new Map(walls.map(({ zone, wall, kind }) => [`${zone} ${wall}`, kind]));
	return wallCases(transitions)
		.map((wall) => ({ ...wall, kind: kinds.get(`${wall.zone} ${wall.wall}`) }))
		.filter(({ kind, expected }) => kind !== expected);
}
