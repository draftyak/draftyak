import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { appendSummary, cliArgs, git, revision, runCli, setOutputs } from "./lib.ts";

export interface Areas {
	readonly docsOnly: boolean;
	readonly ts: boolean;
	readonly workflows: boolean;
	readonly rust: readonly string[];
	readonly spikes: readonly string[];
}

const communityFiles = new Set(["LICENSE", "NOTICE", "THIRD_PARTY_NOTICES"]);
const toolchainFiles = new Set(["rust-toolchain.toml", "rust-toolchain"]);

// Markdown, the community files without an extension, and spike evidence.
export function isDocs(file: string): boolean {
	return /\.md$/i.test(file) || communityFiles.has(file) || /^spikes\/[^/]+\/evidence\//.test(file);
}

// The Cargo workspace holding a file: the nearest [workspace] manifest above it, else the nearest
// package. Each Rust spike is its own workspace; the repo root never is one.
export function rustWorkspace(root: string, file: string): string | undefined {
	let nearest: string | undefined;
	for (let dir = path.posix.dirname(file); dir !== "."; dir = path.posix.dirname(dir)) {
		const manifest = path.join(root, dir, "Cargo.toml");
		if (!existsSync(manifest)) continue;
		if (/^\s*\[workspace\]/m.test(readFileSync(manifest, "utf8"))) return dir;
		nearest ??= dir;
	}
	return nearest;
}

function tracked(root: string): string[] {
	return git(["ls-files", "-z"], root).split("\0").filter(Boolean);
}

// Rust kept tests and clippy run in their spike's test:heavy, so a Rust workspace selects its spike
// and a spike selects its workspaces (for the toolchain and cache steps).
export function classify(
	files: readonly string[],
	root: string,
	allFiles: () => readonly string[] = () => tracked(root),
): Areas {
	let docsOnly = files.length > 0;
	let ts = false;
	let workflows = false;
	const rust = new Set<string>();
	const spikes = new Set<string>();
	let manifests: readonly string[] | undefined;
	const allManifests = (): readonly string[] =>
		(manifests ??= allFiles().filter((file) => path.posix.basename(file) === "Cargo.toml"));
	const addSpike = (file: string): void => {
		const id = /^spikes\/([^/]+)\//.exec(file)?.[1];
		if (id && existsSync(path.join(root, "spikes", id, "package.json"))) spikes.add(`spikes/${id}`);
	};
	const addWorkspace = (file: string): boolean => {
		const workspace = rustWorkspace(root, file);
		if (workspace === undefined) return false;
		rust.add(workspace);
		addSpike(`${workspace}/`);
		return true;
	};
	for (const file of files) {
		if (isDocs(file)) continue;
		docsOnly = false;
		addSpike(file);
		if (file.startsWith(".github/")) workflows = true;
		else if (toolchainFiles.has(file)) {
			for (const manifest of allManifests()) addWorkspace(manifest);
		} else if (!addWorkspace(file)) ts = true;
	}
	for (const spike of [...spikes]) {
		for (const manifest of allManifests()) {
			if (manifest.startsWith(`${spike}/`)) addWorkspace(manifest);
		}
	}
	return { docsOnly, ts, workflows, rust: [...rust].sort(), spikes: [...spikes].sort() };
}

// Rust workspaces outside every spike package: no job would run their tests.
export function untestedRust(areas: Areas): string[] {
	return areas.rust.filter((ws) => !areas.spikes.some((spike) => `${ws}/`.startsWith(`${spike}/`)));
}

export function areaNames(areas: Areas): string[] {
	if (areas.docsOnly) return ["docs-only"];
	return [
		...(areas.ts ? ["ts"] : []),
		...(areas.workflows ? ["workflows"] : []),
		...areas.rust.map((workspace) => `rust:${workspace}`),
		...areas.spikes,
	];
}

function main(argv: readonly string[]): number {
	const args = cliArgs(argv, ["base", "head"]);
	const root = git(["rev-parse", "--show-toplevel"]).trim();
	const base = args.base ?? process.env.BASE_SHA ?? "";
	const head = revision(args.head ?? (process.env.HEAD_SHA || "HEAD"), "head");
	let files: readonly string[];
	let scope: string;
	if (base === "" || /^0+$/.test(base)) {
		files = tracked(root);
		scope = "no base revision, so every area";
	} else {
		const range = `${revision(base, "base")}...${head}`;
		try {
			files = git(["diff", "--name-only", "-z", "--no-renames", range], root)
				.split("\0")
				.filter(Boolean);
			scope = range;
		} catch (error) {
			files = tracked(root);
			scope = `diff failed (${error instanceof Error ? error.message : error}), so every area`;
		}
	}
	const areas = classify(files, root);
	const names = areaNames(areas);
	console.log(`changes: ${scope}: ${files.length} files: ${names.join(", ") || "no areas"}`);
	const untested = untestedRust(areas);
	if (untested.length > 0) {
		console.log(`changes: no spike package's test:heavy runs ${untested.join(", ")}`);
		return 1;
	}
	setOutputs({
		areas: JSON.stringify(names),
		"docs-only": String(areas.docsOnly),
		ts: String(areas.ts),
		workflows: String(areas.workflows),
		rust: areas.rust.join("\n"),
		spikes: areas.spikes.join("\n"),
	});
	appendSummary(`### Changed areas\n\n${names.map((name) => `- ${name}`).join("\n") || "none"}`);
	return 0;
}

if (import.meta.main) await runCli("changes", () => main(process.argv.slice(2)));
