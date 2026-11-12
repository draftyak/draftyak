import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import { assertPortableFileTree } from "@draftyak/bounded-files";
import { CLI_PAYLOAD } from "@draftyak/cli/payload-contract";
import {
	parseChecksums,
	readArchive,
	resolveGpgv,
	verifySignature,
} from "../../fetch-node/fetch-node.mjs";
import { assertHubMigrations } from "./hub-migrations.ts";
import {
	checkBytes,
	digest,
	emptyDirectoryRecords,
	exactTree,
	type FileRecord,
	inventoryOf,
	jsonValue,
	noDotComponents,
	noLinks,
	object,
	records,
	regularBytes,
	relativeFile,
	text,
} from "./inventory.ts";
import { assertCliModuleBoundary, canonicalLauncher } from "./launcher.ts";
import { stageNativePackage } from "./native-payload.ts";

export const NATIVE_NAME = "better-sqlite3-multiple-ciphers";
export const NATIVE_VERSION = "13.0.3";
const pythonUnavailable = "canonical Python runtime producer is unavailable";

function pythonDependencyAlias(value: unknown): boolean {
	// Recognize explicit aliases to this identity, without interpreting other dependency specs.
	return (
		typeof value === "string" &&
		/^(?:npm|workspace):@draftyak\/runtime-python(?:@|$)/i.test(value.trim())
	);
}

function runtimeFreeRecords(value: unknown): readonly FileRecord[] {
	const files = records(value);
	if (files.some((file) => /(^|\/)runtime-python(?:\.inventory\.json)?(?:\/|$)/i.test(file.path)))
		throw new Error(pythonUnavailable);
	return files;
}

function pythonPackageClaim(pkg: Record<string, unknown>): boolean {
	const runtime = "@draftyak/runtime-python";
	if (typeof pkg.name === "string" && pkg.name.toLowerCase() === runtime) return true;
	return [
		"dependencies",
		"optionalDependencies",
		"peerDependencies",
		"devDependencies",
		"bundledDependencies",
		"bundleDependencies",
	].some((name) => {
		const value = pkg[name];
		return Array.isArray(value)
			? value.some(
					(entry) =>
						(typeof entry === "string" && entry.toLowerCase() === runtime) ||
						pythonDependencyAlias(entry),
				)
			: value !== null &&
					typeof value === "object" &&
					Object.entries(value).some(
						([entry, spec]) => entry.toLowerCase() === runtime || pythonDependencyAlias(spec),
					);
	});
}
// The reviewed package pin from pnpm-lock.yaml; a kept test detects lockfile drift.
export const NATIVE_INTEGRITY =
	"sha512-UYabM82r1J84TLWc/SszoHs6XopWpl/2HCg3Nui1JUaFXg/VLswzkPowYiRhK/4CftI8dgtikwyZQecMldrGxQ==";
export const TARGETS: readonly string[] = [
	"darwin-arm64",
	"darwin-x64",
	"linux-arm64",
	"linux-x64",
	"linuxmusl-arm64",
	"linuxmusl-x64",
	"win32-arm64",
	"win32-x64",
];

const libFiles = ["index", "database", "binding", "util", "sqlite-error", ...TARGETS].map(
	(name) => `lib/${name}.js`,
);
const methodFiles = [
	"aggregate",
	"backup",
	"explain",
	"function",
	"inspect",
	"pragma",
	"serialize",
	"table",
	"transaction",
	"wrappers",
].map((name) => `lib/methods/${name}.js`);
export const NATIVE_REQUIRED: readonly string[] = [
	"package.json",
	"LICENSE",
	"binding.gyp",
	...libFiles,
	...methodFiles,
	...TARGETS.map((target) => `prebuilds/${target}.node`),
];

interface Payload {
	readonly root: string;
	readonly files: readonly FileRecord[];
	readonly emptyDirectories?: readonly string[];
}

export interface BundleSpec {
	readonly schemaVersion: 1;
	readonly profile?: "desktop-snapshot";
	readonly version: string;
	readonly target: {
		readonly platform: "win" | "linux" | "darwin";
		readonly arch: "x64" | "arm64";
	};
	readonly hub: Payload;
	readonly cli?: Payload;
	readonly python?: Payload;
	readonly native: { readonly archive: string; readonly files: readonly FileRecord[] };
	readonly node: { readonly root: string };
}

