import { describe, expect, it } from "vitest";
import { rules } from "../rules/index.ts";
import { find, glue, identifiers, lines, type PatternRule } from "../src/rules.ts";

// Every long line grows by fours up to 128 KiB and stops at the first size over the limit, so a
// pattern that backtracks fails within seconds instead of stalling the run. At 128 KiB the slowest
// linear case takes about 20 ms on the dev box, and each pattern that used to backtrack took 0.5 s
// or more. The limit is on this process's CPU time, not wall time: a backtracking pattern burns
// CPU, while a runner busy with other suites only makes the wall clock slower (one CI run took
// 282 ms of wall time for a case that needs 6 ms).
const LIMIT_MS = 250;
const SIZES = [16, 64, 256, 1024, 4096, 16_384, 65_536, 131_072];
const fill = (unit: string, size: number): string => unit.repeat(Math.ceil(size / unit.length));
type Line = (size: number) => string;

function tooSlow(run: (input: string) => unknown, family: Iterable<Line>): string | undefined {
	for (const line of family) {
		for (const size of SIZES) {
			const input = line(size);
			let ms = Number.POSITIVE_INFINITY;
			for (let attempt = 0; attempt < 2 && ms > LIMIT_MS; attempt++) {
				const started = process.cpuUsage();
				run(input);
				const used = process.cpuUsage(started);
				ms = Math.min(ms, (used.user + used.system) / 1000);
			}
			if (ms > LIMIT_MS) {
				return `${JSON.stringify(input.slice(0, 40))}… (${input.length} chars): ${ms.toFixed(0)} ms`;
			}
		}
	}
	return undefined;
}

const patterns = rules.filter((rule): rule is PatternRule => rule.kind !== "mark");

// From each positive case's match: every prefix repeated, and every prefix followed by a run of
// the next character or of the two around it.
function fromCases(rule: PatternRule): Map<string, Line> {
	const family = new Map<string, Line>();
	for (const line of rule.bad.flatMap((sample) => lines(sample.text))) {
		for (const pattern of rule.patterns) {
			const match = pattern.exec(line);
			if (match === null) continue;
			const text = line.slice(match.index, match.index + Math.min(match[0].length + 1, 48));
			for (let k = 1; k <= text.length; k++) {
				const prefix = text.slice(0, k);
				family.set(`*${prefix}`, (size) => fill(prefix, size));
				for (const unit of [text[k] ?? " ", text.slice(k - 1, k + 1)]) {
					family.set(`${prefix}+${unit}`, (size) => prefix + fill(unit, size));
				}
			}
		}
	}
	return family;
}

// Each start once and then repeated, or followed by a run of a separator or of itself plus one.
const starts = ["claude", "codex", "claude.ai/", "Co-authored-by: ", "eyJ", "join(", '"Claude"'];
starts.push(glue(".co", "dex"), "sk-ant-", "xoxb-1", "a@", "+1", "1", "a1:");
const units = [" ", "-", ".", "/", ",", '"', ":", "<", " <", "a", "0", ""];
const generic: Line[] = starts.flatMap((start) =>
	units.flatMap((unit): Line[] =>
		unit === ""
			? [(size) => fill(start, size)]
			: [(size) => start + fill(unit, size), (size) => fill(start + unit, size)],
	),
);

describe("every pattern", () => {
	it.each(patterns.map((rule) => [rule.id, rule] as const))(
		"%s stays linear on long lines built from its cases and from other rules' starts",
		(_id, rule) => {
			const run = (input: string) => find(rule, input);
			expect(tooSlow(run, fromCases(rule).values())).toBeUndefined();
			expect(tooSlow(run, generic)).toBeUndefined();
		},
	);
});

describe("identifier parsing", () => {
	it.each([
		["build.gradle.kts", "namespace"],
		["build.gradle.kts", "namespace = ("],
		["settings.gradle.kts", "rootProject.name = "],
		["Cargo.toml", "[package]\nname"],
		["pyproject.toml", "[project]\nscripts = {"],
		["pyproject.toml", "[project]\nscripts = { a = "],
		["apps/app/src-tauri/tauri.conf.json", '"identifier" : '],
		["AndroidManifest.xml", "package = "],
	])("stays linear in %s after %j", (file, start) => {
		const family = [" ", "a", ",a", " a = ", `${start} `].map(
			(unit): Line =>
				(size) =>
					start + fill(unit, size),
		);
		expect(tooSlow((input) => identifiers(file, input), family)).toBeUndefined();
	});
});
