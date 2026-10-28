import { readdir } from "node:fs/promises";
import path from "node:path";

// This is the complete approved workspace grammar, not an extraction of selected YAML keys.
const WORKSPACE_LINES = [
	"packages:",
	"  - apps/*",
	"  - packages/*",
	"  - plugins/*",
	"  - spikes/*",
	"  - tools/*",
	"minimumReleaseAge: 1440",
	"minimumReleaseAgeExclude: []",
	"allowBuilds: {}",
	"engineStrict: true",
	"savePrefix: ''",
	"verifyDepsBeforeRun: error",
] as const;

export function approvedWorkspace(text: string): boolean {
	if (/\r(?!\n)/.test(text)) return false;
	const lines = text
		.replace(/^\uFEFF/, "")
		.split(/\r?\n/)
		.map((line) => line.replace(/[ \t]+$/, ""))
		.filter((line) => !/^[ \t]*(?:#|$)/.test(line));
	return (
		lines.length === WORKSPACE_LINES.length && lines.every((line, i) => line === WORKSPACE_LINES[i])
	);
}

interface Entry {
	readonly name: string;
	isDirectory(): boolean;
	isSymbolicLink(): boolean;
}
export type ReadDirectory = (dir: string) => Promise<readonly Entry[]>;

// Directory names only: Git ignore rules and nested repositories cannot hide a copy.
// Links are inspected by name but never traversed outside the physical worktree or into a cycle.
export async function namedFiles(
	basename: string,
	root: string,
	insensitive: boolean = process.platform === "win32",
	readDirectory: ReadDirectory = (dir) => readdir(dir, { withFileTypes: true }),
): Promise<string[]> {
	if (!basename || /[/\\\0*?[\]]/.test(basename)) throw new Error("invalid basename");
	const equal = (name: string): boolean =>
		insensitive ? name.toLowerCase() === basename.toLowerCase() : name === basename;
	const pending = [""];
	const found: string[] = [];
	for (let next = 0; next < pending.length; ) {
		const batch = pending.slice(next, next + 4);
		next += batch.length;
		let entries: readonly (readonly Entry[])[];
		try {
			entries = await Promise.all(batch.map((dir) => readDirectory(path.join(root, dir))));
		} catch {
			throw new Error("file-name inventory failed");
		}
		for (const [index, children] of entries.entries()) {
			for (const entry of children) {
				const relative = path.posix.join(batch[index] ?? "", entry.name);
				if (equal(entry.name)) found.push(relative);
				if (entry.isDirectory() && !entry.isSymbolicLink()) pending.push(relative);
			}
		}
	}
	return found.toSorted();
}
