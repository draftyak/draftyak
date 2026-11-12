import { createHash } from "node:crypto";
import fs, {
	existsSync,
	linkSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { manifest } from "../../release-guard/src/guard.ts";
import { inventory } from "../../release-guard/src/integrity.ts";
import { createManifest, main, writeManifest } from "../src/manifest.ts";
import { removeFixture } from "./temp.ts";

const fixtures: string[] = [];
const tempRoot = realpathSync.native(os.tmpdir());
const nodeVersion: string = JSON.parse(
	readFileSync(path.resolve(import.meta.dirname, "../../fetch-node/versions.json"), "utf8"),
).bundled;
function fixture(): { base: string; repo: string; staged: string; sourceRoot: string } {
	const base = mkdtempSync(path.join(tempRoot, "draftyak-manifest-"));
	fixtures.push(base);
	const repo = path.join(base, "repo");
	const staged = path.join(repo, "staged");
	const sourceRoot = path.join(base, "synthetic-node-source");
	mkdirSync(staged, { recursive: true });
	mkdirSync(sourceRoot);
	return { base, repo, staged, sourceRoot };
}
function put(root: string, file: string, bytes: string): void {
	const out = path.join(root, file);
	mkdirSync(path.dirname(out), { recursive: true });
	writeFileSync(out, bytes);
}
const config = () => ({ schemaVersion: 1, version: "0.1.0-rc.1", npm: [] });
afterEach(() => {
	vi.restoreAllMocks();
	syncBuiltinESMExports();
	for (const root of fixtures.splice(0)) removeFixture(root, tempRoot, "draftyak-manifest-");
});

describe("actual staged manifest", () => {
	it("computes deterministic sorted hashes and derives Node metadata without modifying staging", () => {
		const { repo, staged, sourceRoot } = fixture();
		put(staged, "z/last.txt", "last");
		put(staged, "node", "synthetic fixture; never execute");
		put(staged, "a.txt", "a");
		const input = {
			...config(),
			node: { path: "node", version: nodeVersion },
			nodeSource: { root: sourceRoot, platform: "linux", arch: "x64" },
		};
		const before = inventory(staged);
		const expected = createManifest(input, staged);
		expect(expected.artifacts.map((file) => file.path)).toEqual(["a.txt", "node", "z/last.txt"]);
		expect(expected.artifacts[0]?.sha256).toBe(
			"ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb",
		);
		expect(expected.node).toEqual({ ...expected.artifacts[1], version: nodeVersion });
		expect(expected.nodeSource).toEqual(input.nodeSource);
		const first = path.join(repo, "first.json");
		writeManifest(input, { repo, root: staged, out: first });
		writeManifest(input, { repo, root: staged, out: path.join(repo, "second.json") });
		expect(readFileSync(first, "utf8")).toBe(readFileSync(path.join(repo, "second.json"), "utf8"));
		const readback = JSON.parse(readFileSync(first, "utf8"));
		expect(readback).toEqual(expected);
		expect(manifest(readback).node).toEqual(expected.node);
		expect(readFileSync(first, "utf8").endsWith("\n")).toBe(true);
		expect(inventory(staged)).toEqual(before);
	});

	it("omits absent optional authority fields from an ordinary manifest", () => {
		const { repo, staged } = fixture();
		put(staged, "payload", "DYTEST ordinary staged bytes");
		const out = path.join(repo, "ordinary.json");
		const result = writeManifest(config(), { repo, root: staged, out });
		for (const key of ["runtime", "node", "nodeSource", "nodes", "notices"])
			expect(Object.hasOwn(result, key)).toBe(false);
		const readback = JSON.parse(readFileSync(out, "utf8"));
		expect(readback).toEqual(result);
		expect(manifest(readback).artifacts).toEqual(result.artifacts);
	});

	it("measures and reads back multiple synthetic Node targets without authenticating or executing them", () => {
		const { repo, staged, sourceRoot } = fixture();
		const targets = [
			{
				path: "windows/node.exe",
				platform: "win",
				arch: "x64",
				body: "DYTEST synthetic Windows bytes",
			},
			{
				path: "macos/node",
				platform: "darwin",
				arch: "arm64",
				body: "DYTEST synthetic macOS bytes",
			},
			{
				path: "linux/node",
				platform: "linux",
				arch: "x64",
				body: "DYTEST synthetic Linux bytes",
			},
		] as const;
		const nodes = targets.map((target) => {
			const root = path.join(sourceRoot, `${target.platform}-${target.arch}`);
			mkdirSync(root);
			put(staged, target.path, target.body);
			return {
				path: target.path,
				version: nodeVersion,
				source: { root, platform: target.platform, arch: target.arch },
			};
		});
		const input = { ...config(), nodes };
		const out = path.join(repo, "targets.json");
		const before = inventory(staged);
		const result = writeManifest(input, { repo, root: staged, out });
		expect(result.nodes).toEqual(
			nodes.map((node, index) => ({
				...node,
				sha256: createHash("sha256")
					.update(targets[index]?.body ?? "")
					.digest("hex"),
				bytes: Buffer.byteLength(targets[index]?.body ?? ""),
			})),
		);
		expect(Object.hasOwn(result, "node")).toBe(false);
		expect(Object.hasOwn(result, "nodeSource")).toBe(false);
		const readback = JSON.parse(readFileSync(out, "utf8"));
		expect(readback).toEqual(result);
		expect(manifest(readback).nodes).toEqual(result.nodes);
		expect(inventory(staged)).toEqual(before);
		const changed = "DYTEST changed staged Windows bytes";
		put(staged, targets[0].path, changed);
		const measuredAgain = createManifest(input, staged).nodes?.[0];
		expect(measuredAgain?.sha256).toBe(createHash("sha256").update(changed).digest("hex"));
		expect(measuredAgain?.bytes).toBe(Buffer.byteLength(changed));
		expect(measuredAgain?.sha256).not.toBe(result.nodes?.[0]?.sha256);
	});

	it("rejects mixed, duplicate and source-less Node declarations through strict admission", () => {
		const { staged, sourceRoot } = fixture();
		put(staged, "node", "DYTEST synthetic Node bytes");
		const source = { root: sourceRoot, platform: "linux", arch: "x64" };
		const node = { path: "node", version: nodeVersion, source };
		const legacy = { path: "node", version: nodeVersion };
		expect(createManifest({ ...config(), nodes: [node] }, staged).nodes).toHaveLength(1);
		expect(() =>
			createManifest({ ...config(), nodes: [node], node: legacy, nodeSource: source }, staged),
		).toThrow("ambiguous");
		expect(() => createManifest({ ...config(), nodes: [node, node] }, staged)).toThrow("duplicate");
		for (const extra of [
			{ node: legacy },
			{ nodeSource: source },
			{ nodes: [] },
			{ nodes: [{ path: "node", version: nodeVersion }] },
			{ nodes: [{ ...node, source: { root: sourceRoot, platform: "linux" } }] },
			{ nodes: [{ ...node, path: "missing-node" }] },
			{ nodes: [{ ...node, source: { ...source, platform: "unknown" } }] },
		])
			expect(() => createManifest({ ...config(), ...extra }, staged)).toThrow();
	});

	it("refuses supplied Node measurements and unknown source metadata instead of treating them as authority", () => {
		const { base, staged, sourceRoot } = fixture();
		put(staged, "node", "DYTEST measured bytes");
		const source = { root: sourceRoot, platform: "linux", arch: "x64" };
		const node = { path: "node", version: nodeVersion, source };
		for (const forged of [{ sha256: "0".repeat(64) }, { bytes: 1 }]) {
			expect(() =>
				createManifest({ ...config(), nodes: [{ ...node, ...forged }] }, staged),
			).toThrow("unsupported field");
			expect(() =>
				createManifest(
					{
						...config(),
						node: { path: "node", version: nodeVersion, ...forged },
						nodeSource: source,
					},
					staged,
				),
			).toThrow("unsupported field");
		}
		expect(() =>
			createManifest(
				{
					...config(),
					nodes: [
						{
							...node,
							source: { ...source, root: path.join(base, "absent"), trusted: true },
						},
					],
				},
				staged,
			),
		).toThrow("unsupported field");
	});

	it("requires every admitted Node source directory without creating output", () => {
		const { base, repo, staged, sourceRoot } = fixture();
		put(staged, "one/node", "DYTEST first target");
		put(staged, "two/node", "DYTEST second target");
		const nodes = [
			{
				path: "one/node",
				version: nodeVersion,
				source: { root: sourceRoot, platform: "linux", arch: "x64" },
			},
			{
				path: "two/node",
				version: nodeVersion,
				source: { root: path.join(base, "missing-source"), platform: "darwin", arch: "arm64" },
			},
		];
		const out = path.join(repo, "missing-source.json");
		expect(() => writeManifest({ ...config(), nodes }, { repo, root: staged, out })).toThrow(
			"ENOENT",
		);
		expect(existsSync(out)).toBe(false);
	});

	it.each([
		{ runtime: undefined },
		{ runtime: null },
		{ runtime: { canonical: "obsolete.json", copies: [] } },
	])("rejects any own runtime config $runtime before staged or output I/O", ({ runtime }) => {
		const { repo, staged } = fixture();
		const denied = (): never => {
			throw new Error("unexpected artifact I/O");
		};
		const lookups = [
			vi.spyOn(fs, "lstatSync").mockImplementation(denied),
			vi.spyOn(fs, "readdirSync").mockImplementation(denied),
			vi.spyOn(fs, "openSync").mockImplementation(denied),
			vi.spyOn(fs, "writeFileSync").mockImplementation(denied),
		];
		syncBuiltinESMExports();
		const input = { ...config(), runtime };
		expect(() => createManifest(input, staged)).toThrow("Python runtime inputs");
		expect(() =>
			writeManifest(input, { repo, root: staged, out: path.join(repo, "blocked.json") }),
		).toThrow("Python runtime inputs");
		for (const lookup of lookups) expect(lookup).not.toHaveBeenCalled();
	});

	it("refuses an own runtime accessor without evaluating it", () => {
		const { staged } = fixture();
		const getter = vi.fn(() => {
			throw new Error("unexpected runtime getter");
		});
		const input = config();
		Object.defineProperty(input, "runtime", { enumerable: false, get: getter });
		expect(() => createManifest(input, staged)).toThrow("Python runtime inputs");
		expect(getter).not.toHaveBeenCalled();
	});

	it("measures changed bytes instead of trusting a previous hash", () => {
		const { staged } = fixture();
		put(staged, "payload", "before");
		const first = createManifest(config(), staged);
		put(staged, "payload", "after mutation");
		const second = createManifest(config(), staged);
		expect(second.artifacts[0]?.sha256).not.toBe(first.artifacts[0]?.sha256);
		expect(second.artifacts[0]?.bytes).toBe(14);
	});

	it("includes referenced npm and notices files without claiming their semantic validity", () => {
		const { staged } = fixture();
		for (const file of ["cli.tgz", "THIRD_PARTY_NOTICES", "bom.json"])
			put(staged, file, "fixture bytes");
		const result = createManifest(
			{
				...config(),
				npm: [{ path: "cli.tgz", workspace: "apps/cli" }],
				notices: { path: "THIRD_PARTY_NOTICES", sbom: "bom.json" },
			},
			staged,
		);
		expect(result.artifacts).toHaveLength(3);
		expect(result.npm[0]?.path).toBe("cli.tgz");
	});

	it.each([
		{ npm: [{ path: "missing.tgz", workspace: "apps/cli" }] },
		{ node: { path: "missing-node", version: nodeVersion } },
		{ notices: { path: "present", sbom: "missing.json" } },
		{ notices: { path: "missing-notices", sbom: "present" } },
	])("refuses missing references: %j", (extra) => {
		const { staged } = fixture();
		put(staged, "present", "fixture");
		expect(() => createManifest({ ...config(), ...extra }, staged)).toThrow();
	});

	it("rejects empty staging, supplied artifacts, forged Node hashes and unknown fields", () => {
		const { staged } = fixture();
		expect(() => createManifest(config(), staged)).toThrow("empty");
		put(staged, "node", "fixture");
		for (const extra of [
			{ artifacts: [] },
			{ unexpected: true },
			{ node: { path: "node", version: nodeVersion, sha256: "a".repeat(64) } },
		]) {
			expect(() => createManifest({ ...config(), ...extra }, staged)).toThrow("unsupported field");
		}
		expect(() => createManifest({ ...config(), version: "not-a-version" }, staged)).toThrow(
			"version",
		);
	});

	it("refuses linked staged files and linked output ancestors", () => {
		const { repo, staged } = fixture();
		put(staged, "first", "fixture");
		linkSync(path.join(staged, "first"), path.join(staged, "alias"));
		expect(() => createManifest(config(), staged)).toThrow("single-link");
		rmSync(path.join(staged, "alias"));
		mkdirSync(path.join(repo, "real"));
		symlinkSync(path.join(repo, "real"), path.join(repo, "linked"), "junction");
		expect(() =>
			writeManifest(config(), {
				repo,
				root: staged,
				out: path.join(repo, "linked", "manifest.json"),
			}),
		).toThrow("link");
	});
});

describe("exclusive workspace output and strict config", () => {
	it("rejects overwrite, output in staging, output outside workspace and absent parents", () => {
		const { base, repo, staged } = fixture();
		put(staged, "payload", "fixture");
		put(repo, "existing.json", "keep");
		for (const out of [
			path.join(repo, "existing.json"),
			path.join(staged, "manifest.json"),
			path.join(base, "outside.json"),
			path.join(repo, "missing", "manifest.json"),
		]) {
			expect(() => writeManifest(config(), { repo, root: staged, out })).toThrow();
		}
		expect(readFileSync(path.join(repo, "existing.json"), "utf8")).toBe("keep");
		expect(inventory(staged)).toHaveLength(1);
	});

	it("refuses environment and network paths before reading or creating files", () => {
		const { repo, staged } = fixture();
		put(staged, "payload", "fixture");
		for (const out of [path.join(repo, ".env.test"), "\\\\untrusted-host\\share\\manifest.json"]) {
			expect(() => writeManifest(config(), { repo, root: staged, out })).toThrow();
		}
		expect(() => createManifest(config(), "\\\\untrusted-host\\share")).toThrow("local filesystem");
	});

	it("refuses Windows trailing-dot/space directory aliases before containment lookup", () => {
		const { repo, staged } = fixture();
		put(staged, "payload", "fixture");
		for (const alias of [".. ", "staged.", "staged "]) {
			expect(() =>
				writeManifest(config(), {
					repo,
					root: staged,
					out: path.join(repo, alias, "manifest.json"),
				}),
			).toThrow("path aliases");
		}
		expect(() => createManifest(config(), `${staged}.`)).toThrow("path aliases");
	});

	it("reads strict config, rejects duplicate keys and never writes on invalid input", () => {
		const { repo, staged } = fixture();
		put(staged, "payload", "fixture");
		const configPath = path.join(repo, "config.json");
		const out = path.join(repo, "release.json");
		const args = ["--config", configPath, "--root", staged, "--out", out, "--repo", repo];
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(console, "log").mockImplementation(() => {});
		put(repo, "config.json", '{"schemaVersion":1,"version":"0.1.0","version":"0.2.0","npm":[]}');
		expect(main(args)).toBe(1);
		expect(errors.mock.calls.flat().join(" ")).toContain("duplicate JSON key");
		expect(existsSync(out)).toBe(false);
		put(repo, "config.json", JSON.stringify(config()));
		expect(main(["--", ...args])).toBe(0);
		expect(inventory(staged)).toHaveLength(1);
		expect(main(args)).toBe(1);
		expect(main([])).toBe(2);
	});
});
