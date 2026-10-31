import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import path from "node:path";
import { workspaceGlobsOf } from "../../../reserved-tests.ts";
import type { IndexEntry } from "../reserved-tripwire.ts";
import { gitChildEnv } from "./bootstrap.ts";
import { type Checkout, fold, type Kind } from "./safe-fs.ts";

// One git listing of a checkout: the index and the untracked files git doesn't ignore, from git run
// without the variables that would make it list another repository, index or tree.

export { GIT_REPO_VARS, gitChildEnv } from "./bootstrap.ts";

export type GitRunner = (
	args: readonly string[],
	options: { cwd: string; env: NodeJS.ProcessEnv },
) => Promise<{ code: number; stdout: string }>;

export interface Listing {
	readonly root: string;
	readonly entries: readonly IndexEntry[];
	readonly untracked: readonly string[];
}

export type ListingProblem =
	| { kind: "git"; code: number }
	| { kind: "toplevel" }
	| { kind: "unmerged"; paths: readonly string[] }
	| { kind: "nested"; paths: readonly string[] };

export type ListingCheck = "toplevel" | "unmerged" | "nested";

export const LISTING_CHECKS: readonly ListingCheck[] = Object.freeze([
	"toplevel",
	"unmerged",
	"nested",
]);

// git with stdin closed and its error output captured and dropped: only the exit code and the
// listing leave here. A git that can't start exits 127.
const runGit: GitRunner = (args, { cwd, env }) =>
	new Promise((resolve) => {
		let settled = false;
		const done = (code: number, stdout: string): void => {
			if (!settled) resolve({ code, stdout });
			settled = true;
		};
		const chunks: Buffer[] = [];
		try {
			const child = spawn("git", [...args], {
				cwd,
				env,
				stdio: ["ignore", "pipe", "pipe"],
				shell: false,
				windowsHide: true,
			});
			child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
			child.stderr.resume();
			child.once("error", () => done(127, ""));
			child.once("close", (code) => done(code ?? 1, Buffer.concat(chunks).toString("utf8")));
		} catch {
			done(127, "");
		}
	});

const real = (dir: string): string => {
	try {
		return realpathSync.native(dir);
	} catch {
		return dir;
	}
};

// Whether git's toplevel is this folder, as the platform compares paths.
const sameFolder = (toplevel: string, root: string): boolean =>
	fold(path.resolve(toplevel)) === fold(root) || fold(real(path.resolve(toplevel))) === fold(root);

// The checkout's one listing. root is resolved to its real folder, which the listing carries.
// git runs with childEnv's environment (gitChildEnv's by default) and without fsmonitor; checks
// leaves out listing checks for the mutation tests.
export async function listCheckout(
	root: string,
	options: {
		env?: NodeJS.ProcessEnv;
		git?: GitRunner;
		childEnv?: (env: NodeJS.ProcessEnv) => NodeJS.ProcessEnv;
		checks?: readonly ListingCheck[];
	} = {},
): Promise<{ listing: Listing | null; problems: readonly ListingProblem[] }> {
	const at = real(path.resolve(root));
	const env = (options.childEnv ?? gitChildEnv)(options.env ?? process.env);
	const git = options.git ?? runGit;
	const checks = new Set(options.checks ?? LISTING_CHECKS);
	const run = (args: readonly string[]) =>
		git(["-c", "core.fsmonitor=false", ...args], { cwd: at, env });
	const refused = (problem: ListingProblem) => ({ listing: null, problems: [problem] });

	const top = await run(["rev-parse", "--show-toplevel"]);
	if (top.code !== 0) return refused({ kind: "git", code: top.code });
	if (checks.has("toplevel") && !sameFolder(top.stdout.replace(/\r?\n$/, ""), at)) {
		return refused({ kind: "toplevel" });
	}
	const index = await run(["ls-files", "-s", "-z"]);
	if (index.code !== 0) return refused({ kind: "git", code: index.code });
	const others = await run(["ls-files", "-o", "--exclude-standard", "-z"]);
	if (others.code !== 0) return refused({ kind: "git", code: others.code });

	const entries: IndexEntry[] = [];
	const unmerged = new Set<string>();
	for (const record of index.stdout.split("\0")) {
		const tab = record.indexOf("\t");
		if (tab < 0) continue;
		const [mode = "", , stage = ""] = record.slice(0, tab).split(" ");
		const file = record.slice(tab + 1);
		if (stage !== "0") unmerged.add(file);
		entries.push({ mode, path: file });
	}
	const untracked: string[] = [];
	const nested: string[] = [];
	for (const file of others.stdout.split("\0")) {
		if (file === "") continue;
		// git lists a repository of its own below the root as its folder, and never looks inside.
		if (file.endsWith("/")) nested.push(file.slice(0, -1));
		else untracked.push(file);
	}

	const problems: ListingProblem[] = [];
	if (checks.has("unmerged") && unmerged.size > 0) {
		problems.push({ kind: "unmerged", paths: [...unmerged].toSorted() });
	}
	if (checks.has("nested") && nested.length > 0) {
		problems.push({ kind: "nested", paths: nested.toSorted() });
	}
	if (problems.length > 0) return { listing: null, problems };
	return { listing: { root: at, entries, untracked }, problems };
}

