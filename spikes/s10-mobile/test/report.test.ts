import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { CrateBuild } from "../src/cargo.ts";
import { appInfo } from "../src/ios.ts";
import { appendSummary, crateTableMarkdown } from "../src/report.ts";
import { capabilities, mustBuild, recording, spikesRun } from "../src/toolchain.ts";

const build = (provider: CrateBuild["provider"], ok: boolean): CrateBuild => ({
	target: "aarch64-linux-android",
	provider,
	ok,
	seconds: 12,
	log: "",
	strays: [],
	notes: provider === "ring" ? [] : ["Building with: CMake"],
	crates:
		provider === "ring"
			? [
					{ name: "ring", version: "0.17.14", status: "ok" },
					{ name: "transport-skeleton", version: "0.0.0", status: "ok" },
				]
			: [
					{ name: "aws-lc-sys", version: null, status: "fail", reason: "a | b" },
					{ name: "transport-skeleton", version: null, status: "blocked" },
				],
});

describe("the crate table", () => {
	it("has a column per target and provider and a row per crate", () => {
		expect(
			crateTableMarkdown("S10 crate table: Android", [
				build("ring", true),
				build("aws-lc-rs", false),
			]),
		).toBe(`### S10 crate table: Android

| Crate | aarch64-linux-android ring | aarch64-linux-android aws-lc-rs |
|---|---|---|
| **build** | ok (12 s) | **fail** (12 s) |
| ring | ok 0.17.14 | - |
| aws-lc-sys | - | **fail**: a \\| b |
| transport-skeleton | ok 0.0.0 | blocked |

aws-lc-rs: aarch64-linux-android: fails (aws-lc-sys: Building with: CMake)`);
	});

	it("goes to GITHUB_STEP_SUMMARY only when it is set", () => {
		const dir = mkdtempSync(path.join(os.tmpdir(), "draftyak-s10-summary-"));
		try {
			const file = path.join(dir, "summary.md");
			appendSummary("one\n", { GITHUB_STEP_SUMMARY: file });
			appendSummary("two", { GITHUB_STEP_SUMMARY: file });
			appendSummary("nowhere", {});
			expect(readFileSync(file, "utf8")).toBe("one\n\ntwo\n\n");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("when mobile builds must run", () => {
	it("only in spikes-run: GitHub Actions with strict skips, on the build's own OS", () => {
		const github = { GITHUB_ACTIONS: "true", DRAFTYAK_STRICT_SKIPS: "1" };
		expect(mustBuild(github, process.platform)).toBe(true);
		expect(mustBuild(github, process.platform === "darwin" ? "linux" : "darwin")).toBe(false);
		expect(mustBuild({ GITHUB_ACTIONS: "true" }, process.platform)).toBe(false);
		expect(mustBuild({ DRAFTYAK_STRICT_SKIPS: "1" }, process.platform)).toBe(false);
	});

	it("leaves the host checks to CI's full job and local runs, not spikes-run", () => {
		const hostChecks = (env: NodeJS.ProcessEnv): boolean =>
			capabilities(env)["host-checks"]?.detect() ?? false;
		expect(spikesRun({ GITHUB_ACTIONS: "true", DRAFTYAK_STRICT_SKIPS: "1" })).toBe(true);
		expect(hostChecks({ GITHUB_ACTIONS: "true", DRAFTYAK_STRICT_SKIPS: "1" })).toBe(false);
		expect(hostChecks({ GITHUB_ACTIONS: "true" })).toBe(true);
		expect(hostChecks({ DRAFTYAK_STRICT_SKIPS: "1" })).toBe(true);
	});

	it("records evidence only when asked, and never in CI", () => {
		expect(recording({ DRAFTYAK_RECORD_EVIDENCE: "1" })).toBe(true);
		expect(recording({ DRAFTYAK_RECORD_EVIDENCE: "1", CI: "true" })).toBe(false);
		expect(recording({})).toBe(false);
		expect(() => recording({ DRAFTYAK_RECORD_EVIDENCE: "yes" })).toThrow(/1 or 0/);
	});
});

describe("the iOS app's Info.plist", () => {
	it("gives the bundle id, executable and device families", () => {
		const plist = {
			CFBundleIdentifier: "com.draftyak.client",
			CFBundleExecutable: "DraftYak",
			UIDeviceFamily: [2, 1],
		};
		expect(appInfo(JSON.stringify(plist))).toEqual({
			bundleId: "com.draftyak.client",
			executable: "DraftYak",
			deviceFamilies: [1, 2],
		});
		expect(appInfo("{}").deviceFamilies).toEqual([]);
	});
});
