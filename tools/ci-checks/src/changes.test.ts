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
	type SelectionOrigin,
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

describe("pilot S12 heavy selection", () => {
	const pilotRoot = path.join(root, "pilot-selection");
	const retainedRust = "spikes/s05-desktop/rust/Cargo.toml";
	mkdirSync(path.dirname(path.join(pilotRoot, retainedRust)), { recursive: true });
	writeFileSync(path.join(pilotRoot, retainedRust), "[workspace]\n");
	// Importer and changed-path metadata only: no postponed implementation is read or created.
	const graph: readonly WorkspacePackage[] = [
		{ folder: "spikes/kit", dependencies: [] },
		{ folder: "spikes/s02-plugin-sandbox", dependencies: ["spikes/kit"] },
		{ folder: "spikes/s05-desktop", dependencies: ["spikes/s02-plugin-sandbox"] },
		{ folder: "spikes/s11-python-runtime", dependencies: ["spikes/s02-plugin-sandbox"] },
		{ folder: "spikes/s12-sms", dependencies: ["spikes/kit"] },
		{ folder: "tools/bridge", dependencies: ["spikes/s12-sms"] },
		{ folder: "spikes/retained-downstream", dependencies: ["tools/bridge"] },
		{ folder: "spikes/s12-sms-neighbor", dependencies: ["spikes/kit"] },
		{ folder: "spikes/unrelated", dependencies: [] },
	];
	const retained = [
		"spikes/kit",
		"spikes/retained-downstream",
		"spikes/s02-plugin-sandbox",
		"spikes/s05-desktop",
		"spikes/s11-python-runtime",
		"spikes/s12-sms-neighbor",
		"spikes/unrelated",
	];
	const select = (files: readonly string[], origin: SelectionOrigin = "diff") =>
		classify(
			files,
			pilotRoot,
			() => [retainedRust],
			() => graph,
			origin,
		);

	it.each(["pnpm-lock.yaml", ".github/workflows/ci.yml", "vitest.shared.ts"])(
		"omits only S12 heavy for a shared %s change",
		(file) => {
			const selected = select([file]);
			expect(selected.spikes).toEqual(retained);
			expect(selected.rust).toEqual(["spikes/s05-desktop/rust"]);
			expect(selected.docsOnly).toBe(false);
			expect(selected.workflows).toBe(file === ".github/workflows/ci.yml");
			expect(areaNames(selected)).not.toContain("spikes/s12-sms");
		},
	);

	it("retains consumers reached through S12 without making S12 heavy eligible", () => {
		const selected = select(["spikes/kit/run.ts"]);
		expect(selected.spikes).toEqual(retained.filter((folder) => folder !== "spikes/unrelated"));
		expect(selected.rust).toEqual(["spikes/s05-desktop/rust"]);
		// The underlying dependency traversal remains generic and preserves the postponed node.
		expect(consumingSpikes(["spikes/kit"], graph)).toContain("spikes/s12-sms");
		expect(consumingSpikes(["spikes/kit"], graph)).toContain("spikes/retained-downstream");
	});

	it("retains conservative unknown-package fallback and malformed-metadata refusal", () => {
		expect(select(["spikes/deleted/src/synthetic.ts"]).spikes).toEqual(retained);
		expect(() =>
			classify(
				["pnpm-lock.yaml"],
				pilotRoot,
				() => [],
				() => [...graph, { folder: "spikes/kit", dependencies: [] }],
			),
		).toThrow("invalid or ambiguous workspace selection metadata");
	});

	it.each([
		"spikes/s12-sms/src/synthetic.ts",
		"spikes/s12-sms/test/synthetic.heavy.test.ts",
		"spikes/s12-sms/package.json",
		"spikes/s12-sms/vitest.config.ts",
	])("refuses a direct postponed implementation change %#", (file) => {
		expect(() => select([file])).toThrow(
			"postponed spike implementation requires a separate disposition: spikes/s12-sms",
		);
	});

	it.each(["spikes/s12-sms/README.md", "spikes/s12-sms/evidence/synthetic.json"])(
		"keeps documentation and evidence disposition unchanged %#",
		(file) => {
			const selected = select([file]);
			expect(selected.docsOnly).toBe(true);
			expect(areaNames(selected)).toEqual(["docs-only"]);
			expect(selected.spikes).toEqual([]);
		},
	);

	it("classifies preserved tracked implementation as metadata without granting a heavy pass", () => {
		const selected = select(
			["pnpm-lock.yaml", "spikes/s12-sms/src/synthetic.ts", retainedRust],
			"tracked-fallback",
		);
		expect(selected.spikes).toEqual(retained);
		expect(selected.rust).toEqual(["spikes/s05-desktop/rust"]);
		expect(selected.ts).toBe(true);
		expect(selected.docsOnly).toBe(false);
		expect(untestedRust(selected)).toEqual([]);
	});

	it("refuses an unknown classification origin at runtime", () => {
		expect(() => select(["pnpm-lock.yaml"], "unrecognized" as SelectionOrigin)).toThrow();
	});

	it.each(["no-base", "diff-failure"] as const)(
		"the actual CLI preserves postponed files during %s fallback",
		(mode) => {
			const cliRoot = path.join(pilotRoot, `cli-${mode}`);
			mkdirSync(cliRoot, { recursive: true });
			writeFileSync(
				path.join(cliRoot, "pnpm-lock.yaml"),
				"lockfileVersion: '9.0'\nimporters:\n  .: {}\n  spikes/kit: {}\n  spikes/retained: {}\n  spikes/s12-sms: {}\n",
			);
			const tracked = [
				"README.md",
				"pnpm-lock.yaml",
				"apps/hub/src/synthetic.ts",
				"spikes/s12-sms/src/preserved.ts",
			];
			const bootstrap = `
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
childProcess.spawnSync = (command, args) => {
	if (command !== "git") throw new Error("Unexpected external command");
	let stdout = "", stderr = "", status = 0;
	if (args[0] === "rev-parse") stdout = ${JSON.stringify(cliRoot)} + "\\n";
	else if (args[0] === "ls-files") stdout = ${JSON.stringify(tracked.join("\0"))};
	else if (args[0] === "diff") { status = 1; stderr = "Synthetic diff unavailable"; }
	else throw new Error("Unexpected git operation");
	return { stdout, stderr, status, signal: null };
};
syncBuiltinESMExports();
`;
			const output = path.join(cliRoot, "outputs");
			const summary = path.join(cliRoot, "summary");
			const result = spawnSync(
				process.execPath,
				[
					"--import",
					`data:text/javascript;base64,${Buffer.from(bootstrap).toString("base64")}`,
					path.join(import.meta.dirname, "changes.ts"),
				],
				{
					cwd: cliRoot,
					encoding: "utf8",
					windowsHide: true,
					timeout: 10_000,
					maxBuffer: 1024 * 1024,
					env: {
						...process.env,
						BASE_SHA: mode === "no-base" ? "" : "synthetic-base",
						HEAD_SHA: "HEAD",
						GITHUB_OUTPUT: output,
						GITHUB_STEP_SUMMARY: summary,
					},
				},
			);
			expect(result.error).toBeUndefined();
			expect(result.signal).toBeNull();
			expect(result.status, result.stderr).toBe(0);
			expect(result.stdout).toContain("so every retained area");
			const disposition =
				"spikes/s12-sms test:heavy is postponed and not run for the desktop pilot.";
			expect(result.stdout).toContain(disposition);
			const text = readFileSync(output, "utf8");
			expect(text).toContain("docs-only=false");
			expect(text).toContain("spikes/kit\nspikes/retained\n");
			expect(text).not.toContain("spikes/s12-sms");
			const reported = readFileSync(summary, "utf8");
			expect(reported).toContain(disposition);
			expect(reported).not.toContain("- spikes/s12-sms");
		},
	);
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
