import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { changedApplication, heavyApplications } from "./app-heavy.ts";
import { appendSummary, cliArgs, git, revision, runCli, setOutputs } from "./lib.ts";
import { parseYaml, type Yaml } from "./yaml.ts";

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
// These exact policy paths must exercise the mandatory crates/ policy bridge.
const finitePolicyInputs = new Set([
	"tools/native-dependency-policy/src/mobile-http-policy.ts",
	"tools/native-dependency-policy/src/finite-policy-ci.ts",
	"tools/native-dependency-policy/src/native-audit-source.ts",
	"tools/verify/steps/rust.ts",
	"tools/ci-checks/src/changes.ts",
]);
// Web is a separate browser suite; it does not expand the fixed native CLI/Hub allowlist.
const webPackage = "apps/web";
const webHeavyScript = "pnpm build && vitest run --mode heavy";
const webHeavyInputs = new Set([".github/workflows/ci.yml", "tools/ci-checks/src/changes.ts"]);
function changedWeb(file: string): boolean {
	return (
		file.startsWith(`${webPackage}/`) &&
		!file.includes("\\") &&
		![...file].some(
			(character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
		) &&
		file.split("/").every((part) => part !== "" && part !== "." && part !== "..")
	);
}
function eligibleWeb(root: string): boolean {
	try {
		for (const dir of ["apps", webPackage]) {
			const entry = lstatSync(path.join(root, dir));
			if (!entry.isDirectory() || entry.isSymbolicLink()) return false;
		}
		const file = path.join(root, webPackage, "package.json");
		const entry = lstatSync(file);
		if (!entry.isFile() || entry.isSymbolicLink()) return false;
		const value = JSON.parse(readFileSync(file, "utf8"));
		return value?.name === "@draftyak/web" && value?.scripts?.["test:heavy"] === webHeavyScript;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw new Error("cannot inspect Web heavy manifest");
	}
}

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

// Only the finite Cargo package.workspace string field is needed here. Unsupported or ambiguous
// forms refuse rather than assigning a package to a workspace Cargo would not use.
function packageWorkspace(source: string): string | undefined {
	let inPackage = false;
	let packageTables = 0;
	let multiline = false;
	const declarations: string[] = [];
	for (const line of source.split(/\r?\n/)) {
		if (
			/^[ \t]*(?:package|"package"|'package')\s*\.\s*(?:workspace|"workspace"|'workspace')/.test(
				line,
			)
		)
			throw new Error("invalid Cargo package.workspace declaration");
		const table = /^[ \t]*\[([a-zA-Z0-9_.-]+)\][ \t]*(?:#.*)?$/.exec(line);
		if (table) {
			if (table[1] === "package.workspace")
				throw new Error("invalid Cargo package.workspace declaration");
			inPackage = table[1] === "package";
			if (inPackage) packageTables++;
			continue;
		}
		if (/^[ \t]*\[\[/.test(line)) inPackage = false;
		if (!inPackage) continue;
		multiline ||= line.includes('"""') || line.includes("'''");
		if (/^[ \t]*(?:workspace\b|"workspace"|'workspace')/.test(line)) declarations.push(line);
	}
	if (declarations.length === 0) return undefined;
	const declaration = declarations[0] ?? "";
	const value =
		/^[ \t]*(?:workspace|"workspace"|'workspace')[ \t]*=[ \t]*(['"])([a-zA-Z0-9_@./-]+)\1[ \t]*(?:#.*)?$/.exec(
			declaration,
		)?.[2];
	if (packageTables !== 1 || declarations.length !== 1 || multiline || !value)
		throw new Error("invalid Cargo package.workspace declaration");
	return value;
}

// External workspace pointers need an explicit member path, not just a target header.
// Only finite literal members/exclude arrays are supported; unproved membership refuses.
function externalWorkspaceMember(source: string, workspace: string, member: string): boolean {
	const invalid: () => never = () => {
		throw new Error("invalid Cargo package.workspace membership");
	};
	if (/^[ \t]*(?:workspace|"workspace"|'workspace')\s*\./m.test(source)) invalid();
	const lines = source.split(/\r?\n/);
	const fields = new Map<string, string[]>();
	let active = false;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? "";
		if (/^[ \t]*\[/.test(line)) {
			active = /^[ \t]*\[workspace\][ \t]*(?:#.*)?$/.test(line);
			continue;
		}
		if (
			!active ||
			!/^[ \t]*(?:members\b|exclude\b|"members"|"exclude"|'members'|'exclude')/.test(line)
		)
			continue;
		const field =
			/^[ \t]*(members|exclude|"(?:members|exclude)"|'(?:members|exclude)')[ \t]*=[ \t]*(.*)$/.exec(
				line,
			);
		if (!field) invalid();
		const key = (field[1] ?? "").replace(/["']/g, "");
		if (fields.has(key)) invalid();
		let value = (field[2] ?? "").replace(/#.*$/, "");
		while (!value.includes("]") && i + 1 < lines.length)
			value += "\n" + (lines[++i] ?? "").replace(/#.*$/, "");
		const item = "(?:\"[a-zA-Z0-9_@./-]+\"|'[a-zA-Z0-9_@./-]+')";
		if (
			!new RegExp("^\\[\\s*(?:" + item + "\\s*(?:,\\s*" + item + "\\s*)*,?\\s*)?\\]\\s*$").test(
				value,
			)
		)
			invalid();
		const paths = [...value.matchAll(/(["'])([a-zA-Z0-9_@./-]+)\1/g)].map((entry) => {
			const relative = entry[2] ?? invalid();
			const folder = path.posix.normalize(path.posix.join(workspace, relative));
			if (path.posix.isAbsolute(relative) || folder === ".." || folder.startsWith("../")) invalid();
			return folder;
		});
		fields.set(key, paths);
	}
	return (
		(fields.get("members") ?? []).includes(member) && (fields.get("exclude") ?? []).length === 0
	);
}

// The Cargo workspace holding a file: the nearest package's explicit workspace, else the nearest
// ancestral [workspace], else the nearest package. Each Rust spike is its own workspace.
export function rustWorkspace(root: string, file: string): string | undefined {
	if (path.posix.isAbsolute(file)) {
		throw new Error("Rust workspace paths must be repository-relative");
	}
	let nearest: string | undefined;
	for (let dir = path.posix.dirname(file); dir !== "."; dir = path.posix.dirname(dir)) {
		const manifest = path.join(root, dir, "Cargo.toml");
		if (!existsSync(manifest)) continue;
		const source = readFileSync(manifest, "utf8");
		if (nearest === undefined) {
			const declared = packageWorkspace(source);
			if (declared !== undefined) {
				const workspace = path.posix.normalize(path.posix.join(dir, declared));
				if (
					path.posix.isAbsolute(declared) ||
					workspace === "." ||
					workspace === ".." ||
					workspace.startsWith("../")
				)
					throw new Error("invalid Cargo package.workspace target");
				const target = path.join(root, workspace, "Cargo.toml");
				if (!existsSync(target)) throw new Error("invalid Cargo package.workspace target");
				const relative = path.relative(realpathSync(root), realpathSync(target));
				if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`))
					throw new Error("invalid Cargo package.workspace target");
				const targetSource = readFileSync(target, "utf8");
				if (
					targetSource.includes('"""') ||
					targetSource.includes("'''") ||
					[...targetSource.matchAll(/^[ \t]*\[workspace\][ \t]*(?:#.*)?\r?$/gm)].length !== 1
				)
					throw new Error("invalid Cargo package.workspace target");
				if (!externalWorkspaceMember(targetSource, workspace, dir))
					throw new Error("invalid Cargo package.workspace membership");
				return workspace;
			}
		}
		if (/^\s*\[workspace\]/m.test(source)) return dir;
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
	packageMetadata: () => readonly WorkspacePackage[] = () =>
		workspacePackages(readFileSync(path.join(root, "pnpm-lock.yaml"), "utf8")),
): Areas {
	let docsOnly = files.length > 0;
	let ts = false;
	let workflows = false;
	let global = false;
	let globalApplications = false;
	let templateSmoke = false;
	const rust = new Set<string>();
	const spikes = new Set<string>();
	const alone = new Set<string>();
	const strayRust = new Set<string>();
	const withDependents = new Set<string>();
	let applications: readonly string[] | undefined;
	let webEligible: boolean | undefined;
	const webSuite = (): boolean => (webEligible ??= eligibleWeb(root));
	const eligibleApplications = (): readonly string[] => (applications ??= heavyApplications(root));
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
		if (finitePolicyInputs.has(file)) addWorkspace("crates/Cargo.toml");
		if (changedWeb(file)) {
			if (!webSuite()) throw new Error("changed Web requires its fixed heavy entry");
			alone.add(webPackage);
		} else if (webHeavyInputs.has(file) && webSuite()) alone.add(webPackage);
		shared ||= sharedSpikeFiles.has(file);
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
		// App dependency changes can share a lockfile update with an unrelated package manifest.
		// Keep existing package selection, while never losing the bounded app suites in that case.
		if (globalFiles.has(file) || file === "pnpm-lock.yaml") globalApplications = true;
		const app = changedApplication(file);
		if (app !== undefined && eligibleApplications().includes(app)) withDependents.add(app);
		const pkg = /^(?:packages|plugins)\/[^/]+(?=\/)/.exec(file)?.[0];
		if (pkg !== undefined && isPackage(root, pkg)) withDependents.add(pkg);
		if (pkg !== undefined && smokePackages.has(pkg)) templateSmoke = true;
		// Protocol's cross-language tests cover crates/ and the shared vectors; its dependents don't.
		if (file.startsWith("crates/") || file.startsWith("spec/vectors/")) alone.add(protocol);
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
	if (global) {
		templateSmoke = true;
		for (const dir of heavyPackages(root)) alone.add(dir);
	}
	if (globalApplications) {
		for (const dir of eligibleApplications()) alone.add(dir);
		if (webSuite()) alone.add(webPackage);
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
