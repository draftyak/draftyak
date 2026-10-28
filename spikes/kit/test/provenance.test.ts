import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { evidenceStatusArgs, fingerprint, sourceState } from "../evidence.ts";
import { gitEnv } from "../repo.ts";

it("isolates explicit pathspec semantics from every inherited pathspec flag and key casing", () => {
	expect(
		gitEnv({
			GIT_LITERAL_PATHSPECS: "1",
			Git_Glob_Pathspecs: "1",
			git_noglob_pathspecs: "1",
			GIT_ICASE_PATHSPECS: "1",
			PATH: "kept",
		}),
	).toEqual({ PATH: "kept" });
});

it.each(["untracked", "staged"])(
	"fingerprints %s source under inherited literal pathspecs",
	async (state) => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "dy-kit-literal-provenance-"));
		vi.stubEnv("GIT_LITERAL_PATHSPECS", "1");
		try {
			const repo = path.join(root, "repo");
			const cwd = path.join(repo, "spike");
			fs.mkdirSync(cwd, { recursive: true });
			const env = gitEnv();
			const initialized = spawnSync("git", ["init", "-q"], { cwd: repo, env });
			expect(initialized.status).toBe(0);
			const dirty = async (): Promise<boolean | null> => (await sourceState(cwd)).dirty;
			expect(await dirty()).toBe(false);
			const input = path.join(repo, "source.ts");
			fs.writeFileSync(input, "export {};\n");
			if (state === "staged") {
				const staged = spawnSync("git", ["add", "source.ts"], { cwd: repo, env });
				expect(staged.status).toBe(0);
			}
			expect(await dirty(), "source must not disappear under literal pathspecs").toBe(true);
			const output = path.join(cwd, "evidence", "run[1].json");
			fs.mkdirSync(path.dirname(output));
			fs.writeFileSync(output, "{}\n");
			// Explicit literal exclusions still distinguish a bracket name from its wildcard sibling.
			const args = evidenceStatusArgs(cwd, [output]);
			const status = spawnSync("git", args, { cwd, env, encoding: "utf8" });
			expect(status.status).toBe(0);
			expect(status.stdout).toContain("source.ts");
			expect(status.stdout).not.toContain("run[1].json");
			const sibling = path.join(cwd, "evidence", "run1.json");
			fs.writeFileSync(sibling, "{}\n");
			const siblingStatus = spawnSync("git", args, { cwd, env, encoding: "utf8" });
			expect(siblingStatus.status).toBe(0);
			expect(siblingStatus.stdout).toContain("run1.json");
		} finally {
			vi.unstubAllEnvs();
			fs.rmSync(root, { recursive: true, force: true });
		}
	},
	30_000,
);

it("fingerprints non-ignored untracked source, tests and fixtures across the repository", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "dy-kit-provenance-"));
	try {
		const repo = path.join(root, "repo");
		const cwd = path.join(repo, "spike");
		fs.mkdirSync(cwd, { recursive: true });
		const config = path.join(root, "gitconfig");
		fs.writeFileSync(config, "[maintenance]\n\tauto = false\n");
		const env = { ...gitEnv(), GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: "1" };
		const initialized = spawnSync("git", ["init", "-q"], { cwd: repo, env });
		expect(initialized.status).toBe(0);
		const dirty = async (): Promise<boolean | null> => (await sourceState(cwd)).dirty;
		expect(await dirty()).toBe(false);
		for (const file of [
			"spike/src/new.ts",
			"spike/test/new.test.ts",
			"spike/fixtures/input.json",
			"spike/evidence/new.test.ts",
			"spike/evidence/run.json",
			"kit/new.ts",
		]) {
			const input = path.join(repo, file);
			fs.mkdirSync(path.dirname(input), { recursive: true });
			fs.writeFileSync(input, "{}\n");
			expect(await dirty(), file).toBe(true);
			fs.unlinkSync(input);
			expect(await dirty()).toBe(false);
		}
		fs.writeFileSync(path.join(repo, ".git", "info", "exclude"), "ignored-output/\n");
		fs.mkdirSync(path.join(repo, "ignored-output"));
		fs.writeFileSync(path.join(repo, "ignored-output", "generated.json"), "{}\n");
		expect(await dirty()).toBe(false);
		expect((await sourceState(root)).dirty).toBeNull();
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
}, 30_000);

it("records the cwd's commit and dirty state in fingerprint(), null outside a repository", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "dy-kit-provenance-print-"));
	try {
		const repo = path.join(root, "repo");
		const cwd = path.join(repo, "spike");
		fs.mkdirSync(cwd, { recursive: true });
		const config = path.join(root, "gitconfig");
		fs.writeFileSync(config, "[maintenance]\n\tauto = false\n");
		const env = { ...gitEnv(), GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: "1" };
		const git = (...args: string[]) => spawnSync("git", args, { cwd: repo, env, encoding: "utf8" });
		expect(git("init", "-q").status).toBe(0);
		const identity = ["-c", "user.name=kit", "-c", "user.email=kit@example.invalid"];
		expect(git(...identity, "commit", "-q", "--allow-empty", "-m", "base").status).toBe(0);
		const head = git("rev-parse", "HEAD").stdout.trim();
		fs.writeFileSync(path.join(cwd, "new.ts"), "export {};\n");
		// Concurrent: each call lists processes, which takes seconds on a busy Windows machine.
		const [inside, outside] = await Promise.all([
			fingerprint({ cwd, sampleMs: 0 }),
			fingerprint({ cwd: root, sampleMs: 0 }),
		]);
		expect(Object.keys(inside)).toEqual(["os", "node", "commit", "dirty", "load"]);
		expect(inside).toMatchObject({ commit: head, dirty: true });
		expect(outside).toMatchObject({ commit: null, dirty: null });
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
}, 30_000);

it("refuses directory, executable, non-JSON and outside-directory output exemptions", () => {
	const cwd = path.resolve("synthetic-spike");
	for (const file of [
		"evidence",
		"evidence/x.test.ts",
		"evidence/x.mjs",
		"fixtures/x.json",
		"../evidence/x.json",
	]) {
		expect(() => evidenceStatusArgs(cwd, [file])).toThrow(/generated output/);
	}
	expect(evidenceStatusArgs(cwd, ["evidence/run[1].json"])).toEqual([
		"status",
		"--porcelain",
		"--untracked-files=all",
		"--",
		":/",
		":(exclude,literal)evidence/run[1].json",
	]);
});
