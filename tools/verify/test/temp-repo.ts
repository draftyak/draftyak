import { spawnSync } from "node:child_process";
import {
	appendFileSync,
	linkSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gitEnv } from "../../../spikes/kit/repo.ts";
import type { GitRunner } from "../lib/listing.ts";
import { type FsOps, nodeFs } from "../lib/safe-fs.ts";

// The reserved words, built here so no test spells one: word() is the short word, word("-") and
// word("_") the two-part word with each separator.
export function word(separator?: "-" | "_"): string {
	return separator === undefined ? ["si", "wc"].join("") : ["dynamic", "agent"].join(separator);
}

const reservedText = new RegExp(
	[word(), `${["s0", "7"].join("")}[-_]`, ["dynamic", "agent"].join("[-_]")].join("|"),
	"gi",
);

// Text with each reserved word, and the reserved spike's number, replaced: what a test may compare
// and print.
export function scrub(text: string): string {
	return text.replace(reservedText, "<reserved>");
}

export type LinkType = "file" | "dir" | "junction";

export interface TempRepo {
	// The repository's real folder.
	readonly dir: string;
	// An empty folder beside the repository, for targets outside it; removed with it.
	readonly outside: string;
	git(...args: string[]): string;
	write(file: string, content: string | Uint8Array): void;
	// Stages everything git doesn't ignore and commits it; returns the commit.
	commit(message?: string): string;
	// Ignores the patterns through .git/info/exclude.
	ignore(...patterns: string[]): void;
	skipWorktree(file: string): void;
	// A link at `file` to `target` (below the repository, or absolute). Junctions point at the
	// absolute target; file and folder links at a relative one.
	link(file: string, target: string, type: LinkType): void;
	hardlink(file: string, existing: string): void;
	// An index entry of mode 120000 (a symlink) whose blob is `target`, whatever is on disk.
	indexLink(file: string, target: string): void;
	// An index entry of mode 160000 (a submodule) at `sha`.
	gitlink(file: string, sha: string): void;
	remove(): void;
}

export interface TempRepoOptions {
	// The repository folder's own name ("repo" by default).
	readonly name?: string;
}

const author = {
	GIT_AUTHOR_NAME: "Ada Lovelace",
	GIT_AUTHOR_EMAIL: "ada@example.com",
	GIT_COMMITTER_NAME: "Ada Lovelace",
	GIT_COMMITTER_EMAIL: "ada@example.com",
};

type GitRun = (args: readonly string[], input?: string, extra?: NodeJS.ProcessEnv) => string;

// Each repository's git, with its own config and environment, for the helpers below.
const runners = new WeakMap<TempRepo, GitRun>();

function runner(repo: TempRepo): GitRun {
	const run = runners.get(repo);
	if (!run) throw new Error("not a repository from tempRepo()");
	return run;
}

