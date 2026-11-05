import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

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

interface Kind {
	isDirectory(): boolean;
	isSymbolicLink(): boolean;
}
interface Entry extends Kind {
	readonly name: string;
}
export type ReadDirectory = (dir: string) => Promise<readonly Entry[]>;
export type StatPath = (target: string) => Promise<Kind>;

const RETRY_DELAY_MS = 100;

const vanished = (error: unknown): boolean =>
	error instanceof Error &&
	"code" in error &&
	(error.code === "ENOENT" || error.code === "ENOTDIR");

const inventoryFailed = (): Error => new Error("file-name inventory failed");

// A failed lookup is not absence: filesystem names need not round-trip through strings.
// Confirm the exact entry is absent from a fresh, unambiguous parent listing instead.
async function missingDirectory(
	target: string,
	readDirectory: ReadDirectory,
	statPath: StatPath,
	boundary?: string,
): Promise<boolean> {
	let kind: Kind;
	try {
		kind = await statPath(target);
	} catch (error) {
		if (!vanished(error)) return false;
		return absentFromParent(target, readDirectory, statPath, boundary);
	}
	if (!kind.isDirectory() || kind.isSymbolicLink()) throw inventoryFailed();
	return false;
}

async function absentFromParent(
	target: string,
	readDirectory: ReadDirectory,
	statPath: StatPath,
	boundary?: string,
): Promise<boolean> {
	if (target === boundary || path.dirname(target) === target) return false;
	const parent = path.dirname(target);
	let entries: readonly Entry[];
	try {
		entries = await readDirectory(parent);
	} catch {
		return missingDirectory(parent, readDirectory, statPath, boundary);
	}
	const names = entries.map((entry) => entry.name);
	if (
		names.some(
			(name) =>
				name.length === 0 ||
				!name.isWellFormed() ||
				name.includes("\uFFFD") ||
				path.basename(name) !== name ||
				name === "." ||
				name === "..",
		) ||
		new Set(names).size !== names.length
	)
		return false;
	return !names.includes(path.basename(target));
}

// Directory names only: Git ignore rules and nested repositories cannot hide a copy.
// Links are inspected by name but never traversed outside the physical worktree or into a cycle.
export async function namedFiles(
	basename: string,
	root: string,
	insensitive: boolean = process.platform === "win32",
	readDirectory: ReadDirectory = (dir) => readdir(dir, { withFileTypes: true }),
	statPath: StatPath = (target) => lstat(target),
): Promise<string[]> {
	if (!basename || /[/\\\0*?[\]]/.test(basename)) throw new Error("invalid basename");
	root = path.resolve(root);
	const rootPrefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
	const wanted = insensitive ? basename.toLowerCase() : basename;
	const dotWanted = wanted.charCodeAt(0) === 0x2e;
	const equal = (name: string): boolean => {
		if (!insensitive) return name === wanted;
		// A non-dot ASCII first code unit cannot lowercase to the target's leading dot.
		// Every other name retains the complete comparison, including Unicode expansion.
		if (dotWanted) {
			const first = name.charCodeAt(0);
			if (first <= 0x7f && first !== 0x2e) return false;
		}
		return name.toLowerCase() === wanted;
	};
	const relativeName = (directory: string, name: string): string =>
		directory === "." ||
		directory.endsWith("/") ||
		name === "" ||
		name === "." ||
		name === ".." ||
		name.includes("/")
			? path.posix.join(directory, name)
			: directory === ""
				? name
				: `${directory}/${name}`;
	const attempt = async (target: string): Promise<readonly Entry[] | undefined> => {
		try {
			return await readDirectory(target);
		} catch {
			return undefined;
		}
	};
	// A replacement link or file refuses validation instead of being followed by a retry.
	const gone = (target: string): Promise<boolean> =>
		missingDirectory(target, readDirectory, statPath, root);
	// Other checkouts add and remove folders mid-walk. The root must list; below it, a vanished
	// folder is skipped and any other failed folder is listed once more before validation is refused.
	const list = async (dir: string | undefined, target: string): Promise<readonly Entry[]> => {
		if (dir === "") return readDirectory(target);
		let first: readonly Entry[] | undefined;
		try {
			first = await readDirectory(target);
		} catch {
			// Failed reads retain the fresh disappearance proof and bounded retry below.
		}
		if (first) return first;
		if (await gone(target)) return [];
		await sleep(RETRY_DELAY_MS);
		const second = await attempt(target);
		if (second) {
			let kind: Kind;
			try {
				kind = await statPath(target);
			} catch (error) {
				if (vanished(error) && (await absentFromParent(target, readDirectory, statPath, root)))
					return [];
				throw inventoryFailed();
			}
			if (!kind.isDirectory() || kind.isSymbolicLink()) throw inventoryFailed();
			return second;
		}
		if (await gone(target)) return [];
		throw new Error("file-name inventory failed");
	};
	type PendingDirectory = {
		readonly directory: string | undefined;
		readonly target: string;
		readonly plain: boolean;
		next?: PendingDirectory;
	};
	let first: PendingDirectory | undefined = { directory: "", target: root, plain: true };
	const found: string[] = [];
	await new Promise<void>((resolve, reject) => {
		let active = 0;
		let failed = false;
		const visit = async (
			directory: string | undefined,
			absolute: string,
			plainAncestry: boolean,
		): Promise<void> => {
			try {
				const children = await list(directory, absolute);
				if (failed) return;
				let discoveredFirst: PendingDirectory | undefined;
				let discoveredLast: PendingDirectory | undefined;
				for (const entry of children) {
					const name = entry.name;
					if (typeof name !== "string" || !name.isWellFormed() || name.includes("\uFFFD"))
						throw inventoryFailed();
					const matches = equal(name);
					const descend = entry.isDirectory() && !entry.isSymbolicLink();
					// Ordinary files need no relative path; keep normalization for synthetic edge names.
					if (matches || descend) {
						// Ordinary components can extend an already-normalized native target. Keep the
						// original whole-path normalization for every unusual component and descendant.
						const plain =
							plainAncestry &&
							name !== "" &&
							name !== "." &&
							name !== ".." &&
							!/[\\/:\0]/.test(name);
						// Plain queued directories need only their native target. Materialize a relative
						// path for a match or the first unusual component, never by resolving/casefolding.
						const relative =
							matches || !plain
								? relativeName(
										directory ?? absolute.slice(rootPrefix.length).replaceAll(path.sep, "/"),
										name,
									)
								: undefined;
						if (matches) {
							if (relative === undefined) throw inventoryFailed();
							found.push(relative);
						}
						if (!descend) continue;
						let target: string;
						if (plain) target = `${absolute}${absolute.endsWith(path.sep) ? "" : path.sep}${name}`;
						else {
							if (relative === undefined) throw inventoryFailed();
							target = path.join(root, relative);
						}
						const pending: PendingDirectory = {
							directory: plain ? undefined : relative,
							target,
							plain,
						};
						if (discoveredLast) discoveredLast.next = pending;
						else discoveredFirst = pending;
						discoveredLast = pending;
					}
				}
				// Keep each listing's order, but descend before older pending siblings instead
				// of retaining every directory in a breadth-level frontier at once.
				if (discoveredLast) {
					discoveredLast.next = first;
					first = discoveredFirst;
				}
			} catch {
				failed = true;
				first = undefined;
			} finally {
				active -= 1;
				advance();
			}
		};
		const advance = (): void => {
			// Refill each free slot immediately; a slow sibling must not stall the whole frontier.
			while (!failed && active < 4 && first) {
				const current = first;
				first = current.next;
				active += 1;
				// Passing only values prevents a slow read from retaining a dequeued node's tail.
				void visit(current.directory, current.target, current.plain);
			}
			// Stop admitting work on failure, but drain every read already in flight before settling.
			if (active === 0) {
				if (failed) reject(inventoryFailed());
				else resolve();
			}
		};
		advance();
	});
	return found.toSorted();
}

