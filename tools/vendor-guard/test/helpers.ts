import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { rules } from "../rules/index.ts";
import { gitEnv } from "../src/scan.ts";

const base = mkdtempSync(path.join(tmpdir(), "draftyak-vendor-guard-"));
const config = path.join(base, "gitconfig");
writeFileSync(config, "[maintenance]\n\tauto = false\n");

// git, here and in the scanner, without the user's or the system's config (excludes, hooks,
// signing), without repo variables from hooks or `rebase -x`, never above the temp dir, and
// without background maintenance, which writes into .git while a test reads or removes it.
export const env: NodeJS.ProcessEnv = {
	...gitEnv(),
	GIT_CONFIG_GLOBAL: config,
	GIT_CONFIG_NOSYSTEM: "1",
	GIT_CEILING_DIRECTORIES: base,
};
Object.assign(process.env, env);

export function removeTemp(): void {
	rmSync(base, { recursive: true, force: true });
}

let count = 0;
export function tempDir(): string {
	count += 1;
	const dir = path.join(base, `case-${count}`);
	mkdirSync(dir);
	return dir;
}

export function write(dir: string, file: string, content: string | Uint8Array): void {
	mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
	writeFileSync(path.join(dir, file), content);
}

export interface Repo {
	readonly dir: string;
	write(file: string, content: string | Uint8Array): void;
	git(...args: string[]): string;
	commit(message: string): string;
}

export function tempRepo(): Repo {
	const dir = tempDir();
	const git = (...args: string[]): string => {
		const result = spawnSync("git", args, { cwd: dir, env, encoding: "utf8" });
		if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
		return result.stdout.trim();
	};
	git("init", "-q", "-b", "main");
	git("config", "user.name", "Ada Lovelace");
	git("config", "user.email", "ada@example.com");
	return {
		dir,
		write: (file, content) => write(dir, file, content),
		git,
		commit: (message) => {
			git("add", "-A");
			git("commit", "-q", "--allow-empty", "-m", message);
			return git("rev-parse", "HEAD");
		},
	};
}

// A rule's positive or negative case, from rules/, where the literals live.
export function sample(id: string, which: "bad" | "good" = "bad", index = 0): string {
	const text = rules.find((rule) => rule.id === id)?.[which][index]?.text;
	if (text === undefined) throw new Error(`no ${which} case ${index} for ${id}`);
	return text.trimEnd();
}
