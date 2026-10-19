import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { appendSummary, cliArgs, git, revision, runCli, setOutputs } from "./lib.ts";

export interface Areas {
	readonly docsOnly: boolean;
	readonly ts: boolean;
	readonly workflows: boolean;
	readonly rust: readonly string[];
	readonly spikes: readonly string[];
	// Turbo filters for the product packages whose test:heavy `full` runs.
	readonly heavy: readonly string[];
	readonly templateSmoke: boolean;
	// Rust that no Cargo.toml builds: sources and lock files outside every workspace, and Cargo
	// manifests under another name.
	readonly strayRust: readonly string[];
}

const communityFiles = new Set(["LICENSE", "NOTICE", "THIRD_PARTY_NOTICES"]);
const toolchainFiles = new Set(["rust-toolchain.toml", "rust-toolchain"]);
// Every heavy suite depends on these; so does pnpm-lock.yaml when no package.json changed.
const globalFiles = new Set([
	".node-version",
	"tools/fetch-node/versions.json",
	"pnpm-workspace.yaml",
	"package.json",
	"turbo.json",
	"tsconfig.base.json",
	"vitest.shared.ts",
]);
const protocol = "packages/protocol";
const smokePackages = new Set([
	"packages/create-plugin",
	"packages/plugin-testkit",
	"packages/sdk",
]);
const inCrates = (workspace: string): boolean =>
	workspace === "crates" || workspace.startsWith("crates/");

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

