import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { areaNames, classify, untestedRust } from "./changes.ts";

const root = mkdtempSync(path.join(tmpdir(), "draftyak-changes-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const tree: Record<string, string> = {
	"spikes/s01/package.json": "{}",
	"spikes/s05/package.json": "{}",
	"spikes/s05/rust/Cargo.toml": "[workspace]\nmembers = ['ekm']\n",
	"spikes/s05/rust/ekm/Cargo.toml": "[package]\nname = 'ekm'\n",
	"spikes/clock/package.json": "{}",
	"spikes/clock/jiff/Cargo.toml": "[package]\nname = 'jiff-check'\n",
};
for (const [file, content] of Object.entries(tree)) {
	mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
	writeFileSync(path.join(root, file), content);
}
const manifests = Object.keys(tree).filter((file) => file.endsWith("Cargo.toml"));

describe("changed areas", () => {
	it.each([
		[["README.md", "docs/x.md", "LICENSE", "NOTICE", "spikes/s01/evidence/a.json"], ["docs-only"]],
		[["tools/ci-checks/src/dco.ts", "README.md"], ["ts"]],
		[[".github/workflows/ci.yml"], ["workflows"]],
		[
			["spikes/s01/src/open.ts", "spikes/s01/evidence/a.json"],
			["ts", "spikes/s01"],
		],
		[["spikes/s05/rust/ekm/src/lib.rs"], ["rust:spikes/s05/rust", "spikes/s05"]],
		[["spikes/s05/test/ekm.heavy.test.ts"], ["ts", "rust:spikes/s05/rust", "spikes/s05"]],
		[["spikes/clock/jiff/src/main.rs"], ["rust:spikes/clock/jiff", "spikes/clock"]],
		[
			["rust-toolchain.toml"],
			["rust:spikes/clock/jiff", "rust:spikes/s05/rust", "spikes/clock", "spikes/s05"],
		],
		[["spikes/run.json", "spikes/gone/src/x.ts"], ["ts"]],
		[[], []],
	])("%j → %j", (files, expected) => {
		expect(areaNames(classify(files, root, () => manifests))).toEqual(expected);
	});

	it("names Rust workspaces that no spike package tests", () => {
		mkdirSync(path.join(root, "tools", "x"), { recursive: true });
		writeFileSync(path.join(root, "tools", "x", "Cargo.toml"), "[workspace]\n");
		const files = ["tools/x/src/lib.rs", "spikes/s05/rust/ekm/src/lib.rs"];
		expect(untestedRust(classify(files, root, () => manifests))).toEqual(["tools/x"]);
	});

	it("writes step outputs, with every area when there's no base", () => {
		const output = path.join(root, "github-output");
		const outputs = (base: string): string => {
			writeFileSync(output, "");
			const env = {
				BASE_SHA: base,
				HEAD_SHA: "HEAD",
				GITHUB_OUTPUT: output,
				GITHUB_STEP_SUMMARY: "",
			};
			const script = path.join(import.meta.dirname, "changes.ts");
			const result = spawnSync(process.execPath, [script], { env: { ...process.env, ...env } });
			expect(result.status, String(result.stderr)).toBe(0);
			return readFileSync(output, "utf8");
		};
		expect(outputs("HEAD")).toMatch(/^areas=\[\]\ndocs-only=false\nts=false\n/);
		expect(outputs("")).toMatch(/^areas=\[.*"ts".*\]\ndocs-only=false\nts=true\n/);
	});
});
