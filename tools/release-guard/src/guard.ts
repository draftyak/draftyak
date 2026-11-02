import { existsSync } from "node:fs";
import path from "node:path";
import { emptyDirectoryRecords, jsonValue } from "../../bundle-hub/src/inventory.ts";
import {
	compare,
	type FileRecord,
	fields,
	hash,
	inventory,
	json,
	localPath,
	object,
	read,
	records,
	relative,
	text,
} from "./integrity.ts";
import { inspectScheduleEquivalence } from "./schedule.ts";
import { unpackTree } from "./tar.ts";
import {
	authenticatedNodeProbe,
	authenticateNodeBytes,
	isHostNodeTarget,
	type NodeSource,
	type NodeTestDeps,
} from "./trusted-node.ts";

export const npmPackages: Readonly<Record<string, string>> = {
	draftyak: "apps/cli",
	"create-draftyak-plugin": "packages/create-plugin",
	"@draftyak/protocol": "packages/protocol",
	"@draftyak/sdk": "packages/sdk",
	"@draftyak/plugin-testkit": "packages/plugin-testkit",
	"@draftyak/client": "packages/client",
	"@draftyak/extensions": "packages/extensions",
	"@draftyak/content": "packages/content",
	"@draftyak/mime": "packages/mime",
	"@draftyak/fakes": "packages/fakes",
	"@draftyak/channel-gmail": "plugins/channel-gmail",
	"@draftyak/channel-slack": "plugins/channel-slack",
	"@draftyak/channel-hello": "plugins/channel-hello",
	"@draftyak/ai-messages-api": "plugins/ai-messages-api",
	"@draftyak/ai-responses-api": "plugins/ai-responses-api",
	"@draftyak/ai-chat-completions": "plugins/ai-chat-completions",
	"@draftyak/tool-hello": "plugins/tool-hello",
	"@draftyak/tool-calendar-ics": "plugins/tool-calendar-ics",
};

export interface NodeArtifact extends FileRecord {
	readonly version: string;
	readonly source: NodeSource;
}

export interface Manifest {
	readonly schemaVersion: 1;
	readonly version: string;
	readonly artifacts: readonly FileRecord[];
	readonly npm: readonly { readonly path: string; readonly workspace: string }[];
	readonly node?: FileRecord & { readonly version: string };
	readonly nodeSource?: NodeSource;
	readonly nodes?: readonly NodeArtifact[];
	readonly notices?: { readonly path: string; readonly sbom: string };
}

export interface Finding {
	readonly check: string;
	readonly reason: string;
}

export interface Result {
	readonly scope: "artifacts" | "full";
	readonly findings: readonly Finding[];
	readonly checks: readonly string[];
	readonly warnings?: readonly Finding[];
}

export function version(value: unknown): string {
	const result = text(value);
	if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/.test(result)) {
		throw new Error(`unsupported version: ${result}`);
	}
	return result;
}

function sourceRecord(input: unknown): NodeSource {
	const item = object(input);
	fields(item, ["root", "platform", "arch"]);
	if (!path.isAbsolute(text(item.root))) throw new Error("Node source root must be absolute");
	if (
		typeof item.platform !== "string" ||
		!["win", "linux", "darwin"].includes(item.platform) ||
		typeof item.arch !== "string" ||
		!["x64", "arm64"].includes(item.arch)
	)
		throw new Error("Node artifact needs an official platform/architecture");
	return {
		root: localPath(text(item.root)),
		platform: item.platform as NodeSource["platform"],
		arch: item.arch as NodeSource["arch"],
	};
}

function nodeRecord(input: unknown, source?: unknown): NodeArtifact {
	const item = object(input);
	fields(
		item,
		source === undefined
			? ["path", "sha256", "bytes", "version", "source"]
			: ["path", "sha256", "bytes", "version"],
	);
	const file = records([{ path: item.path, sha256: item.sha256, bytes: item.bytes }])[0];
	if (!file) throw new Error("Node artifact record missing");
	return { ...file, version: version(item.version), source: sourceRecord(source ?? item.source) };
}

function nodeArtifacts(release: Manifest): readonly NodeArtifact[] {
	if (release.nodes) return release.nodes;
	return release.node && release.nodeSource
		? [{ ...release.node, source: release.nodeSource }]
		: [];
}

function knownNodeExecutable(file: string): boolean {
	return /(?:^|\/)(?:node(?:\.exe)?|draftyak-node-[^/]+)$/i.test(file);
}

