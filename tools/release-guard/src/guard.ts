import { existsSync } from "node:fs";
import path from "node:path";
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
import { unpack } from "./tar.ts";
import { authenticatedNodeProbe, type NodeSource, type NodeTestDeps } from "./trusted-node.ts";

export const npmPackages: Readonly<Record<string, string>> = {
	draftyak: "apps/cli",
	"create-draftyak-plugin": "packages/create-plugin",
	"@draftyak/protocol": "packages/protocol",
	"@draftyak/sdk": "packages/sdk",
	"@draftyak/plugin-testkit": "packages/plugin-testkit",
	"@draftyak/runtime-python": "packages/runtime-python",
	"@draftyak/client": "packages/client",
	"@draftyak/extensions": "packages/extensions",
	"@draftyak/content": "packages/content",
	"@draftyak/mime": "packages/mime",
	"@draftyak/fakes": "packages/fakes",
	"@draftyak/channel-gmail": "plugins/channel-gmail",
	"@draftyak/channel-slack": "plugins/channel-slack",
	"@draftyak/channel-hello": "plugins/channel-hello",
	"@draftyak/channel-hello-py": "plugins/channel-hello-py",
	"@draftyak/ai-messages-api": "plugins/ai-messages-api",
	"@draftyak/ai-responses-api": "plugins/ai-responses-api",
	"@draftyak/ai-chat-completions": "plugins/ai-chat-completions",
	"@draftyak/tool-hello": "plugins/tool-hello",
	"@draftyak/tool-calendar-ics": "plugins/tool-calendar-ics",
};

export interface Manifest {
	readonly schemaVersion: 1;
	readonly version: string;
	readonly artifacts: readonly FileRecord[];
	readonly npm: readonly { readonly path: string; readonly workspace: string }[];
	readonly node?: FileRecord & { readonly version: string };
	readonly nodeSource?: NodeSource;
	readonly runtime?: { readonly canonical: string; readonly copies: readonly string[] };
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
}

export function version(value: unknown): string {
	const result = text(value);
	if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/.test(result)) {
		throw new Error(`unsupported version: ${result}`);
	}
	return result;
}

