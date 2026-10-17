import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { glue } from "../src/rules.ts";
import { ALLOW_FILE } from "../src/scan.ts";
import { env, removeTemp, sample, tempDir, tempRepo } from "./helpers.ts";

afterAll(removeTemp);

const cli = path.join(import.meta.dirname, "..", "src", "cli.ts");

function guard(
	cwd: string,
	args: readonly string[] = [],
	extra: NodeJS.ProcessEnv = {},
): { code: number | null; out: string; err: string } {
	const result = spawnSync(process.execPath, [cli, ...args], {
		cwd,
		env: { ...env, ...extra },
		encoding: "utf8",
	});
	return { code: result.status, out: result.stdout, err: result.stderr };
}

const summary = /^vendor-guard: 0 findings in \d+ files?(?: and \d+ commits?)? \(\d+\.\d s\)$/m;

describe("pnpm guard", () => {
	it("exits 0 with a summary, and accepts the leading -- that bash and cmd pass through", () => {
		const repo = tempRepo();
		repo.write("src/ok.ts", "export const ok = 1;\n");
		for (const args of [[], ["--"]]) {
			const { code, out, err } = guard(repo.dir, args);
			expect({ code, err }).toEqual({ code: 0, err: "" });
			expect(out).toMatch(summary);
		}
	});

	it("exits 1 naming file:line:column, rule and reason, never the match", () => {
		const repo = tempRepo();
		const secret = sample("secret-anthropic");
		repo.write("src/key.ts", `\n${secret}\n`);
		repo.write("docs/a.md", `${sample("slack-mcp")}\n`);
		const { code, out } = guard(path.join(repo.dir, "src"));
		expect(code).toBe(1);
		const lines = out.trimEnd().split("\n");
		expect(lines[0]).toMatch(
			/^docs\/a\.md:1:\d+: slack-mcp: Slack's MCP server \(guardrail 6\) \(allow\.json sha256 [0-9a-f]{64}\)$/,
		);
		expect(lines[1]).toMatch(
			/^src\/key\.ts:2:\d+: secret-anthropic: an Anthropic API or OAuth key$/,
		);
		expect(lines[2]).toMatch(/^vendor-guard: 2 findings in 2 files \(\d+\.\d s\)$/);
		expect(out).not.toContain(secret.slice(secret.indexOf("sk-")));
	});

	it("prints JSON with --json", () => {
		const repo = tempRepo();
		repo.write("src/a.ts", `${sample("slack-rts")}\n`);
		const { code, out } = guard(repo.dir, ["--json"]);
		expect(code).toBe(1);
		expect(JSON.parse(out)).toEqual({
			findings: [
				{
					file: "src/a.ts",
					line: 1,
					column: expect.any(Number),
					rule: "slack-rts",
					reason: expect.any(String),
				},
			],
			files: 1,
			commits: null,
		});
	});

	it("checks commit messages in a range with --commits, ending lines at a lone CR too", () => {
		const repo = tempRepo();
		const first = repo.commit("chore: start");
		const trailer = glue("Co", "-authored-by: Someone <someone@example.com>");
		const flagged = repo.commit(`feat: add a\n\nBody.\n\n${trailer}`);
		repo.commit(`fix: b\n\nThe ${glue("Co", "-authored-by")} rule, in prose.`);
		repo.git("commit", "-q", "--allow-empty", "--cleanup=verbatim", "-m", `fix: c\r\r${trailer}`);
		const lone = repo.git("rev-parse", "HEAD");
		const all = guard(repo.dir, ["--commits", `${first}..HEAD`]);
		expect(all.code).toBe(1);
		expect(all.out).toContain(`commit ${flagged}:5:1: attribution: `);
		expect(all.out).toContain(`commit ${lone}:3:1: attribution: `);
		expect(all.out).toMatch(/^vendor-guard: 2 findings in 0 files and 3 commits /m);
		const clean = guard(repo.dir, ["--", `--commits=${flagged}..HEAD~1`]);
		expect({ code: clean.code, out: clean.out }).toEqual({
			code: 0,
			out: expect.stringMatching(summary),
		});
	});

	it("checks the repository at its working directory, whatever GIT_DIR or GIT_INDEX_FILE say", () => {
		const repo = tempRepo();
		repo.write("src/a.ts", `${sample("slack-mcp")}\n`);
		repo.commit("chore: start");
		const other = tempRepo();
		other.write("src/b.ts", "export const ok = 1;\n");
		other.commit("chore: start");
		const git = path.join(other.dir, ".git");
		// Through the other repository, this one's files would be untracked, and excluded.
		mkdirSync(path.join(git, "info"), { recursive: true });
		writeFileSync(path.join(git, "info", "exclude"), "*\n");
		const { code, out } = guard(repo.dir, [], {
			GIT_DIR: git,
			GIT_INDEX_FILE: path.join(git, "index"),
		});
		expect(code).toBe(1);
		expect(out).toContain("src/a.ts:1:");
	});

	it("exits 2 for usage errors, bad ranges, a broken allow.json and outside a repository", () => {
		const repo = tempRepo();
		repo.commit("chore: start");
		const cases: [string, string[], RegExp][] = [
			[repo.dir, ["--bogus"], /^vendor-guard: Unknown option '--bogus'.*\nusage: pnpm guard/s],
			[repo.dir, ["--commits", "-p"], /argument is ambiguous/],
			[repo.dir, ["--commits=-p"], /--commits takes a revision range/],
			[repo.dir, ["--commits", "main..nowhere"], /^vendor-guard: git log .*nowhere/],
			[tempDir(), [], /^vendor-guard: git rev-parse --show-toplevel: .*not a git repository/i],
		];
		for (const [cwd, args, message] of cases) {
			const { code, out, err } = guard(cwd, args);
			expect({ args, code, out }).toEqual({ args, code: 2, out: "" });
			expect(err).toMatch(message);
		}
		repo.write(ALLOW_FILE, "{}");
		expect(guard(repo.dir)).toEqual({
			code: 2,
			out: "",
			err: expect.stringContaining("JSON array"),
		});
	});

	it("prints its usage with --help", () => {
		const { code, out } = guard(tempDir(), ["--help"]);
		expect(code).toBe(0);
		expect(out).toMatch(/^usage: pnpm guard \[--json\] \[--commits <range>\]/);
	});
});
