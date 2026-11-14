import { spawnSync } from "node:child_process";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Tier, tierFiles, vitestConfig } from "../../vitest.shared.ts";

const config = (mode: string) => vitestConfig({ command: "serve", mode });

describe("test tiers", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("runs only unit tests by default and never loads .env files", () => {
		vi.stubEnv("CI", "");
		const { envDir, test } = config("test");
		expect(envDir).toBe(false);
		expect(test).toMatchObject({
			include: [tierFiles.unit],
			passWithNoTests: false,
			testTimeout: 30_000,
			hookTimeout: 30_000,
		});
		expect(test?.exclude).toEqual(
			expect.arrayContaining([tierFiles.heavy, tierFiles.live, tierFiles.device]),
		);
	});

	it("keeps Vitest's module cache inside the package, never at the workspace root", () => {
		expect(config("test").test?.fsModuleCachePath).toBe(
			path.join(process.cwd(), "node_modules", ".vitest-cache"),
		);
	});

	it.each<Tier>(["heavy", "live", "device"])(
		"--mode %s runs only that tier, passing with none",
		(tier) => {
			const { test } = config(tier);
			expect(test).toMatchObject({
				include: [tierFiles[tier]],
				passWithNoTests: true,
				testTimeout: 30_000,
			});
			expect(test?.exclude).not.toContain(tierFiles[tier]);
		},
	);

	it("refuses an unknown mode", () => {
		expect(() => config("production")).toThrow('unknown test tier "production"');
	});
});

interface VitestMetadata {
	readonly name: string;
	readonly bin: { readonly vitest: string };
	readonly exports: {
		readonly ".": { readonly import: string | { readonly default: string } };
	};
}

function ownVitest(): { readonly cli: string; readonly entryUrl: string } {
	const manifest = createRequire(import.meta.url).resolve("vitest/package.json");
	const installed: VitestMetadata = JSON.parse(readFileSync(manifest, "utf8"));
	expect(installed.name).toBe("vitest");
	const root = path.dirname(realpathSync(manifest));
	const entry = installed.exports["."].import;
	const publicEntry = typeof entry === "string" ? entry : entry.default;
	return {
		cli: realpathSync(path.resolve(root, installed.bin.vitest)),
		entryUrl: pathToFileURL(realpathSync(path.resolve(root, publicEntry))).href,
	};
}

const discoveryModes = ["test", "heavy", "live", "device"] as const;

describe("test tier file discovery", () => {
	it.each(discoveryModes)("executes only the synthetic %s TS and TSX fixtures", (mode) => {
		const project = realpathSync(mkdtempSync(path.join(os.tmpdir(), "draftyak-tier-discovery-")));
		try {
			// A temporary project must be outside every worktree, including a redirected temp root.
			const location = spawnSync(
				"git",
				[
					"--no-optional-locks",
					"-c",
					"gc.auto=0",
					"-c",
					"maintenance.auto=false",
					"-C",
					project,
					"rev-parse",
					"--is-inside-work-tree",
				],
				{ encoding: "utf8", windowsHide: true, timeout: 20_000 },
			);
			expect(location.error).toBeUndefined();
			expect(location.signal).toBeNull();
			expect(location.status).toBe(128);

			const { cli, entryUrl } = ownVitest();
			const shared = path.resolve(import.meta.dirname, "../../vitest.shared.ts");
			const fixtureConfig = path.join(project, "vitest.config.mts");
			writeFileSync(
				fixtureConfig,
				"export { vitestConfig as default } from " +
					JSON.stringify(pathToFileURL(shared).href) +
					";\n",
			);
			const markers = path.join(project, "markers");
			mkdirSync(markers);
			for (const fixtureMode of discoveryModes) {
				for (const extension of ["ts", "tsx"]) {
					const name = fixtureMode + "." + extension;
					const filename =
						fixtureMode === "test"
							? "ordinary.test." + extension
							: "selected." + fixtureMode + ".test." + extension;
					const source = [
						"import { expect, it } from " + JSON.stringify(entryUrl) + ";",
						'import { writeFileSync } from "node:fs";',
						"it(" + JSON.stringify("DYTEST " + name) + ", () => {",
						"  expect(process.env.DYTEST_SELECTED_MODE).toBe(" + JSON.stringify(fixtureMode) + ");",
						"  writeFileSync(" +
							JSON.stringify(path.join(markers, name)) +
							', "DYTEST", { flag: "wx" });',
						"});",
						"",
					].join("\n");
					writeFileSync(path.join(project, filename), source);
				}
			}
			const result = spawnSync(
				process.execPath,
				[
					cli,
					"run",
					"--config",
					fixtureConfig,
					"--mode",
					mode,
					"--reporter=default",
					"--exclude",
					"**/*siwc*/**",
					"--exclude",
					"**/*siwc*",
					"--exclude",
					"**/*dynamic-agent*",
					"--exclude",
					"**/*dynamic_agent*",
				],
				{
					cwd: project,
					env: { ...process.env, DYTEST_SELECTED_MODE: mode },
					encoding: "utf8",
					windowsHide: true,
					timeout: 20_000,
					maxBuffer: 1024 * 1024,
				},
			);
			expect(result.error).toBeUndefined();
			expect(result.signal).toBeNull();
			expect(result.status, result.stdout + result.stderr).toBe(0);
			expect(readdirSync(markers).sort()).toEqual([mode + ".ts", mode + ".tsx"]);
			for (const name of readdirSync(markers)) {
				expect(readFileSync(path.join(markers, name), "utf8")).toBe("DYTEST");
			}
		} finally {
			expect(lstatSync(project).isSymbolicLink()).toBe(false);
			expect(realpathSync(project)).toBe(project);
			rmSync(project, { recursive: true, force: true });
			expect(existsSync(project)).toBe(false);
		}
	});
});
