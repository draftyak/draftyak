import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { main } from "../src/cli.ts";

const repo = path.resolve(import.meta.dirname, "..", "..", "..");
const tmp = mkdtempSync(path.join(tmpdir(), "draftyak-adr-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const valid = `# ADR 0002: Sample decision

- **Status:** proposed
- **Date:** 2026-10-17
- **Spike:** S1
- **Plan:** §15 S1
- **Owner decision:** no

## Context
Why.

\`\`\`md
## Not a section
\`\`\`

## Options
- One
- Two

## Decision
<!--
The decision is the first line after comments.
-->
Go

Plan changes:
- drop X
- add \`Y\`

### Detail
More.

## Fallback
Something else.

## Evidence
- \`spikes/s01-sample/evidence/run.json\`: numbers.

## Kept test
- **Path:** \`spikes/s01-sample/test/kept.test.ts\`
- **Command:** \`pnpm --filter @draftyak/spike-s01-sample test\`
- **Guards:** the thing.
- **Destination:** M2a, \`apps/hub/test/\`
`;

// One case per row: text in the valid ADR » its replacement » the problem pnpm adr reports (⏎ = newline).
const broken = `
# ADR 0002: Sample decision » # Sample » title must be "# ADR NNNN: Title"
# ADR 0002: » # ADR 0003: » title number 0003 differs from the file number 0002
Status:** proposed » Status:** draft » Status "draft" is not proposed, accepted or superseded
Date:** 2026-10-17 » Date:** 2026-02-30 » Date "2026-02-30" is not a YYYY-MM-DD date
- **Date:** 2026-10-17⏎ »  » header field "Date" is missing
Spike:** S1 » Spike:** X1 » Spike "X1" is not "none" or a spike id
Plan:** §15 S1 » Plan:** the plan » Plan "the plan" names no plan section (§n)
Owner decision:** no » Owner decision:** maybe » Owner decision "maybe" is not yes or no
- **Plan:** » - **Author:** x⏎- **Plan:** » unknown header field "Author"
Status:** proposed » Status:** superseded » Status superseded and a "Superseded by" field
Status:** proposed » Status:** superseded⏎- **Superseded by:** 0009 » Superseded by "0009" doesn't name another ADR
## Options » ## Notes⏎x⏎⏎## Options » sections must be Context, Options, Decision, Fallback, Evidence, Kept test in that order (found: Context, Notes, Options,
## Context » ## Background » (found: Background, Options, Decision, Fallback, Evidence, Kept test)
Something else. » <!-- later --> » Fallback is empty
Go⏎⏎Plan » Maybe⏎⏎Plan » Decision must start with one of: Go, Go with fallback, No-go, Not run (found "Maybe")
test/kept.test.ts » test/gone.test.ts » kept-test path spikes/s01-sample/test/gone.test.ts does not exist
Path:** \`spikes/s01-sample/test/kept.test.ts\` » Path:** \`/etc/passwd\` » kept-test path /etc/passwd must be relative
Path:** \`spikes/s01-sample/test/kept.test.ts\` » Path:** \`../x.test.ts\` » kept-test path ../x.test.ts must be relative
Path:** \`spikes/s01-sample/test/kept.test.ts\` » Path:** \`.\` » kept-test path . is the repository root or a top-level folder
test/kept.test.ts\` » ./test/kept.test.ts\` » should be written spikes/s01-sample/test/kept.test.ts
spikes/s01-sample/test/kept.test.ts\` » spikes\\s01-sample\\test\\kept.test.ts\` » must use forward slashes
Destination:** M2a, » Destination:** » Destination names no milestone (e.g. M2a)
M2a, \`apps/hub/test/\` » M2a » Destination names no \`path\`
M2a, \`apps/hub/test/\` » M6 \`channel-slack\` » Destination names no \`path\` with a folder
- **Guards:** the thing.⏎ »  » kept test Guards is missing
- **Guards:** the thing.⏎ » <!-- hidden⏎- **Guards:** the thing.⏎-->⏎ » kept test Guards is missing
- **Path:** » - **Paths:** » Kept test has no Path field
- **Path:** \`spikes/s01-sample/test/kept.test.ts\`⏎ » ~~~⏎- **Path:** \`x\`⏎~~~⏎ » Kept test has no Path field
Path:** \`spikes/s01-sample/test/kept.test.ts\` » Path:** none » Path "none" needs the Decision No-go or Not run
`
	.trim()
	.split("\n")
	.map((row) => row.replaceAll("⏎", "\n").split(" » ") as [string, string, string]);

function write(root: string, file: string, text: string | Buffer): void {
	mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
	writeFileSync(path.join(root, file), text);
}

let repos = 0;
function repoWith(adrs: Record<string, string>): string {
	const root = path.join(tmp, `repo-${++repos}`);
	write(root, "docs/adr/template.md", readFileSync(path.join(repo, "docs/adr/template.md")));
	write(root, "spikes/s01-sample/test/kept.test.ts", "");
	for (const [name, text] of Object.entries(adrs)) write(root, `docs/adr/${name}`, text);
	return root;
}

// Output in order, and stderr's lines on their own.
function cli(argv: string[], root: string): { code: number; lines: string[]; stderr: string[] } {
	const lines: string[] = [];
	const stderr: string[] = [];
	const collect =
		(...targets: string[][]) =>
		(...parts: unknown[]): void => {
			for (const target of targets) target.push(...parts.join(" ").split("\n"));
		};
	const log = vi.spyOn(console, "log").mockImplementation(collect(lines));
	const error = vi.spyOn(console, "error").mockImplementation(collect(lines, stderr));
	try {
		return { code: main(argv, root), lines, stderr };
	} finally {
		log.mockRestore();
		error.mockRestore();
	}
}

describe("pnpm adr", () => {
	it("accepts a well-formed ADR", () => {
		expect(cli([], repoWith({ "0002-sample.md": valid }))).toMatchObject({
			code: 0,
			lines: ["1 ADR, 0 problems"],
		});
	});

	it.each(broken)("reports %j → %j", (from, to, problem) => {
		expect(valid).toContain(from);
		const result = cli([], repoWith({ "0002-sample.md": valid.replace(from, to) }));
		expect(result.code).toBe(1);
		const line = result.lines.find((candidate) => candidate.includes(problem));
		expect(line, result.lines.join("\n")).toMatch(/^docs\/adr\/0002-sample\.md(?::\d+)?: /);
		expect(result.lines.at(-1)).toMatch(/^1 ADR, [1-9]\d* problems?$/);
	});

	it("accepts a Not run ADR without a kept test, and a superseded ADR naming its successor", () => {
		const notRun = valid
			.replace("0002: Sample decision", "0003: Optional bridge")
			.replace("Go\n\nPlan", "Not run\n\nPlan")
			.replace(/- \*\*Path:\*\*[\s\S]*$/, "- **Path:** none (not run)\n");
		const superseded = valid.replace("proposed", "superseded\n- **Superseded by:** ADR 0003");
		const root = repoWith({ "0002-sample.md": superseded, "0003-bridge.md": notRun });
		expect(cli([], root)).toMatchObject({ code: 0, lines: ["2 ADRs, 0 problems"] });
	});

	it("checks file names, numbers and the template", () => {
		const names = ["0002-a.md", "0002-b.md", "2-Bad.md", "0003-upper.MD"];
		const root = repoWith(Object.fromEntries(names.map((name) => [name, valid])));
		rmSync(path.join(root, "docs", "adr", "template.md"));
		const { code, lines } = cli([], root);
		expect(code).toBe(1);
		expect(lines).toEqual(
			expect.arrayContaining([
				"docs/adr/template.md: the ADR template is missing",
				"docs/adr/2-Bad.md: ADR file names are NNNN-slug.md (lower-case slug)",
				"docs/adr/0003-upper.MD: ADR file names are NNNN-slug.md (lower-case slug)",
				"docs/adr/0002-b.md: ADR number 0002 is used twice",
			]),
		);
	});

	it("checks kept-test paths against git: the exact case, and nothing git ignores", () => {
		const moved = (number: string, folder: string): string =>
			valid.replace("0002", number).replace("spikes/s01-sample/test", folder);
		const root = repoWith({
			"0002-sample.md": valid,
			"0003-case.md": moved("0003", "Spikes/s01-sample/test"),
			"0004-ignored.md": moved("0004", "ignored"),
		});
		write(root, ".gitignore", "ignored/\n");
		write(root, "ignored/kept.test.ts", "");
		expect(spawnSync("git", ["init", "-q"], { cwd: root }).status).toBe(0);
		const { code, lines } = cli([], root);
		expect(code).toBe(1);
		expect(lines.filter((line) => line.includes("does not exist"))).toEqual([
			expect.stringMatching(/^docs\/adr\/0003-case\.md:\d+: kept-test path Spikes\/s01-sample\//),
			expect.stringMatching(/^docs\/adr\/0004-ignored\.md:\d+: kept-test path ignored\/kept/),
		]);
		expect(lines.at(-1)).toBe("3 ADRs, 2 problems");
	});

	it("--index writes docs/adr/README.md, and refuses while problems remain", () => {
		const root = repoWith({ "0002-sample.md": valid });
		expect(cli(["--", "--index"], root).code).toBe(0);
		expect(readFileSync(path.join(root, "docs", "adr", "README.md"), "utf8")).toContain(
			"| [0002](0002-sample.md) | Sample decision | proposed | Go | 2026-10-17 | S1 | no |",
		);
		const failing = repoWith({ "0002-sample.md": valid.replace("proposed", "draft") });
		expect(cli(["--index"], failing).code).toBe(1);
		expect(existsSync(path.join(failing, "docs", "adr", "README.md"))).toBe(false);
	});

	it("--report prints the gate's spike table", () => {
		const { code, lines } = cli(["--report"], repoWith({ "0002-sample.md": valid }));
		expect(code).toBe(0);
		expect(lines).toEqual([
			"| Spike | ADR | Decision | Evidence | Kept test → destination | Plan changes |",
			"|---|---|---|---|---|---|",
			"| S1 | [0002](../adr/0002-sample.md) Sample decision | Go (proposed) | `spikes/s01-sample/evidence/run.json` | `spikes/s01-sample/test/kept.test.ts` → M2a, `apps/hub/test/` | drop X; add `Y` |",
		]);
	});

	it.each([
		[["--index", "--report"], "adr: --index and --report can't be combined"],
		[["--bogus"], "adr: Unknown option '--bogus'"],
		[["extra"], "adr: Unexpected argument 'extra'"],
	])("refuses %j on stderr", (argv, reason) => {
		const { code, stderr } = cli(argv, repoWith({}));
		expect(code).toBe(2);
		expect(stderr[0]).toContain(reason);
		expect(stderr[1]).toMatch(/^usage: pnpm adr /);
	});

	it("runs before pnpm install: src imports only node: built-ins and relative files", () => {
		const src = path.resolve(import.meta.dirname, "..", "src");
		const imports = readdirSync(src).flatMap((file) =>
			[
				...readFileSync(path.join(src, file), "utf8").matchAll(
					/\b(?:from|import)\s*\(?\s*["']([^"']+)/g,
				),
			]
				.map((match) => match[1] ?? "")
				.filter((specifier) => !/^(?:node:|\.\.?\/)/.test(specifier)),
		);
		expect(imports).toEqual([]);
	});
});