export function manifest(value: unknown): Manifest {
	const row = object(value);
	fields(row, [
		"schemaVersion",
		"version",
		"artifacts",
		"npm",
		"node",
		"nodeSource",
		"runtime",
		"notices",
	]);
	if (row.schemaVersion !== 1) throw new Error("schemaVersion must be 1");
	if (!Array.isArray(row.npm)) throw new Error("npm must be an array");
	const npm = row.npm.map((value) => {
		const item = object(value);
		fields(item, ["path", "workspace"]);
		return { path: relative(item.path), workspace: relative(item.workspace) };
	});
	let node: Manifest["node"];
	if (row.node !== undefined) {
		const item = object(row.node);
		fields(item, ["path", "sha256", "bytes", "version"]);
		const file = records([{ path: item.path, sha256: item.sha256, bytes: item.bytes }])[0];
		if (!file) throw new Error("node record missing");
		node = { ...file, version: version(item.version) };
	}
	let nodeSource: Manifest["nodeSource"];
	if (row.nodeSource !== undefined) {
		const item = object(row.nodeSource);
		fields(item, ["root", "platform", "arch"]);
		if (!path.isAbsolute(text(item.root))) throw new Error("nodeSource root must be absolute");
		if (
			!node ||
			!["win", "linux", "darwin"].includes(String(item.platform)) ||
			!["x64", "arm64"].includes(String(item.arch))
		) {
			throw new Error("nodeSource needs a Node record and an official platform/architecture");
		}
		nodeSource = {
			root: localPath(text(item.root)),
			platform: item.platform as NodeSource["platform"],
			arch: item.arch as NodeSource["arch"],
		};
	}
	let runtime: Manifest["runtime"];
	if (row.runtime !== undefined) {
		const item = object(row.runtime);
		fields(item, ["canonical", "copies"]);
		if (!Array.isArray(item.copies) || item.copies.length === 0)
			throw new Error("runtime copies required");
		const copies = item.copies.map(relative);
		if (new Set(copies.map((copy) => copy.toLowerCase())).size !== copies.length) {
			throw new Error("duplicate runtime copy");
		}
		runtime = { canonical: relative(item.canonical), copies };
	}
	let notices: Manifest["notices"];
	if (row.notices !== undefined) {
		const item = object(row.notices);
		fields(item, ["path", "sbom"]);
		notices = { path: relative(item.path), sbom: relative(item.sbom) };
	}
	return {
		schemaVersion: 1,
		version: version(row.version),
		artifacts: records(row.artifacts),
		npm,
		node,
		nodeSource,
		runtime,
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

function packageMetadata(value: unknown): { name: string; version: string } {
	const row = object(value);
	const name = text(row.name);
	if (!Object.hasOwn(npmPackages, name))
		throw new Error(`package is not on the npm allowlist: ${name}`);
	if (row.private !== undefined && row.private !== false)
		throw new Error(`private package: ${name}`);
	noInstallScripts(row, name);
	return { name, version: version(row.version) };
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
		"compiled native schedule-module comparison is available separately; release acceptance still requires native application/source binding and installed-binary schedule verification",
	],
	[
		"sms-host",
		"APK merged-manifest, build flags, signature and in-app license inspection are not implemented",
	],
	[
		"dependency-coverage",
		"complete dependency/SBOM and MPL byte/source-tag coverage require product bundle and lock inspection",
	],
	[
		"runtime-provenance",
		"canonical runtime package/compiled-hub binding and runtime coverage in every final artifact are not inspected",
	],
	["pypi-artifact", "built Python distribution metadata and contents are not inspected"],
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
	const artifactSafe = check("artifact-integrity", () =>
		compare(release.artifacts, inventory(options.root)),
	);
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
			const files = unpack(read(options.root, pkg.path));
			const metadata = files.get("package/package.json");
			if (!metadata) throw new Error("npm artifact has no package/package.json");
			const packed = packageMetadata(JSON.parse(metadata.toString("utf8")));
			if (npmPackages[packed.name] !== pkg.workspace)
				throw new Error("workspace does not match package allowlist");
			if (files.has("package/binding.gyp"))
				throw new Error("binding.gyp implies an install lifecycle action");
			for (const [file, bytes] of files) {
				if (file.startsWith("package/node_modules/") && file.endsWith("/package.json")) {
					noInstallScripts(object(JSON.parse(bytes.toString("utf8"))), file);
				}
				if (file.startsWith("package/node_modules/") && file.endsWith("/binding.gyp")) {
					throw new Error(`bundled dependency binding.gyp implies an install action: ${file}`);
				}
			}
			const source = packageMetadata(json(options.repo, `${pkg.workspace}/package.json`));
			if (source.name !== packed.name || source.version !== packed.version)
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
	for (const component of ["apps/cli", "apps/hub", "apps/app", "packages/runtime-python"]) {
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
	const pyproject = "packages/sdk-python/pyproject.toml";
	if (options.scope === "full" || existsSync(path.join(options.repo, pyproject)))
		check("python-sdk-version", () => {
			const sdk = version(object(json(options.repo, "packages/sdk/package.json")).version);
			const source = read(options.repo, pyproject).toString("utf8");
			const project = source.match(/^\[project\]\s*$([\s\S]*?)(?=^\[|$(?![\s\S]))/m)?.[1];
			const name = project?.match(/^name\s*=\s*["']([^"']+)["']\s*$/m)?.[1];
			const pyVersion = project?.match(/^version\s*=\s*["']([^"']+)["']\s*$/m)?.[1];
			if (name !== "draftyak" || pyVersion !== sdk)
				throw new Error(
					"Python project must be draftyak with a literal version matching @draftyak/sdk",
				);
		});
	if (release.runtime)
		check("python-runtime", () => {
			const runtime = release.runtime;
			if (!runtime) throw new Error("runtime missing");
			requireArtifact(runtime.canonical);
			const canonical = object(json(options.root, runtime.canonical));
			fields(canonical, ["schemaVersion", "files"]);
			if (canonical.schemaVersion !== 1)
				throw new Error("runtime inventory schemaVersion must be 1");
			const expected = records(canonical.files);
			for (const copy of runtime.copies)
				compare(expected, inventory(path.join(options.root, copy)));
		});
	if (release.notices)
		check("sbom-notices", () => {
			const notices = release.notices;
			if (!notices) throw new Error("notices missing");
			requireArtifact(notices.path);
			requireArtifact(notices.sbom);
			checkNotices(options.root, notices);
		});
	if (release.node) {
		const consistent = check("bundled-node-integrity", () => {
			const node = release.node;
			if (!node) throw new Error("Node missing");
			requireArtifact(node.path);
			if (!artifactSafe) throw new Error("staged artifact integrity failed");
			const bundled = text(object(json(options.repo, "tools/fetch-node/versions.json")).bundled);
			if (node.version !== bundled)
				throw new Error("Node version differs from repository bundled pin");
			checkNodeIntegrity(options.root, node);
		});
		if (consistent)
			findings.push({
				check: "bundled-node-runtime",
				reason:
					"candidate not executed: official archive trust and the Temporal/--disable-sigusr1 probe require an independently verified executable",
			});
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
		for (const name of ["node", "runtime", "notices"] as const) {
			if (!release[name])
				findings.push({ check: name, reason: `required release input missing: ${name}` });
		}
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
	if (!release.node || !release.nodeSource) return result;
	const findings = result.findings.filter((finding) => finding.check !== "bundled-node-runtime");
	const checks = [...result.checks];
	try {
		await authenticatedNodeProbe(options.root, release.node, release.nodeSource, deps);
		checks.push("bundled-node-authentication", "bundled-node-runtime");
	} catch (error) {
		findings.push({
			check: "bundled-node-runtime",
			reason: error instanceof Error ? error.message : String(error),
		});
	}
	return { scope: options.scope, findings, checks };
}