const pythonUnavailable = "Python runtime inputs require an available reviewed runtime producer";

function pythonRuntimePath(file: string): boolean {
	return /(?:^|\/)(?:runtime-python|python-runtime)(?:\/|\.|$)|\.whl$/i.test(file);
}

function noPythonRuntimeMetadata(row: Record<string, unknown>): void {
	const runtime = "@draftyak/runtime-python";
	const runtimeName = (value: unknown): boolean =>
		typeof value === "string" && value.toLowerCase() === runtime;
	const runtimeAlias = (value: unknown): boolean =>
		typeof value === "string" &&
		/^(?:npm|workspace):@draftyak\/runtime-python(?:@|$)/i.test(value.trim());
	if (
		runtimeName(row.name) ||
		[
			"dependencies",
			"optionalDependencies",
			"peerDependencies",
			"devDependencies",
			"bundledDependencies",
			"bundleDependencies",
		].some((field) => {
			const value = row[field];
			return Array.isArray(value)
				? value.some((entry) => runtimeName(entry) || runtimeAlias(entry))
				: value !== null &&
						typeof value === "object" &&
						Object.entries(value).some(([name, spec]) => runtimeName(name) || runtimeAlias(spec));
		})
	)
		throw new Error(pythonUnavailable);
}

export function manifest(value: unknown): Manifest {
	const row = object(value);
	if (Object.hasOwn(row, "runtime")) throw new Error(pythonUnavailable);
	fields(row, [
		"schemaVersion",
		"version",
		"artifacts",
		"npm",
		"node",
		"nodeSource",
		"nodes",
		"notices",
	]);
	if (row.schemaVersion !== 1) throw new Error("schemaVersion must be 1");
	if (!Array.isArray(row.npm)) throw new Error("npm must be an array");
	const npm = row.npm.map((value) => {
		const item = object(value);
		fields(item, ["path", "workspace"]);
		const workspace = relative(item.workspace);
		if (
			["packages/runtime-python", "plugins/channel-hello-py", "packages/sdk-python"].includes(
				workspace,
			)
		)
			throw new Error(pythonUnavailable);
		return { path: relative(item.path), workspace };
	});
	if (
		Object.hasOwn(row, "nodes") &&
		(Object.hasOwn(row, "node") || Object.hasOwn(row, "nodeSource"))
	)
		throw new Error("combined legacy and per-artifact Node records are ambiguous");
	let selected: readonly NodeArtifact[] = [];
	const perArtifact = Object.hasOwn(row, "nodes");
	if (perArtifact) {
		if (!Array.isArray(row.nodes) || row.nodes.length === 0 || row.nodes.length > 512)
			throw new Error("nodes must be a nonempty bounded array");
		selected = row.nodes.map((item) => nodeRecord(item));
	} else if (Object.hasOwn(row, "node") || Object.hasOwn(row, "nodeSource")) {
		if (row.node === undefined || row.nodeSource === undefined)
			throw new Error("Node artifact requires its official source target");
		selected = [nodeRecord(row.node, row.nodeSource)];
	}
	let notices: Manifest["notices"];
	if (row.notices !== undefined) {
		const item = object(row.notices);
		fields(item, ["path", "sbom"]);
		notices = { path: relative(item.path), sbom: relative(item.sbom) };
	}
	const artifacts = records(row.artifacts);
	if (artifacts.some((file) => pythonRuntimePath(file.path))) throw new Error(pythonUnavailable);
	const artifactPaths = new Map(artifacts.map((file) => [file.path, file]));
	const nodePaths = new Set<string>();
	for (const node of selected) {
		if (nodePaths.has(node.path.toLowerCase()))
			throw new Error("duplicate or case-aliased Node artifact record");
		nodePaths.add(node.path.toLowerCase());
		const artifact = artifactPaths.get(node.path);
		if (!artifact || artifact.sha256 !== node.sha256 || artifact.bytes !== node.bytes)
			throw new Error("Node record must match an inventoried artifact exactly");
	}
	return {
		schemaVersion: 1,
		version: version(row.version),
		artifacts,
		npm,
		...(perArtifact
			? { nodes: selected }
			: selected[0]
				? {
						node: {
							path: selected[0].path,
							sha256: selected[0].sha256,
							bytes: selected[0].bytes,
							version: selected[0].version,
						},
						nodeSource: selected[0].source,
					}
				: {}),
		notices,
	};
}

const lifecycle = [
	"preinstall",
	"install",
	"postinstall",
	"prepublish",
	"preprepare",
	"prepare",
	"postprepare",
];

