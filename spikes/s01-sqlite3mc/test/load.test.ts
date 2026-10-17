import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	type Basis,
	type HostLoads,
	type LoadRun,
	loadMatrix,
	matrixPair,
	readHostFiles,
	readMatrix,
	STALE,
} from "../src/matrix.ts";
import { loadReport, openDatabase } from "../src/open.ts";
import {
	bundleDir,
	copyPrebuild,
	hostTarget,
	napiVersion,
	PACKAGE,
	packageDir,
	prebuildHashes,
	spikeDir,
	TARGETS,
	targetFor,
} from "../src/prebuilds.ts";
import { recording, selectedNodes, unrun } from "../src/record.ts";

const require = createRequire(import.meta.url);
const sha256 = (file: string): string =>
	createHash("sha256").update(readFileSync(file)).digest("hex");
const fake = (text: string): string => createHash("sha256").update(text).digest("hex");
const thrown = (action: () => unknown): unknown => {
	try {
		action();
	} catch (error) {
		return error;
	}
	return undefined;
};

function inTemp<T>(prefix: string, use: (dir: string) => T): T {
	const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
	try {
		return use(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

describe("the installed package", () => {
	const dir = packageDir();
	const manifest = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")) as {
		version: string;
		gypfile?: boolean;
		scripts?: Record<string, string>;
		exports: Record<string, string>;
	};

	it("is the pinned version, from pnpm's store, with no build step for pnpm to run", () => {
		const spike = JSON.parse(readFileSync(path.join(spikeDir, "package.json"), "utf8")) as {
			dependencies: Record<string, string>;
		};
		expect(manifest.version).toBe(spike.dependencies[PACKAGE]);
		expect(dir.split(path.sep)).toContain(".pnpm");
		const lifecycle = ["preinstall", "install", "postinstall"];
		expect(Object.keys(manifest.scripts ?? {}).filter((name) => lifecycle.includes(name))).toEqual(
			[],
		);
		// It ships binding.gyp, which would mean an implicit `node-gyp rebuild` without this.
		expect([existsSync(path.join(dir, "binding.gyp")), manifest.gypfile]).toEqual([true, false]);
	});

	it("ships one N-API 10 prebuild per target, each also a subpath export", () => {
		const shipped = readdirSync(path.join(dir, "prebuilds")).toSorted();
		expect(shipped).toEqual(TARGETS.map((target) => `${target}.node`));
		expect(
			Object.keys(manifest.exports).filter((key) => key !== "." && key !== "./package.json"),
		).toHaveLength(TARGETS.length);
		for (const target of TARGETS) expect(manifest.exports[`./${target}`]).toBeDefined();
		expect(napiVersion(dir)).toBe(10);
	});
});

describe("targetFor", () => {
	it("names the prebuild the package's own loader would pick", () => {
		expect(targetFor("win32", "x64", undefined)).toBe("win32-x64");
		expect(targetFor("darwin", "arm64", undefined)).toBe("darwin-arm64");
		expect(targetFor("linux", "arm64", "2.39")).toBe("linux-arm64");
		expect(targetFor("linux", "x64", undefined)).toBe("linuxmusl-x64");
		expect(() => targetFor("freebsd", "x64", undefined)).toThrow("no prebuild for freebsd-x64");
		expect(() => targetFor("win32", "ia32", undefined)).toThrow("no prebuild for win32-ia32");
	});
});

describe("the host's prebuild", () => {
	const target = hostTarget();
	const source = path.join(packageDir(), "prebuilds", `${target}.node`);

	it("is copied from the package's real folder into bundle/prebuilds/", () => {
		const prebuild = copyPrebuild(target);
		expect(prebuild.file).toBe(path.join(bundleDir, "prebuilds", `${target}.node`));
		expect(lstatSync(prebuild.file).isSymbolicLink()).toBe(false);
		expect(lstatSync(prebuild.file).nlink).toBe(1);
		expect(sha256(prebuild.file)).toBe(sha256(source));
		expect([prebuild.sha256, prebuild.bytes]).toEqual([sha256(source), lstatSync(source).size]);
		expect(copyPrebuild(target)).toEqual(prebuild);
		expect(sha256(prebuild.file)).toBe(sha256(source));
	});

	it("replaces a copy that holds other bytes", () => {
		inTemp("s01-bundle-", (bundle) => {
			const { file } = copyPrebuild(target, bundle);
			writeFileSync(file, Buffer.concat([readFileSync(file), Buffer.alloc(8)]));
			expect(sha256(file)).not.toBe(sha256(source));
			expect(copyPrebuild(target, bundle).sha256).toBe(sha256(source));
			expect(sha256(file)).toBe(sha256(source));
		});
	});

	it("loads through the main entry's nativeBinding and reports the SQLite3MC version", () => {
		const { file } = copyPrebuild(target);
		const report = loadReport(file);
		console.log(
			`${report.sqlite3mcVersion} (SQLite ${report.sqliteVersion}) on ${report.target}, ` +
				`Node ${report.nodeVersion}, N-API ${report.napiVersion}, opened in ${report.openMs} ms`,
		);
		expect(report).toMatchObject({
			target,
			nodeVersion: process.versions.node,
			fromBundle: true,
			sha256: prebuildHashes()[target],
		});
		expect(report.sqlite3mcVersion).toMatch(/^SQLite3 Multiple Ciphers \d+\.\d+\.\d+$/);
		expect(report.sqliteVersion).toMatch(/^3\.\d+\.\d+$/);
		expect(report.napiVersion).toBeGreaterThanOrEqual(napiVersion());
	});

	it("needs an absolute path to a .node file", () => {
		const { file } = copyPrebuild(target);
		for (const binding of ["bundle/prebuilds/x.node", file.slice(0, -".node".length), ""]) {
			expect(thrown(() => openDatabase(":memory:", binding))).toMatchObject({
				name: "NativeBindingError",
				code: "ERR_NATIVE_BINDING_PATH",
			});
		}
	});

	it("is probed in a child: the result on stdout, the reason for a failure on stderr", () => {
		const { file } = copyPrebuild(target);
		const run = (binding: string) =>
			spawnSync(process.execPath, [path.join(spikeDir, "src", "probe.ts"), binding], {
				encoding: "utf8",
				windowsHide: true,
			});
		const ok = run(file);
		expect([ok.status, JSON.parse(ok.stdout)]).toMatchObject([
			0,
			{ loaded: true, target, fromBundle: true, sha256: sha256(source), keyed: { ok: true } },
		]);
		const refused = run(file.slice(0, -".node".length));
		expect([refused.status, JSON.parse(refused.stdout)]).toMatchObject([
			1,
			{ loaded: false, error: "ERR_NATIVE_BINDING_PATH", target },
		]);
		expect(refused.stderr).toContain("probe: ERR_NATIVE_BINDING_PATH: nativeBinding is");
	});
});

describe("the per-platform subpath exports", () => {
	type Constructor = new (file: string, options: object) => unknown;

	it.for(TARGETS)("%s refuses nativeBinding before loading anything", (target) => {
		const Database = require(`${PACKAGE}/${target}`) as Constructor;
		const nativeBinding = path.join(bundleDir, "prebuilds", `${target}.node`);
		expect(() => new Database(":memory:", { nativeBinding })).toThrow(
			'The "nativeBinding" option is only supported by the default better-sqlite3 entrypoint',
		);
	});
});

const nodes = ["26.5.1", "26.12.0"];
const basis: Basis = {
	package: `${PACKAGE}@13.0.3`,
	napiExpected: 10,
	nodes,
	prebuilds: Object.fromEntries(TARGETS.map((target) => [target, fake(target)])),
};
const ran = (target: string, nodeVersion: string, extra: Partial<LoadRun> = {}): LoadRun =>
	({
		loaded: true,
		target,
		nodeVersion,
		napiVersion: 10,
		libc: null,
		sqliteVersion: "3.53.4",
		sqlite3mcVersion: "SQLite3 Multiple Ciphers 2.4.0",
		fromBundle: true,
		sha256: fake(target),
		openMs: 1,
		keyed: { ok: true },
		via: "native",
		nodeFrom: "fetch-node",
		...extra,
	}) as LoadRun;
const failed = (target: string, nodeVersion: string, error: string): LoadRun => ({
	loaded: false,
	error,
	target,
	nodeVersion,
	napiVersion: null,
	via: "docker",
	nodeFrom: "image",
});
const host = (name: string, runs: LoadRun[], pkg = basis.package): HostLoads => ({
	host: name,
	package: pkg,
	napiExpected: 10,
	runs,
});

describe("the load matrix", () => {
	it("marks each target × Node pair loaded, failed or not run, and says why", () => {
		const matrix = loadMatrix(
			[
				host("win32-x64", [
					ran("win32-x64", "26.5.1"),
					ran("win32-x64", "26.12.0"),
					ran("linux-x64", "26.5.1", { via: "docker" }),
					ran("linux-x64", "26.12.0", { via: "docker", fromBundle: false }),
					ran("linuxmusl-x64", "26.5.1", { via: "docker" }),
					failed("linuxmusl-x64", "26.12.0", "exit:139"),
				]),
				host("linux-arm64", [
					ran("linux-x64", "26.5.1", { via: "docker" }),
					ran("linuxmusl-x64", "26.5.1", { via: "docker", napiVersion: 9 }),
					ran("linux-arm64", "26.5.1", { sha256: fake("other bytes") }),
					ran("linuxmusl-arm64", "26.5.1", { keyed: { ok: false, failure: "wrong key: opened" } }),
					failed("linux-arm64", "26.12.0", "ERR_DLOPEN_FAILED"),
				]),
				host("darwin-arm64", [ran("darwin-arm64", "26.5.1")], `${PACKAGE}@13.0.2`),
			],
			basis,
		);
		expect(matrix).toMatchObject({
			...basis,
			hosts: ["win32-x64", "linux-arm64"],
			complete: false,
		});
		expect(Object.keys(matrix.targets)).toEqual([...TARGETS]);
		const cell = (target: string, node: string) => matrix.targets[target]?.[node];
		expect(cell("win32-x64", "26.5.1")).toEqual({
			status: "loaded",
			napiVersions: [10],
			ranOn: ["win32-x64 native"],
			problems: [],
		});
		expect(cell("linux-x64", "26.5.1")?.ranOn).toEqual(["win32-x64 docker", "linux-arm64 docker"]);
		expect(cell("linux-x64", "26.12.0")).toMatchObject({
			status: "failed",
			problems: ["not from the bundle"],
		});
		expect(cell("linuxmusl-x64", "26.5.1")).toMatchObject({
			status: "failed",
			napiVersions: [9, 10],
			problems: ["N-API 9"],
		});
		expect(cell("linuxmusl-x64", "26.12.0")).toMatchObject({
			status: "failed",
			napiVersions: [],
			problems: ["exit:139"],
		});
		expect(cell("linux-arm64", "26.5.1")?.problems).toEqual(["other bytes"]);
		expect(cell("linux-arm64", "26.12.0")?.problems).toEqual(["ERR_DLOPEN_FAILED"]);
		expect(cell("linuxmusl-arm64", "26.5.1")).toMatchObject({
			status: "failed",
			problems: ["keyed: wrong key: opened"],
		});
		expect(cell("darwin-arm64", "26.5.1")?.status).toBe("not run");
	});

	it("is complete once all 8 targets load on both Nodes", () => {
		const runs = TARGETS.flatMap((target) => nodes.map((node) => ran(target, node)));
		expect(loadMatrix([host("any", runs)], basis).complete).toBe(true);
	});

	it("names a host file or matrix that is truncated or foreign", () => {
		inTemp("s01-evidence-", (dir) => {
			const write = (name: string, value: unknown) =>
				writeFileSync(
					path.join(dir, name),
					typeof value === "string" ? value : JSON.stringify({ data: value }),
				);
			write("load-linux-arm64.json", '{"recordedAt": "x", "data": {"host": "linux-ar');
			expect(() => readHostFiles(dir)).toThrow(/^load-linux-arm64\.json: not JSON \(/);
			write("load-linux-arm64.json", '{"recordedAt": "x"}');
			expect(() => readHostFiles(dir)).toThrow(
				"load-linux-arm64.json: not an S1 host file (data is missing or malformed)",
			);
			write("load-linux-arm64.json", { ...host("linux-arm64", []), runs: {} });
			expect(() => readHostFiles(dir)).toThrow("(runs is missing or malformed)");
			const partial = { loaded: true, target: "linux-arm64" };
			write(
				"load-linux-arm64.json",
				host("linux-arm64", [failed("x", "1", "e"), partial as LoadRun]),
			);
			expect(() => readHostFiles(dir)).toThrow("(runs[1].nodeVersion is missing or malformed)");
			write("load-linux-arm64.json", host("linux-arm64", [{ target: "x" } as unknown as LoadRun]));
			expect(() => readHostFiles(dir)).toThrow("(runs[0].loaded is missing or malformed)");
			const unkeyed = { ...ran("linux-arm64", "26.5.1"), keyed: undefined } as unknown as LoadRun;
			write("load-linux-arm64.json", host("linux-arm64", [unkeyed]));
			expect(() => readHostFiles(dir)).toThrow("(runs[0].keyed is missing or malformed)");
			write("load-linux-arm64.json", host("linux-arm64", [failed("linux-arm64", "26.5.1", "e")]));
			write("load-matrix.json", "{");
			expect(readHostFiles(dir)).toHaveLength(1);
			expect(() => readMatrix(dir)).toThrow(/^load-matrix\.json: not JSON \(/);
			write("load-matrix.json", { ...basis, prebuilds: undefined });
			expect(() => readMatrix(dir)).toThrow(
				"load-matrix.json: not an S1 load matrix (nodes or prebuilds is missing or malformed)",
			);
		});
	});

	it("in evidence/ matches the host files beside it, for the installed package", () => {
		const { recorded, rebuilt } = matrixPair();
		expect(recorded, STALE).toEqual(rebuilt);
		const dir = packageDir();
		const { version } = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")) as {
			version: string;
		};
		expect(recorded).toMatchObject({
			package: `${PACKAGE}@${version}`,
			napiExpected: napiVersion(dir),
			prebuilds: prebuildHashes(dir),
		});
	});

	it("is checked by node src/matrix.ts --check with no install", () => {
		inTemp("s01-check-", (dir) => {
			mkdirSync(path.join(dir, "src"));
			for (const file of ["package.json", "src/matrix.ts", "src/prebuilds.ts"]) {
				cpSync(path.join(spikeDir, file), path.join(dir, file));
			}
			cpSync(path.join(spikeDir, "evidence"), path.join(dir, "evidence"), { recursive: true });
			const check = () =>
				spawnSync(process.execPath, [path.join("src", "matrix.ts"), "--", "--check"], {
					cwd: dir,
					encoding: "utf8",
					windowsHide: true,
				});
			expect(check()).toMatchObject({ status: 0, stdout: expect.stringContaining("matches") });
			const { recorded } = matrixPair();
			const download = { ...host("darwin-arm64", []), package: recorded.package };
			writeFileSync(
				path.join(dir, "evidence", "load-darwin-arm64.json"),
				JSON.stringify({ data: download }),
			);
			expect(check()).toMatchObject({ status: 1, stderr: expect.stringContaining(STALE) });
		});
	});
});

describe("recording", () => {
	it("happens only when asked, or in CI", () => {
		expect(recording({})).toBe(false);
		expect(recording({ CI: "true" })).toBe(true);
		expect(recording({ DRAFTYAK_RECORD_EVIDENCE: "1" })).toBe(true);
		expect(recording({ CI: "true", DRAFTYAK_RECORD_EVIDENCE: "0" })).toBe(false);
		expect(() => recording({ DRAFTYAK_RECORD_EVIDENCE: "true" })).toThrow('not "true"');
	});

	it("covers the Nodes DRAFTYAK_NODES selects", () => {
		const versions = { minimum: "26.5.1", bundled: "26.12.0" };
		expect(selectedNodes(versions, {})).toEqual(nodes);
		expect(selectedNodes(versions, { DRAFTYAK_NODES: "both" })).toEqual(nodes);
		expect(selectedNodes(versions, { DRAFTYAK_NODES: "minimum" })).toEqual(["26.5.1"]);
		expect(selectedNodes(versions, { DRAFTYAK_NODES: "bundled" })).toEqual(["26.12.0"]);
		expect(() => selectedNodes(versions, { DRAFTYAK_NODES: "26.5.1" })).toThrow('not "26.5.1"');
	});

	it("needs a run, loaded or failed, for every planned case", () => {
		const planned = [
			{ target: "win32-x64", nodeVersion: "26.5.1", via: "native" },
			{ target: "linux-x64", nodeVersion: "26.5.1", via: "docker" },
			{ target: "linux-x64", nodeVersion: "26.12.0", via: "docker" },
		] as const;
		const runs = [ran("win32-x64", "26.5.1"), failed("linux-x64", "26.12.0", "timeout")];
		expect(unrun(planned, runs)).toEqual([planned[1]]);
	});
});
