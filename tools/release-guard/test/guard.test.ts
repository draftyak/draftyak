import { spawnSync } from "node:child_process";
import {
	linkSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { afterAll, describe, expect, it, vi } from "vitest";
import { checkNodeIntegrity, guard, manifest, npmPackages } from "../src/guard.ts";
import { compare, hash, inventory, records, relative } from "../src/integrity.ts";
import { unpack, unpackTree } from "../src/tar.ts";

const base = realpathSync.native(mkdtempSync(path.join(tmpdir(), "draftyak-release-guard-")));
afterAll(() => rmSync(base, { recursive: true, force: true }));
let counter = 0;

function write(root: string, file: string, content: string | Uint8Array): void {
	const target = path.join(root, file);
	mkdirSync(path.dirname(target), { recursive: true });
	writeFileSync(target, content);
}

function fixture(): { stage: string; repo: string } {
	const folder = path.join(base, String(counter++));
	const stage = path.join(folder, "stage");
	const repo = path.join(folder, "repo");
	mkdirSync(stage, { recursive: true });
	mkdirSync(repo);
	write(stage, "hub/hub.mjs", "export {};\n");
	return { stage, repo };
}

interface Entry {
	name: string;
	body?: string;
	kind?: string;
	link?: string;
}

function tar(entries: readonly Entry[]): Buffer {
	const blocks: Buffer[] = [];
	for (const entry of entries) {
		const header = Buffer.alloc(512);
		header.write(entry.name);
		header.write("0000644\0", 100);
		header.write("0000000\0", 108);
		header.write("0000000\0", 116);
		const body = Buffer.from(entry.body ?? "");
		header.write(`${body.length.toString(8).padStart(11, "0")}\0`, 124);
		header.write("00000000000\0", 136);
		header.fill(32, 148, 156);
		header.write(entry.kind ?? "0", 156);
		if (entry.link) header.write(entry.link, 157);
		header.write("ustar\0", 257);
		header.write("00", 263);
		const sum = header.reduce((total, byte) => total + byte, 0);
		header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
		blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
	}
	blocks.push(Buffer.alloc(1024));
	return gzipSync(Buffer.concat(blocks));
}

function packageTar(metadata: Record<string, unknown>, extras: readonly Entry[] = []): Buffer {
	return tar([{ name: "package/package.json", body: JSON.stringify(metadata) }, ...extras]);
}

function input(stage: string): Record<string, unknown> {
	return { schemaVersion: 1, version: "0.1.0", artifacts: inventory(stage), npm: [] };
}

function inspect(
	stage: string,
	repo: string,
	value: unknown = input(stage),
): ReturnType<typeof guard> {
	return guard(value, { root: stage, repo, scope: "artifacts" });
}

function addPackage(
	stage: string,
	repo: string,
	metadata: Record<string, unknown>,
	extras: readonly Entry[] = [],
): Record<string, unknown> {
	write(stage, "cli.tgz", packageTar(metadata, extras));
	write(
		repo,
		"apps/cli/package.json",
		JSON.stringify({ ...metadata, name: "@draftyak/cli", private: true }),
	);
	return { ...input(stage), npm: [{ path: "cli.tgz", workspace: "apps/cli" }] };
}

describe("inventory integrity", () => {
	it("validates a real tree and refuses tampering, extra and missing files", () => {
		const { stage, repo } = fixture();
		const release = input(stage);
		expect(inspect(stage, repo, release).findings).toEqual([]);
		write(stage, "hub/hub.mjs", "tampered");
		expect(inspect(stage, repo, release).findings[0]?.reason).toContain("mismatch");
		write(stage, "extra", "x");
		expect(() => compare(records(release.artifacts), inventory(stage))).toThrow();
		expect(() =>
			compare([{ path: "missing", sha256: hash(Buffer.alloc(0)), bytes: 0 }], inventory(stage)),
		).toThrow("missing");
	});
	it.each([
		"../secret",
		"/absolute",
		"C:/escape",
		"x\\y",
		"x/../y",
		"x//y",
		"x:stream",
		"NUL.txt",
		"CONIN$",
		"CONOUT$.txt",
		"COM¹.txt",
		"lpt².log",
		"CON .txt",
		"a?b",
		"a|b",
		"a<b",
		'a"b',
		"a*b",
		".env.live",
		"nested/.ENV.secret",
		"a.",
		"a/ ",
		"a\u0000b",
	])("rejects hostile path %j", (file) => {
		expect(() => relative(file)).toThrow("unsafe");
	});
	it("rejects hard links and parent junctions", () => {
		const { stage } = fixture();
		linkSync(path.join(stage, "hub/hub.mjs"), path.join(stage, "hard-link"));
		expect(() => inventory(stage)).toThrow("single-link");
		const other = fixture();
		const target = path.join(base, "junction-target");
		mkdirSync(target);
		write(target, "payload", "x");
		symlinkSync(
			target,
			path.join(other.stage, "junction"),
			process.platform === "win32" ? "junction" : "dir",
		);
		expect(() => inventory(other.stage)).toThrow("link refused");
	});
	it("rejects unsorted and case-colliding expected records", () => {
		const row = { sha256: "a".repeat(64), bytes: 1 };
		expect(() =>
			records([
				{ ...row, path: "b" },
				{ ...row, path: "a" },
			]),
		).toThrow("unsorted");
		expect(() =>
			records([
				{ ...row, path: "A" },
				{ ...row, path: "a" },
			]),
		).toThrow("colliding");
	});
});

describe("npm file and empty-directory inventory", () => {
	const leaf = "cli/doctor/checks";
	function inspected(
		options: {
			declared?: readonly string[];
			actual?: readonly string[];
			child?: boolean;
			tamperedHash?: boolean;
			unknownField?: boolean;
			duplicateKey?: boolean;
			omitInventory?: boolean;
		} = {},
	) {
		const { stage, repo } = fixture();
		const metadata = { name: "draftyak", version: "0.1.0" };
		const extras: Entry[] = (options.actual ?? [leaf]).map((name) => ({
			name: `package/${name}`,
			kind: "5",
		}));
		if (options.child) extras.push({ name: `package/${leaf}/value.txt`, body: "fixture" });
		const files = [
			{ name: "package/package.json", body: JSON.stringify(metadata) },
			...extras.filter((entry) => entry.kind !== "5"),
		]
			.map((entry) => {
				const bytes = Buffer.from(entry.body ?? "");
				return {
					path: entry.name.slice("package/".length),
					sha256: hash(bytes),
					bytes: bytes.length,
				};
			})
			.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
		if (options.tamperedHash && files[0]) files[0].sha256 = "0".repeat(64);
		if (!options.omitInventory) {
			let body = JSON.stringify({
				schemaVersion: 1,
				files,
				emptyDirectories: options.declared ?? [leaf],
				...(options.unknownField ? { otherDirectories: [] } : {}),
			});
			if (options.duplicateKey)
				body = body.replace('"schemaVersion":1', '"schemaVersion":0,"schemaVersion":1');
			extras.push({ name: "package/package.inventory.json", body });
		}
		return inspect(stage, repo, addPackage(stage, repo, metadata, extras));
	}
	it("accepts exact files and declared empty directory headers", () => {
		expect(inspected().findings).toEqual([]);
	});
	it.each([
		{ name: "missing directory", actual: [] },
		{ name: "extra empty directory", actual: [leaf, "cli/extra"] },
		{ name: "nonempty directory", child: true },
		{ name: "case-aliased directory", actual: ["CLI/doctor/checks"] },
	])("refuses $name even with exact file hashes", (options) => {
		expect(inspected(options).findings).toContainEqual({
			check: "npm:cli.tgz",
			reason: expect.stringContaining("directory coverage"),
		});
	});
	it("refuses a matching-directory package with altered file hashes", () => {
		expect(inspected({ tamperedHash: true }).findings).toContainEqual({
			check: "npm:cli.tgz",
			reason: expect.stringContaining("integrity mismatch"),
		});
	});
	it("refuses empty headers without a package inventory", () => {
		expect(inspected({ omitInventory: true }).findings).toContainEqual({
			check: "npm:cli.tgz",
			reason: expect.stringContaining("exact package inventory"),
		});
	});
	it.each([{ unknownField: true }, { duplicateKey: true }])(
		"keeps inventory field and duplicate-key refusal %j",
		(options) => {
			expect(inspected(options).findings).toHaveLength(1);
			expect(inspected(options).findings[0]?.check).toBe("npm:cli.tgz");
		},
	);
	it("refuses differently spelled explicit directory ancestors", () => {
		expect(() =>
			unpackTree(
				tar([
					{ name: "package/CLI", kind: "5" },
					{ name: "package/cli/value.txt", body: "fixture" },
				]),
			),
		).toThrow("case-aliased tar path");
	});
});

describe("selected-native npm integrity", () => {
	function inspected(change?: string) {
		const { stage, repo } = fixture();
		const metadata = { name: "draftyak", version: "0.1.0" };
		const native = {
			name: "better-sqlite3-multiple-ciphers",
			version: "13.0.3",
			integrity: `sha512-${Buffer.alloc(64).toString("base64")}`,
			main: "native/lib/index.js",
			bindings: { "linux-x64": "native/prebuilds/linux-x64.node" } as Record<string, string>,
		};
		if (change === "extra map") native.bindings["win32-x64"] = "native/prebuilds/win32-x64.node";
		if (change === "integrity") native.integrity = "sha512-invalid";
		const pkg = {
			name: native.name,
			version: native.version,
			main: "lib/index.js",
			...(change === "lifecycle" ? { scripts: { postinstall: "must-not-run" } } : {}),
		};
		if (change === "identity") pkg.version = "0.0.0";
		const extras: Entry[] = [
			{ name: "package/native/package.json", body: JSON.stringify(pkg) },
			{ name: "package/native/lib/index.js", body: "module.exports = {};" },
			{
				name: "package/native/binding.gyp",
				body: change === "NAPI" ? "NAPI_VERSION=9" : "NAPI_VERSION=10",
			},
			{
				name: "package/native/prebuilds/linux-x64.node",
				body: "structural fixture; never executed",
			},
		];
		if (change === "extra prebuild")
			extras.push({
				name: "package/native/prebuilds/win32-x64.node",
				body: "unselected; never executed",
			});
		if (change === "extra directory")
			extras.push({ name: "package/native/prebuilds/extra", kind: "5" });
		extras.push({
			name: "package/bundle.json",
			body: JSON.stringify({
				schemaVersion: 1,
				format: "npm",
				version: metadata.version,
				target: { platform: "linux", arch: "x64" },
				native,
			}),
		});
		const files = [
			{ name: "package/package.json", body: JSON.stringify(metadata) },
			...extras.filter((entry) => entry.kind !== "5"),
		]
			.map((entry) => {
				const bytes = Buffer.from(entry.body ?? "");
				return { path: entry.name.slice(8), sha256: hash(bytes), bytes: bytes.length };
			})
			.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
		extras.push({
			name: "package/package.inventory.json",
			body: JSON.stringify({
				schemaVersion: 1,
				files,
				...(change === "extra directory" ? { emptyDirectories: ["native/prebuilds/extra"] } : {}),
			}),
		});
		return inspect(stage, repo, addPackage(stage, repo, metadata, extras));
	}
	it("accepts the selected binding with exact inventoried native metadata", () => {
		expect(inspected().findings).toEqual([]);
	});
	it.each([
		"extra map",
		"extra prebuild",
		"extra directory",
		"integrity",
		"identity",
		"lifecycle",
		"NAPI",
	])("refuses %s despite refreshed archive file hashes", (change) => {
		expect(inspected(change).findings).toContainEqual({
			check: "npm:cli.tgz",
			reason: expect.any(String),
		});
	});
});

describe("publication boundary", () => {
	it("keeps an exact Node-package allowlist without prefix wildcards or Python admission", () => {
		expect(Object.keys(npmPackages)).toHaveLength(18);
		expect(npmPackages.draftyak).toBe("apps/cli");
		expect(npmPackages["@draftyak/mcp-apps"]).toBeUndefined();
		expect(npmPackages["@draftyak/spike-kit"]).toBeUndefined();
		expect(npmPackages["@draftyak/fake-commercial"]).toBeUndefined();
		expect(npmPackages["@draftyak/runtime-python"]).toBeUndefined();
		expect(npmPackages["@draftyak/channel-hello-py"]).toBeUndefined();
	});
	it("reads metadata from the actual tgz and compares workspace identity/version", () => {
		const { stage, repo } = fixture();
		const release = addPackage(stage, repo, { name: "draftyak", version: "0.1.0" });
		expect(inspect(stage, repo, release).findings).toEqual([]);
		write(
			repo,
			"apps/cli/package.json",
			JSON.stringify({ name: "@draftyak/cli", version: "0.2.0", private: true }),
		);
		expect(
			inspect(stage, repo, release).findings.some((finding) =>
				finding.reason.includes("differs from workspace"),
			),
		).toBe(true);
	});
	it.each([
		["draftyak", "@draftyak/cli"],
		["@draftyak/protocol", "@draftyak/protocol"],
	])(
		"audits private source %s identity separately from packed publishability",
		(name, sourceName) => {
			const { stage, repo } = fixture();
			const workspace = npmPackages[name];
			expect(workspace).toBeDefined();
			const source = {
				name: sourceName,
				version: "0.1.0",
				private: true,
				scripts: { prepare: "build-source", prepack: "build-source" },
			};
			write(stage, "package.tgz", packageTar({ name, version: "0.1.0" }));
			write(repo, `${workspace}/package.json`, JSON.stringify(source));
			const release = {
				...input(stage),
				npm: [{ path: "package.tgz", workspace }],
			};
			expect(inspect(stage, repo, release).findings).toEqual([]);
			for (const changed of [
				{ ...source, name: name === "draftyak" ? name : "@draftyak/cli" },
				{ ...source, version: "0.2.0" },
			]) {
				write(repo, `${workspace}/package.json`, JSON.stringify(changed));
				expect(inspect(stage, repo, release).findings).toContainEqual({
					check: "npm:package.tgz",
					reason: "packed identity/version differs from workspace",
				});
			}
			write(repo, `${workspace}/package.json`, JSON.stringify(source));
			for (const [metadata, reason] of [
				[{ name, version: "0.1.0", private: true }, `private package: ${name}`],
				[
					{ name, version: "0.1.0", scripts: { prepare: "build-source" } },
					`install lifecycle script prepare: ${name}`,
				],
			] as const) {
				write(stage, "package.tgz", packageTar(metadata));
				expect(
					inspect(stage, repo, { ...release, artifacts: inventory(stage) }).findings,
				).toContainEqual({ check: "npm:package.tgz", reason });
			}
		},
	);
	it.each([
		{ name: "@draftyak/mcp-apps", version: "0.1.0" },
		{ name: "@draftyak/spike-kit", version: "0.1.0" },
		{ name: "draftyak", version: "0.1.0", private: true },
		{ name: "draftyak", version: "0.1.0", scripts: { prepare: "bad" } },
		{ name: "draftyak", version: "0.1.0", scripts: { postinstall: "bad" } },
	])("refuses unsafe npm metadata %j", (metadata) => {
		const { stage, repo } = fixture();
		expect(inspect(stage, repo, addPackage(stage, repo, metadata)).findings).not.toEqual([]);
	});
	it("refuses implicit node-gyp installs and forged workspace associations", () => {
		const { stage, repo } = fixture();
		const metadata = { name: "draftyak", version: "0.1.0" };
		const release = addPackage(stage, repo, metadata, [
			{ name: "package/binding.gyp", body: "{}" },
		]);
		expect(
			inspect(stage, repo, release).findings.some((finding) =>
				finding.reason.includes("binding.gyp"),
			),
		).toBe(true);
		const clean = addPackage(stage, repo, metadata);
		clean.npm = [{ path: "cli.tgz", workspace: "spikes/internal" }];
		expect(
			inspect(stage, repo, clean).findings.some((finding) => finding.reason.includes("allowlist")),
		).toBe(true);
	});
	it("refuses install hooks in bundled dependencies and unclassified tarballs", () => {
		const { stage, repo } = fixture();
		const metadata = { name: "draftyak", version: "0.1.0" };
		const release = addPackage(stage, repo, metadata, [
			{
				name: "package/node_modules/example/package.json",
				body: JSON.stringify({ name: "example", scripts: { install: "bad" } }),
			},
		]);
		expect(
			inspect(stage, repo, release).findings.some((finding) =>
				finding.reason.includes("lifecycle"),
			),
		).toBe(true);
		expect(
			inspect(stage, repo, input(stage)).findings.some((finding) =>
				finding.reason.includes("unclassified"),
			),
		).toBe(true);
	});
	it.each([
		{ name: "package/../escape", body: "x" },
		{ name: "package/link", kind: "2", link: "../../outside" },
		{ name: "package/link", kind: "1", link: "package/package.json" },
		{ name: "package/pax", kind: "x", body: "path=outside" },
		{ name: "outside/file", body: "x" },
	])("rejects hostile tar entries %j", (entry) => {
		expect(() => unpack(packageTar({ name: "draftyak", version: "0.1.0" }, [entry]))).toThrow();
	});
	it("checks retained source versions without requiring or reading postponed Python metadata", () => {
		const { stage, repo } = fixture();
		write(repo, "apps/hub/package.json", '{"version":"0.2.0"}');
		write(repo, "packages/sdk/package.json", '{"version":"0.3.0"}');
		write(
			repo,
			"packages/sdk-python/pyproject.toml",
			'[project]\nname = "draftyak"\nversion = "0.3.0"\n\n[build-system]\nrequires = []\n',
		);
		const report = inspect(stage, repo);
		expect(report.findings.map((finding) => finding.check)).toEqual(["version:apps/hub"]);
		write(
			repo,
			"packages/sdk-python/pyproject.toml",
			'[project]\nname = "draftyak"\nversion = "0.4.0"\n',
		);
		expect(inspect(stage, repo).findings.map((finding) => finding.check)).toEqual([
			"version:apps/hub",
		]);
	});
	it("rejects archive file/directory overlaps in either order and case aliases", () => {
		const parent = { name: "package/parent", body: "file" };
		const child = { name: "package/parent/child", body: "child" };
		expect(() => unpack(tar([parent, child]))).toThrow("parent is a file");
		expect(() => unpack(tar([child, parent]))).toThrow("overlaps a directory");
		expect(() =>
			unpack(
				tar([
					{ name: "package/File", body: "x" },
					{ name: "package/file", body: "y" },
				]),
			),
		).toThrow("duplicate");
	});
});

describe("runtime and evidence", () => {
	it("keeps unrelated package names, dependency aliases and Python documentation inspectable", () => {
		const { stage, repo } = fixture();
		const release = addPackage(
			stage,
			repo,
			{
				name: "draftyak",
				version: "0.1.0",
				dependencies: { runtime: "npm:example@1.0.0", "python-helper": "1.0.0" },
			},
			[
				{ name: "package/docs/python.txt", body: "Runtime documentation." },
				{
					name: "package/node_modules/python-helper/package.json",
					body: JSON.stringify({ name: "python-helper", version: "1.0.0" }),
				},
			],
		);
		expect(inspect(stage, repo, release).findings).toEqual([]);
	});
	it.each([
		"package/runtime-python/bin/python",
		"package/runtime-python.inventory.json",
		"package/python-runtime/archive.bin",
		"package/runtime.whl",
	])("refuses an embedded Python runtime hidden inside an allowed npm archive: %s", (file) => {
		const { stage, repo } = fixture();
		const release = addPackage(stage, repo, { name: "draftyak", version: "0.1.0" }, [
			{ name: file, body: "substituted runtime with a caller-controlled inventory" },
		]);
		expect(inspect(stage, repo, release).findings).toContainEqual({
			check: "npm:cli.tgz",
			reason: "Python runtime inputs require an available reviewed runtime producer",
		});
	});
	it("refuses an empty Python runtime directory inside an allowed npm archive", () => {
		const { stage, repo } = fixture();
		const release = addPackage(stage, repo, { name: "draftyak", version: "0.1.0" }, [
			{ name: "package/runtime-python", kind: "5" },
		]);
		expect(inspect(stage, repo, release).findings).toContainEqual({
			check: "npm:cli.tgz",
			reason: "Python runtime inputs require an available reviewed runtime producer",
		});
	});
	it.each([
		{ dependencies: { "@draftyak/runtime-python": "0.1.0" } },
		{ optionalDependencies: { runtime: "npm:@draftyak/runtime-python@0.1.0" } },
		{ peerDependencies: { runtime: "workspace:@draftyak/runtime-python@*" } },
		{ devDependencies: { "@draftyak/runtime-python": "0.1.0" } },
		{ bundledDependencies: ["@draftyak/runtime-python"] },
		{ bundleDependencies: ["@draftyak/runtime-python"] },
	])("refuses Python runtime dependency authority in npm metadata: %j", (dependency) => {
		const { stage, repo } = fixture();
		const release = addPackage(stage, repo, {
			name: "draftyak",
			version: "0.1.0",
			...dependency,
		});
		expect(inspect(stage, repo, release).findings).toContainEqual({
			check: "npm:cli.tgz",
			reason: "Python runtime inputs require an available reviewed runtime producer",
		});
	});
	it.each([
		{ name: "@draftyak/runtime-python", version: "0.1.0" },
		{ name: "alias", dependencies: { runtime: "npm:@draftyak/runtime-python@0.1.0" } },
	])("refuses renamed bundled Python runtime metadata: %j", (dependency) => {
		const { stage, repo } = fixture();
		const release = addPackage(stage, repo, { name: "draftyak", version: "0.1.0" }, [
			{ name: "package/node_modules/alias/package.json", body: JSON.stringify(dependency) },
		]);
		expect(inspect(stage, repo, release).findings).toContainEqual({
			check: "npm:cli.tgz",
			reason: "Python runtime inputs require an available reviewed runtime producer",
		});
	});
	it.each([null, { canonical: "runtime.inventory.json", copies: ["runtime"] }])(
		"refuses runtime authority %j before inspecting artifacts or entering the filesystem",
		(runtime) => {
			const getter = vi.fn(() => {
				throw new Error("artifact getter must not run");
			});
			const release = { schemaVersion: 1, version: "0.1.0", npm: [], runtime };
			Object.defineProperty(release, "artifacts", { enumerable: true, get: getter });
			const absent = path.join(base, "nonexistent-runtime-input");
			const report = guard(release, { root: absent, repo: absent, scope: "full" });
			expect(report.findings).toEqual([
				{
					check: "manifest",
					reason: "Python runtime inputs require an available reviewed runtime producer",
				},
			]);
			expect(report.checks).toEqual(["local-input-paths"]);
			expect(getter).not.toHaveBeenCalled();
		},
	);
	it.each([
		"runtime-python/inventory.json",
		"python-runtime/archive.bin",
		"python-runtime.inventory.json",
		"package.whl",
	])("refuses recognized Python artifact %s before artifact I/O", (file) => {
		const absent = path.join(base, "nonexistent-python-artifact");
		const report = guard(
			{
				schemaVersion: 1,
				version: "0.1.0",
				npm: [],
				artifacts: [{ path: file, bytes: 1, sha256: hash(Buffer.from("x")) }],
			},
			{ root: absent, repo: absent, scope: "artifacts" },
		);
		expect(report.findings).toEqual([
			{
				check: "manifest",
				reason: "Python runtime inputs require an available reviewed runtime producer",
			},
		]);
		expect(report.checks).toEqual(["local-input-paths"]);
	});
	it.each(["packages/runtime-python", "plugins/channel-hello-py", "packages/sdk-python"])(
		"refuses Python workspace %s before opening its archive",
		(workspace) => {
			const absent = path.join(base, "nonexistent-python-archive");
			const report = guard(
				{
					schemaVersion: 1,
					version: "0.1.0",
					artifacts: [],
					npm: [{ path: "package.tgz", workspace }],
				},
				{ root: absent, repo: absent, scope: "artifacts" },
			);
			expect(report.findings).toEqual([
				{
					check: "manifest",
					reason: "Python runtime inputs require an available reviewed runtime producer",
				},
			]);
			expect(report.checks).toEqual(["local-input-paths"]);
		},
	);
	it("requires one notice marker for every declared SBOM component", () => {
		const { stage, repo } = fixture();
		write(
			stage,
			"bom.json",
			JSON.stringify({
				bomFormat: "CycloneDX",
				specVersion: "1.6",
				components: [
					{
						"bom-ref": "pkg:generic/example@1.0.0",
						name: "example",
						version: "1.0.0",
						licenses: [{ license: { id: "MIT" } }],
					},
				],
			}),
		);
		write(stage, "THIRD_PARTY_NOTICES", "Component: pkg:generic/example@1.0.0\nMIT\n");
		const release = { ...input(stage), notices: { path: "THIRD_PARTY_NOTICES", sbom: "bom.json" } };
		expect(inspect(stage, repo, release).findings).toEqual([]);
		write(stage, "THIRD_PARTY_NOTICES", "incomplete");
		expect(
			inspect(stage, repo, { ...release, artifacts: inventory(stage) }).findings.some((finding) =>
				finding.reason.includes("notice missing"),
			),
		).toBe(true);
	});
	it("checks candidate bytes without trusting or executing them", () => {
		const { stage, repo } = fixture();
		const file = "candidate-node";
		write(stage, file, 'console.log("Temporal is available")');
		const bytes = readFileSync(path.join(stage, file));
		const node = { path: file, sha256: hash(bytes), bytes: bytes.length, version: "26.12.0" };
		expect(() => checkNodeIntegrity(stage, { ...node, sha256: "0".repeat(64) })).toThrow(
			"integrity mismatch",
		);
		expect(() => checkNodeIntegrity(stage, node)).not.toThrow();
		write(repo, "tools/fetch-node/versions.json", '{"bundled":"26.12.0"}');
		const release = {
			...input(stage),
			node,
			nodeSource: {
				root: stage,
				platform: process.platform === "win32" ? "win" : process.platform,
				arch: process.arch,
			},
		};
		const report = inspect(stage, repo, release);
		expect(report.checks).toContain("bundled-node-integrity");
		expect(report.findings).toEqual([
			{
				check: "bundled-node-runtime",
				reason: expect.stringContaining("candidate not executed"),
			},
		]);
		expect(report.findings[0]?.reason).toContain("Temporal/--disable-sigusr1");
		expect(report.findings[0]?.reason).toContain("independent official-archive authentication");
	});
	it("does not accept security booleans or a partial manifest as full readiness", () => {
		const { stage, repo } = fixture();
		expect(() => manifest({ ...input(stage), mockStoreAbsent: true })).toThrow("unsupported field");
		const report = guard(input(stage), { root: stage, repo, scope: "full" });
		expect(
			report.findings.find((finding) => finding.check === "schedule-equivalence")?.reason,
		).toContain("canonical schedule vectors");
		expect(report.findings.some((finding) => finding.check === "test-power-hooks")).toBe(true);
		const powerHooks = report.findings.find(
			(finding) => finding.check === "test-power-hooks",
		)?.reason;
		for (const hook of [
			"DRAFTYAK_SPIKE_POWER",
			"DRAFTYAK_SPIKE_KEEP_AWAKE",
			"--spike-control",
			"simulate_wake",
		])
			expect(powerHooks).toContain(hook);
		expect(
			report.findings.some((finding) =>
				["sms-host", "runtime", "pypi-artifact"].includes(finding.check),
			),
		).toBe(false);
		expect(report.findings.some((finding) => finding.check === "dev-key-refusal")).toBe(true);
		expect(report.findings.filter((finding) => finding.check === "publish-set")).toHaveLength(18);
	});
	it.each(["bundle.json", "hub-runtime/provenance/bundle.json"])(
		"refuses a desktop snapshot as a full release at %s",
		(file) => {
			const { stage, repo } = fixture();
			write(stage, file, JSON.stringify({ schemaVersion: 1, profile: "desktop-snapshot" }));
			const release = input(stage);
			expect(inspect(stage, repo, release).findings).toEqual([]);
			expect(guard(release, { root: stage, repo, scope: "full" }).findings).toContainEqual({
				check: "release-profile",
				reason: expect.stringContaining("development desktop snapshot is not a full release"),
			});
		},
	);
	it("returns nonzero usage for absent CLI input", () => {
		const cli = path.resolve(import.meta.dirname, "../src/cli.ts");
		const child = spawnSync(process.execPath, [cli], { encoding: "utf8", windowsHide: true });
		expect(child.status).toBe(2);
		expect(child.stderr).toContain("usage:");
		const leading = spawnSync(process.execPath, [cli, "--", "--help"], {
			encoding: "utf8",
			windowsHide: true,
		});
		expect(leading.status).toBe(0);
	});
});