function noInstallScripts(row: Record<string, unknown>, name: string): void {
	if (row.scripts === undefined) return;
	const scripts = object(row.scripts);
	for (const script of lifecycle) {
		if (Object.hasOwn(scripts, script))
			throw new Error(`install lifecycle script ${script}: ${name}`);
	}
}

function packageIdentity(value: unknown): { name: string; version: string } {
	const row = object(value);
	return { name: text(row.name), version: version(row.version) };
}

function packageMetadata(value: unknown): { name: string; version: string } {
	const row = object(value);
	noPythonRuntimeMetadata(row);
	const identity = packageIdentity(row);
	const { name } = identity;
	if (!Object.hasOwn(npmPackages, name))
		throw new Error(`package is not on the npm allowlist: ${name}`);
	if (row.private !== undefined && row.private !== false)
		throw new Error(`private package: ${name}`);
	noInstallScripts(row, name);
	return identity;
}

function selectedNativeContents(
	files: ReadonlyMap<string, Buffer>,
	emptyDirectories: readonly string[],
	expectedVersion: string,
): void {
	const bytes = files.get("package/bundle.json");
	if (!bytes) return;
	const bundle = object(jsonValue(bytes.toString("utf8")));
	fields(bundle, [
		"schemaVersion",
		"format",
		"version",
		"target",
		"hub",
		"cli",
		"native",
		"node",
		"stagingNode",
		"provenance",
	]);
	if (bundle.schemaVersion !== 1 || bundle.format !== "npm" || bundle.version !== expectedVersion)
		throw new Error("invalid npm bundle metadata identity");
	const target = object(bundle.target);
	fields(target, ["platform", "arch"]);
	if (
		typeof target.platform !== "string" ||
		typeof target.arch !== "string" ||
		!["win", "linux", "darwin"].includes(target.platform) ||
		!["x64", "arm64"].includes(target.arch)
	)
		throw new Error("unsupported native bundle target");
	const selected = `${target.platform === "win" ? "win32" : target.platform}-${target.arch}`;
	const native = object(bundle.native);
	fields(native, ["name", "version", "integrity", "main", "bindings"]);
	if (
		native.name !== "better-sqlite3-multiple-ciphers" ||
		native.version !== "13.0.3" ||
		native.main !== "native/lib/index.js" ||
		typeof native.integrity !== "string" ||
		!/^sha512-[A-Za-z0-9+/]{86}==$/.test(native.integrity)
	)
		throw new Error("invalid native package provenance");
	const bindings = object(native.bindings);
	fields(bindings, [selected]);
	const selectedPath = `native/prebuilds/${selected}.node`;
	if (bindings[selected] !== selectedPath || Object.keys(bindings).length !== 1)
		throw new Error("native binding must match the selected target");
	const prebuilds = [...files.keys()].filter((file) =>
		file.startsWith("package/native/prebuilds/"),
	);
	if (
		prebuilds.length !== 1 ||
		prebuilds[0] !== `package/${selectedPath}` ||
		emptyDirectories.some(
			(directory) =>
				directory === "package/native/prebuilds" ||
				directory.startsWith("package/native/prebuilds/"),
		)
	)
		throw new Error("native prebuild inventory must contain only the selected target");
	const required = (file: string): Buffer => {
		const value = files.get(`package/${file}`);
		if (!value?.length) throw new Error("native payload is missing a required file");
		return value;
	};
	required(selectedPath);
	required("native/lib/index.js");
	const pkg = object(jsonValue(required("native/package.json").toString("utf8")));
	if (pkg.name !== native.name || pkg.version !== native.version || pkg.main !== "lib/index.js")
		throw new Error("native package identity differs from bundle metadata");
	noInstallScripts(pkg, "native/package.json");
	if (!/\bNAPI_VERSION=10\b/.test(required("native/binding.gyp").toString("utf8")))
		throw new Error("native payload requires N-API 10");
}

export function checkNodeIntegrity(root: string, node: NonNullable<Manifest["node"]>): void {
	// A manifest digest establishes self-consistency, never executable provenance.
	const bytes = read(root, node.path);
	if (hash(bytes) !== node.sha256 || bytes.length !== node.bytes)
		throw new Error("Node integrity mismatch");
}

