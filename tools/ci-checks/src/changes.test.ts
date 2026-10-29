import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
	areaNames,
	classify,
	consumingSpikes,
	rustWorkspace,
	untestedRust,
	type WorkspacePackage,
	workspacePackages,
} from "./changes.ts";

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
const fixtureGraph: readonly WorkspacePackage[] = ["spikes/s01", "spikes/s05", "spikes/clock"].map(
	(folder) => ({ folder, dependencies: [] }),
);
const fixtureClassify = (files: readonly string[]) =>
	classify(
		files,
		root,
		() => manifests,
		() => fixtureGraph,
	);

describe("transitive consuming spikes", () => {
	const graph: readonly WorkspacePackage[] = [
		{ folder: "spikes/kit", dependencies: [] },
		{ folder: "spikes/s02-plugin-sandbox", dependencies: ["spikes/kit"] },
		{ folder: "spikes/s05-desktop", dependencies: ["spikes/s02-plugin-sandbox"] },
		{ folder: "spikes/s11-python-runtime", dependencies: ["spikes/s02-plugin-sandbox"] },
		{ folder: "spikes/s07-siwc", dependencies: ["spikes/kit"] },
		{ folder: "tools/bridge", dependencies: ["spikes/s11-python-runtime"] },
		{ folder: "spikes/downstream", dependencies: ["tools/bridge"] },
		{ folder: "spikes/unrelated", dependencies: [] },
	];

	it("selects S5/S11 and transitive consumers through a non-spike package for an S2 change", () => {
		expect(consumingSpikes(["spikes/s02-plugin-sandbox"], graph)).toEqual([
			"spikes/downstream",
			"spikes/s02-plugin-sandbox",
			"spikes/s05-desktop",
			"spikes/s11-python-runtime",
		]);
	});

	it("selects every consuming suite for kit without treating an external dependency as a workspace edge", () => {
		expect(consumingSpikes(["spikes/kit"], graph)).toEqual(
			graph
				.filter((pkg) => pkg.folder.startsWith("spikes/") && pkg.folder !== "spikes/unrelated")
				.map((pkg) => pkg.folder)
				.sort(),
		);
	});

	it("terminates cycles and deduplicates multiple changed paths", () => {
		const cycle = graph.map((pkg) =>
			pkg.folder === "spikes/s02-plugin-sandbox"
				? { ...pkg, dependencies: [...pkg.dependencies, "spikes/s05-desktop"] }
				: pkg,
		);
		expect(
			consumingSpikes(["spikes/s02-plugin-sandbox", "spikes/s02-plugin-sandbox"], cycle),
		).toEqual(consumingSpikes(["spikes/s02-plugin-sandbox"], graph));
	});

	it("selects all current spikes when a changed package is deleted or missing from metadata", () => {
		expect(consumingSpikes(["spikes/deleted"], graph)).toEqual(
			graph
				.filter((pkg) => pkg.folder.startsWith("spikes/"))
				.map((pkg) => pkg.folder)
				.sort(),
		);
	});

	it("refuses duplicate folders or unsafe metadata rather than producing selectors", () => {
		for (const extra of [
			graph[0],
			{ folder: "spikes/../escape", dependencies: [] },
			{ folder: "spikes/unsafe name", dependencies: [] },
		]) {
			expect(() => consumingSpikes(["spikes/kit"], [...graph, extra as WorkspacePackage])).toThrow(
				"invalid or ambiguous workspace selection metadata",
			);
		}
	});

	it("derives Rust setup from the final consuming set for kit and S2", () => {
		const files = [
			"spikes/s05-desktop/rust/Cargo.toml",
			"spikes/s11-python-runtime/rust/Cargo.toml",
		];
		for (const file of files) {
			mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
			writeFileSync(path.join(root, file), "[workspace]\n");
		}
		for (const changed of ["spikes/kit/run.ts", "spikes/s02-plugin-sandbox/src/spawn.ts"]) {
			const selected = classify(
				[changed],
				root,
				() => files,
				() => graph,
			);
			expect(selected.spikes).toContain("spikes/s05-desktop");
			expect(selected.spikes).toContain("spikes/s11-python-runtime");
			expect(selected.rust).toEqual(["spikes/s05-desktop/rust", "spikes/s11-python-runtime/rust"]);
		}
	});

	it.each([
		"pnpm-lock.yaml",
		"package.json",
		"pnpm-workspace.yaml",
		".node-version",
		"vitest.shared.ts",
		"tsconfig.base.json",
		"turbo.json",
	])("fans shared %s changes out to every spike", (file) => {
		expect(
			classify(
				[file],
				root,
				() => [],
				() => graph,
			).spikes,
		).toEqual(
			graph
				.filter((pkg) => pkg.folder.startsWith("spikes/"))
				.map((pkg) => pkg.folder)
				.sort(),
		);
	});
});