// cargo reads only manifests named Cargo.toml, so a [package] or [workspace] table in any other
// TOML file is a manifest that no rust step would ever build.
const cargoTable = /^[ \t]*\[(?:package|workspace)\][ \t]*(?:#.*)?$/m;
function strayRustFile(root: string, file: string, inWorkspace: boolean): boolean {
	const full = path.join(root, file);
	if (!existsSync(full)) return false;
	const base = path.posix.basename(file);
	if (file.endsWith(".toml") && base !== "Cargo.toml")
		return cargoTable.test(readFileSync(full, "utf8"));
	return !inWorkspace && (file.endsWith(".rs") || base === "Cargo.lock");
}

function tracked(root: string): string[] {
	return git(["ls-files", "-z"], root).split("\0").filter(Boolean);
}

const isPackage = (root: string, dir: string): boolean =>
	existsSync(path.join(root, dir, "package.json"));

// Every package under packages/ and plugins/ with a test:heavy script, then tools/verify.
function heavyPackages(root: string): string[] {
	const dirs = ["packages", "plugins"].flatMap((parent) =>
		existsSync(path.join(root, parent))
			? readdirSync(path.join(root, parent)).map((name) => `${parent}/${name}`)
			: [],
	);
	const heavy = dirs.filter((dir) => {
		if (!isPackage(root, dir)) return false;
		const manifest = JSON.parse(readFileSync(path.join(root, dir, "package.json"), "utf8"));
		return typeof manifest?.scripts?.["test:heavy"] === "string";
	});
	return isPackage(root, "tools/verify") ? [...heavy, "tools/verify"] : heavy;
}

// Rust kept tests and clippy run in their spike's test:heavy, so a Rust workspace selects its spike
// and a spike selects its workspaces (for the toolchain and cache steps). crates/ is checked by the
// rust verify profile, and packages/protocol's cross-language tests need its toolchain.
export function classify(
	files: readonly string[],
	root: string,
	allFiles: () => readonly string[] = () => tracked(root),
): Areas {
	let docsOnly = files.length > 0;
	let ts = false;
	let workflows = false;
	let global = false;
	let templateSmoke = false;
	const rust = new Set<string>();
	const spikes = new Set<string>();
	const alone = new Set<string>();
	const strayRust = new Set<string>();
	const withDependents = new Set<string>();
	let manifests: readonly string[] | undefined;
	const allManifests = (): readonly string[] =>
		(manifests ??= allFiles().filter((file) => path.posix.basename(file) === "Cargo.toml"));
	const addSpike = (file: string): void => {
		const id = /^spikes\/([^/]+)\//.exec(file)?.[1];
		if (id && existsSync(path.join(root, "spikes", id, "package.json"))) spikes.add(`spikes/${id}`);
	};
	// crates/ is one workspace, whatever its manifests say: the rust step checks it as a whole and
	// fails on a Cargo.toml that isn't the root or a member.
	const inCratesWorkspace = (file: string): boolean =>
		file.startsWith("crates/") && allManifests().some((manifest) => manifest.startsWith("crates/"));
	const addWorkspace = (file: string): boolean => {
		const workspace = inCratesWorkspace(file) ? "crates" : rustWorkspace(root, file);
		if (workspace === undefined) return false;
		rust.add(workspace);
		addSpike(`${workspace}/`);
		return true;
	};
	const noPackageJson = !files.some((file) => path.posix.basename(file) === "package.json");
	for (const file of files) {
		if (isDocs(file)) continue;
		docsOnly = false;
		addSpike(file);
		if (file.startsWith(".github/")) workflows = true;
		else if (toolchainFiles.has(file)) {
			for (const manifest of allManifests()) addWorkspace(manifest);
			alone.add(protocol);
		} else {
			const inWorkspace = addWorkspace(file);
			if (!inWorkspace) ts = true;
			if (strayRustFile(root, file, inWorkspace)) strayRust.add(file);
		}
		if (globalFiles.has(file) || (file === "pnpm-lock.yaml" && noPackageJson)) global = true;
		const pkg = /^(?:packages|plugins)\/[^/]+(?=\/)/.exec(file)?.[0];
		if (pkg !== undefined && isPackage(root, pkg)) withDependents.add(pkg);
		if (pkg !== undefined && smokePackages.has(pkg)) templateSmoke = true;
		// Protocol's cross-language tests cover crates/ and the shared vectors; its dependents don't.
		if (file.startsWith("crates/") || file.startsWith("spec/vectors/")) alone.add(protocol);
	}
	for (const spike of [...spikes]) {
		for (const manifest of allManifests()) {
			if (manifest.startsWith(`${spike}/`)) addWorkspace(manifest);
		}
	}
	if (global) {
		templateSmoke = true;
		for (const dir of heavyPackages(root)) alone.add(dir);
	}
	const heavy = [
		...[...withDependents].map((dir) => `...{./${dir}}`),
		...[...alone]
			.filter((dir) => !withDependents.has(dir) && isPackage(root, dir))
			.map((dir) => `./${dir}`),
	];
	if (withDependents.has(protocol) || heavy.includes(`./${protocol}`)) {
		for (const manifest of allManifests()) {
			if (manifest.startsWith("crates/")) addWorkspace(manifest);
		}
	}
	return {
		docsOnly,
		ts,
		workflows,
		rust: [...rust].sort(),
		spikes: [...spikes].sort(),
		heavy: heavy.sort(),
		templateSmoke,
		strayRust: [...strayRust].sort(),
	};
}

// Rust workspaces outside every spike package and crates/: no job would run their tests.
export function untestedRust(areas: Areas): string[] {
	return areas.rust.filter(
		(ws) => !inCrates(ws) && !areas.spikes.some((spike) => `${ws}/`.startsWith(`${spike}/`)),
	);
}

export function areaNames(areas: Areas): string[] {
	if (areas.docsOnly) return ["docs-only"];
	return [
		...(areas.ts ? ["ts"] : []),
		...(areas.workflows ? ["workflows"] : []),
		...areas.rust.map((workspace) => `rust:${workspace}`),
		...areas.spikes,
		...areas.heavy.map((filter) => `heavy:${filter}`),
		...(areas.templateSmoke ? ["template-smoke"] : []),
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
		console.log(`changes: no spike package's test:heavy or crates/ runs ${untested.join(", ")}`);
		return 1;
	}
	if (areas.strayRust.length > 0) {
		const stray = areas.strayRust.join(", ");
		console.log(`changes: no Cargo.toml builds ${stray}, so nothing tests it`);
		return 1;
	}
	setOutputs({
		areas: JSON.stringify(names),
		"docs-only": String(areas.docsOnly),
		ts: String(areas.ts),
		workflows: String(areas.workflows),
		rust: areas.rust.join("\n"),
		spikes: areas.spikes.join("\n"),
		heavy: areas.heavy.join("\n"),
		"template-smoke": String(areas.templateSmoke),
	});
	appendSummary(`### Changed areas\n\n${names.map((name) => `- ${name}`).join("\n") || "none"}`);
	return 0;
}

if (import.meta.main) await runCli("changes", () => main(process.argv.slice(2)));