function checkNotices(root: string, config: NonNullable<Manifest["notices"]>): void {
	const bom = object(json(root, config.sbom));
	if (
		bom.bomFormat !== "CycloneDX" ||
		typeof bom.specVersion !== "string" ||
		!Array.isArray(bom.components) ||
		bom.components.length === 0
	) {
		throw new Error("nonempty CycloneDX components required");
	}
	const notices = read(root, config.path).toString("utf8");
	const markers = notices
		.split(/\r?\n/)
		.filter((line) => line.startsWith("Component: "))
		.map((line) => line.slice(11));
	const refs = new Set<string>();
	for (const item of bom.components) {
		const component = object(item);
		const ref = text(component["bom-ref"]);
		if (/[\r\n]/.test(ref) || refs.has(ref)) throw new Error("invalid or duplicate SBOM reference");
		refs.add(ref);
		text(component.name);
		text(component.version);
		if (!Array.isArray(component.licenses) || component.licenses.length === 0)
			throw new Error(`license missing in SBOM: ${ref}`);
		for (const value of component.licenses) {
			const item = object(value);
			if (typeof item.expression === "string") text(item.expression);
			else {
				const license = object(item.license);
				text(license.id ?? license.name);
			}
		}
		if (markers.filter((marker) => marker === ref).length !== 1)
			throw new Error(`notice missing or duplicated: ${ref}`);
	}
	if (markers.length !== refs.size) throw new Error("notice component not found in SBOM");
}

export interface GuardOptions {
	readonly root: string;
	readonly repo: string;
	readonly scope: "artifacts" | "full";
}

const unsupported = [
	[
		"native-features",
		"native build inspection is not implemented: e2e features, mock stores and conformance profiles must be proven absent",
	],
	["dev-key-refusal", "compiled rejection of key_class=dev needs a real native negative test"],
	["docker", "Docker image Temporal, launch argv and runtime inspection require a built image"],
	[
		"schedule-equivalence",
		"the shared M1 jiff comparison against authenticated bundled Node must complete over the canonical schedule vectors",
	],
	[
		"test-power-hooks",
		"compiled absence of DRAFTYAK_SPIKE_POWER, DRAFTYAK_SPIKE_KEEP_AWAKE, --spike-control and simulate_wake requires a native release check",
	],
	[
		"dependency-coverage",
		"complete dependency/SBOM and MPL byte/source-tag coverage require product bundle and lock inspection",
	],
	[
		"runtime-provenance",
		"compiled-hub binding, installer/image extraction and native artifact/target coverage are not inspected",
	],
] as const;

