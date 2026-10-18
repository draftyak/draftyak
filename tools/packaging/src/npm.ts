import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	linkSync,
	lstatSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { gzipSync } from "node:zlib";
import {
	checkBytes,
	digest,
	exactTree,
	type FileRecord,
	jsonValue,
	noLinks,
	object,
	records,
	regularBytes,
	relativeFile,
	text,
} from "../../bundle-hub/src/inventory.ts";
import { localPath } from "../../release-guard/src/integrity.ts";
import { unpack } from "../../release-guard/src/tar.ts";

const defaultRepo = path.resolve(import.meta.dirname, "../../..");
const nativeTargets = [
	"darwin-arm64",
	"darwin-x64",
	"linux-arm64",
	"linux-x64",
	"linuxmusl-arm64",
	"linuxmusl-x64",
	"win32-arm64",
	"win32-x64",
];
const MAX_ARCHIVE = 256 * 1024 * 1024;

export interface NpmOptions {
	readonly bundle: string;
	readonly out: string;
	readonly repo?: string;
}

export interface NpmArtifact {
	readonly file: string;
	readonly version: string;
	readonly sha256: string;
	readonly bytes: number;
}

const json = (value: unknown): Buffer => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const row = (file: string, bytes: Buffer): FileRecord => ({
	path: file,
	sha256: digest(bytes),
	bytes: bytes.length,
});

function releaseVersion(value: unknown): string {
	const version = text(value, "release version");
	if (
		!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][A-Za-z0-9-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][A-Za-z0-9-]*))*)?$/.test(
			version,
		)
	)
		throw new Error("unsupported npm release version");
	return version;
}

function expectPath(value: unknown, expected: string, label: string): void {
	if (value !== expected) throw new Error(`${label} must be ${expected}`);
}

function packageObject(bytes: Buffer): Record<string, unknown> {
	const value = jsonValue(bytes.toString("utf8"));
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("package metadata must be an object");
	const pkg = value as Record<string, unknown>;
	if (pkg.scripts !== undefined) {
		const scripts = pkg.scripts;
		if (!scripts || typeof scripts !== "object" || Array.isArray(scripts))
			throw new Error("package scripts must be an object");
		if (
			[
				"preinstall",
				"install",
				"postinstall",
				"prepublish",
				"preprepare",
				"prepare",
				"postprepare",
			].some((name) => Object.hasOwn(scripts, name))
		)
			throw new Error("install lifecycle hooks are forbidden in npm payloads");
	}
	return pkg;
}

interface Candidate {
	readonly version: string;
	readonly files: Map<string, Buffer>;
	readonly python: boolean;
}

