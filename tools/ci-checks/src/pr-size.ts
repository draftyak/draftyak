import path from "node:path";
import { cliArgs, git, revision, runCli } from "./lib.ts";

export interface FileStat {
	readonly file: string;
	readonly added: number;
	readonly deleted: number;
}

// Owner decision, 2026-10-17 ("Count code, not tests"): only code, meaning source and configuration
// files, counts toward the ~1,500-line guideline. The other categories are reported, not counted.
export type Category =
	| "code"
	| "tests"
	| "docs"
	| "lockfiles"
	| "wrappers"
	| "vendored"
	| "vectors"
	| "generated"
	| "evidence";

const uncounted: Readonly<Record<Exclude<Category, "code">, string>> = {
	tests: "tests and fixtures",
	docs: "prose docs",
	lockfiles: "lockfiles",
	wrappers: "generated wrapper files",
	vendored: "vendored upstream files",
	vectors: "generated vectors",
	generated: "generated schemas",
	evidence: "evidence JSON",
};

const lockfiles = new Set(["pnpm-lock.yaml", "Cargo.lock", "uv.lock", "package-lock.json"]);

// The first match wins, so vendored and generated files keep their category inside test folders.
// Test helpers live under test/, tests/ or __tests__/.
export function category(file: string): Category {
	const name = path.posix.basename(file);
	if (lockfiles.has(name) || name.endsWith(".lock.json")) return "lockfiles";
	if (name === "gradlew" || name === "gradlew.bat" || /(?:^|\/)gradle\/wrapper\//.test(file)) {
		return "wrappers";
	}
	if (/(?:^|\/)vendor\//.test(file)) return "vendored";
	// Generated vector data only; the generators under packages/protocol/scripts/vectors/ are code.
	if (/^(?:spec|spikes\/[^/]+)\/vectors\//.test(file)) return "vectors";
	// JSON Schemas that @draftyak/protocol exports to spec/; a drift test checks them.
	if (/^spec\/(?:[^/]+\/)*[^/]+\.schema\.json$/.test(file)) return "generated";
	if (/^spikes\/[^/]+\/evidence\//.test(file)) return "evidence";
	if (/(?:^|\/)(?:test|tests|__tests__|fixtures)\//.test(file) || name.includes(".test.")) {
		return "tests";
	}
	if (/\.md$/i.test(name) || name === "LICENSE" || name === "NOTICE") return "docs";
	return "code";
}

// `git diff --numstat -z`: "added\tdeleted\tpath\0", or "added\tdeleted\t\0from\0to\0" for a
// rename; binary files show "-".
export function parseNumstat(output: string): FileStat[] {
	const fields = output.split("\0");
	const stats: FileStat[] = [];
	for (let at = 0; at < fields.length; at++) {
		const match = /^(-|\d+)\t(-|\d+)\t([\s\S]*)$/.exec(fields[at] ?? "");
		if (!match) continue;
		let file = match[3] ?? "";
		if (file === "") {
			file = fields[at + 2] ?? "";
			at += 2;
		}
		stats.push({ file, added: Number(match[1]) || 0, deleted: Number(match[2]) || 0 });
	}
	return stats;
}

export interface Size {
	readonly raw: number;
	readonly counted: number;
	readonly byCategory: Readonly<Record<Category, number>>;
	readonly files: number;
}

export function measure(stats: readonly FileStat[]): Size {
	const byCategory: Record<Category, number> = {
		code: 0,
		tests: 0,
		docs: 0,
		lockfiles: 0,
		wrappers: 0,
		vendored: 0,
		vectors: 0,
		generated: 0,
		evidence: 0,
	};
	for (const stat of stats) byCategory[category(stat.file)] += stat.added + stat.deleted;
	const raw = Object.values(byCategory).reduce((sum, lines) => sum + lines, 0);
	return { raw, counted: byCategory.code, byCategory, files: stats.length };
}

export function sizeBand(lines: number): string {
	if (lines <= 400) return "S";
	if (lines <= 900) return "M";
	return lines <= 1500 ? "L" : "over ~1,500";
}

const count = (lines: number): string => lines.toLocaleString("en-US");

export function report(size: Size): string[] {
	const width = count(size.raw).length;
	const row = (indent: number, label: string, lines: number): string =>
		`${" ".repeat(indent)}${label.padEnd(28 - indent)}${count(lines).padStart(width)} lines`;
	return [
		`${row(2, "counted code", size.counted)}: ${sizeBand(size.counted)}`,
		"  not counted:",
		...Object.entries(uncounted).map(([key, label]) =>
			row(4, label, size.byCategory[key as Category]),
		),
		row(2, "raw total", size.raw),
	];
}

// mN-<nn>-<slug> is item MN.<nn> going into mN; mN itself goes into main.
export function itemOf(branch: string): { id: string; into: string } | undefined {
	const item = /^m(\d+[a-z]?)-(\d{2})([a-z]?)-[a-z0-9]+(?:-[a-z0-9]+)*$/.exec(branch);
	if (item) return { id: `M${item[1]}.${Number(item[2])}${item[3]}`, into: `m${item[1]}` };
	const milestone = /^m(\d+[a-z]?)$/.exec(branch);
	return milestone ? { id: `M${milestone[1]}`, into: "main" } : undefined;
}

function main(argv: readonly string[]): number {
	const args = cliArgs(argv, ["base"]);
	const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]).trim();
	const item = itemOf(branch);
	// A PR is measured against the remote branch it merges into.
	const base = args.base ? revision(args.base, "--base") : item && `origin/${item.into}`;
	if (!base) throw new Error(`${branch} isn't an item or milestone branch; pass --base <rev>`);
	const size = measure(parseNumstat(git(["diff", "--numstat", "-z", "-M", `${base}...HEAD`])));
	console.log(`pr-size: ${item?.id ?? branch}, ${branch} against ${base}, ${size.files} files`);
	for (const line of report(size)) console.log(line);
	if (git(["status", "--porcelain"]).trim() !== "") {
		console.log("  uncommitted changes aren't included");
	}
	return 0;
}

if (import.meta.main) await runCli("pr-size", () => main(process.argv.slice(2)));
