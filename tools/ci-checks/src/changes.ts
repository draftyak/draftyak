import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { appendSummary, cliArgs, git, revision, runCli, setOutputs } from "./lib.ts";
import { parseYaml, type Yaml } from "./yaml.ts";

export interface Areas {
	readonly docsOnly: boolean;
	readonly ts: boolean;
	readonly workflows: boolean;
	readonly rust: readonly string[];
	readonly spikes: readonly string[];
}

const communityFiles = new Set(["LICENSE", "NOTICE", "THIRD_PARTY_NOTICES"]);
const toolchainFiles = new Set(["rust-toolchain.toml", "rust-toolchain"]);
const sharedSpikeFiles = new Set([
	".node-version",
	"package.json",
	"pnpm-lock.yaml",
	"pnpm-workspace.yaml",
	".npmrc",
	"turbo.json",
	"tsconfig.json",
	"tsconfig.base.json",
	"vitest.config.ts",
	"vitest.shared.ts",
	"tools/verify/turbo.ts",
	"tools/ci-checks/src/changes.ts",
	"tools/ci-checks/src/yaml.ts",
	".github/workflows/ci.yml",
]);

// Resolved workspace edges only; external dependencies are irrelevant to the reverse graph.
export interface WorkspacePackage {
	readonly folder: string;
	readonly dependencies: readonly string[];
}

const folderName = (folder: string): boolean =>
	folder === "." ||
	folder.split("/").every((part) => /^[a-z0-9_@.-]+$/i.test(part) && part !== "." && part !== "..");
const object = (value: Yaml | undefined): value is { [key: string]: Yaml } =>
	typeof value === "object" && value !== null && !Array.isArray(value);