// A throwaway repository under the system temp folder. git sees only a config file of its own (no
// user or system config: signing, hooks, eol and fsmonitor stay off), no repository variables
// inherited from a hook, and no background maintenance writing into .git while a test reads it.
export function tempRepo(options: TempRepoOptions = {}): TempRepo {
	const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), "draftyak-verify-")));
	const dir = path.join(root, options.name ?? "repo");
	const outside = path.join(root, "outside");
	const config = path.join(root, "gitconfig");
	mkdirSync(dir);
	mkdirSync(outside);
	writeFileSync(
		config,
		"[maintenance]\n\tauto = false\n[gc]\n\tauto = 0\n[core]\n\tautocrlf = false\n",
	);
	const env = { ...gitEnv(), GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: "1" };
	const run = (args: readonly string[], input?: string, extra: NodeJS.ProcessEnv = {}): string => {
		const result = spawnSync("git", args, {
			cwd: dir,
			encoding: "utf8",
			env: { ...env, ...extra },
			input,
			windowsHide: true,
		});
		if (result.status !== 0) {
			const reason = result.stderr || result.error?.message || `exit ${result.status}`;
			throw new Error(scrub(`git ${args.join(" ")}: ${reason}`));
		}
		return result.stdout.trim();
	};
	const at = (file: string): string => path.join(dir, file);
	const parent = (file: string): void => {
		mkdirSync(path.dirname(at(file)), { recursive: true });
	};
	run(["init", "-q", "-b", "main"]);
	const repo: TempRepo = {
		dir,
		outside,
		git: (...args) => run(args),
		write: (file, content) => {
			parent(file);
			writeFileSync(at(file), content);
		},
		commit: (message = "fixture") => {
			run(["add", "-A"]);
			run(["commit", "-q", "--allow-empty", "-m", message], undefined, author);
			return run(["rev-parse", "HEAD"]);
		},
		ignore: (...patterns) => {
			mkdirSync(path.join(dir, ".git", "info"), { recursive: true });
			appendFileSync(
				path.join(dir, ".git", "info", "exclude"),
				patterns.map((p) => `${p}\n`).join(""),
			);
		},
		skipWorktree: (file) => {
			run(["update-index", "--skip-worktree", "--", file]);
		},
		link: (file, target, type) => {
			parent(file);
			const to = path.resolve(dir, target);
			symlinkSync(
				type === "junction" ? to : path.relative(path.dirname(at(file)), to),
				at(file),
				type,
			);
		},
		hardlink: (file, existing) => {
			parent(file);
			linkSync(at(existing), at(file));
		},
		indexLink: (file, target) => {
			const blob = run(["hash-object", "-w", "--stdin"], target);
			run(["update-index", "--add", "--cacheinfo", `120000,${blob},${file}`]);
		},
		gitlink: (file, sha) => {
			run(["update-index", "--add", "--cacheinfo", `160000,${sha},${file}`]);
		},
		remove: () => rmSync(root, { recursive: true, force: true, maxRetries: 5 }),
	};
	runners.set(repo, run);
	return repo;
}

// Puts `file` (below the repository, with / separators) in the index at stages 1 to 3 only, as an
// unresolved merge leaves it; the working tree is left as it is.
export function unmerged(repo: TempRepo, file: string): void {
	const run = runner(repo);
	const blobs = ["base\n", "ours\n", "theirs\n"].map((text) =>
		run(["hash-object", "-w", "--stdin"], text),
	);
	const none = "0".repeat(blobs[0]?.length ?? 40);
	const lines = [
		`0 ${none}\t${file}`,
		...blobs.map((blob, at) => `100644 ${blob} ${at + 1}\t${file}`),
	];
	run(["update-index", "--index-info"], `${lines.join("\n")}\n`);
}

// Makes `dir` (below the repository) a repository of its own with one commit: the outer one lists it
// as an untracked `dir/` and never looks into it.
export function nested(repo: TempRepo, dir: string): void {
	const run = runner(repo);
	const inner = path.join(repo.dir, dir);
	mkdirSync(inner, { recursive: true });
	writeFileSync(path.join(inner, "nested.txt"), "nested\n");
	run(["-C", inner, "init", "-q", "-b", "main"]);
	run(["-C", inner, "add", "-A"]);
	run(["-C", inner, "commit", "-q", "-m", "nested"], undefined, author);
}

// An existing folder's 8.3 alias on Windows, from cmd's %~s; null elsewhere, and on a volume that
// makes no short names. Windows callers fail on null rather than skip.
export function shortAlias(dir: string): string | null {
	if (process.platform !== "win32") return null;
	const result = spawnSync(
		process.env.ComSpec ?? "cmd.exe",
		["/d", "/s", "/c", `"for %I in ("${dir}") do @echo %~sI"`],
		{ encoding: "utf8", windowsHide: true, windowsVerbatimArguments: true },
	);
	const alias = result.status === 0 ? result.stdout.trim() : "";
	return alias.includes("~") && alias.toLowerCase() !== dir.toLowerCase() ? alias : null;
}

export interface SpawnSpy {
	// Every child asked for, in order.
	readonly calls: readonly { command: string; args: readonly string[] }[];
	readonly git: GitRunner;
	run(invocation: { command: string; args: readonly string[] }): Promise<number>;
}

