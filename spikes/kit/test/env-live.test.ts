import { createHash } from "node:crypto";
import {
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { inspect } from "node:util";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { deleteEnvLive, envLivePath, loadEnvLive, Secret, saveEnvLive } from "../env-live.ts";
import { assertContentFree, fingerprint, redact } from "../evidence.ts";
import { git } from "../repo.ts";

// Throwaway repos; the real .env.live is never touched.
const base = realpathSync.native(mkdtempSync(path.join(tmpdir(), "draftyak-kit-env-")));
const main = path.join(base, "main");
const worktree = path.join(base, "wt");
const decoy = path.join(base, "decoy");
function repo(dir: string): void {
	git(base, "init", "-q", dir);
	// Background maintenance would write into .git while contents() hashes it.
	git(dir, "config", "maintenance.auto", "false");
	writeFileSync(path.join(dir, ".gitignore"), ".env.live\n");
	git(dir, "add", ".gitignore");
	const message = path.basename(dir);
	git(dir, "-c", "user.name=kit", "-c", "user.email=kit@example.invalid", "commit", "-qm", message);
}
const contents = (dir: string): string => {
	const hash = createHash("sha256");
	for (const entry of readdirSync(dir, { recursive: true, encoding: "utf8" }).toSorted()) {
		hash.update(entry);
		if (statSync(path.join(dir, entry)).isFile()) hash.update(readFileSync(path.join(dir, entry)));
	}
	return hash.digest("hex");
};
repo(decoy);
writeFileSync(path.join(decoy, ".env.live"), "DY_LIVE_ONE=decoy\n");
const untouched = contents(decoy);
// What a hook, `git rebase -x` or `git bisect run` exports in a linked worktree: the kit must still
// act on the repository at the path it is given, never on the one these name.
const outer = {
	GIT_DIR: path.join(decoy, ".git"),
	GIT_WORK_TREE: decoy,
	GIT_INDEX_FILE: path.join(decoy, ".git", "index"),
};
Object.assign(process.env, outer);
repo(main);
git(main, "worktree", "add", "-q", worktree);
afterAll(() => {
	for (const name of Object.keys(outer)) delete process.env[name];
	rmSync(base, { recursive: true, force: true });
});

const file = path.join(main, ".env.live");
const token = ["tok", "en-", "4f7c9e2b1d8a"].join("");
const at = { cwd: worktree, env: {} };

describe("env-live.ts", () => {
	beforeEach(() => {
		writeFileSync(file, `# names only in the example\nDY_LIVE_ONE=${token}\nDY_LIVE_EMPTY=\n`);
		rmSync(path.join(worktree, ".env.live"), { force: true });
	});

	it("reads the main checkout's file from a worktree, as Secrets that never print", () => {
		expect([envLivePath(at), envLivePath({ cwd: main, env: {} })]).toEqual([file, file]);
		const { DY_LIVE_ONE } = loadEnvLive(["DY_LIVE_ONE"], at);
		expect(DY_LIVE_ONE.reveal()).toBe(token);
		const shown = [String(DY_LIVE_ONE), JSON.stringify({ DY_LIVE_ONE }), inspect(DY_LIVE_ONE)];
		expect(shown).toEqual(["[redacted]", '{"DY_LIVE_ONE":"[redacted]"}', "Secret [redacted]"]);
		expect(redact(`header ${token}`)).toBe("header [redacted:secret]");
		expect(() => assertContentFree({ value: token })).toThrow("$.value (secret)");
	});

	it("names missing entries and bad names, never values", () => {
		const names = ["DY_LIVE_ONE", "DY_LIVE_EMPTY", "DY_LIVE_NONE"];
		expect(() => loadEnvLive(names, at)).toThrow(/not set in .*: DY_LIVE_EMPTY, DY_LIVE_NONE$/);
		expect(() => loadEnvLive(["PATH"], at)).toThrow("DY_LIVE_*");
	});

	it("refuses a .env.live inside a worktree, also through DRAFTYAK_ENV_LIVE", () => {
		const env = { DRAFTYAK_ENV_LIVE: path.join(worktree, "x.env") };
		expect(() => envLivePath({ cwd: main, env })).toThrow(`inside the worktree ${worktree}`);
		writeFileSync(path.join(worktree, ".env.live"), "DY_LIVE_ONE=x\n");
		expect(() => loadEnvLive(["DY_LIVE_ONE"], at)).toThrow("inside the worktree");
		expect(() => saveEnvLive("DY_LIVE_TWO", "value-2", at)).toThrow("inside the worktree");
		expect(() => deleteEnvLive(["DY_LIVE_ONE"], at)).toThrow("inside the worktree");
	});

	it("takes an absolute DRAFTYAK_ENV_LIVE outside the worktrees", () => {
		const outside = path.join(base, "elsewhere.env");
		writeFileSync(outside, "DY_LIVE_ONE=elsewhere\n");
		const env = { DRAFTYAK_ENV_LIVE: outside };
		expect(loadEnvLive(["DY_LIVE_ONE"], { cwd: worktree, env }).DY_LIVE_ONE.reveal()).toBe(
			"elsewhere",
		);
		expect(() => envLivePath({ cwd: main, env: { DRAFTYAK_ENV_LIVE: "x.env" } })).toThrow(
			"absolute",
		);
	});

	it("saves in place, keeps comments, deletes after a session", () => {
		saveEnvLive("DY_LIVE_ONE", "replaced-1", at);
		saveEnvLive("DY_LIVE_TWO", new Secret("second-2"), at);
		const saved =
			"# names only in the example\nDY_LIVE_ONE=replaced-1\nDY_LIVE_EMPTY=\nDY_LIVE_TWO=second-2\n";
		expect(readFileSync(file, "utf8")).toBe(saved);
		expect(() => saveEnvLive("DY_LIVE_TWO", "a\nb", at)).toThrow("one non-empty line");
		expect(deleteEnvLive(["DY_LIVE_ONE", "DY_LIVE_NONE"], at)).toEqual(["DY_LIVE_ONE"]);
		expect(readFileSync(file, "utf8")).toBe(
			"# names only in the example\nDY_LIVE_EMPTY=\nDY_LIVE_TWO=second-2\n",
		);
	});

	it("refuses to write a file git would commit", () => {
		writeFileSync(path.join(main, ".gitignore"), "");
		expect(() => saveEnvLive("DY_LIVE_TWO", "value-2", at)).toThrow("git doesn't ignore it");
		writeFileSync(path.join(main, ".gitignore"), ".env.live\n");
	});

	it("leaves alone the repository that GIT_DIR, GIT_WORK_TREE and GIT_INDEX_FILE name", async () => {
		const print = await fingerprint({ cwd: main, sampleMs: 50 });
		expect(print.commit).toBe(git(main, "rev-parse", "HEAD").stdout.trim());
		expect(print.commit).not.toBe(git(decoy, "rev-parse", "HEAD").stdout.trim());
		expect(contents(decoy)).toBe(untouched);
	});
});
