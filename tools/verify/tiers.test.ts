import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { capabilities as kitCapabilities } from "../../spikes/kit/vitest.ts";
import {
	heavyCapabilities,
	heavyVitestConfig,
	type Tier,
	tierFiles,
	vitestConfig,
} from "../../vitest.shared.ts";
import { capture } from "./lib/spawn.ts";

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

describe("heavyVitestConfig", () => {
	const extra = {
		nowhere: { description: "never", detect: () => false },
		here: { description: "always", detect: () => true },
	};
	const heavyConfig = (mode: string, strict = "") => {
		vi.stubEnv("CI", "");
		vi.stubEnv("DRAFTYAK_STRICT_SKIPS", strict);
		try {
			return heavyVitestConfig({ command: "serve", mode }, extra);
		} finally {
			vi.unstubAllEnvs();
		}
	};

	it("keeps the tiers and adds a requires: tag per capability, skipping only missing ones", () => {
		const heavy = heavyConfig("heavy").test;
		expect(heavy?.include).toEqual([tierFiles.heavy]);
		expect(heavy?.tags?.map((tag) => tag.name)).toEqual([
			"requires:cargo",
			"requires:symlink-privilege",
			"requires:windows",
			"requires:linux",
			"requires:macos",
			"requires:posix",
			"requires:nowhere",
			"requires:here",
		]);
		const skipped = (name: string) =>
			heavy?.tags?.find((tag) => tag.name === `requires:${name}`)?.skip;
		const hosts: Record<string, string> = { win32: "windows", linux: "linux", darwin: "macos" };
		const host = hosts[process.platform];
		expect([skipped("nowhere"), skipped("here"), host && skipped(host)]).toEqual([
			true,
			undefined,
			undefined,
		]);
		const timeouts = ["test", "heavy", "live", "device"].map(
			(mode) => heavyConfig(mode).test?.testTimeout,
		);
		expect(timeouts).toEqual([30_000, 300_000, 600_000, 600_000]);
	});

	it("detects and describes the tags it shares with the spike kit as the kit does", () => {
		const shared = Object.keys(heavyCapabilities).filter((name) => name in kitCapabilities);
		expect(shared).toEqual(["symlink-privilege", "windows", "linux", "macos", "posix"]);
		for (const name of shared) {
			const [ours, kit] = [heavyCapabilities[name], kitCapabilities[name]];
			expect([ours?.description, ours?.detect()], name).toEqual([kit?.description, kit?.detect()]);
		}
	});

	it("adds the strict-skips plugin to heavy runs only, and refuses other strict values", () => {
		expect(heavyConfig("heavy", "1").plugins).toMatchObject([{ name: "draftyak:strict-skips" }]);
		expect([heavyConfig("heavy").plugins, heavyConfig("heavy", "0").plugins]).toEqual([[], []]);
		expect(heavyConfig("test", "1").plugins).toEqual([]);
		expect(() => heavyConfig("heavy", "true")).toThrow('not "true"');
	});
});

describe("heavyVitestConfig in a Vitest run, with cargo hidden from PATH", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "draftyak-tiers-"));
	afterAll(() => rmSync(dir, { recursive: true, force: true }));
	const shared = pathToFileURL(path.resolve(import.meta.dirname, "..", "..", "vitest.shared.ts"));
	const write = (file: string, text: string) => writeFileSync(path.join(dir, file), text);
	write(
		"vitest.config.mjs",
		`import { heavyVitestConfig } from ${JSON.stringify(shared.href)};
export default (env) => {
	const config = heavyVitestConfig(env);
	return { ...config, test: { ...config.test, globals: true } };
};
`,
	);
	write(
		"cargo.heavy.test.ts",
		`it("needs cargo", { tags: ["requires:cargo"] }, () => {
	throw new Error("ran without cargo");
});
it("runs anywhere", () => {});
`,
	);
	write("skip.heavy.test.ts", `it.skip("skipped by hand", () => {});\nit("runs", () => {});\n`);

	const manifest = createRequire(import.meta.url).resolve("vitest/package.json");
	const { bin } = JSON.parse(readFileSync(manifest, "utf8")) as { bin: { vitest: string } };
	const vitest = path.join(path.dirname(manifest), bin.vitest);
	const cargo = process.platform === "win32" ? "cargo.exe" : "cargo";
	const withoutCargo = (process.env.PATH ?? "")
		.split(path.delimiter)
		.filter((entry) => entry !== "" && !existsSync(path.join(entry, cargo)))
		.join(path.delimiter);
	// A clean child: no outer Vitest state, colours or CI behaviour.
	const inherited =
		/^(?:VITEST|TEST$|NODE_ENV$|DRAFTYAK_STRICT|FORCE_COLOR$|GITHUB_ACTIONS$|CI$|PATH$)/i;
	const env = Object.fromEntries(
		Object.entries(process.env).filter(([name]) => !inherited.test(name)),
	);
	const run = (filters: string[], strict = false) =>
		capture(
			{
				command: process.execPath,
				args: [vitest, "run", "--mode", "heavy", "--configLoader", "native", ...filters],
			},
			{
				cwd: dir,
				env: {
					...env,
					PATH: withoutCargo,
					NO_COLOR: "1",
					...(strict ? { DRAFTYAK_STRICT_SKIPS: "1" } : {}),
				},
			},
		);
	const strictMessage = "heavy test(s) skipped instead of running:";

	it("skips the requires:cargo test and passes", async () => {
		const result = await run(["cargo"]);
		expect(result.stdout).toContain("1 passed | 1 skipped (2)");
		expect(result.code).toBe(0);
	}, 120_000);

	it("fails an untagged it.skip under DRAFTYAK_STRICT_SKIPS=1, but not the routed cargo test", async () => {
		const result = await run([], true);
		const output = result.stdout + result.stderr;
		expect(output).toContain(`1 ${strictMessage}\n  skip.heavy.test.ts > skipped by hand\n`);
		expect(result.code).toBe(1);
		const routed = await run(["cargo"], true);
		expect(routed.stdout + routed.stderr).not.toContain(strictMessage);
		expect(routed.code).toBe(0);
	}, 120_000);
});
