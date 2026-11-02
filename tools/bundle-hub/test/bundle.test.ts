import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs, {
	existsSync,
	linkSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmdirSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { afterAll, describe, expect, it, vi } from "vitest";
import { tar, zip } from "../../fetch-node/test/archives.ts";
import {
	type BundleDeps,
	type BundleSpec,
	bundle,
	NATIVE_INTEGRITY,
	NATIVE_NAME,
	NATIVE_REQUIRED,
	NATIVE_VERSION,
	parseSpec,
	TARGETS,
} from "../src/bundle.ts";
import {
	digest,
	type FileRecord,
	inventoryOf,
	jsonValue,
	noLinks,
	records,
	regularBytes,
} from "../src/inventory.ts";
import { canonicalLauncher } from "../src/launcher.ts";
import { hubMigrationFixture } from "./helpers/hub-migrations-fixture.ts";

const packageRoot = path.resolve(import.meta.dirname, "..");
const repo = path.resolve(packageRoot, "../..");
const scratch = mkdtempSync(path.join(import.meta.dirname, ".tmp-bundle-"));
afterAll(() => {
	if (path.dirname(scratch) !== import.meta.dirname)
		throw new Error("unexpected test scratch path");
	rmSync(scratch, { recursive: true, force: true });
});

const record = (file: string, data: string): FileRecord => ({
	path: file,
	sha256: digest(Buffer.from(data)),
	bytes: Buffer.byteLength(data),
});

function payload(
	root: string,
	files: Record<string, string>,
): { root: string; files: readonly FileRecord[] } {
	for (const [file, data] of Object.entries(files)) {
		mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
		writeFileSync(path.join(root, file), data);
	}
	return { root, files: records(Object.entries(files).map(([file, data]) => record(file, data))) };
}

function pythonPayload(root: string) {
	return payload(path.join(root, "python-input"), {
		"package.json": JSON.stringify({ name: "@draftyak/runtime-python", version: "0.1.0" }),
		"shim.mjs": "// Synthetic runtime fixture; never executed.\n",
		"pyodide/fixture.wasm": "synthetic wasm bytes",
		"node_modules/ws/package.json": JSON.stringify({ name: "ws", version: "0.0.0" }),
	});
}

interface Fixture {
	readonly root: string;
	readonly output: string;
	readonly spec: BundleSpec;
	readonly deps: BundleDeps;
	readonly nodeArchive: string;
}

function fixture(windows = false): Fixture {
	const root = mkdtempSync(path.join(scratch, "case-"));
	const hub = payload(path.join(root, "hub-input"), {
		"hub.mjs": "export const hub = 'fixture-only';\n",
		"plugins/hello/plugin.mjs": "export default {};\n",
		...hubMigrationFixture(),
		"spa/index.html": "<!doctype html><title>Fixture</title>\n",
	});
	const cli = payload(path.join(root, "cli-input"), {
		"main.mjs": "export const main = async () => 0;\n",
		"package.json": '{"type":"module"}\n',
	});
	const nativeFiles = Object.fromEntries(
		NATIVE_REQUIRED.map((file) => [file, `synthetic native fixture: ${file}`]),
	);
	nativeFiles["package.json"] = JSON.stringify({
		name: NATIVE_NAME,
		version: NATIVE_VERSION,
		main: "lib/index.js",
	});
	nativeFiles["binding.gyp"] = JSON.stringify({ defines: ["NAPI_VERSION=10"] });
	const nativeArchive = gzipSync(
		tar(Object.entries(nativeFiles).map(([name, data]) => ({ name: `package/${name}`, data }))),
	);
	const native = path.join(root, "native.tgz");
	writeFileSync(native, nativeArchive);
	const platform = windows ? "win" : "linux";
	const binary = windows ? "node.exe" : "bin/node";
	const nodeRoot = path.join(root, "node-input");
	mkdirSync(nodeRoot);
	const folder = `node-v26.12.0-${platform}-x64`;
	const nodeFiles = [
		{ name: `${folder}/${binary}`, data: "synthetic Node fixture, not executable" },
		{ name: `${folder}/LICENSE`, data: "synthetic Node license" },
	];
	const nodeArchive = path.join(nodeRoot, `${folder}.${windows ? "zip" : "tar.gz"}`);
	const nodeBytes = windows ? zip(nodeFiles) : gzipSync(tar(nodeFiles));
	writeFileSync(nodeArchive, nodeBytes);
	writeFileSync(
		path.join(nodeRoot, "SHASUMS256.txt"),
		`${digest(nodeBytes)}  ${path.basename(nodeArchive)}\n`,
	);
	writeFileSync(
		path.join(nodeRoot, "SHASUMS256.txt.sig"),
		"synthetic signature; test verifier only",
	);
	return {
		root,
		output: path.join(root, "candidate"),
		spec: parseSpec(
			{
				schemaVersion: 1,
				version: "0.1.0",
				target: { platform, arch: "x64" },
				hub,
				cli,
				native: {
					archive: native,
					files: Object.entries(nativeFiles).map(([file, data]) => record(file, data)),
				},
				node: { root: nodeRoot },
			},
			root,
		),
		deps: {
			signature: async () => "synthetic-test-signer",
			nativeIntegrity: `sha512-${createHash("sha512").update(nativeArchive).digest("base64")}`,
		},
		nodeArchive,
	};
}

function clean(f: Fixture): void {
	expect(existsSync(f.output)).toBe(false);
	expect(readdirSync(f.root).filter((file) => file.startsWith(".bundle-hub-"))).toEqual([]);
}

describe("bundle-hub candidate staging", () => {
	it("stages explicitly inventoried empty CLI directories and rejects missing input directories", async () => {
		const f = fixture(true);
		if (!f.spec.cli) throw new Error("missing CLI fixture");
		mkdirSync(path.join(f.spec.cli.root, "doctor/checks"), { recursive: true });
		const spec = { ...f.spec, cli: { ...f.spec.cli, emptyDirectories: ["doctor/checks"] } };
		await bundle(spec, f.output, f.deps);
		expect(statSync(path.join(f.output, "cli/doctor/checks")).isDirectory()).toBe(true);
		expect(readdirSync(path.join(f.output, "cli/doctor/checks"))).toEqual([]);
		expect(
			JSON.parse(readFileSync(path.join(f.output, "inventory.json"), "utf8")).emptyDirectories,
		).toEqual(["cli/doctor/checks"]);
		const missing = fixture(true);
		if (!missing.spec.cli) throw new Error("missing CLI fixture");
		await expect(
			bundle(
				{ ...missing.spec, cli: { ...missing.spec.cli, emptyDirectories: ["doctor/checks"] } },
				missing.output,
				missing.deps,
			),
		).rejects.toThrow("inventoried empty directory is missing");
		clean(missing);
	});
	it.each([false, true])(
		"preserves a scoped real desktop layout and authenticates its binding (tamper=%s)",
		async (tamper) => {
			const f = fixture(true);
			const native = "synthetic native fixture: prebuilds/win32-x64.node";
			const hub = payload(path.join(f.root, "desktop-input"), {
				"hub.mjs": "export {};\n",
				"web/index.html": "<!doctype html>",
				...hubMigrationFixture(),
				"native/win32-x64.node": tamper ? "changed native bytes" : native,
			});
			const spec = parseSpec(
				{ ...f.spec, profile: "desktop-snapshot", hub, cli: undefined },
				f.root,
			);
			if (tamper) {
				await expect(bundle(spec, f.output, f.deps)).rejects.toThrow(
					"authenticated package prebuild",
				);
				clean(f);
			} else {
				await bundle(spec, f.output, f.deps);
				expect(readFileSync(path.join(f.output, "hub/web/index.html"), "utf8")).toBe(
					"<!doctype html>",
				);
				expect(JSON.parse(readFileSync(path.join(f.output, "bundle.json"), "utf8")).profile).toBe(
					"desktop-snapshot",
				);
				expect(() => parseSpec({ ...spec, profile: undefined }, f.root)).toThrow(
					"missing built product assets",
				);
			}
		},
	);
	it("rejects unknown profiles and invented CLI/Python completion in a desktop snapshot", () => {
		const f = fixture();
		expect(() => parseSpec({ ...f.spec, profile: "release-approved" }, f.root)).toThrow(
			"unsupported profile",
		);
		const hub = payload(path.join(f.root, "desktop-input"), {
			"hub.mjs": "export {};",
			"web/index.html": "html",
			"native/linux-x64.node": "native",
			...hubMigrationFixture(),
		});
		expect(() => parseSpec({ ...f.spec, profile: "desktop-snapshot", hub }, f.root)).toThrow(
			"unfinished CLI or Python",
		);
	});
	it.each(["\\\\server\\share\\file", "//server/share/file", "\\\\?\\C:\\device-path"])(
		"rejects network or device root %j before filesystem access",
		(file) => {
			expect(() => noLinks(file)).toThrow("network shares and device paths are not bundle inputs");
		},
	);
	it("normalizes every output file and directory to the portable mode contract", async () => {
		const f = fixture();
		await bundle(f.spec, f.output, f.deps);
		const inspect = (file: string): void => {
			const stat = statSync(file);
			const executable =
				path.basename(file) === "node" ||
				path.basename(file) === "node.exe" ||
				file === path.join(f.output, "draftyak.mjs");
			if (process.platform === "win32") {
				// Windows chmod exposes read/write attributes, not POSIX executable/group bits.
				expect(stat.mode & 0o600).toBe(0o600);
			} else {
				expect(stat.mode & 0o777).toBe(stat.isDirectory() || executable ? 0o755 : 0o644);
			}
			if (stat.isDirectory()) for (const name of readdirSync(file)) inspect(path.join(file, name));
		};
		inspect(f.output);
	});

	it.skipIf(process.platform === "win32")("keeps output modes fixed under POSIX umask 077", () => {
		const f = fixture();
		const code =
			"const {bundle}=await import(process.argv[1]); process.umask(0o077); await bundle(JSON.parse(process.argv[2]),process.argv[3],{signature:async()=> 'synthetic-test-signer',nativeIntegrity:process.argv[4]});";
		const child = spawnSync(
			process.execPath,
			[
				"--input-type=module",
				"-e",
				code,
				pathToFileURL(path.join(packageRoot, "src/bundle.ts")).href,
				JSON.stringify(f.spec),
				f.output,
				f.deps.nativeIntegrity ?? "",
			],
			{ encoding: "utf8" },
		);
		expect(child.status, child.stderr).toBe(0);
		const inspect = (file: string): void => {
			const stat = statSync(file);
			const executable =
				path.basename(file) === "node" || file === path.join(f.output, "draftyak.mjs");
			expect(stat.mode & 0o777).toBe(stat.isDirectory() || executable ? 0o755 : 0o644);
			if (stat.isDirectory()) for (const name of readdirSync(file)) inspect(path.join(file, name));
		};
		inspect(f.output);
	});

	it.each([".env", ".env.live", ".envrc", ".ENV_TEST", ".env.production"])(
		"rejects environment-file input %s before opening it",
		(file) => {
			expect(() => regularBytes(path.join(scratch, file))).toThrow(
				"environment files are never bundle inputs",
			);
		},
	);
	it("rejects duplicate JSON keys, including escaped names, without printing input", () => {
		expect(() => jsonValue('{"root":1,"r\\u006fot":2}')).toThrow("duplicate JSON key");
		expect(() => jsonValue('{"nested":{"x":1,"x":2}}')).toThrow("duplicate JSON key");
		expect(() => jsonValue('{"private-value":malformed}')).toThrow("invalid JSON input");
		expect(jsonValue('{"a":[{"x":1},{"x":2}],"b":"{,}"}')).toEqual({
			a: [{ x: 1 }, { x: 2 }],
			b: "{,}",
		});
	});
	it.each([false, true])(
		"copies verified bytes and only the selected binding deterministically (Windows=%s)",
		async (windows) => {
			const f = fixture(windows);
			await bundle(f.spec, f.output, f.deps);
			const second = path.join(f.root, "candidate-second");
			await bundle(f.spec, second, f.deps);
			expect(readFileSync(path.join(f.output, "inventory.json"), "utf8")).toBe(
				readFileSync(path.join(second, "inventory.json"), "utf8"),
			);
			expect(readFileSync(path.join(f.output, "bundle.json"), "utf8")).toBe(
				readFileSync(path.join(second, "bundle.json"), "utf8"),
			);
			const inventory = JSON.parse(readFileSync(path.join(f.output, "inventory.json"), "utf8"));
			const actual = inventoryOf(f.output).files.filter((file) => file.path !== "inventory.json");
			expect(inventory).toEqual({ schemaVersion: 1, files: actual });
			expect(
				actual.some((file) => file.path.startsWith("cli/") && file.path.endsWith("main.mjs")),
			).toBe(true);
			const selected = windows ? "win32-x64" : "linux-x64";
			expect(readdirSync(path.join(f.output, "native/prebuilds"))).toEqual([`${selected}.node`]);
			expect(
				readFileSync(path.join(f.output, "native/prebuilds", `${selected}.node`), "utf8"),
			).toBe(`synthetic native fixture: prebuilds/${selected}.node`);
			for (const target of TARGETS.filter((target) => target !== selected))
				expect(existsSync(path.join(f.output, "native/prebuilds", `${target}.node`))).toBe(false);
			const metadata = JSON.parse(readFileSync(path.join(f.output, "bundle.json"), "utf8"));
			expect(readFileSync(path.join(f.output, "draftyak.mjs"))).toEqual(canonicalLauncher().bytes);
			expect(metadata.native.main).toBe("native/lib/index.js");
			expect(metadata.native.bindings).toEqual({ [selected]: `native/prebuilds/${selected}.node` });
			expect(metadata.node.binary).toBe(windows ? "node.exe" : "node");
			expect(metadata.python).toBeUndefined();
			expect(actual.some((file) => file.path.startsWith("runtime-python"))).toBe(false);
			expect(readFileSync(path.join(f.output, "bundle.json"), "utf8")).not.toContain(f.root);
		},
	);

	it("refuses a launcher added inside the catalogued CLI payload", async () => {
		const f = fixture();
		const cli = f.spec.cli;
		if (!cli) throw new Error("missing CLI fixture");
		writeFileSync(path.join(cli.root, "draftyak.mjs"), canonicalLauncher().bytes);
		const changed = { ...f.spec, cli: { ...cli, files: inventoryOf(cli.root).files } };
		await expect(bundle(changed, f.output, f.deps)).rejects.toThrow("launcher must stay outside");
		expect(existsSync(f.output)).toBe(false);
	});

	it("refuses a tampered native archive after staging other files and removes partial output", async () => {
		const f = fixture();
		writeFileSync(f.spec.native.archive, "tampered");
		await expect(bundle(f.spec, f.output, f.deps)).rejects.toThrow("native package sha512");
		clean(f);
	});
	it.each(['{"type":"commonjs"}', '{"type":"module","imports":{"#outside":"outside"}}'])(
		"refuses a caller-controlled CLI module boundary %s before publishing",
		async (metadata) => {
			const f = fixture();
			const cli = f.spec.cli;
			if (!cli) throw new Error("missing CLI fixture");
			writeFileSync(path.join(cli.root, "package.json"), metadata);
			const changed = { ...f.spec, cli: { ...cli, files: inventoryOf(cli.root).files } };
			await expect(bundle(changed, f.output, f.deps)).rejects.toThrow("CLI module boundary");
			expect(existsSync(f.output)).toBe(false);
		},
	);

	it("rejects Node archive tampering and signature failure; neither publishes a candidate", async () => {
		const f = fixture();
		writeFileSync(f.nodeArchive, "tampered");
		await expect(bundle(f.spec, f.output, f.deps)).rejects.toThrow("Node archive SHA-256");
		clean(f);
		const other = fixture();
		await expect(
			bundle(other.spec, other.output, {
				...other.deps,
				signature: async () => {
					throw new Error("untrusted signature");
				},
			}),
		).rejects.toThrow("untrusted signature");
		clean(other);
	});

	it.each(["tamper", "extra", "missing"])(
		"fails closed on %s in the built product tree",
		async (kind) => {
			const f = fixture();
			if (kind === "tamper") writeFileSync(path.join(f.spec.hub.root, "hub.mjs"), "changed");
			if (kind === "extra") writeFileSync(path.join(f.spec.hub.root, "unexpected.txt"), "extra");
			if (kind === "missing") rmSync(path.join(f.spec.hub.root, "hub.mjs"));
			await expect(bundle(f.spec, f.output, f.deps)).rejects.toThrow(
				kind === "tamper" ? "inventory mismatch" : "missing or unexpected",
			);
			clean(f);
		},
	);

	it("does not overwrite an existing candidate or place output in a source tree", async () => {
		const f = fixture();
		mkdirSync(f.output);
		writeFileSync(path.join(f.output, "sentinel"), "untouched");
		await expect(bundle(f.spec, f.output, f.deps)).rejects.toThrow("new directory");
		expect(readFileSync(path.join(f.output, "sentinel"), "utf8")).toBe("untouched");
		await expect(bundle(f.spec, path.join(f.spec.hub.root, "inside"), f.deps)).rejects.toThrow(
			"inside an input",
		);
	});

	it("rejects hard links, linked source roots and linked ancestors", async () => {
		const hard = fixture();
		linkSync(path.join(hard.spec.hub.root, "hub.mjs"), path.join(hard.root, "alias"));
		await expect(bundle(hard.spec, hard.output, hard.deps)).rejects.toThrow(
			"payload special file or hard-link alias refused",
		);
		clean(hard);
		const linked = fixture();
		const alias = path.join(linked.root, "linked-input");
		symlinkSync(linked.spec.hub.root, alias, process.platform === "win32" ? "junction" : "dir");
		await expect(
			bundle(
				{ ...linked.spec, hub: { ...linked.spec.hub, root: alias } },
				linked.output,
				linked.deps,
			),
		).rejects.toThrow("link");
		await expect(
			bundle(
				{ ...linked.spec, hub: { ...linked.spec.hub, root: path.join(alias, "plugins") } },
				linked.output,
				linked.deps,
			),
		).rejects.toThrow("link");
		clean(linked);
	});
	it("rejects in-tree payload directory links before traversing a valid target", async () => {
		const f = fixture();
		const linkedDirectory = path.join(f.spec.hub.root, "spa");
		const page = readFileSync(path.join(linkedDirectory, "index.html"));
		const outside = path.join(f.root, "outside-spa");
		const control = path.join(f.root, "control-candidate");
		const directories = vi.spyOn(fs, "opendirSync");
		syncBuiltinESMExports();
		try {
			await expect(bundle(f.spec, control, f.deps)).resolves.toBeUndefined();
			expect(readFileSync(path.join(control, "hub/spa/index.html"))).toEqual(page);
			expect(directories.mock.calls.map(([file]) => file)).toContain(linkedDirectory);
			mkdirSync(outside);
			writeFileSync(path.join(outside, "index.html"), page);
			rmSync(path.join(linkedDirectory, "index.html"));
			rmdirSync(linkedDirectory);
			symlinkSync(outside, linkedDirectory, process.platform === "win32" ? "junction" : "dir");
			directories.mockClear();
			let refusal: unknown;
			try {
				await bundle(f.spec, f.output, f.deps);
			} catch (error) {
				refusal = error;
			}
			expect(directories.mock.calls.map(([file]) => file)).not.toContain(linkedDirectory);
			expect(directories.mock.calls.map(([file]) => file)).not.toContain(outside);
			expect(refusal).toBeInstanceOf(Error);
			expect((refusal as Error).message).toBe("payload link refused");
			clean(f);
		} finally {
			directories.mockRestore();
			syncBuiltinESMExports();
		}
	});

	it("supports desktop payloads without optional CLI or Python runtime", async () => {
		const f = fixture();
		await bundle({ ...f.spec, cli: undefined }, f.output, f.deps);
		expect(existsSync(path.join(f.output, "cli"))).toBe(false);
		expect(existsSync(path.join(f.output, "runtime-python"))).toBe(false);
	});

	it("rejects missing product assets, incomplete matrix and unsupported Python runtime inputs", async () => {
		const f = fixture();
		expect(() =>
			parseSpec(
				{
					...f.spec,
					hub: { ...f.spec.hub, files: f.spec.hub.files.filter((row) => row.path !== "hub.mjs") },
				},
				f.root,
			),
		).toThrow("missing built product assets");
		expect(() =>
			parseSpec(
				{
					...f.spec,
					native: {
						...f.spec.native,
						files: f.spec.native.files.filter((row) => row.path !== "prebuilds/win32-arm64.node"),
					},
				},
				f.root,
			),
		).toThrow("eight-prebuild");
		await expect(
			bundle({ ...f.spec, version: "0.2.0", python: pythonPayload(f.root) }, f.output, f.deps),
		).rejects.toThrow("canonical Python runtime producer is unavailable");
		clean(f);
	});

	it.each(["identity", "main", "lifecycle", "napi"])(
		"rejects an invalid native %s even with a fixture pin",
		async (kind) => {
			const f = fixture();
			const data = Object.fromEntries(
				NATIVE_REQUIRED.map((file) => [file, `synthetic native fixture: ${file}`]),
			);
			data["package.json"] = JSON.stringify({
				name: kind === "identity" ? "different-package" : NATIVE_NAME,
				version: NATIVE_VERSION,
				main: kind === "main" ? "lib/linux-x64.js" : "lib/index.js",
				...(kind === "lifecycle" ? { scripts: { install: "do-not-run" } } : {}),
			});
			data["binding.gyp"] = JSON.stringify({
				defines: [kind === "napi" ? "NAPI_VERSION=9" : "NAPI_VERSION=10"],
			});
			const packed = gzipSync(
				tar(Object.entries(data).map(([name, data]) => ({ name: `package/${name}`, data }))),
			);
			writeFileSync(f.spec.native.archive, packed);
			const spec = {
				...f.spec,
				native: {
					...f.spec.native,
					files: Object.entries(data).map(([file, data]) => record(file, data)),
				},
			};
			const deps = {
				...f.deps,
				nativeIntegrity: `sha512-${createHash("sha512").update(packed).digest("base64")}`,
			};
			await expect(bundle(spec, f.output, deps)).rejects.toThrow(
				kind === "napi" ? "N-API" : kind === "lifecycle" ? "lifecycle" : "identity or main",
			);
			clean(f);
		},
	);

	it("refuses credential-shaped payload content without disclosing it", async () => {
		const f = fixture();
		const secret = ["sk-", "proj-", "fixture1234567890123456789012345"].join("");
		writeFileSync(path.join(f.spec.hub.root, "hub.mjs"), secret);
		const spec = {
			...f.spec,
			hub: {
				...f.spec.hub,
				files: f.spec.hub.files.map((row) =>
					row.path === "hub.mjs" ? record(row.path, secret) : row,
				),
			},
		};
		await expect(bundle(spec, f.output, f.deps)).rejects.toThrow(
			"credential-shaped data refused: hub.mjs",
		);
		clean(f);
	});

	it.each([
		"../outside",
		"/absolute",
		"a\\b",
		"a//b",
		"C:ads",
		"a/../b",
		"CON.txt",
		"CONIN$",
		"CONOUT$.txt",
		"COM¹.txt",
		"LPT²",
		"a?b",
		"a|b",
		"a<b",
		"a>b",
		'a"b',
		"a*b",
		".env.live",
		"nested/.envrc",
		"nested/.ENV_TEST",
		"secret.key",
		"state.db",
	])("rejects unsafe or private path %s", (file) => {
		expect(() => records([record(file, "fixture")])).toThrow("unsafe or private-state");
	});

	it("rejects case aliases, prefix conflicts, unsafe counts and unknown spec fields", () => {
		expect(() => records([record("A.js", "a"), record("a.js", "a")])).toThrow("case-aliased");
		expect(() => records([record("a", "a"), record("a/b", "b")])).toThrow("also a directory");
		expect(() => records([{ ...record("a", "a"), bytes: -1 }])).toThrow("byte count");
		const f = fixture();
		expect(() => parseSpec({ ...f.spec, download: true }, f.root)).toThrow("unexpected field");
	});

	it("pins the native archive integrity to the reviewed lockfile and bundled Node to fetch-node metadata", () => {
		const lock = readFileSync(path.join(repo, "pnpm-lock.yaml"), "utf8");
		expect(lock).toContain(
			`better-sqlite3-multiple-ciphers@${NATIVE_VERSION}:\n    resolution: {integrity: ${NATIVE_INTEGRITY}}`,
		);
		expect(
			JSON.parse(readFileSync(path.join(repo, "tools/fetch-node/versions.json"), "utf8")).bundled,
		).toBe("26.12.0");
	});

	it("CLI help works and a missing product spec fails without creating output", () => {
		const cli = path.join(packageRoot, "src/cli.ts");
		expect(execFileSync(process.execPath, [cli, "--help"], { encoding: "utf8" })).toContain(
			"--spec",
		);
		const f = fixture();
		const file = path.join(f.root, "missing-product.json");
		writeFileSync(file, JSON.stringify({ ...f.spec, hub: { ...f.spec.hub, files: [] } }));
		const result = spawnSync(process.execPath, [cli, "--spec", file, "--out", f.output], {
			encoding: "utf8",
		});
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("file list is empty, sparse or exceeds its record limit");
		clean(f);
	});

	it("production CLI never accepts synthetic signatures or fixture integrity overrides", () => {
		const f = fixture();
		const file = path.join(f.root, "synthetic-spec.json");
		writeFileSync(file, JSON.stringify(f.spec));
		const result = spawnSync(
			process.execPath,
			[path.join(packageRoot, "src/cli.ts"), "--spec", file, "--out", f.output],
			{ encoding: "utf8" },
		);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("bundle-hub:");
		clean(f);
	});
});