const TRIPWIRE = "reserved tripwire:";

// One line per problem; the caller adds the stop line once. names adds the paths, for the reserved
// files' maintainer.
export function listingLines(problems: readonly ListingProblem[], names = false): string[] {
	return problems.map((problem) => {
		if (problem.kind === "git")
			return `${TRIPWIRE} git exited ${problem.code}; nothing was checked`;
		if (problem.kind === "toplevel") {
			return `${TRIPWIRE} git listed another checkout than this one; nothing was checked`;
		}
		const line =
			problem.kind === "unmerged"
				? `${TRIPWIRE} ${problem.paths.length} unmerged index entry(ies); nothing was checked`
				: `${TRIPWIRE} ${problem.paths.length} nested repository(ies) that git doesn't list into; nothing was checked`;
		return names ? `${line}: ${problem.paths.join(", ")}` : line;
	});
}

const WORKSPACE = "pnpm-workspace.yaml";
// The manifests pnpm reads in a package folder.
const MANIFESTS = ["package.json", "package.yaml", "package.json5"];

// The listed paths of a listing, folded as the platform compares paths.
export function listedSet(listing: Listing): ReadonlySet<string> {
	return new Set(
		[...listing.entries.map((entry) => entry.path), ...listing.untracked].map((rel) => fold(rel)),
	);
}

// The workspace's package folders, from pnpm-workspace.yaml, and what is refused on the way: the
// workspace file itself when it is unlisted, not a regular file or unparsable; a folder a glob names
// that is a link, junction or redirect, or can't be listed; and a manifest in a package folder that
// isn't a regular, listed file. pnpm and turbo follow links, so a refused folder is never looked
// into. Names and kinds only: the workspace file is the one file read.
export function packageDirs(
	checkout: Checkout,
	listing: Listing,
): {
	readonly dirs: readonly string[];
	readonly refused: readonly { rel: string; kind: Kind | "unlisted" }[];
} {
	const listed = listedSet(listing);
	const dirs = new Set<string>();
	const refused: { rel: string; kind: Kind | "unlisted" }[] = [];
	const refuse = (rel: string, kind: Kind | "unlisted"): void => {
		if (!refused.some((item) => item.rel === rel)) refused.push({ rel, kind });
	};
	const plain = (rel: string): boolean | null => {
		const kind = checkout.kindOf(rel);
		if (kind === "missing") return null;
		if (kind === "file" && listed.has(fold(rel))) return true;
		refuse(rel, kind === "file" ? "unlisted" : kind);
		return false;
	};
	if (plain(WORKSPACE) !== true) return { dirs: [], refused };
	const text = checkout.readText(WORKSPACE);
	let globs: string[];
	try {
		if (text === "unreadable") throw new Error(text);
		globs = workspaceGlobsOf(text);
	} catch {
		refuse(WORKSPACE, "unreadable");
		return { dirs: [], refused };
	}
	const consider = (dir: string): void => {
		const found = MANIFESTS.map((name) => plain(`${dir}/${name}`));
		if (found.includes(true)) dirs.add(dir);
	};
	for (const glob of globs) {
		if (!glob.endsWith("/*")) {
			const kind = checkout.kindOf(glob);
			if (kind === "dir") consider(glob);
			else if (kind !== "missing" && kind !== "file" && kind !== "hardlink") refuse(glob, kind);
			continue;
		}
		const parent = glob.slice(0, -2);
		const children: { rel: string; kind: Kind }[] = [];
		const kind = checkout.walk(parent, (rel, found) => {
			children.push({ rel, kind: found });
			return false;
		});
		if (kind === "missing") continue;
		if (kind !== "dir") {
			refuse(parent, kind);
			continue;
		}
		for (const child of children) {
			// pnpm's glob leaves out dot folders and node_modules.
			const name = fold(path.posix.basename(child.rel));
			if (name.startsWith(".") || name === "node_modules") continue;
			if (child.kind === "dir") consider(child.rel);
			else if (child.kind === "link" || child.kind === "redirect" || child.kind === "unreadable") {
				refuse(child.rel, child.kind);
			}
		}
	}
	return { dirs: [...dirs].toSorted(), refused };
}