export interface ListedWorktree {
	readonly directory: string;
	readonly prunable: boolean;
}

/** NUL porcelain preserves whitespace/newlines in paths; malformed or lossy listings refuse. */
export function listedWorktrees(text: string): readonly ListedWorktree[] {
	if (!text.endsWith("\0\0")) throw inventoryFailed();
	const records = text.slice(0, -2).split("\0\0");
	const result = records.map((record) => {
		const fields = record.split("\0");
		const directories = fields.filter((field) => field.startsWith("worktree "));
		const prunable = fields.filter((field) => /^prunable(?: |$)/.test(field));
		const directory = directories[0]?.slice("worktree ".length) ?? "";
		if (
			directories.length !== 1 ||
			fields[0] !== directories[0] ||
			prunable.length > 1 ||
			!path.isAbsolute(directory) ||
			!directory.isWellFormed() ||
			directory.includes("\uFFFD")
		)
			throw inventoryFailed();
		return { directory, prunable: prunable.length === 1 };
	});
	return result;
}

/** A root can disappear only with fresh Git confirmation, never from a failed lookup alone. */
export async function namedWorktreeFiles(
	basename: string,
	root: string,
	refreshWorktrees: () => Promise<readonly ListedWorktree[]>,
	insensitive: boolean = process.platform === "win32",
	readDirectory: ReadDirectory = (dir) => readdir(dir, { withFileTypes: true }),
	statPath: StatPath = (target) => lstat(target),
): Promise<string[]> {
	try {
		try {
			const found = await namedFiles(basename, root, insensitive, readDirectory, statPath);
			const kind = await statPath(root);
			if (!kind.isDirectory() || kind.isSymbolicLink()) throw inventoryFailed();
			return found;
		} catch {
			if (!(await missingDirectory(root, readDirectory, statPath))) throw inventoryFailed();
		}
		const key = (directory: string): string => {
			if (!path.isAbsolute(directory) || !directory.isWellFormed() || directory.includes("\uFFFD"))
				throw inventoryFailed();
			const resolved = path.resolve(directory);
			return insensitive ? resolved.toLowerCase() : resolved;
		};
		const entries = await refreshWorktrees();
		if (entries.length === 0) throw inventoryFailed();
		const keys = entries.map(({ directory, prunable }) => {
			if (typeof prunable !== "boolean") throw inventoryFailed();
			return key(directory);
		});
		if (new Set(keys).size !== keys.length) throw inventoryFailed();
		const registered = entries[keys.indexOf(key(root))];
		if (registered !== undefined && !registered.prunable) throw inventoryFailed();
		return [];
	} catch {
		throw inventoryFailed();
	}
}
