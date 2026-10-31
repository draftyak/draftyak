import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { rules } from "../rules/index.ts";
import { find, glue, identifiers, lineHits, lines, type PatternRule } from "../src/rules.ts";
import { CAPS, unpack } from "../src/unpack.ts";

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

// String escapes, which secret and vendor rules also read decoded, round after round: runs of each
// around a few starts, and before a reference that only the decoded line shows.
const escapes = [
	"\\n",
	"\\u0073",
	"\\u{1F600}",
	"\\u{",
	"\\x7",
	"\\U0001",
	"\\\\",
	"\\\\n",
	"\\\\\\\\u0073",
	'\\"',
	"\\/",
	"\\",
];
const escaped: Line[] = [
	...["sk-ant-", "claude", "eyJ"].flatMap((start) =>
		escapes.flatMap((sequence): Line[] => [
			(size) => start + fill(sequence, size),
			(size) => fill(sequence + start, size),
		]),
	),
	...escapes.map(
		(sequence): Line =>
			(size) =>
				`${fill(sequence, size)}\\n${glue(".cl", "aude")}`,
	),
	// A backslash written as \x5c before a run of the rest of it: each decoding writes the next one,
	// so only the cap on decodings keeps the line linear.
	(size) => `\\${fill("x5c", size)}`,
];
const decoded = patterns.filter((rule) => rule.kind === "secret" || rule.kind === "vendor");

describe("every pattern", () => {
	it.each(patterns.map((rule) => [rule.id, rule] as const))(
		"%s stays linear on long lines built from its cases and from other rules' starts",
		(_id, rule) => {
			const run = (input: string) => find(rule, input);
			expect(tooSlow(run, fromCases(rule).values())).toBeUndefined();
			expect(tooSlow(run, generic)).toBeUndefined();
		},
	);

	it.each(decoded.map((rule) => [rule.id, rule] as const))(
		"%s stays linear on long lines of string escapes",
		(_id, rule) => {
			expect(tooSlow((input) => lineHits(input, [rule]), escaped)).toBeUndefined();
		},
	);
});

describe("unpacking", () => {
	const header = (size: string): string =>
		`${"a".padEnd(124, "\0")}${size.padEnd(12, "\0")}${"\0".repeat(121)}ustar${"\0".repeat(250)}`;
	const markers = (start: string, units: readonly string[]): Line[] =>
		units.map(
			(unit): Line =>
				(size) =>
					start + fill(unit, size),
		);
	// A valid PDF: its catalog, a FlateDecode stream object for each piece of data, its trailer.
	const pdf =
		(streams: (size: number) => readonly Buffer[]): Line =>
		(size) => {
			const objects = streams(size).map(
				(data, index) =>
					`${index + 3} 0 obj << /Length ${data.length} /Filter /FlateDecode >>\nstream\n${data.toString("latin1")}\nendstream\nendobj\n`,
			);
			const pages = "2 0 obj << /Type /Pages /Kids [] /Count 0 >> endobj\n";
			return `%PDF-1.7\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n${pages}${objects.join("")}trailer << /Root 1 0 R >>\n%%EOF\n`;
		};
	const small = deflateSync("BT /F1 12 Tf (a) Tj ET");
	it.each([
		[
			"a PDF",
			[
				pdf((size) => Array.from({ length: Math.ceil(size / 96) }, () => small)),
				// Stored, so the markers that frame streams fill the stream's data.
				pdf((size) => [deflateSync(fill("endstream\nendobj\nstream\r\n", size), { level: 0 })]),
			],
			"x.pdf",
		],
		[
			"a zip",
			markers("PK\u0003\u0004", ["PK\u0005\u0006", "PK\u0001\u0002\u0000\u0000", "\u0000"]),
			"",
		],
		[
			"data before a zip",
			markers("MZ", ["PK\u0005\u0006", "PK\u0001\u0002\u0000\u0000PK\u0005\u0006"]),
			"",
		],
		["a tar", markers("", [header("0"), header("1"), `${header("777")}a`]), ""],
	])("stays linear on %s full of its markers", (_kind, family, name) => {
		expect(
			tooSlow((input) => unpack(Buffer.from(input, "latin1"), CAPS, name), family),
		).toBeUndefined();
	});
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