export interface BundleDeps {
	// Test fixtures replace signature verification, never the CLI's production verifier.
	readonly signature?: (sums: Buffer, signature: Buffer) => Promise<string>;
	readonly nativeIntegrity?: string;
}

export function parseSpec(value: unknown, base: string): BundleSpec {
	noDotComponents(base);
	const row = object(
		value,
		["schemaVersion", "profile", "version", "target", "hub", "cli", "python", "native", "node"],
		"bundle spec",
	);
	if (row.schemaVersion !== 1) throw new Error("bundle spec: unsupported schemaVersion");
	if ("python" in row) throw new Error(pythonUnavailable);
	if (row.profile !== undefined && row.profile !== "desktop-snapshot")
		throw new Error("bundle spec: unsupported profile");
	const version = text(row.version, "version");
	if (!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)*)?$/.test(version)) {
		throw new Error("bundle spec: invalid release version");
	}
	const target = object(row.target, ["platform", "arch"], "target");
	if (
		!["win", "linux", "darwin"].includes(String(target.platform)) ||
		!["x64", "arm64"].includes(String(target.arch))
	) {
		throw new Error("bundle spec: unsupported target");
	}
	const payload = (value: unknown, name: string): Payload => {
		const item = object(value, ["root", "files", "emptyDirectories"], name);
		const root = text(item.root, `${name} root`);
		noDotComponents(root);
		const files = runtimeFreeRecords(item.files);
		const emptyDirectories = emptyDirectoryRecords(item.emptyDirectories);
		if (
			emptyDirectories.some((directory) =>
				/(^|\/)runtime-python(?:\.inventory\.json)?(?:\/|$)/i.test(directory),
			)
		)
			throw new Error(pythonUnavailable);
		assertPortableFileTree([...files.map((file) => file.path), ...emptyDirectories]);
		return {
			root: path.resolve(base, root),
			files,
			...(emptyDirectories.length ? { emptyDirectories } : {}),
		};
	};
	const native = object(row.native, ["archive", "files"], "native");
	const node = object(row.node, ["root"], "node");
	const archive = text(native.archive, "native archive");
	const nodeRoot = text(node.root, "node root");
	noDotComponents(archive);
	noDotComponents(nodeRoot);
	const spec: BundleSpec = {
		schemaVersion: 1,
		...(row.profile === undefined ? {} : { profile: "desktop-snapshot" as const }),
		version,
		target: {
			platform: target.platform as BundleSpec["target"]["platform"],
			arch: target.arch as BundleSpec["target"]["arch"],
		},
		hub: payload(row.hub, "hub"),
		...(row.cli === undefined ? {} : { cli: payload(row.cli, "cli") }),
		native: {
			archive: path.resolve(base, archive),
			files: runtimeFreeRecords(native.files),
		},
		node: { root: path.resolve(base, nodeRoot) },
	};
	const hubFiles = spec.hub.files.map((file) => file.path);
	if (spec.profile === "desktop-snapshot") {
		const host = `${spec.target.platform === "win" ? "win32" : spec.target.platform}-${spec.target.arch}`;
		if (
			["hub.mjs", "web/index.html", `native/${host}.node`].some(
				(file) => !spec.hub.files.some((row) => row.path === file && row.bytes > 0),
			)
		)
			throw new Error(
				"desktop snapshot requires the real hub, web, migrations and host native binding",
			);
		if (spec.cli)
			throw new Error(
				"desktop snapshot cannot assert unfinished CLI or Python release integration",
			);
	} else if (
		!hubFiles.includes("hub.mjs") ||
		!hubFiles.includes("spa/index.html") ||
		!hubFiles.some((file) => file.startsWith("plugins/")) ||
		spec.hub.files.some(
			(file) => ["hub.mjs", "spa/index.html"].includes(file.path) && file.bytes === 0,
		)
	) {
		throw new Error(
			"missing built product assets: hub.mjs, plugins/, migrations/ and spa/ are required",
		);
	}
	if (
		spec.cli &&
		[CLI_PAYLOAD.entry, "package.json"].some(
			(file) => !spec.cli?.files.some((row) => row.path === file),
		)
	) {
		throw new Error(`CLI payload requires ${CLI_PAYLOAD.entry} and package.json`);
	}
	if (spec.cli?.files.some((row) => row.path === "draftyak.mjs"))
		throw new Error("protected launcher must stay outside the catalogued CLI payload");
	if (NATIVE_REQUIRED.some((file) => !spec.native.files.some((row) => row.path === file))) {
		throw new Error(
			"native package inventory lacks runtime files or the complete eight-prebuild matrix",
		);
	}
	if (
		spec.native.files.some(
			(row) =>
				row.path.startsWith("prebuilds/") &&
				!TARGETS.some((target) => row.path === `prebuilds/${target}.node`),
		)
	) {
		throw new Error("native inventory includes an unexpected prebuild");
	}
	assertHubMigrations(spec.hub.files);
	return spec;
}

