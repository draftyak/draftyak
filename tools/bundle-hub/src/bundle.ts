import { createHash } from "node:crypto";
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
import {
	parseChecksums,
	readArchive,
	resolveGpgv,
	verifySignature,
} from "../../fetch-node/fetch-node.mjs";
import {
	checkBytes,
	digest,
	exactTree,
	type FileRecord,
	inventoryOf,
	noLinks,
	object,
	records,
	regularBytes,
	relativeFile,
	text,
} from "./inventory.ts";

export const NATIVE_NAME = "better-sqlite3-multiple-ciphers";
export const NATIVE_VERSION = "13.0.3";
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
	const row = object(
		value,
		["schemaVersion", "profile", "version", "target", "hub", "cli", "python", "native", "node"],
		"bundle spec",
	);
	if (row.schemaVersion !== 1) throw new Error("bundle spec: unsupported schemaVersion");
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
		const item = object(value, ["root", "files"], name);
		return {
			root: path.resolve(base, text(item.root, `${name} root`)),
			files: records(item.files),
		};
	};
	const native = object(row.native, ["archive", "files"], "native");
	const node = object(row.node, ["root"], "node");
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
		...(row.python === undefined ? {} : { python: payload(row.python, "python") }),
		native: {
			archive: path.resolve(base, text(native.archive, "native archive")),
			files: records(native.files),
		},
		node: { root: path.resolve(base, text(node.root, "node root")) },
	};
	const hubFiles = spec.hub.files.map((file) => file.path);
	if (spec.profile === "desktop-snapshot") {
		const host = `${spec.target.platform === "win" ? "win32" : spec.target.platform}-${spec.target.arch}`;
		if (
			["hub.mjs", "web/index.html", `native/${host}.node`].some(
				(file) => !spec.hub.files.some((row) => row.path === file && row.bytes > 0),
			) ||
			!hubFiles.some((file) => file.startsWith("migrations/"))
		)
			throw new Error(
				"desktop snapshot requires the real hub, web, migrations and host native binding",
			);
		if (spec.cli || spec.python)
			throw new Error(
				"desktop snapshot cannot assert unfinished CLI or Python release integration",
			);
	} else if (
		!hubFiles.includes("hub.mjs") ||
		!hubFiles.includes("spa/index.html") ||
		["plugins/", "migrations/"].some(
			(prefix) => !hubFiles.some((file) => file.startsWith(prefix)),
		) ||
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
		["draftyak.mjs", "main.js"].some((file) => !spec.cli?.files.some((row) => row.path === file))
	) {
		throw new Error("CLI payload requires draftyak.mjs and main.js");
	}
	if (
		spec.python &&
		["package.json", "shim.mjs"].some(
			(file) => !spec.python?.files.some((row) => row.path === file),
		)
	) {
		throw new Error("Python runtime requires package.json and shim.mjs");
	}
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
	exactTree(payload.root, payload.files);
	for (const row of payload.files) {
		const bytes = regularBytes(path.join(payload.root, row.path));
		checkBytes(row, bytes);
		write(stage, `${prefix}/${row.path}`, bytes);
	}
	// Detect newly added, removed, or linked files before publication too.
	exactTree(payload.root, payload.files);
}

async function copyNode(
	spec: BundleSpec,
	stage: string,
	deps: BundleDeps,
): Promise<Record<string, string>> {
	const versions = JSON.parse(
		regularBytes(path.resolve(import.meta.dirname, "../../fetch-node/versions.json")).toString(
			"utf8",
		),
	) as { bundled: string };
	const version = versions.bundled;
	if (!/^26\.\d+\.\d+$/.test(version) || Number(version.split(".")[1]) < 12) {
		throw new Error("bundled Node must be pinned to 26.12.0 or newer Node 26");
	}
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

async function copyNative(spec: BundleSpec, stage: string, deps: BundleDeps): Promise<void> {
	const packed = regularBytes(spec.native.archive);
	const integrity = `sha512-${createHash("sha512").update(packed).digest("base64")}`;
	if (integrity !== (deps.nativeIntegrity ?? NATIVE_INTEGRITY))
		throw new Error("native package sha512 does not match its reviewed pin");
	const entries = await readArchive(
		packed,
		"tar.gz",
		spec.native.files.map((file) => `package/${file.path}`),
	);
	for (const row of spec.native.files) {
		const bytes = entries.get(`package/${row.path}`);
		if (!bytes) throw new Error("native archive lacks an inventoried file");
		checkBytes(row, bytes);
		if (row.path === "package.json") {
			const pkg = JSON.parse(bytes.toString("utf8"));
			if (pkg.name !== NATIVE_NAME || pkg.version !== NATIVE_VERSION || pkg.main !== "lib/index.js")
				throw new Error("native package identity or main entry mismatch");
			if (
				["preinstall", "install", "postinstall", "prepare"].some(
					(hook) => pkg.scripts?.[hook] !== undefined,
				)
			)
				throw new Error("native lifecycle script refused");
		}
		if (row.path === "binding.gyp" && !/\bNAPI_VERSION=10\b/.test(bytes.toString("utf8")))
			throw new Error("native N-API version must be 10");
		write(stage, `native/${row.path}`, bytes);
	}
}

/** Create a new candidate; never merge into or replace an existing output. No network or product execution. */
export async function bundle(
	spec: BundleSpec,
	output: string,
	deps: BundleDeps = {},
): Promise<void> {
	// Revalidate callers using the programmatic API as strictly as the CLI.
	spec = parseSpec(spec, process.cwd());
	const destination = path.resolve(output);
	const parent = path.dirname(destination);
	noLinks(parent);
	if (!lstatSync(parent).isDirectory() || existsSync(destination))
		throw new Error("output must be a new directory under an existing parent");
	const inputs = [spec.hub.root, spec.cli?.root, spec.python?.root, spec.node.root].filter(
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
	const stage = mkdtempSync(path.join(parent, ".bundle-hub-"));
	try {
		copyPayload(spec.hub, stage, "hub");
		if (spec.cli) copyPayload(spec.cli, stage, "cli");
		if (spec.python) {
			copyPayload(spec.python, stage, "runtime-python");
			const pkg = JSON.parse(
				regularBytes(path.join(spec.python.root, "package.json")).toString("utf8"),
			);
			if (pkg.name !== "@draftyak/runtime-python" || pkg.version !== spec.version)
				throw new Error("Python runtime and hub versions must match");
			json(stage, "runtime-python.inventory.json", { schemaVersion: 1, files: spec.python.files });
		}
		const node = await copyNode(spec, stage, deps);
		await copyNative(spec, stage, deps);
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
			...(spec.cli ? { cli: { entry: "cli/draftyak.mjs", main: "cli/main.js" } } : {}),
			native: {
				name: NATIVE_NAME,
				version: NATIVE_VERSION,
				integrity: deps.nativeIntegrity ?? NATIVE_INTEGRITY,
				main: "native/lib/index.js",
				bindings: Object.fromEntries(
					TARGETS.map((target) => [target, `native/prebuilds/${target}.node`]),
				),
			},
			...(spec.python
				? { python: { root: "runtime-python", inventory: "runtime-python.inventory.json" } }
				: {}),
		});
		const inventory = inventoryOf(stage);
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