export function guard(input: unknown, options: GuardOptions): Result {
	const findings: Finding[] = [];
	const checks: string[] = [];
	const check = (name: string, action: () => void): boolean => {
		try {
			action();
			checks.push(name);
			return true;
		} catch (error) {
			findings.push({
				check: name,
				reason: error instanceof Error ? error.message : String(error),
			});
			return false;
		}
	};
	if (
		!check("local-input-paths", () => {
			localPath(options.root);
			localPath(options.repo);
		})
	) {
		return { scope: options.scope, findings, checks };
	}
	let config: Manifest | undefined;
	check("manifest", () => {
		config = manifest(input);
	});
	if (!config) return { scope: options.scope, findings, checks };
	const release = config;
	let staged: readonly FileRecord[] = [];
	const artifactSafe = check("artifact-integrity", () => {
		staged = inventory(options.root);
		compare(release.artifacts, staged);
	});
	const expectedArtifacts = new Set(release.artifacts.map((file) => file.path));
	const requireArtifact = (file: string): void => {
		if (!expectedArtifacts.has(file)) throw new Error(`input is not inventoried: ${file}`);
	};
	const published = new Set<string>();
	const npmPaths = new Set<string>();
	for (const pkg of release.npm) {
		check(`npm:${pkg.path}`, () => {
			requireArtifact(pkg.path);
			if (!pkg.path.endsWith(".tgz")) throw new Error("npm artifacts must use the .tgz extension");
			if (npmPaths.has(pkg.path)) throw new Error("duplicate npm artifact");
			npmPaths.add(pkg.path);
			const tree = unpackTree(read(options.root, pkg.path));
			const files = tree.files;
			if ([...files.keys(), ...tree.emptyDirectories].some((file) => pythonRuntimePath(file)))
				throw new Error(pythonUnavailable);
			const packageInventory = files.get("package/package.inventory.json");
			if (packageInventory) {
				const declared = object(jsonValue(packageInventory.toString("utf8")));
				fields(declared, ["schemaVersion", "files", "emptyDirectories"]);
				if (declared.schemaVersion !== 1)
					throw new Error("package inventory schemaVersion must be 1");
				const expected = records(declared.files);
				const actual = [...files]
					.filter(([file]) => file !== "package/package.inventory.json")
					.map(([file, bytes]) => ({
						path: file.slice("package/".length),
						bytes: bytes.length,
						sha256: hash(bytes),
					}))
					.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
				compare(expected, actual);
				const directories = emptyDirectoryRecords(declared.emptyDirectories).map(
					(directory) => `package/${directory}`,
				);
				if (JSON.stringify(directories) !== JSON.stringify(tree.emptyDirectories))
					throw new Error("package inventory directory coverage mismatch");
			} else if (tree.emptyDirectories.length)
				throw new Error("empty directories require an exact package inventory");
			const metadata = files.get("package/package.json");
			if (!metadata) throw new Error("npm artifact has no package/package.json");
			const packed = packageMetadata(JSON.parse(metadata.toString("utf8")));
			if (packed.name === "draftyak")
				selectedNativeContents(files, tree.emptyDirectories, packed.version);
			if (npmPackages[packed.name] !== pkg.workspace)
				throw new Error("workspace does not match package allowlist");
			if (files.has("package/binding.gyp"))
				throw new Error("binding.gyp implies an install lifecycle action");
			for (const [file, bytes] of files) {
				if (file.startsWith("package/node_modules/") && file.endsWith("/package.json")) {
					const dependency = object(JSON.parse(bytes.toString("utf8")));
					noPythonRuntimeMetadata(dependency);
					noInstallScripts(dependency, file);
				}
				if (file.startsWith("package/node_modules/") && file.endsWith("/binding.gyp")) {
					throw new Error(`bundled dependency binding.gyp implies an install action: ${file}`);
				}
			}
			const source = packageIdentity(json(options.repo, `${pkg.workspace}/package.json`));
			const sourceName = packed.name === "draftyak" ? "@draftyak/cli" : packed.name;
			if (source.name !== sourceName || source.version !== packed.version)
				throw new Error("packed identity/version differs from workspace");
			if (published.has(packed.name)) throw new Error("duplicate published package name");
			published.add(packed.name);
		});
	}
	for (const file of release.artifacts) {
		if (file.path.toLowerCase().endsWith(".tgz") && !npmPaths.has(file.path)) {
			findings.push({ check: "publish-set", reason: `unclassified npm archive: ${file.path}` });
		}
	}
	for (const component of ["apps/cli", "apps/hub", "apps/app"]) {
		const file = `${component}/package.json`;
		if (options.scope === "full" || existsSync(path.join(options.repo, file)))
			check(`version:${component}`, () => {
				if (version(object(json(options.repo, file)).version) !== release.version)
					throw new Error("release component version differs");
			});
	}
	const tauri = "apps/app/src-tauri/tauri.conf.json";
	if (options.scope === "full" || existsSync(path.join(options.repo, tauri)))
		check("version:tauri", () => {
			if (version(object(json(options.repo, tauri)).version) !== release.version)
				throw new Error("Tauri app version differs");
		});
	if (release.notices)
		check("sbom-notices", () => {
			const notices = release.notices;
			if (!notices) throw new Error("notices missing");
			requireArtifact(notices.path);
			requireArtifact(notices.sbom);
			checkNotices(options.root, notices);
		});
	const nodes = nodeArtifacts(release);
	const covered = check("bundled-node-coverage", () => {
		if (!artifactSafe) throw new Error("staged artifact integrity failed");
		const recorded = new Set(nodes.map((node) => node.path));
		for (const file of staged)
			if (knownNodeExecutable(file.path) && !recorded.has(file.path))
				throw new Error(`Node executable has no exact target/source record: ${file.path}`);
	});
	if (nodes.length > 0 && covered) {
		let consistent = true;
		for (const node of nodes) {
			const ok = check(`bundled-node-integrity:${node.path}`, () => {
				requireArtifact(node.path);
				const bundled = text(object(json(options.repo, "tools/fetch-node/versions.json")).bundled);
				if (node.version !== bundled)
					throw new Error("Node version differs from repository bundled pin");
				checkNodeIntegrity(options.root, node);
			});
			consistent = ok && consistent;
		}
		if (consistent) {
			checks.push("bundled-node-integrity");
			findings.push({
				check: "bundled-node-runtime",
				reason:
					"candidate not executed: every Node requires independent official-archive authentication; matching-host targets also require the Temporal/--disable-sigusr1 probe",
			});
		}
	}
	if (options.scope === "full") {
		check("release-profile", () => {
			for (const file of release.artifacts) {
				if (/(^|\/)bundle\.json$/.test(file.path)) {
					const bundle = object(json(options.root, file.path));
					if (bundle.profile === "desktop-snapshot")
						throw new Error(`development desktop snapshot is not a full release: ${file.path}`);
				}
			}
		});
		for (const name of Object.keys(npmPackages)) {
			if (!published.has(name))
				findings.push({ check: "publish-set", reason: `missing npm artifact: ${name}` });
		}
		if (nodes.length === 0)
			findings.push({ check: "node", reason: "required release input missing: node" });
		if (!release.notices)
			findings.push({ check: "notices", reason: "required release input missing: notices" });
		for (const [name, reason] of unsupported) findings.push({ check: name, reason });
	}
	return { scope: options.scope, findings, checks };
}