function write(root: string, file: string, bytes: Uint8Array, executable = false): void {
	relativeFile(file);
	const destination = path.join(root, file);
	mkdirSync(path.dirname(destination), { recursive: true });
	writeFileSync(destination, bytes, { flag: "wx", mode: executable ? 0o755 : 0o644 });
	// Creation modes are masked by umask; chmod establishes the packaging contract afterward.
	chmodSync(destination, executable ? 0o755 : 0o644);
}

function directoryModes(root: string): void {
	for (const name of readdirSync(root)) {
		const file = path.join(root, name);
		const stat = lstatSync(file);
		if (stat.isSymbolicLink()) throw new Error("link appeared in staged output");
		if (stat.isDirectory()) directoryModes(file);
	}
	// Include the mkdtemp root, whose initial permissions are 0700 on POSIX.
	chmodSync(root, 0o755);
}

function json(root: string, file: string, value: unknown): void {
	write(root, file, Buffer.from(`${JSON.stringify(value, null, 2)}\n`));
}

function copyPayload(payload: Payload, stage: string, prefix: string): void {
	exactTree(payload.root, payload.files, payload.emptyDirectories);
	for (const row of payload.files) {
		const bytes = regularBytes(path.join(payload.root, row.path));
		checkBytes(row, bytes);
		write(stage, `${prefix}/${row.path}`, bytes);
	}
	for (const directory of payload.emptyDirectories ?? [])
		mkdirSync(path.join(stage, prefix, directory), { recursive: true });
	// Detect newly added, removed, or linked files before publication too.
	exactTree(payload.root, payload.files, payload.emptyDirectories);
}

async function copyNode(
	spec: BundleSpec,
	stage: string,
	deps: BundleDeps,
	version: string,
): Promise<Record<string, string>> {
	const { platform, arch } = spec.target;
	const folder = `node-v${version}-${platform}-${arch}`;
	const format = platform === "win" ? "zip" : "tar.gz";
	const archive = `${folder}.${format}`;
	const sums = regularBytes(path.join(spec.node.root, "SHASUMS256.txt"));
	const signature = regularBytes(path.join(spec.node.root, "SHASUMS256.txt.sig"));
	const signer = await (
		deps.signature ??
		((text, signature) =>
			verifySignature(
				text,
				signature,
				path.resolve(import.meta.dirname, "../../fetch-node/keys"),
				resolveGpgv(),
			))
	)(sums, signature);
	const expected = parseChecksums(sums.toString("utf8")).get(archive);
	const packed = regularBytes(path.join(spec.node.root, archive));
	if (!expected || digest(packed) !== expected)
		throw new Error("official Node archive SHA-256 mismatch");
	const binary = platform === "win" ? "node.exe" : "node";
	const binaryEntry = `${folder}/${platform === "win" ? binary : `bin/${binary}`}`;
	const licenseEntry = `${folder}/LICENSE`;
	const files = await readArchive(packed, format, [binaryEntry, licenseEntry]);
	const node = files.get(binaryEntry);
	const license = files.get(licenseEntry);
	if (!node?.length || !license?.length)
		throw new Error("official Node archive lacks required files");
	write(stage, binary, node, true);
	write(stage, "LICENSE.node", license);
	return { version, signer, archiveSha256: expected, binary, license: "LICENSE.node" };
}

