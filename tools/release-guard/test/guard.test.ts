import { spawnSync } from "node:child_process";
import {
	linkSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { afterAll, describe, expect, it } from "vitest";
import { checkNodeIntegrity, guard, manifest, npmPackages } from "../src/guard.ts";
import { compare, hash, inventory, records, relative } from "../src/integrity.ts";
import { unpack } from "../src/tar.ts";

const base = mkdtempSync(path.join(tmpdir(), "draftyak-release-guard-"));
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
	write(repo, "apps/cli/package.json", JSON.stringify(metadata));
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

describe("publication boundary", () => {
	it("keeps the exact 20-package plan allowlist without prefix wildcards", () => {
		expect(Object.keys(npmPackages)).toHaveLength(20);
		expect(npmPackages.draftyak).toBe("apps/cli");
		expect(npmPackages["@draftyak/mcp-apps"]).toBeUndefined();
		expect(npmPackages["@draftyak/spike-kit"]).toBeUndefined();
		expect(npmPackages["@draftyak/fake-commercial"]).toBeUndefined();
	});
	it("reads metadata from the actual tgz and compares workspace identity/version", () => {
		const { stage, repo } = fixture();
		const release = addPackage(stage, repo, { name: "draftyak", version: "0.1.0" });
		expect(inspect(stage, repo, release).findings).toEqual([]);
		write(repo, "apps/cli/package.json", JSON.stringify({ name: "draftyak", version: "0.2.0" }));
		expect(
			inspect(stage, repo, release).findings.some((finding) =>
				finding.reason.includes("differs from workspace"),
			),
		).toBe(true);
	});
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
	it("checks lockstep source versions and Python SDK metadata where present", () => {
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
		expect(
			inspect(stage, repo).findings.some((finding) => finding.check === "python-sdk-version"),
		).toBe(true);
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
	it("compares every Python file to the canonical inventory", () => {
		const { stage, repo } = fixture();
		write(stage, "runtime/shim.mjs", "shim");
		write(stage, "runtime/pyodide.wasm", "wasm");
		write(
			stage,
			"runtime.inventory.json",
			JSON.stringify({ schemaVersion: 1, files: inventory(path.join(stage, "runtime")) }),
		);
		const release = {
			...input(stage),
			runtime: { canonical: "runtime.inventory.json", copies: ["runtime"] },
		};
		expect(inspect(stage, repo, release).findings).toEqual([]);
		write(stage, "runtime/extra", "x");
		const extra = { ...release, artifacts: inventory(stage) };
		expect(
			inspect(stage, repo, extra).findings.some(
				(finding) => finding.check === "python-runtime" && finding.reason.includes("extra"),
			),
		).toBe(true);
		write(stage, "runtime/shim.mjs", "changed");
		expect(
			inspect(stage, repo, { ...release, artifacts: inventory(stage) }).findings.some((finding) =>
				finding.reason.includes("mismatch"),
			),
		).toBe(true);
	});
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
		const release = { ...input(stage), node };
		const report = inspect(stage, repo, release);
		expect(report.checks).toContain("bundled-node-integrity");
		expect(report.findings).toEqual([
			{
				check: "bundled-node-runtime",
				reason: expect.stringContaining("candidate not executed"),
			},
		]);
		expect(report.findings[0]?.reason).toContain("Temporal/--disable-sigusr1");
		expect(report.findings[0]?.reason).toContain("independently verified executable");
	});
	it("does not accept security booleans or a partial manifest as full readiness", () => {
		const { stage, repo } = fixture();
		expect(() => manifest({ ...input(stage), mockStoreAbsent: true })).toThrow("unsupported field");
		const report = guard(input(stage), { root: stage, repo, scope: "full" });
		expect(report.findings.some((finding) => finding.check === "sms-host")).toBe(true);
		expect(report.findings.some((finding) => finding.check === "dev-key-refusal")).toBe(true);
		expect(report.findings.filter((finding) => finding.check === "publish-set")).toHaveLength(20);
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