// Records every child it is asked to start and starts none. Each call gets `answer`'s result: exit 0
// and no output unless it says otherwise.
export function spawnSpy(
	answer: (command: string, args: readonly string[]) => { code: number; stdout: string } = () => ({
		code: 0,
		stdout: "",
	}),
): SpawnSpy {
	const calls: { command: string; args: readonly string[] }[] = [];
	const ask = (command: string, args: readonly string[]): { code: number; stdout: string } => {
		calls.push({ command, args: [...args] });
		return answer(command, args);
	};
	return {
		calls,
		git: (args) => Promise.resolve(ask("git", args)),
		run: (invocation) => Promise.resolve(ask(invocation.command, invocation.args).code),
	};
}

// Whether this host makes links of `type`: junctions always; file and folder symlinks on Windows
// only with Developer Mode or elevation.
export function canLink(type: LinkType): boolean {
	const dir = mkdtempSync(path.join(tmpdir(), "draftyak-link-"));
	try {
		writeFileSync(path.join(dir, "target"), "");
		symlinkSync(type === "file" ? "target" : dir, path.join(dir, "link"), type);
		return true;
	} catch {
		return false;
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

export interface ReaderSpy {
	readonly fs: FsOps;
	// Every open and every listing, as a path below the root ("" for the root itself; outside it,
	// the whole path), scrubbed.
	readonly opens: string[];
	readonly readdirs: string[];
	// The opens `forbidden` refused; each threw.
	readonly refused: string[];
}

// Wraps `inner`, recording each open and readdir. An open of a path `forbidden` names (a link's
// target, an ignored file, an allowed-root path) is recorded as refused and throws.
export function readerSpy(
	root: string,
	forbidden: (rel: string) => boolean = () => false,
	inner: FsOps = nodeFs,
): ReaderSpy {
	const real = realpathSync.native(root);
	const below = (file: string): string => {
		const rel = path.relative(real, file);
		const outside = path.isAbsolute(rel) || rel === ".." || rel.startsWith(`..${path.sep}`);
		return (outside ? file : rel).split(path.sep).join("/");
	};
	const opens: string[] = [];
	const readdirs: string[] = [];
	const refused: string[] = [];
	return {
		opens,
		readdirs,
		refused,
		fs: {
			...inner,
			open: (file, flags) => {
				const rel = below(file);
				opens.push(scrub(rel));
				if (forbidden(rel)) {
					refused.push(scrub(rel));
					throw Object.assign(new Error("the reader spy refused this open"), { code: "EACCES" });
				}
				return inner.open(file, flags);
			},
			readdir: (dir) => {
				readdirs.push(scrub(below(dir)));
				return inner.readdir(dir);
			},
		},
	};
}

// The environment tempRepo() runs `repo`'s git with: its own config file and no repository
// variables inherited from a hook.
export function gitEnvOf(repo: TempRepo): NodeJS.ProcessEnv {
	const config = path.join(path.dirname(repo.dir), "gitconfig");
	return { ...gitEnv(), GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: "1" };
}

// Real git on `repo`, for a spawn spy to answer with: exit code and output, error output dropped.
export function realGit(
	repo: TempRepo,
	env: NodeJS.ProcessEnv = gitEnvOf(repo),
): (command: string, args: readonly string[]) => { code: number; stdout: string } {
	return (_command, args) => {
		const result = spawnSync("git", [...args], {
			cwd: repo.dir,
			encoding: "utf8",
			env,
			windowsHide: true,
		});
		return { code: result.status ?? 1, stdout: result.stdout ?? "" };
	};
}

// The repository this file belongs to.
export const ownRepo: string = path.resolve(import.meta.dirname, "..", "..", "..");

// Its workspace file, with LF line ends: the approved form that the gate and the pre-install check
// hold every checkout's workspace file to.
export const ownWorkspace: string = readFileSync(
	path.join(ownRepo, "pnpm-workspace.yaml"),
	"utf8",
).replaceAll("\r\n", "\n");

// Copies this repository's own files (below its root, with / separators) into `repo` as they are.
export function copyOwn(repo: TempRepo, rels: readonly string[]): void {
	for (const rel of rels) repo.write(rel, readFileSync(path.join(ownRepo, rel)));
}
