import { spawnSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { tempRepo } from "../test/temp-repo.ts";
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

	it("names Rust that no Cargo.toml builds: stray sources and locks, and renamed manifests", () => {
		const files: Record<string, string> = {
			"tools/y/oracle.toml": "[workspace]\nmembers = ['.']\n",
			"tools/y/src/main.rs": "fn main() {}\n",
			"tools/y/Cargo.lock": "version = 4\n",
			"spikes/s05/rust/ekm/extra.toml": "[package]  # built by hand\nname = 'extra'\n",
			"tools/y/pyproject.toml": "[project]\nname = 'y'\n[tool.uv.workspace]\nmembers = []\n",
			"tools/y/poetry.toml": "[[package]]\nname = 'z'\n",
		};
		for (const [file, content] of Object.entries(files)) {
			mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
			writeFileSync(path.join(root, file), content);
		}
		const changed = [
			...Object.keys(files),
			"spikes/s05/rust/ekm/src/lib.rs",
			"tools/gone/src/lib.rs",
		];
		expect(fixtureClassify(changed).strayRust).toEqual([
			"spikes/s05/rust/ekm/extra.toml",
			"tools/y/Cargo.lock",
			"tools/y/oracle.toml",
			"tools/y/src/main.rs",
		]);
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

// M1's layout: a Cargo workspace at crates/, product packages, and the tools CI may select.
const heavy = (name: string): string =>
	JSON.stringify({ name, scripts: { "test:heavy": "vitest run --mode heavy" } });
const m1Tree: Record<string, string> = {
	"crates/Cargo.toml": "[workspace]\nmembers = ['draftyak-protocol']\n",
	"crates/draftyak-protocol/Cargo.toml": "[package]\nname = 'draftyak-protocol'\n",
	"crates/draftyak-protocol/src/lib.rs": "",
	"packages/protocol/package.json": heavy("@draftyak/protocol"),
	"packages/sdk/package.json": heavy("@draftyak/sdk"),
	"packages/fakes/package.json": JSON.stringify({ name: "@draftyak/fakes" }),
	"packages/create-plugin/package.json": heavy("create-draftyak-plugin"),
	"plugins/channel-hello/package.json": heavy("@draftyak/channel-hello"),
	"spikes/s05/package.json": "{}",
	"spikes/s05/rust/Cargo.toml": "[workspace]\n",
	"tools/verify/package.json": heavy("@draftyak/verify"),
	"tools/fetch-node/package.json": heavy("@draftyak/fetch-node"),
};
m1Tree["pnpm-lock.yaml"] = `lockfileVersion: '9.0'\nimporters:\n${Object.keys(m1Tree)
	.filter((file) => file.endsWith("/package.json"))
	.map((file) => `  ${path.posix.dirname(file)}: {}\n`)
	.join("")}`;
const m1Root = mkdtempSync(path.join(tmpdir(), "draftyak-changes-m1-"));
afterAll(() => rmSync(m1Root, { recursive: true, force: true }));
for (const [file, content] of Object.entries(m1Tree)) {
	mkdirSync(path.dirname(path.join(m1Root, file)), { recursive: true });
	writeFileSync(path.join(m1Root, file), content);
}
const m1Manifests = Object.keys(m1Tree).filter((file) => file.endsWith("Cargo.toml"));
const everyHeavy = [
	"./packages/create-plugin",
	"./packages/protocol",
	"./packages/sdk",
	"./plugins/channel-hello",
	"./tools/verify",
];

describe("heavy selection for full", () => {
	const select = (files: string[]) => classify(files, m1Root, () => m1Manifests);

	it.each([
		[["crates/draftyak-protocol/src/lib.rs"], ["rust:crates", "heavy:./packages/protocol"]],
		[["spec/vectors/jcs/a.json"], ["ts", "rust:crates", "heavy:./packages/protocol"]],
		[["packages/protocol/src/x.ts"], ["ts", "rust:crates", "heavy:...{./packages/protocol}"]],
		[["packages/sdk/src/x.ts"], ["ts", "heavy:...{./packages/sdk}", "template-smoke"]],
		[["tools/fetch-node/src/fetch.ts"], ["ts"]],
		[["spec/flags-v1.md", "packages/protocol/README.md"], ["docs-only"]],
	])("%j → %j", (files, expected) => {
		expect(areaNames(select(files))).toEqual(expected);
	});

	it.each([
		[".node-version", ["crates", "spikes/s05/rust"]],
		["vitest.shared.ts", ["crates", "spikes/s05/rust"]],
		["pnpm-lock.yaml", ["crates", "spikes/s05/rust"]],
		["tools/fetch-node/versions.json", ["crates"]],
		["pnpm-workspace.yaml", ["crates", "spikes/s05/rust"]],
		["package.json", ["crates", "spikes/s05/rust"]],
		["turbo.json", ["crates", "spikes/s05/rust"]],
		["tsconfig.base.json", ["crates", "spikes/s05/rust"]],
	])("a change to %s selects every heavy package and the template smoke", (file, rust) => {
		expect(select([file])).toMatchObject({
			rust,
			heavy: everyHeavy,
			templateSmoke: true,
		});
	});

	it("treats pnpm-lock.yaml as global only when no package.json changed", () => {
		expect(select(["pnpm-lock.yaml", "packages/fakes/package.json"])).toMatchObject({
			rust: ["spikes/s05/rust"],
			spikes: ["spikes/s05"],
			heavy: ["...{./packages/fakes}"],
			templateSmoke: false,
		});
	});

	it("runs every Cargo workspace and protocol's cross tests on a toolchain change", () => {
		expect(select(["rust-toolchain.toml"])).toMatchObject({
			rust: ["crates", "spikes/s05/rust"],
			spikes: ["spikes/s05"],
			heavy: ["./packages/protocol"],
			templateSmoke: false,
		});
	});

	it("sets the template smoke for the create-plugin, plugin-testkit and sdk folders", () => {
		const smoke = (file: string) => select([file]).templateSmoke;
		expect(
			["packages/create-plugin/src/cli.ts", "packages/plugin-testkit/src/x.ts"].map(smoke),
		).toEqual([true, true]);
		expect(["packages/fakes/src/x.ts", "plugins/channel-hello/src/x.ts"].map(smoke)).toEqual([
			false,
			false,
		]);
	});

	it("selects only packages that exist, and never a tools/ folder but tools/verify", () => {
		expect(select(["packages/gone/src/x.ts", "tools/fetch-node/package.json"]).heavy).toEqual([]);
	});

	it("maps every change under crates/ to the one crates workspace, whatever its manifests say", () => {
		const other = mkdtempSync(path.join(tmpdir(), "draftyak-changes-crates-"));
		try {
			const files: Record<string, string> = {
				"crates/Cargo.toml": "[package]\nname = 'one'\n",
				"crates/b/Cargo.toml": "[package]\nname = 'b'\n",
				"packages/protocol/package.json": heavy("@draftyak/protocol"),
			};
			for (const [file, content] of Object.entries(files)) {
				mkdirSync(path.dirname(path.join(other, file)), { recursive: true });
				writeFileSync(path.join(other, file), content);
			}
			const cargo = ["crates/Cargo.toml", "crates/b/Cargo.toml"];
			const areas = classify(
				["crates/b/src/lib.rs"],
				other,
				() => cargo,
				() => [],
			);
			expect(areaNames(areas)).toEqual(["rust:crates", "heavy:./packages/protocol"]);
			expect(untestedRust(areas)).toEqual([]);
			// Without a Cargo.toml under crates/, there's nothing for the rust profile to check.
			expect(areaNames(fixtureClassify(["crates/notes.txt"]))).toEqual(["ts"]);
		} finally {
			rmSync(other, { recursive: true, force: true });
		}
	});

	it("tests crates/ itself, but still names a Rust workspace outside spikes/ and crates/", () => {
		mkdirSync(path.join(m1Root, "tools", "x"), { recursive: true });
		writeFileSync(path.join(m1Root, "tools", "x", "Cargo.toml"), "[workspace]\n");
		const areas = select(["tools/x/src/lib.rs", "crates/draftyak-protocol/src/lib.rs"]);
		expect(areas.rust).toEqual(["crates", "tools/x"]);
		expect(untestedRust(areas)).toEqual(["tools/x"]);
	});

	it("exits 0 with crates/ selected, and 1 for a Cargo workspace at tools/x/ or a renamed manifest", () => {
		const repo = tempRepo();
		try {
			for (const [file, content] of Object.entries(m1Tree)) repo.write(file, content);
			const base = repo.commit("chore: base");
			repo.write("crates/draftyak-protocol/src/lib.rs", "pub fn x() {}\n");
			const crates = repo.commit("feat: change the crate");
			repo.write("tools/x/Cargo.toml", "[workspace]\n");
			repo.write("tools/x/src/lib.rs", "");
			const tools = repo.commit("feat: add a workspace under tools/");
			repo.write("tools/y/oracle.toml", "[workspace]\n");
			repo.write("tools/y/src/main.rs", "fn main() {}\n");
			const renamed = repo.commit("feat: add a workspace whose manifest isn't Cargo.toml");
			const output = path.join(repo.dir, "..", "github-output");
			const config = path.join(repo.dir, "..", "child-gitconfig");
			writeFileSync(config, "[maintenance]\n\tauto = false\n");
			const run = (from: string, to: string) => {
				writeFileSync(output, "");
				const env = {
					BASE_SHA: from,
					HEAD_SHA: to,
					GITHUB_OUTPUT: output,
					GITHUB_STEP_SUMMARY: "",
					GIT_CONFIG_GLOBAL: config,
					GIT_CONFIG_NOSYSTEM: "1",
				};
				const script = path.join(import.meta.dirname, "changes.ts");
				const result = spawnSync(process.execPath, [script], {
					cwd: repo.dir,
					encoding: "utf8",
					env: { ...process.env, ...env },
				});
				return {
					code: result.status,
					stdout: result.stdout,
					outputs: readFileSync(output, "utf8"),
				};
			};
			const first = run(base, crates);
			expect(first.code, first.stdout).toBe(0);
			expect(first.outputs).toContain('areas=["rust:crates","heavy:./packages/protocol"]\n');
			expect(first.outputs).toMatch(/^rust=crates\n(?:.*\n)*heavy=\.\/packages\/protocol\n/m);
			expect(first.outputs).toContain("template-smoke=false\n");
			const second = run(crates, tools);
			expect(second.code).toBe(1);
			expect(second.stdout).toContain("no spike package's test:heavy or crates/ runs tools/x");
			expect(second.outputs).toBe("");
			const third = run(tools, renamed);
			expect(third.code).toBe(1);
			expect(third.stdout).toContain(
				"no Cargo.toml builds tools/y/oracle.toml, tools/y/src/main.rs, so nothing tests it",
			);
			expect(third.outputs).toBe("");
		} finally {
			repo.remove();
		}
	});
});

describe("explicit external crates workspace members", () => {
	const member = "apps/app/src-tauri";
	const packageSource = "[package]\nname = 'external-app'\nworkspace = '../../../crates'\n";
	const workspaceSource = "[workspace]\nmembers = ['native-core', '../apps/app/src-tauri']\n";
	const files: Record<string, string> = {
		"crates/Cargo.toml": workspaceSource,
		"crates/native-core/Cargo.toml": "[package]\nname = 'native-core'\n",
		"crates/native-core/src/lib.rs": "",
		[`${member}/Cargo.toml`]: packageSource,
		[`${member}/src/lib.rs`]: "",
		[`${member}/build.rs`]: "fn main() {}\n",
		[`${member}/tauri.conf.json`]: "{}",
	};
	const fixture = <T>(
		tree: Record<string, string>,
		check: (dir: string, select: (changed: string[]) => ReturnType<typeof classify>) => T,
	): T => {
		const dir = mkdtempSync(path.join(tmpdir(), "draftyak-external-workspace-"));
		try {
			for (const [file, content] of Object.entries(tree)) {
				mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
				writeFileSync(path.join(dir, file), content);
			}
			return check(dir, (changed) =>
				classify(
					changed,
					dir,
					() => Object.keys(tree).filter((file) => path.posix.basename(file) === "Cargo.toml"),
					() =>
						Object.keys(tree)
							.filter((file) => file.endsWith("/package.json"))
							.map((file) => ({ folder: path.posix.dirname(file), dependencies: [] })),
				),
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	};

	it.each(["src/lib.rs", "build.rs", "Cargo.toml", "tauri.conf.json"])(
		"selects the real crates build for the explicitly declared external %s",
		(file) =>
			fixture(files, (dir, select) => {
				expect(rustWorkspace(dir, `${member}/${file}`)).toBe("crates");
				const selected = select([`${member}/${file}`]);
				expect(selected.rust).toEqual(["crates"]);
				expect(untestedRust(selected)).toEqual([]);
				expect(selected.strayRust).toEqual([]);
			}),
	);

	it.each([
		["declared", workspaceSource, 0],
		["undeclared", "[workspace]\nmembers = ['native-core']\n", 1],
	] as const)(
		"the actual CLI requires reciprocal membership for a %s external member",
		(_, workspace, code) => {
			const repo = tempRepo();
			try {
				for (const [file, content] of Object.entries(files)) repo.write(file, content);
				repo.write("crates/Cargo.toml", workspace);
				repo.write("pnpm-lock.yaml", "lockfileVersion: '9.0'\nimporters:\n  .: {}\n");
				const base = repo.commit("chore: external member fixture");
				repo.write(`${member}/src/lib.rs`, "pub fn changed() {}\n");
				const head = repo.commit("feat: change external member");
				const output = path.join(repo.dir, "..", "github-output");
				const summary = path.join(repo.dir, "..", "github-summary");
				const config = path.join(repo.dir, "..", "child-gitconfig");
				writeFileSync(output, "");
				writeFileSync(summary, "");
				writeFileSync(config, "[maintenance]\n\tauto = false\n");
				const result = spawnSync(process.execPath, [path.join(import.meta.dirname, "changes.ts")], {
					cwd: repo.dir,
					encoding: "utf8",
					windowsHide: true,
					timeout: 10_000,
					maxBuffer: 1024 * 1024,
					env: {
						...process.env,
						BASE_SHA: base,
						HEAD_SHA: head,
						GITHUB_OUTPUT: output,
						GITHUB_STEP_SUMMARY: summary,
						GIT_CONFIG_GLOBAL: config,
						GIT_CONFIG_NOSYSTEM: "1",
					},
				});
				expect(result.error).toBeUndefined();
				expect(result.signal).toBeNull();
				expect(result.status, result.stderr).toBe(code);
				const outputs = readFileSync(output, "utf8");
				const reported = readFileSync(summary, "utf8");
				if (code === 0) {
					expect(outputs).toContain('areas=["rust:crates"]\n');
					expect(outputs).toMatch(/^rust=crates\n/m);
					expect(outputs).toContain("template-smoke=false\n");
					expect(reported).toContain("- rust:crates");
				} else {
					expect(result.stdout).toContain(
						`no spike package's test:heavy or crates/ runs ${member}`,
					);
					expect(outputs).toBe("");
					expect(reported).toBe("");
				}
			} finally {
				repo.remove();
			}
		},
	);

	it("normalizes reciprocal paths and accepts comments, quoted keys and multiline literal members", () => {
		fixture(
			{
				...files,
				[`${member}/Cargo.toml`]:
					'[package]\nname = "external-app"\n"workspace" = "../../.././crates/" # owner\n',
				"crates/Cargo.toml":
					'[workspace]\n"members" = [\n  "native-core",\n  "../apps/./app/src-tauri/", # external member\n]\nexclude = ["../apps/unrelated"]\n',
			},
			(dir, select) => {
				expect(rustWorkspace(dir, `${member}/src/lib.rs`)).toBe("crates");
				expect(untestedRust(select([`${member}/src/lib.rs`]))).toEqual([]);
			},
		);
	});

	it.each([
		["undeclared member", packageSource, "[workspace]\nmembers = ['native-core']\n"],
		["missing members", packageSource, "[workspace]\n"],
		["non-workspace target", packageSource, "[package]\nname = 'not-a-workspace'\n"],
		["excluded member", packageSource, `${workspaceSource}exclude = ['../apps/app/src-tauri']\n`],
		["excluded parent", packageSource, `${workspaceSource}exclude = ['../apps']\n`],
		["ambiguous members", packageSource, `${workspaceSource}members = ['../apps/app/src-tauri']\n`],
		[
			"duplicate member aliases",
			packageSource,
			"[workspace]\nmembers = ['../apps/app/src-tauri', '../apps/./app/src-tauri']\n",
		],
		[
			"case aliases",
			packageSource,
			"[workspace]\nmembers = ['../apps/app/src-tauri', '../Apps/App/src-tauri']\n",
		],
		["duplicate workspace table", packageSource, `${workspaceSource}${workspaceSource}`],
		["ambiguous pointer", `${packageSource}workspace = '../../../crates'\n`, workspaceSource],
		[
			"escaping pointer",
			packageSource.replace("../../../crates", "../../../../outside"),
			workspaceSource,
		],
		["absolute pointer", packageSource.replace("../../../crates", "/crates"), workspaceSource],
		["Windows pointer", packageSource.replace("../../../crates", "C:/crates"), workspaceSource],
		[
			"cyclic root pointer",
			packageSource,
			`${workspaceSource}[package]\nname = 'root'\nworkspace = '../apps/app/src-tauri'\n`,
		],
		[
			"metadata lookalike",
			"[package]\nname = 'external-app'\n[package.metadata]\nworkspace = '../../../crates'\n",
			workspaceSource,
		],
		["unsupported wildcard", packageSource, "[workspace]\nmembers = ['../apps/*/src-tauri']\n"],
	])("keeps %s untested instead of claiming crates coverage", (_, source, workspace) => {
		fixture(
			{ ...files, [`${member}/Cargo.toml`]: source, "crates/Cargo.toml": workspace },
			(dir, select) => {
				expect(rustWorkspace(dir, `${member}/src/lib.rs`)).toBe(member);
				const selected = select([`${member}/src/lib.rs`]);
				expect(selected.rust).toEqual([member]);
				expect(untestedRust(selected)).toEqual([member]);
			},
		);
	});

	it("does not follow a nested crates workspace or inherit the outer member's pointer", () => {
		fixture(
			{
				...files,
				[`${member}/Cargo.toml`]: packageSource.replace(
					"../../../crates",
					"../../../crates/nested",
				),
				"crates/nested/Cargo.toml": "[workspace]\nmembers = ['../../apps/app/src-tauri']\n",
			},
			(_, select) => {
				expect(untestedRust(select([`${member}/src/lib.rs`]))).toEqual([member]);
			},
		);
		fixture(
			{
				...files,
				[`${member}/nested/Cargo.toml`]: "[package]\nname = 'nested'\n",
				[`${member}/nested/src/lib.rs`]: "",
			},
			(_, select) => {
				expect(untestedRust(select([`${member}/nested/src/lib.rs`]))).toEqual([`${member}/nested`]);
			},
		);
	});

	it("keeps an ancestor workspace authoritative rather than resolving a second claim", () => {
		fixture(
			{ ...files, "apps/Cargo.toml": "[workspace]\nmembers = ['app/src-tauri']\n" },
			(dir, select) => {
				expect(rustWorkspace(dir, `${member}/src/lib.rs`)).toBe("apps");
				expect(untestedRust(select([`${member}/src/lib.rs`]))).toEqual(["apps"]);
			},
		);
	});

	it("refuses a physically escaping crates manifest before accepting the association", () => {
		const outside = mkdtempSync(path.join(tmpdir(), "draftyak-external-cargo-target-"));
		try {
			writeFileSync(path.join(outside, "Cargo.toml"), workspaceSource);
			const withoutCrates = Object.fromEntries(
				Object.entries(files).filter(([file]) => !file.startsWith("crates/")),
			);
			fixture(withoutCrates, (dir, select) => {
				symlinkSync(
					outside,
					path.join(dir, "crates"),
					process.platform === "win32" ? "junction" : "dir",
				);
				expect(rustWorkspace(dir, `${member}/src/lib.rs`)).toBe(member);
				expect(untestedRust(select([`${member}/src/lib.rs`]))).toEqual([member]);
			});
		} finally {
			rmSync(outside, { recursive: true, force: true });
		}
	});

	it("refuses an aliased crates manifest even when its physical target stays inside the repository", () => {
		const withoutCrates = Object.fromEntries(
			Object.entries(files).filter(([file]) => !file.startsWith("crates/")),
		);
		fixture(
			{
				...withoutCrates,
				"native-cargo-target/Cargo.toml": workspaceSource,
				"native-cargo-target/native-core/Cargo.toml": "[package]\nname = 'native-core'\n",
				"native-cargo-target/native-core/src/lib.rs": "",
			},
			(dir, select) => {
				symlinkSync(
					path.join(dir, "native-cargo-target"),
					path.join(dir, "crates"),
					process.platform === "win32" ? "junction" : "dir",
				);
				expect(
					path.relative(realpathSync(dir), realpathSync(path.join(dir, "crates", "Cargo.toml"))),
				).toBe(path.join("native-cargo-target", "Cargo.toml"));
				expect(rustWorkspace(dir, `${member}/src/lib.rs`)).toBe(member);
				expect(untestedRust(select([`${member}/src/lib.rs`]))).toEqual([member]);
			},
		);
	});

	it("retains ignored external locks, renamed manifests and stray source refusals", () => {
		fixture(
			{
				...files,
				[`${member}/Cargo.lock`]: "version = 4\n",
				[`${member}/extra.toml`]: "[package]\nname = 'not-built'\n",
				"tools/stray/src/lib.rs": "",
			},
			(_, select) => {
				expect(untestedRust(select([`${member}/Cargo.lock`]))).toEqual([member]);
				expect(select([`${member}/extra.toml`]).strayRust).toEqual([`${member}/extra.toml`]);
				expect(select(["tools/stray/src/lib.rs"]).strayRust).toEqual(["tools/stray/src/lib.rs"]);
			},
		);
	});

	it("preserves ordinary spike ancestry and coarse crates classification", () => {
		fixture(
			{
				...files,
				"spikes/synthetic/package.json": "{}",
				"spikes/synthetic/rust/Cargo.toml": "[workspace]\nmembers = ['member']\n",
				"spikes/synthetic/rust/member/Cargo.toml": "[package]\nname = 'spike-member'\n",
				"spikes/synthetic/rust/member/src/lib.rs": "",
			},
			(dir, select) => {
				expect(rustWorkspace(dir, "spikes/synthetic/rust/member/src/lib.rs")).toBe(
					"spikes/synthetic/rust",
				);
				expect(untestedRust(select(["spikes/synthetic/rust/member/src/lib.rs"]))).toEqual([]);
				expect(select(["crates/native-core/src/lib.rs"]).rust).toEqual(["crates"]);
			},
		);
	});
});
