import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export interface TempRepo {
	readonly dir: string;
	git(...args: string[]): string;
	write(file: string, content: string | Uint8Array): void;
	commit(message: string, author?: string): string;
	remove(): void;
}

// A throwaway repository for tests, isolated from the user's git config (signing, hooks, eol).
export function tempRepo(): TempRepo {
	const root = mkdtempSync(path.join(tmpdir(), "draftyak-ci-checks-"));
	const dir = path.join(root, "repo");
	const config = path.join(root, "gitconfig");
	mkdirSync(dir);
	writeFileSync(config, "");
	const run = (args: string[], env: Record<string, string> = {}): string => {
		const result = spawnSync("git", args, {
			cwd: dir,
			encoding: "utf8",
			env: { ...process.env, GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: "1", ...env },
		});
		if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
		return result.stdout.trim();
	};
	run(["init", "-q", "-b", "main"]);
	return {
		dir,
		git: (...args) => run(args),
		write: (file, content) => {
			mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
			writeFileSync(path.join(dir, file), content);
		},
		commit: (message, author = "Ada Lovelace <ada@example.com>") => {
			const [, name = "", email = ""] = /^(.*) <(.*)>$/.exec(author) ?? [];
			run(["add", "-A"]);
			run(["commit", "-q", "--allow-empty", "-m", message], {
				GIT_AUTHOR_NAME: name,
				GIT_AUTHOR_EMAIL: email,
				GIT_COMMITTER_NAME: name,
				GIT_COMMITTER_EMAIL: email,
			});
			return run(["rev-parse", "HEAD"]);
		},
		remove: () => rmSync(root, { recursive: true, force: true }),
	};
}