describe("lockfile workspace metadata", () => {
	const lock = `lockfileVersion: '9.0'\nimporters:\n  .: {}\n  spikes/kit: {}\n  spikes/s02: {}\n  spikes/s05:\n    devDependencies:\n      '@fixture/kit':\n        specifier: workspace:*\n        version: link:../kit\n    dependencies:\n      alias:\n        specifier: workspace:../s02\n        version: link:../s02\n      registry-package:\n        specifier: 1.0.0\n        version: 1.0.0\n  spikes/s07-siwc:\n    devDependencies:\n      '@fixture/kit':\n        specifier: workspace:*\n        version: link:../kit\npackages:\n  ignored: {not: parsed}\n`;

	it("uses runtime and dev link targets, including aliases, without reading package files", () => {
		const graph = workspacePackages(lock);
		expect(graph.find((pkg) => pkg.folder === "spikes/s05")?.dependencies).toEqual([
			"spikes/kit",
			"spikes/s02",
		]);
		expect(consumingSpikes(["spikes/kit"], graph)).toEqual([
			"spikes/kit",
			"spikes/s05",
			"spikes/s07-siwc",
		]);
		expect(workspacePackages(lock.replaceAll("\n", "\r\n"))).toEqual(graph);
	});

	it.each([
		["an escaping link", "link:../kit", "link:../../../../outside"],
		["an absolute link", "link:../kit", "link:/spikes/kit"],
		["an unknown link", "link:../kit", "link:../gone"],
		["an unresolved workspace edge", "version: link:../kit", "version: 1.0.0"],
		["an alias", "spikes/kit: {}", "spikes/kit: *hidden"],
		["a duplicate importer", "spikes/kit: {}", "spikes/kit: {}\n  spikes/kit: {}"],
		["a prototype key", "spikes/kit: {}", "__proto__: {}"],
	])("refuses %s", (_, before, after) => {
		expect(() => workspacePackages(lock.replace(before, after))).toThrow();
	});
});

describe("changed areas", () => {
	it("selects synthetic shared-root consumers before Rust derivation", () => {
		expect(fixtureClassify(["pnpm-lock.yaml"]).spikes).toEqual([
			"spikes/clock",
			"spikes/s01",
			"spikes/s05",
		]);
	});
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
		[
			[".github/workflows/ci.yml"],
			[
				"workflows",
				"rust:spikes/clock/jiff",
				"rust:spikes/s05/rust",
				"spikes/clock",
				"spikes/s01",
				"spikes/s05",
			],
		],
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
		[
			["spikes/run.json", "spikes/gone/src/x.ts"],
			[
				"ts",
				"rust:spikes/clock/jiff",
				"rust:spikes/s05/rust",
				"spikes/clock",
				"spikes/s01",
				"spikes/s05",
			],
		],
		[[], []],
	])("%j → %j", (files, expected) => {
		expect(areaNames(fixtureClassify(files))).toEqual(expected);
	});

	it("names Rust workspaces that no spike package tests", () => {
		mkdirSync(path.join(root, "tools", "x"), { recursive: true });
		writeFileSync(path.join(root, "tools", "x", "Cargo.toml"), "[workspace]\n");
		const files = ["tools/x/src/lib.rs", "spikes/s05/rust/ekm/src/lib.rs"];
		expect(untestedRust(fixtureClassify(files))).toEqual(["tools/x"]);
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
