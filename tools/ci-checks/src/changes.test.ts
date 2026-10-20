import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { tempRepo } from "../test/temp-repo.ts";
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
		expect(classify(changed, root, () => manifests).strayRust).toEqual([
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
		[".node-version"],
		["vitest.shared.ts"],
		["pnpm-lock.yaml"],
		["tools/fetch-node/versions.json"],
		["pnpm-workspace.yaml"],
		["package.json"],
		["turbo.json"],
		["tsconfig.base.json"],
	])("a change to %s selects every heavy package and the template smoke", (file) => {
		expect(select([file])).toMatchObject({
			rust: ["crates"],
			heavy: everyHeavy,
			templateSmoke: true,
		});
	});

	it("treats pnpm-lock.yaml as global only when no package.json changed", () => {
		expect(select(["pnpm-lock.yaml", "packages/fakes/package.json"])).toMatchObject({
			rust: [],
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
			const areas = classify(["crates/b/src/lib.rs"], other, () => cargo);
			expect(areaNames(areas)).toEqual(["rust:crates", "heavy:./packages/protocol"]);
			expect(untestedRust(areas)).toEqual([]);
			// Without a Cargo.toml under crates/, there's nothing for the rust profile to check.
			expect(areaNames(classify(["crates/notes.txt"], root, () => manifests))).toEqual(["ts"]);
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
