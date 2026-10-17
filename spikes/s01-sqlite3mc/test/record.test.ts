import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { codeChanged } from "../src/record.ts";
import { tempDir } from "./support.ts";

// git without the user's or the system's config (signing, hooks, templates), without repository
// variables from a hook or `rebase -x`, and without background maintenance, which writes into .git
// while the test reads it.
function gitIn(root: string): (cwd: string, ...args: string[]) => void {
	const config = path.join(root, "gitconfig");
	writeFileSync(config, "[maintenance]\n\tauto = false\n[commit]\n\tgpgsign = false\n");
	const env = {
		...Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^GIT_/i.test(name))),
		GIT_CONFIG_GLOBAL: config,
		GIT_CONFIG_NOSYSTEM: "1",
	};
	return (cwd, ...args) => {
		const result = spawnSync("git", args, { cwd, encoding: "utf8", env, windowsHide: true });
		if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
	};
}

it("counts changes anywhere in the repository except the spike's own evidence/ as code changes", () => {
	const root = tempDir("s01-git-");
	const repo = path.join(root, "repo");
	const git = gitIn(root);
	const write = (file: string, text: string): void => {
		mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
		writeFileSync(path.join(repo, file), text);
	};
	for (const file of ["spike/evidence/load.json", "spike/src/open.ts", "kit/index.ts"]) {
		write(file, "{}\n");
	}
	git(repo, "init", "-q");
	git(repo, "add", ".");
	git(repo, "-c", "user.name=s01", "-c", "user.email=s01@example.invalid", "commit", "-qm", "base");
	const spike = path.join(repo, "spike");
	expect(codeChanged(spike)).toBe(false);
	write("spike/evidence/load.json", '{ "recordedAt": "now" }\n');
	write("spike/evidence/bench.json", "{}\n");
	expect(codeChanged(spike)).toBe(false);
	write("kit/index.ts", "export {};\n");
	expect(codeChanged(spike)).toBe(true);
	git(repo, "checkout", "--", "kit/index.ts");
	write("spike/src/open.ts", "export {};\n");
	expect(codeChanged(spike)).toBe(true);
	expect(codeChanged(tempDir("s01-nogit-"))).toBeNull();
});