// The static API never executes an artifact. The CLI uses this wrapper for authenticated probes.
export async function guardRelease(
	input: unknown,
	options: GuardOptions,
	deps: NodeTestDeps = {},
): Promise<Result> {
	const result = guard(input, options);
	if (!result.checks.includes("bundled-node-integrity")) return result;
	const release = manifest(input);
	const nodes = nodeArtifacts(release);
	const findings = result.findings.filter((finding) => finding.check !== "bundled-node-runtime");
	const checks = [...result.checks];
	const warnings: Finding[] = [];
	let scheduleComplete = true;
	let scheduleInspections = 0;
	let authenticated = true;
	for (const node of nodes) {
		try {
			await authenticateNodeBytes(options.root, node, node.source, deps);
			checks.push(`bundled-node-authentication:${node.path}`);
		} catch (error) {
			authenticated = false;
			findings.push({
				check: `bundled-node-authentication:${node.path}`,
				reason: error instanceof Error ? error.message : String(error),
			});
		}
	}
	if (authenticated) {
		checks.push("bundled-node-authentication");
		let probed = true;
		let hostTargets = 0;
		for (const node of nodes) {
			if (!isHostNodeTarget(node.source)) {
				checks.push(`bundled-node-byte-equality:${node.path}`);
				if (options.scope === "full") {
					scheduleComplete = false;
					findings.push({
						check: `schedule-equivalence:${node.path}`,
						reason: "schedule comparison not executed: Node target does not match this host",
					});
				}
				continue;
			}
			hostTargets++;
			try {
				// The probe re-authenticates its own inputs after the preceding awaits.
				await authenticatedNodeProbe(options.root, node, node.source, deps);
				checks.push(`bundled-node-runtime:${node.path}`);
			} catch (error) {
				probed = false;
				scheduleComplete = false;
				findings.push({
					check: `bundled-node-runtime:${node.path}`,
					reason: error instanceof Error ? error.message : String(error),
				});
				continue;
			}
			if (options.scope === "full") {
				try {
					const report = await inspectScheduleEquivalence({
						repo: options.repo,
						root: options.root,
						node,
						nodeSource: node.source,
					});
					scheduleInspections++;
					checks.push(`schedule-equivalence:${node.path}`);
					for (const reason of report.warnings)
						warnings.push({ check: `schedule-equivalence:${node.path}`, reason });
				} catch (error) {
					scheduleComplete = false;
					findings.push({
						check: `schedule-equivalence:${node.path}`,
						reason: error instanceof Error ? error.message : String(error),
					});
				}
			}
		}
		if (probed && hostTargets > 0) checks.push("bundled-node-runtime");
		for (const node of nodes) {
			try {
				checkNodeIntegrity(options.root, node);
			} catch (error) {
				scheduleComplete = false;
				findings.push({
					check: `bundled-node-integrity:${node.path}`,
					reason: error instanceof Error ? error.message : String(error),
				});
			}
		}
		try {
			compare(release.artifacts, inventory(options.root));
		} catch (error) {
			scheduleComplete = false;
			findings.push({
				check: "artifact-integrity",
				reason: error instanceof Error ? error.message : String(error),
			});
		}
	}
	const schedulePassed =
		options.scope === "full" &&
		authenticated &&
		scheduleComplete &&
		scheduleInspections > 0 &&
		scheduleInspections === nodes.length;
	if (schedulePassed) checks.push("schedule-equivalence");
	return {
		scope: options.scope,
		findings: schedulePassed
			? findings.filter((finding) => finding.check !== "schedule-equivalence")
			: findings,
		checks,
		...(warnings.length ? { warnings } : {}),
	};
}