/** Create a new candidate; never merge into or replace an existing output. No network or product execution. */
export async function bundle(
	spec: BundleSpec,
	output: string,
	deps: BundleDeps = {},
): Promise<void> {
	// Revalidate callers using the programmatic API as strictly as the CLI.
	noDotComponents(output);
	spec = parseSpec(spec, process.cwd());
	for (const payload of [spec.hub, spec.cli]) {
		if (!payload) continue;
		for (const row of payload.files) {
			if (!/(^|\/)package\.json$/i.test(row.path)) continue;
			const bytes = regularBytes(path.join(payload.root, row.path));
			checkBytes(row, bytes);
			const pkg = jsonValue(bytes.toString("utf8"));
			if (!pkg || typeof pkg !== "object" || Array.isArray(pkg))
				throw new Error("payload package metadata must be an object");
			if (pythonPackageClaim(pkg as Record<string, unknown>)) throw new Error(pythonUnavailable);
		}
	}
	const destination = path.resolve(output);
	const parent = path.dirname(destination);
	noLinks(parent);
	if (!lstatSync(parent).isDirectory() || existsSync(destination))
		throw new Error("output must be a new directory under an existing parent");
	const inputs = [spec.hub.root, spec.cli?.root, spec.node.root].filter(
		(root): root is string => root !== undefined,
	);
	if (
		inputs.some((root) => {
			const relative = path.relative(root, destination);
			return (
				relative === "" ||
				(!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
			);
		})
	)
		throw new Error("output must not be inside an input tree");
	const launcher = canonicalLauncher();
	const stage = mkdtempSync(path.join(parent, ".bundle-hub-"));
	try {
		copyPayload(spec.hub, stage, "hub");
		if (spec.cli) {
			copyPayload(spec.cli, stage, "cli");
			assertCliModuleBoundary(regularBytes(path.join(stage, "cli/package.json"), 65_536));
			write(stage, "draftyak.mjs", launcher.bytes, true);
		}
		const node = await copyNode(spec, stage, deps, launcher.policy.bundled);
		const bindings = await stageNativePackage(
			spec.native,
			spec.target,
			stage,
			deps.nativeIntegrity,
		);
		if (spec.profile === "desktop-snapshot") {
			const host = `${spec.target.platform === "win" ? "win32" : spec.target.platform}-${spec.target.arch}`;
			const actual = regularBytes(path.join(stage, `hub/native/${host}.node`));
			const canonical = regularBytes(path.join(stage, `native/prebuilds/${host}.node`));
			if (!actual.equals(canonical))
				throw new Error("hub native binding differs from authenticated package prebuild");
		}
		json(stage, "bundle.json", {
			schemaVersion: 1,
			...(spec.profile ? { profile: spec.profile } : {}),
			version: spec.version,
			target: spec.target,
			node,
			hub: { entry: "hub/hub.mjs" },
			...(spec.cli ? { cli: { entry: "draftyak.mjs", main: CLI_PAYLOAD.stagedEntry } } : {}),
			native: {
				name: NATIVE_NAME,
				version: NATIVE_VERSION,
				integrity: deps.nativeIntegrity ?? NATIVE_INTEGRITY,
				main: "native/lib/index.js",
				bindings,
			},
		});
		const emptyDirectories = [
			...(spec.hub.emptyDirectories ?? []).map((directory) => `hub/${directory}`),
			...(spec.cli?.emptyDirectories ?? []).map((directory) => `cli/${directory}`),
		];
		const inventory = inventoryOf(stage, emptyDirectories);
		for (const row of inventory.files) checkBytes(row, regularBytes(path.join(stage, row.path)));
		json(stage, "inventory.json", inventory);
		directoryModes(stage);
		if (existsSync(destination)) throw new Error("output appeared during staging");
		// Same-parent rename publishes the complete tree; failure removes only our private scratch dir.
		renameSync(stage, destination);
	} finally {
		if (existsSync(stage)) rmSync(stage, { recursive: true, force: true });
	}
}
