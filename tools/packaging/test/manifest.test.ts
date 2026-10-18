import {
	existsSync,
	linkSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { manifest } from "../../release-guard/src/guard.ts";
import { inventory } from "../../release-guard/src/integrity.ts";
import { createManifest, main, writeManifest } from "../src/manifest.ts";
import { removeFixture } from "./temp.ts";

const fixtures: string[] = [];
function fixture(): { base: string; repo: string; staged: string } {
	const base = mkdtempSync(path.join(os.tmpdir(), "draftyak-manifest-"));
	fixtures.push(base);
	const repo = path.join(base, "repo");
	const staged = path.join(repo, "staged");
	mkdirSync(staged, { recursive: true });
	return { base, repo, staged };
}
function put(root: string, file: string, bytes: string): void {
	const out = path.join(root, file);
	mkdirSync(path.dirname(out), { recursive: true });
	writeFileSync(out, bytes);
}
const config = () => ({ schemaVersion: 1, version: "0.1.0-rc.1", npm: [] });
afterEach(() => {
	vi.restoreAllMocks();
	for (const root of fixtures.splice(0)) removeFixture(root, os.tmpdir(), "draftyak-manifest-");
});

describe("actual staged manifest", () => {
	it("computes deterministic sorted hashes and derives Node metadata without modifying staging", () => {
		const { repo, staged } = fixture();
		put(staged, "z/last.txt", "last");
		put(staged, "node", "synthetic fixture; never execute");
		put(staged, "a.txt", "a");
		const input = { ...config(), node: { path: "node", version: "26.12.0" } };
		const before = inventory(staged);
		const expected = createManifest(input, staged);
		expect(expected.artifacts.map((file) => file.path)).toEqual(["a.txt", "node", "z/last.txt"]);
		expect(expected.artifacts[0]?.sha256).toBe(
			"ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb",
		);
		expect(expected.node).toEqual({ ...expected.artifacts[1], version: "26.12.0" });
		const first = path.join(repo, "first.json");
		writeManifest(input, { repo, root: staged, out: first });
		writeManifest(input, { repo, root: staged, out: path.join(repo, "second.json") });
		expect(readFileSync(first, "utf8")).toBe(readFileSync(path.join(repo, "second.json"), "utf8"));
		expect(manifest(JSON.parse(readFileSync(first, "utf8")))).toEqual(expected);
		expect(readFileSync(first, "utf8").endsWith("\n")).toBe(true);
		expect(inventory(staged)).toEqual(before);
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

	it("includes real referenced npm, runtime and notices files without claiming their semantic validity", () => {
		const { staged } = fixture();
		for (const file of [
			"cli.tgz",
			"runtime.inventory.json",
			"runtime/shim.mjs",
			"THIRD_PARTY_NOTICES",
			"bom.json",
		])
			put(staged, file, "fixture bytes");
		const result = createManifest(
			{
				...config(),
				npm: [{ path: "cli.tgz", workspace: "apps/cli" }],
				runtime: { canonical: "runtime.inventory.json", copies: ["runtime"] },
				notices: { path: "THIRD_PARTY_NOTICES", sbom: "bom.json" },
			},
			staged,
		);
		expect(result.artifacts).toHaveLength(5);
		expect(result.npm[0]?.path).toBe("cli.tgz");
	});

	it.each([
		{ npm: [{ path: "missing.tgz", workspace: "apps/cli" }] },
		{ node: { path: "missing-node", version: "26.12.0" } },
		{ runtime: { canonical: "missing.json", copies: ["runtime"] } },
		{ runtime: { canonical: "present", copies: ["missing-runtime"] } },
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
			{ node: { path: "node", version: "26.12.0", sha256: "a".repeat(64) } },
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