// Only the lockfile's importer metadata is needed. No package manifest or package code is read.
// Adapt folder keys and empty maps to the strict workflow YAML subset; unsupported YAML refuses.
export function workspacePackages(source: string): WorkspacePackage[] {
	const headers = [...source.matchAll(/^importers:\s*$/gm)];
	if (headers.length !== 1) throw new Error("expected one lockfile importers map");
	const start = headers[0]?.index ?? 0;
	const tail = source.slice(start).split(/\r?\n/);
	const end = tail.findIndex((line, index) => index > 0 && /^[^\s#]/.test(line));
	const lines = tail.slice(0, end < 0 ? undefined : end).map((line) => {
		if (/^\s*['"]?__proto__['"]?:/.test(line)) throw new Error("invalid importer key");
		const folder = /^ {2}([^'" ].*?):(?=\s|$)/.exec(line);
		if (folder) line = `  ${JSON.stringify(folder[1])}:${line.slice(folder[0].length)}`;
		return line.replace(/:\s*\{\}\s*(?:#.*)?$/, ":");
	});
	const parsed = parseYaml(lines.join("\n")).value;
	if (!object(parsed) || !object(parsed.importers))
		throw new Error("invalid lockfile importers map");
	const folders = new Set(Object.keys(parsed.importers));
	return Object.entries(parsed.importers).map(([folder, entry]) => {
		if (!folderName(folder) || (entry !== null && !object(entry)))
			throw new Error("invalid importer folder");
		const dependencies = new Set<string>();
		for (const field of ["dependencies", "devDependencies", "optionalDependencies"]) {
			const group = object(entry) ? entry[field] : undefined;
			if (group === undefined || group === null) continue;
			if (!object(group)) throw new Error("invalid importer dependencies");
			for (const dependency of Object.values(group)) {
				if (!object(dependency) || typeof dependency.version !== "string")
					throw new Error("invalid importer dependency");
				const version = dependency.version;
				if (!version.startsWith("link:")) {
					if (
						typeof dependency.specifier === "string" &&
						dependency.specifier.startsWith("workspace:")
					)
						throw new Error("unresolved workspace dependency");
					continue;
				}
				const link = version.slice(5);
				const target = path.posix.normalize(path.posix.join(folder, link));
				if (!link || path.posix.isAbsolute(link) || !folderName(target) || !folders.has(target))
					throw new Error("invalid workspace link");
				dependencies.add(target);
			}
		}
		return { folder, dependencies: [...dependencies].sort() };
	});
}

// Include each changed package's transitive consumers, including test-only consumers. Metadata is
// injected so graph decisions can be checked without inspecting or executing any package's code.
export function consumingSpikes(
	changed: readonly string[],
	packages: readonly WorkspacePackage[],
): string[] {
	const byFolder = new Map<string, WorkspacePackage>();
	for (const pkg of packages) {
		if (
			!folderName(pkg.folder) ||
			!Array.isArray(pkg.dependencies) ||
			pkg.dependencies.some((folder) => typeof folder !== "string" || !folderName(folder)) ||
			byFolder.has(pkg.folder)
		) {
			throw new Error("invalid or ambiguous workspace selection metadata");
		}
		byFolder.set(pkg.folder, pkg);
	}
	const allSpikes = packages.filter((pkg) => pkg.folder.startsWith("spikes/"));
	// A deleted or newly added package can lack current metadata. Select every spike rather than
	// silently losing its possible consumers while the workspace is changing.
	if (changed.some((folder) => !byFolder.has(folder))) {
		return allSpikes.map((pkg) => pkg.folder).sort();
	}
	const selected = new Set(changed);
	const queue = [...changed];
	for (const folder of queue) {
		for (const candidate of packages) {
			if (candidate.dependencies.includes(folder) && !selected.has(candidate.folder)) {
				selected.add(candidate.folder);
				queue.push(candidate.folder);
			}
		}
	}
	return allSpikes
		.filter((pkg) => selected.has(pkg.folder))
		.map((pkg) => pkg.folder)
		.sort();
}

// Markdown, the community files without an extension, and spike evidence.
export function isDocs(file: string): boolean {
	return /\.md$/i.test(file) || communityFiles.has(file) || /^spikes\/[^/]+\/evidence\//.test(file);
}

// The Cargo workspace holding a file: the nearest [workspace] manifest above it, else the nearest
// package. Each Rust spike is its own workspace; the repo root never is one.
export function rustWorkspace(root: string, file: string): string | undefined {
	if (path.posix.isAbsolute(file)) {
		throw new Error("Rust workspace paths must be repository-relative");
	}
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
	packageMetadata: () => readonly WorkspacePackage[] = () =>
		workspacePackages(readFileSync(path.join(root, "pnpm-lock.yaml"), "utf8")),
): Areas {
	let docsOnly = files.length > 0;
	let ts = false;
	let workflows = false;
	const rust = new Set<string>();
	const spikes = new Set<string>();
	const changedPackages = new Set<string>();
	let packages: readonly WorkspacePackage[] | undefined;
	const graph = (): readonly WorkspacePackage[] => {
		if (!packages) {
			packages = packageMetadata();
			consumingSpikes([], packages);
		}
		return packages;
	};
	let shared = false;
	let manifests: readonly string[] | undefined;
	const allManifests = (): readonly string[] =>
		(manifests ??= allFiles().filter((file) => path.posix.basename(file) === "Cargo.toml"));
	const addSpike = (file: string): void => {
		const owner = graph()
			.filter((pkg) => pkg.folder !== "." && file.startsWith(`${pkg.folder}/`))
			.sort((a, b) => b.folder.length - a.folder.length)[0]?.folder;
		if (owner) changedPackages.add(owner);
		const spike = owner?.startsWith("spikes/")
			? owner
			: /^spikes\/[^/]+\//.exec(file)?.[0].slice(0, -1);
		if (spike) spikes.add(spike);
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
		shared ||= sharedSpikeFiles.has(file);
		if (file.startsWith(".github/")) workflows = true;
		else if (toolchainFiles.has(file)) {
			for (const manifest of allManifests()) addWorkspace(manifest);
		} else if (!addWorkspace(file)) ts = true;
		addSpike(file);
	}
	if (!docsOnly && files.length > 0) {
		const selected = shared
			? graph()
					.filter((pkg) => pkg.folder.startsWith("spikes/"))
					.map((pkg) => pkg.folder)
			: consumingSpikes([...changedPackages, ...spikes], graph());
		spikes.clear();
		for (const spike of selected) spikes.add(spike);
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
