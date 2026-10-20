import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { areaNames, classify, rustWorkspace, untestedRust } from "./changes.ts";

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
		["spikes/s05/rust/ekm/src/lib.rs", "spikes/s05/rust"],
		["spikes/s05/rust/ekm/Cargo.toml", "spikes/s05/rust"],
		["spikes/clock/jiff/src/main.rs", "spikes/clock/jiff"],
		["spikes/clock/jiff/Cargo.toml", "spikes/clock/jiff"],
		["tools/ci-checks/src/dco.ts", undefined],
		["Cargo.toml", undefined],
	])("keeps relative Rust ancestor selection for %s", (file, expected) => {
		expect(rustWorkspace(root, file)).toBe(expected);
	});

	it.each(["/synthetic/member/src/lib.rs", "/Cargo.toml", "/", "//synthetic/member/src/lib.rs"])(
		"rejects POSIX absolute Rust paths before manifest probes: %s",
		(file) => {
			const script = `
import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const { classify, rustWorkspace } = await import(${JSON.stringify(new URL("./changes.ts", import.meta.url).href)});
let probes = 0;
fs.existsSync = () => {
	if (++probes > 32) throw new Error("Synthetic manifest-probe budget exhausted");
	return false;
};
fs.readFileSync = () => { throw new Error("Unexpected manifest read"); };
syncBuiltinESMExports();
for (const check of [
	() => rustWorkspace(process.argv[2], process.argv[1]),
	() => classify([process.argv[1]], process.argv[2], () => []),
]) {
	assert.throws(check, /^Error: Rust workspace paths must be repository-relative$/,
		"Absolute paths must be rejected before filesystem probes");
}
assert.equal(probes, 0, "Absolute paths must perform zero manifest probes");
console.log("absolute paths rejected without manifest probes");
`;
			const result = spawnSync(
				process.execPath,
				["--input-type=module", "-e", script, file, root],
				{
					encoding: "utf8",
					timeout: 5_000,
					windowsHide: true,
				},
			);
			expect(result.error, "The bounded child must complete without a timeout").toBeUndefined();
			expect(result.signal).toBeNull();
			expect(result.status, result.stderr).toBe(0);
			expect(result.stdout.trim()).toBe("absolute paths rejected without manifest probes");
		},
	);

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