// The supplied inventory is a trusted build input, not proof of product behavior or release approval.
function verifiedCandidate(root: string, repo: string): Candidate {
	const originalInventory = regularBytes(path.join(root, "inventory.json"));
	const inventory = object(
		jsonValue(originalInventory.toString("utf8")),
		["schemaVersion", "files"],
		"bundle inventory",
	);
	if (inventory.schemaVersion !== 1) throw new Error("bundle inventory schemaVersion must be 1");
	const expected = records(inventory.files);
	if (expected.some((file) => file.path === "inventory.json"))
		throw new Error("bundle inventory must exclude itself");
	exactTree(root, [...expected, row("inventory.json", originalInventory)]);
	const source = new Map<string, Buffer>();
	for (const file of expected) {
		const bytes = regularBytes(path.join(root, file.path));
		checkBytes(file, bytes);
		source.set(file.path, bytes);
	}
	const requireFile = (file: string): Buffer => {
		const bytes = source.get(file);
		if (!bytes?.length) throw new Error(`required built payload is missing or empty: ${file}`);
		return bytes;
	};
	const metadata = object(
		jsonValue(requireFile("bundle.json").toString("utf8")),
		["schemaVersion", "version", "target", "node", "hub", "cli", "native", "python"],
		"bundle metadata",
	);
	if (metadata.schemaVersion !== 1) throw new Error("bundle metadata schemaVersion must be 1");
	const version = releaseVersion(metadata.version);
	const target = object(metadata.target, ["platform", "arch"], "bundle target");
	if (
		!["win", "linux", "darwin"].includes(String(target.platform)) ||
		!["x64", "arm64"].includes(String(target.arch))
	)
		throw new Error("unsupported bundle target");
	const cli = object(metadata.cli, ["entry", "main"], "built CLI metadata");
	expectPath(cli.entry, "cli/draftyak.mjs", "CLI launcher");
	expectPath(cli.main, "cli/main.js", "CLI main");
	if (
		!requireFile("cli/draftyak.mjs").equals(
			regularBytes(path.join(repo, "tools/packaging/templates/draftyak.mjs")),
		)
	)
		throw new Error("candidate launcher differs from the protected repository launcher");
	requireFile("cli/main.js");
	const hub = object(metadata.hub, ["entry"], "hub metadata");
	expectPath(hub.entry, "hub/hub.mjs", "hub entry");
	requireFile("hub/hub.mjs");
	requireFile("hub/spa/index.html");
	for (const prefix of ["hub/plugins/", "hub/migrations/"])
		if (![...source.keys()].some((file) => file.startsWith(prefix)))
			throw new Error(`required built payload is missing: ${prefix}`);
	const native = object(
		metadata.native,
		["name", "version", "integrity", "main", "bindings"],
		"native metadata",
	);
	expectPath(native.name, "better-sqlite3-multiple-ciphers", "native package name");
	expectPath(native.version, "13.0.3", "native package version");
	expectPath(native.main, "native/lib/index.js", "native package main");
	if (!/^sha512-[A-Za-z0-9+/]{86}==$/.test(text(native.integrity, "native archive integrity")))
		throw new Error("invalid native archive integrity provenance");
	const bindings = object(native.bindings, nativeTargets, "native bindings");
	for (const target of nativeTargets) {
		const file = `native/prebuilds/${target}.node`;
		expectPath(bindings[target], file, "native binding");
		requireFile(file);
	}
	const pkg = packageObject(requireFile("native/package.json"));
	if (pkg.name !== native.name || pkg.version !== native.version || pkg.main !== "lib/index.js")
		throw new Error("native package identity differs from bundle metadata");
	requireFile("native/LICENSE");
	requireFile("native/lib/index.js");
	for (const file of ["database", "binding", "util", "sqlite-error", ...nativeTargets])
		requireFile(`native/lib/${file}.js`);
	for (const method of [
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
	])
		requireFile(`native/lib/methods/${method}.js`);
	if (!/\bNAPI_VERSION=10\b/.test(requireFile("native/binding.gyp").toString("utf8")))
		throw new Error("native payload requires N-API 10");
	const node = object(
		metadata.node,
		["version", "signer", "archiveSha256", "binary", "license"],
		"staging Node provenance",
	);
	expectPath(
		node.binary,
		target.platform === "win" ? "node.exe" : "node",
		"staging Node executable",
	);
	expectPath(node.license, "LICENSE.node", "staging Node license");
	if (!/^[0-9a-f]{64}$/.test(text(node.archiveSha256, "Node archive digest")))
		throw new Error("invalid Node archive provenance");
	text(node.signer, "Node signer");
	text(node.version, "Node version");
	requireFile(String(node.binary));
	requireFile("LICENSE.node");
	let python: Record<string, unknown> | undefined;
	if (metadata.python !== undefined) {
		python = object(metadata.python, ["root", "inventory"], "Python runtime metadata");
		expectPath(python.root, "runtime-python", "Python runtime root");
		expectPath(python.inventory, "runtime-python.inventory.json", "Python runtime inventory");
		const canonical = object(
			jsonValue(requireFile("runtime-python.inventory.json").toString("utf8")),
			["schemaVersion", "files"],
			"Python inventory",
		);
		if (canonical.schemaVersion !== 1) throw new Error("Python inventory schemaVersion must be 1");
		const runtimeFiles = records(canonical.files);
		exactTree(path.join(root, "runtime-python"), runtimeFiles);
		for (const file of runtimeFiles) checkBytes(file, requireFile(`runtime-python/${file.path}`));
		const runtimePackage = packageObject(requireFile("runtime-python/package.json"));
		if (runtimePackage.name !== "@draftyak/runtime-python" || runtimePackage.version !== version)
			throw new Error("Python runtime must match the npm release version");
		requireFile("runtime-python/shim.mjs");
	}
	const files = new Map<string, Buffer>();
	for (const [file, bytes] of source) {
		if (file.endsWith("/package.json")) packageObject(bytes);
		if (file === "bundle.json" || file === node.binary || file === node.license) continue;
		if (
			!["hub/", "cli/", "native/", ...(python ? ["runtime-python/"] : [])].some((prefix) =>
				file.startsWith(prefix),
			) &&
			!(python && file === "runtime-python.inventory.json")
		)
			throw new Error(`unexpected staged payload: ${file}`);
		files.set(file, bytes);
	}
	files.set("provenance/bundle.inventory.json", originalInventory);
	files.set("provenance/bundle.json", requireFile("bundle.json"));
	files.set(
		"bundle.json",
		json({
			schemaVersion: 1,
			format: "npm",
			version,
			target: { platform: "portable", arch: "portable" },
			hub,
			cli,
			native,
			...(python ? { python } : {}),
			node: { mode: "host", minimumVersion: "26.5.1" },
			stagingNode: { ...node, includedInPackage: false },
			provenance: {
				metadata: "provenance/bundle.json",
				inventory: "provenance/bundle.inventory.json",
			},
		}),
	);
	return { version, files, python: python !== undefined };
}

