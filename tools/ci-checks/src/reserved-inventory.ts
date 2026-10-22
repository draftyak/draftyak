import { readFileSync } from "node:fs";
import path from "node:path";
import { reservedWord } from "../../../reserved-tests.ts";
import { isFork } from "./commit-identity.ts";
import { exec, revision, runCli, UsageError } from "./lib.ts";

// tools/verify/reserved-inventory.json holds the reserved suites' minimum passed counts, which
// only their maintainer changes. A PR may add rows or raise minimums. Removing a row, lowering a
// minimum, raising maxSkipped or changing a tier needs both the maintainer's own branch (this
// repository's, its name holding a reserved word; never printed) and a change, rename or deletion of
// that row's own file in the same PR: a branch name alone is no identity. Output names rows by
// number only.
export const INVENTORY = "tools/verify/reserved-inventory.json";

interface Row {
	readonly key: string;
	readonly tier: unknown;
	readonly minPassed: number;
	readonly maxSkipped: number;
	// Whether a changed path is this row's own test file.
	readonly own: (file: string) => boolean;
}

function rows(text: string, side: "base" | "head"): Row[] {
	let value: {
		files?: { file?: unknown; tier?: unknown; minPassed?: unknown; maxSkipped?: unknown }[];
	};
	try {
		value = JSON.parse(text);
	} catch {
		// JSON.parse's message quotes the text, which names reserved files.
		throw new UsageError(`the ${side}'s inventory isn't valid JSON`);
	}
	const number = (value: unknown, fallback: number): number =>
		typeof value === "number" ? value : fallback;
	return (value.files ?? []).map((row) => ({
		key: `file ${String(row.file)}`,
		tier: row.tier,
		minPassed: number(row.minPassed, 0),
		maxSkipped: number(row.maxSkipped, 0),
		own: (file: string) => file === row.file,
	}));
}

export interface Change {
	// The base's row number, and what the change takes away.
	readonly row: number;
	readonly what: string;
	readonly own: (file: string) => boolean;
}

// What a change takes away, by the base's row numbers; empty when it only adds or raises.
export function loosened(base: string, head: string): Change[] {
	const after = new Map(rows(head, "head").map((row) => [row.key, row]));
	return rows(base, "base").flatMap((row, index) => {
		const at = index + 1;
		const change = (what: string): Change => ({ row: at, what, own: row.own });
		const now = after.get(row.key);
		if (now === undefined) return [change("was removed or renamed")];
		const found: Change[] = [];
		if (now.tier !== row.tier) found.push(change("changed its tier"));
		if (now.minPassed < row.minPassed) found.push(change("lowered minPassed"));
		if (now.maxSkipped > row.maxSkipped) found.push(change("raised maxSkipped"));
		return found;
	});
}

export const describeChange = (change: Change): string => `row ${change.row} ${change.what}`;

// The paths `git diff --name-status -z -M` names: both sides of a rename or copy.
export function changedPaths(nameStatus: string): Set<string> {
	const files = new Set<string>();
	const fields = nameStatus.split("\0");
	for (let i = 0; i < fields.length; ) {
		const status = fields[i] ?? "";
		if (status === "") {
			i++;
			continue;
		}
		const count = /^[RC]/.test(status) ? 2 : 1;
		for (const file of fields.slice(i + 1, i + 1 + count)) if (file) files.add(file);
		i += 1 + count;
	}
	return files;
}

export interface Branch {
	readonly headRef: string | undefined;
	readonly headRepo: string | undefined;
	readonly baseRepo: string | undefined;
}

// The maintainer works on this repository's own branches whose names hold a reserved word.
export const maintainers = (branch: Branch): boolean =>
	!!branch.baseRepo &&
	!isFork(branch.headRepo, branch.baseRepo) &&
	reservedWord.test(branch.headRef ?? "");

// The changes neither the maintainer's branch nor a change to each row's own file accounts for.
export function unaccounted(
	changes: readonly Change[],
	branch: Branch,
	changed: ReadonlySet<string>,
): Change[] {
	if (!maintainers(branch)) return [...changes];
	return changes.filter((change) => ![...changed].some((file) => change.own(file)));
}

function main(root: string = process.cwd()): number {
	const env = process.env;
	const sha = env.BASE_SHA ?? "";
	if (sha === "" || /^0+$/.test(sha)) {
		console.log("reserved-inventory: no base commit to compare with");
		return 0;
	}
	const base = revision(sha, "BASE_SHA");
	const now = readFileSync(path.join(root, INVENTORY), "utf8");
	// Only a base commit without the file is a first appearance; a base git can't read fails.
	if (exec("git", ["ls-tree", "--name-only", base, "--", INVENTORY], root).trim() === "") {
		const count = rows(now, "head").length;
		console.log(
			`reserved-inventory: the base has no inventory yet, so all ${count} row(s) are new`,
		);
		return 0;
	}
	const before = exec("git", ["show", `${base}:${INVENTORY}`], root);
	const changes = loosened(before, now);
	if (changes.length === 0) {
		console.log("reserved-inventory: every base row is kept, at or above its minimum");
		return 0;
	}
	const branch = { headRef: env.HEAD_REF, headRepo: env.HEAD_REPO, baseRepo: env.BASE_REPO };
	const changed = changedPaths(exec("git", ["diff", "--name-status", "-z", "-M", base], root));
	const left = unaccounted(changes, branch, changed);
	if (left.length === 0) {
		console.log(
			`reserved-inventory: the maintainer's branch changes ${changes.length} row(s), each with its own file`,
		);
		return 0;
	}
	console.log(
		`reserved-inventory: ${left.length} change(s) loosen the reserved suites' inventory, which only their maintainer changes, together with each row's own file:`,
	);
	for (const change of left) console.log(`  ${describeChange(change)}`);
	console.log(
		"reserved-inventory: leave the file as the base has it and ask the reserved files' maintainer",
	);
	return 1;
}

if (import.meta.main) await runCli("reserved-inventory", () => main());
