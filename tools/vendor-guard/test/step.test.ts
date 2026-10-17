import { spawnSync } from "node:child_process";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type { StepContext } from "../../verify/lib/registry.ts";
import { baseOf, step } from "../../verify/steps/vendor-guard.ts";
import { glue } from "../src/rules.ts";
import { env, type Repo, removeTemp, tempRepo } from "./helpers.ts";

afterAll(removeTemp);
afterEach(() => vi.restoreAllMocks());

const cli = path.join(import.meta.dirname, "..", "src", "cli.ts");
const trailer = glue("Co", "-authored-by: Someone <someone@example.com>");

// verify's context in a temp repository: git runs there, and the step's CLI is this one.
function run(repo: Repo): Promise<{ outcome: unknown; out: string; notes: string[] }> {
	const notes: string[] = [];
	vi.spyOn(console, "log").mockImplementation((line: string) => notes.push(line));
	let out = "";
	const spawn = (command: string, args: readonly string[]) => {
		const result = spawnSync(command, [...args], { cwd: repo.dir, env, encoding: "utf8" });
		return { code: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
	};
	const unused = () => Promise.reject(new Error("the step doesn't use this"));
	const ctx: StepContext = {
		root: repo.dir,
		profile: "default",
		env,
		capture: async (command, args) => spawn(command, args),
		node: async ([script = "", ...args]) => {
			expect(script).toBe(path.join(repo.dir, "tools", "vendor-guard", "src", "cli.ts"));
			const result = spawn(process.execPath, [cli, ...args]);
			out = result.stdout;
			return result.code;
		},
		run: unused,
		pnpm: unused,
		turbo: unused,
		biome: unused,
	};
	return step.run(ctx).then((outcome) => ({ outcome, out, notes }));
}

function branch(name: string, base: string | undefined): Repo {
	const repo = tempRepo();
	const start = repo.commit("chore: start");
	if (base) repo.git("update-ref", `refs/remotes/${base}`, start);
	repo.git("checkout", "-q", "-b", name);
	return repo;
}

describe("the vendor-guard verify step", () => {
	it("knows the branch each item and milestone branch merges into", () => {
		const bases = ["m0-04-vendor-guard", "m0-06a-spike-kit", "m2c-01-runtime", "m0", "m1b"];
		expect(bases.map(baseOf)).toEqual([
			"origin/m0",
			"origin/m0",
			"origin/m2c",
			"origin/main",
			"origin/main",
		]);
		expect(["main", "feature/x", "m0-4-x", "m0-04-CI", "spikes-run/m0-04-x"].map(baseOf)).toEqual([
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
		]);
	});

	it("checks the commit messages of an item branch against its base", async () => {
		const repo = branch("m0-99-probe", "origin/m0");
		const clean = repo.commit("feat: a");
		expect(await run(repo)).toMatchObject({
			outcome: { status: "passed" },
			out: expect.stringMatching(/^vendor-guard: 0 findings in 0 files and 1 commit /m),
		});
		const flagged = repo.commit(`fix: b\n\n${trailer}`);
		const { outcome, out } = await run(repo);
		expect(outcome).toEqual({ status: "failed", reason: "exit code 1" });
		expect(out).toContain(`commit ${flagged}:3:1: attribution: `);
		expect(out).not.toContain(clean);
	});

	it("checks a milestone branch's commits against origin/main", async () => {
		const repo = branch("m0", "origin/main");
		const flagged = repo.commit(`feat: a\n\n${trailer}`);
		expect((await run(repo)).out).toContain(`commit ${flagged}:3:1: attribution: `);
	});

	it("checks only the files, and says so, when the base or the branch is unknown", async () => {
		const missing = branch("m0-99-probe", undefined);
		missing.commit(`feat: a\n\n${trailer}`);
		expect(await run(missing)).toMatchObject({
			outcome: { status: "passed" },
			notes: ["vendor-guard: commit messages not checked (origin/m0 not found)"],
		});
		const detached = branch("m0-99-probe", "origin/m0");
		detached.commit(`feat: a\n\n${trailer}`);
		detached.git("checkout", "-q", "--detach");
		expect(await run(detached)).toMatchObject({
			outcome: { status: "passed" },
			notes: ["vendor-guard: commit messages not checked (not on an item or milestone branch)"],
		});
	});
});