// Standard POSIX ustar with canonical ownership/time/modes, followed by deterministic gzip.
function archive(files: ReadonlyMap<string, Buffer>): Buffer {
	const blocks: Buffer[] = [];
	let size = 1024;
	for (const file of [...files.keys()].sort()) {
		relativeFile(file);
		const data = files.get(file);
		if (!data) throw new Error("archive file disappeared");
		const full = `package/${file}`;
		let name = full;
		let prefix = "";
		if (Buffer.byteLength(full) > 100) {
			const split = [...full.matchAll(/\//g)]
				.map((match) => match.index)
				.reverse()
				.find(
					(at) =>
						Buffer.byteLength(full.slice(0, at)) <= 155 &&
						Buffer.byteLength(full.slice(at + 1)) <= 100,
				);
			if (split === undefined) throw new Error("path cannot be encoded in ustar");
			name = full.slice(split + 1);
			prefix = full.slice(0, split);
		}
		const padding = (512 - (data.length % 512)) % 512;
		size += 512 + data.length + padding;
		if (size > MAX_ARCHIVE) throw new Error("npm artifact expands beyond 256 MiB");
		const header = Buffer.alloc(512);
		const octal = (value: number, width: number): string =>
			`${value.toString(8).padStart(width - 1, "0")}\0`;
		header.write(name, 0, 100, "utf8");
		header.write(octal(file === "cli/draftyak.mjs" ? 0o755 : 0o644, 8), 100);
		header.write(octal(0, 8), 108);
		header.write(octal(0, 8), 116);
		header.write(octal(data.length, 12), 124);
		header.write(octal(0, 12), 136);
		header.fill(32, 148, 156);
		header.write("0", 156);
		header.write("ustar\0", 257);
		header.write("00", 263);
		header.write(prefix, 345, 155, "utf8");
		header.write(
			`${octal(
				header.reduce((sum, byte) => sum + byte, 0),
				7,
			)} `,
			148,
		);
		blocks.push(header, data, Buffer.alloc(padding));
	}
	blocks.push(Buffer.alloc(1024));
	const packed = gzipSync(Buffer.concat(blocks), { level: 9 });
	packed.writeUInt32LE(0, 4);
	packed[9] = 255; // platform-neutral gzip OS header; CRC covers payload, not this header.
	const actual = unpack(packed);
	if (actual.size !== files.size) throw new Error("archive self-check file count mismatch");
	for (const [file, bytes] of files)
		if (!actual.get(`package/${file}`)?.equals(bytes))
			throw new Error("archive self-check byte mismatch");
	return packed;
}

/** Assemble only; no subprocesses, installs, downloads, signatures, publication or product execution. */
export function assembleNpm(options: NpmOptions): NpmArtifact {
	const root = localPath(options.bundle);
	const out = localPath(options.out);
	const repo = localPath(options.repo ?? defaultRepo);
	noLinks(out);
	if (!lstatSync(out).isDirectory()) throw new Error("npm output directory must already exist");
	const relative = path.relative(root, out);
	if (
		relative === "" ||
		(!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
	)
		throw new Error("npm output must be outside the candidate tree");
	const candidate = verifiedCandidate(root, repo);
	const files = candidate.files;
	files.set("LICENSE", regularBytes(path.join(repo, "LICENSE")));
	files.set("NOTICE", regularBytes(path.join(repo, "NOTICE")));
	files.set(
		"package.json",
		json({
			name: "draftyak",
			version: candidate.version,
			type: "module",
			license: "Apache-2.0",
			engines: { node: ">=26.5.1" },
			bin: { draftyak: "cli/draftyak.mjs" },
			...(candidate.python
				? { dependencies: { "@draftyak/runtime-python": candidate.version } }
				: {}),
		}),
	);
	files.set(
		"package.inventory.json",
		json({
			schemaVersion: 1,
			files: [...files.entries()]
				.sort(([a], [b]) => (a < b ? -1 : 1))
				.map(([file, bytes]) => row(file, bytes)),
		}),
	);
	const packed = archive(files);
	const destination = path.join(out, `draftyak-${candidate.version}.tgz`);
	if (existsSync(destination)) throw new Error("npm artifact already exists");
	const temporary = mkdtempSync(path.join(out, ".npm-assemble-"));
	if (path.dirname(temporary) !== out || !path.basename(temporary).startsWith(".npm-assemble-"))
		throw new Error("unexpected npm scratch path");
	try {
		const staged = path.join(temporary, "package.tgz");
		writeFileSync(staged, packed, { flag: "wx", mode: 0o644 });
		chmodSync(staged, 0o644);
		// link is exclusive: even a concurrently created destination cannot be overwritten.
		linkSync(staged, destination);
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
	return {
		file: destination,
		version: candidate.version,
		sha256: createHash("sha256").update(packed).digest("hex"),
		bytes: packed.length,
	};
}

export function main(argv: readonly string[]): number {
	try {
		const { values } = parseArgs({
			args: argv[0] === "--" ? argv.slice(1) : [...argv],
			options: {
				bundle: { type: "string" },
				out: { type: "string" },
				repo: { type: "string" },
				help: { type: "boolean" },
			},
		});
		if (values.help) {
			console.log(
				"usage: npm-artifact --bundle <verified-stage> --out <existing-output-directory> [--repo <repository>]",
			);
			return 0;
		}
		if (!values.bundle || !values.out) throw new Error("--bundle and --out are required");
		console.log(
			JSON.stringify(assembleNpm({ bundle: values.bundle, out: values.out, repo: values.repo })),
		);
		return 0;
	} catch (error) {
		console.error(`npm-artifact: ${error instanceof Error ? error.message : "failed"}`);
		return 1;
	}
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2));
