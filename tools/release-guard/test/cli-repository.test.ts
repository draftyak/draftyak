import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/cli.ts";
import * as release from "../src/guard.ts";

const repo = path.resolve(import.meta.dirname, "../../..");
const entry = path.resolve(import.meta.dirname, "../src/cli.ts");
const temporary = realpathSync.native(tmpdir());
const fixtures: { readonly root: string; readonly dev: number; readonly ino: number }[] = [];
function fixture(): {
	readonly cwd: string;
	readonly args: readonly string[];
	readonly version: string;
} {
	const root = mkdtempSync(path.join(temporary, "draftyak-release-cli-"));
	const identity = lstatSync(root);
	fixtures.push({ root, dev: identity.dev, ino: identity.ino });
	const cwd = path.join(root, "elsewhere");
	const stage = path.join(root, "stage");
	mkdirSync(cwd);
	mkdirSync(stage);
	const current = JSON.parse(readFileSync(path.join(repo, "apps/hub/package.json"), "utf8"));
	const version = current.version === "0.0.0" ? "1.0.0" : "0.0.0";
	const bytes = Buffer.from("Synthetic inert release input; never executed.");
	writeFileSync(path.join(stage, "payload.bin"), bytes);
	const manifest = path.join(root, "release.json");
	writeFileSync(
		manifest,
		JSON.stringify({
			schemaVersion: 1,
			version,
			artifacts: [
				{
					path: "payload.bin",
					bytes: bytes.length,
					sha256: createHash("sha256").update(bytes).digest("hex"),
				},
			],
			npm: [],
		}),
	);
	return {
		cwd,
		args: ["--manifest", manifest, "--root", stage, "--scope", "artifacts", "--json"],
		version,
	};
}
function run(cwd: string, args: readonly string[]): ReturnType<typeof spawnSync> {
	const env = { ...process.env };
	delete env.NODE_OPTIONS;
	delete env.NODE_PATH;
	return spawnSync(process.execPath, ["--disable-sigusr1", entry, ...args], {
		cwd,
		env,
		encoding: "utf8",
		timeout: 5_000,
		maxBuffer: 16_384,
		windowsHide: true,
		shell: false,
	});
}
afterEach(() => {
	vi.restoreAllMocks();
	for (const fixture of fixtures.splice(0)) {
		const current = lstatSync(fixture.root);
		if (
			path.dirname(fixture.root) !== temporary ||
			!path.basename(fixture.root).startsWith("draftyak-release-cli-") ||
			!current.isDirectory() ||
			current.isSymbolicLink() ||
			current.dev !== fixture.dev ||
			current.ino !== fixture.ino ||
			realpathSync(fixture.root) !== fixture.root
		)
			throw new Error("Unsafe release CLI fixture cleanup");
		rmSync(fixture.root, { recursive: true, force: true });
	}
});

describe("release CLI repository selection", () => {
	it.each([false, true])(
		"prints non-failing warnings without hiding findings (finding=%s)",
		async (failed) => {
			const f = fixture();
			const warning = {
				check: "schedule-equivalence:node",
				reason: "tzdata differs; canonical answers agree",
			};
			vi.spyOn(release, "guardRelease").mockResolvedValue({
				scope: "full",
				checks: ["schedule-equivalence"],
				warnings: [warning],
				findings: failed
					? [{ check: "native-features", reason: "real product inspection missing" }]
					: [],
			});
			const output = vi.spyOn(console, "log").mockImplementation(() => {});
			expect(await main(f.args.filter((arg) => arg !== "--json"))).toBe(failed ? 1 : 0);
			expect(output).toHaveBeenCalledWith(`warning: ${warning.check}: ${warning.reason}`);
			if (failed)
				expect(output).toHaveBeenCalledWith("native-features: real product inspection missing");
		},
	);

	it("uses this repository from another cwd instead of omitting its version checks", () => {
		const f = fixture();
		const result = run(f.cwd, f.args);
		expect(result.status, String(result.stderr)).toBe(1);
		expect(result.stderr).toBe("");
		const report = JSON.parse(String(result.stdout));
		expect(report.scope).toBe("artifacts");
		expect(report.findings).toContainEqual({
			check: "version:apps/hub",
			reason: "release component version differs",
		});
	});

	it("preserves an explicit trusted source repository independently of the invocation cwd", () => {
		const f = fixture();
		const source = path.join(f.cwd, "explicit-source");
		mkdirSync(path.join(source, "apps/hub"), { recursive: true });
		writeFileSync(
			path.join(source, "apps/hub/package.json"),
			JSON.stringify({ version: f.version }),
		);
		const result = run(f.cwd, [...f.args, "--repo", source]);
		expect(result.status, String(result.stderr)).toBe(0);
		expect(result.stderr).toBe("");
		const report = JSON.parse(String(result.stdout));
		expect(report.findings).toEqual([]);
		expect(report.checks).toContain("version:apps/hub");
	});

	it.each([
		[["--help"], 0],
		[[], 2],
	] as const)("reports the runnable package command for arguments %j", (args, status) => {
		const f = fixture();
		const result = run(f.cwd, args);
		expect(result.status, String(result.stderr)).toBe(status);
		const output = String(status === 0 ? result.stdout : result.stderr);
		expect(output).toContain(
			"usage: pnpm --filter @draftyak/release-guard guard:release --manifest",
		);
		expect(output).toContain("--root <staged-directory> [--repo <repository>]");
		expect(status === 0 ? result.stderr : result.stdout).toBe("");
	});
});
