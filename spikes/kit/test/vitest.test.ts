import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { GATE_ROOT_ENV } from "../../../tools/verify/lib/bootstrap.ts";
import { PLUGIN_MISSING } from "../../../vitest.shared.ts";
import { exec } from "../exec.ts";
import { kitDir, repoRoot } from "../repo.ts";
import { strictSkips } from "../skip.ts";
import { capabilities, spikeVitestConfig } from "../vitest.ts";

const extra = {
	nowhere: { description: "never", detect: () => false },
	here: { description: "always", detect: () => true },
};

describe("spikeVitestConfig", () => {
	const config = (mode: string, env: NodeJS.ProcessEnv = {}) =>
		spikeVitestConfig({ command: "serve", mode }, { env, capabilities: extra });
	const plugins = (mode: string, env: NodeJS.ProcessEnv = {}) =>
		(config(mode, env).plugins ?? []).map((plugin) => (plugin as { name?: string }).name);

	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("keeps M0.1's tiers and adds a requires: tag per capability, skipping only missing ones", () => {
		vi.stubEnv("CI", "");
		const heavy = config("heavy").test;
		// The tier's glob arrives through draftyak:reserved-tests; the runs below use it.
		expect(heavy?.include).toEqual([PLUGIN_MISSING]);
		const names = [...Object.keys(capabilities), "nowhere", "here"].map(
			(name) => `requires:${name}`,
		);
		expect(heavy?.tags?.map((tag) => tag.name)).toEqual(names);
		expect(heavy?.tags?.find((tag) => tag.name === "requires:nowhere")?.skip).toBe(true);
		expect(heavy?.tags?.find((tag) => tag.name === "requires:here")).not.toHaveProperty("skip");
		expect([config("test").test?.testTimeout, heavy?.testTimeout]).toEqual([30_000, 300_000]);
		expect(() => config("production")).toThrow('unknown test tier "production"');
	});

	it("keeps the shared reserved-tests plugin and adds strict skips to heavy runs only", () => {
		const strict = { DRAFTYAK_STRICT_SKIPS: "1" };
		const shared = "draftyak:reserved-tests";
		expect(plugins("heavy", strict)).toEqual([shared, "draftyak:strict-skips"]);
		expect([plugins("heavy"), plugins("test", strict)]).toEqual([[shared], [shared]]);
		expect(() => config("heavy", { DRAFTYAK_STRICT_SKIPS: "true" })).toThrow('not "true"');
		expect([strictSkips({}), strictSkips({ DRAFTYAK_STRICT_SKIPS: "0" })]).toEqual([false, false]);
	});
});

describe("run.ts --heavy in a spike", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "draftyak-kit-run-"));
	afterAll(() => rmSync(dir, { recursive: true, force: true }));
	const kit = (file: string) => JSON.stringify(pathToFileURL(path.join(kitDir, file)).href);
	const write = (file: string, text: string) => writeFileSync(path.join(dir, file), text);
	write(
		"vitest.config.mjs",
		`import { spikeVitestConfig } from ${kit("vitest.ts")};
export default (env) => {
	const config = spikeVitestConfig(env, { capabilities: {
		nowhere: { description: "", detect: () => false },
		here: { description: "", detect: () => true },
	} });
	return { ...config, test: { ...config.test, globals: true } };
};
`,
	);
	write(
		"cases.heavy.test.ts",
		`import { needDocker } from ${kit("docker.ts")};
const ran = () => { throw new Error("ran without a capability"); };
it("routed away", { tags: ["requires:nowhere"] }, () => {});
it("missing first", { tags: ["requires:nowhere", "requires:here"] }, ran);
it("missing last", { tags: ["requires:here", "requires:nowhere"] }, ran);
describe("missing suite", { tags: ["requires:nowhere"] }, () => {
	it("present test", { tags: ["requires:here"] }, ran);
});
it("needs Docker", async (ctx) => {
	await needDocker(ctx, { probe: async () => ({ error: "no engine" }), desktop: null });
});
it.skip("skipped by hand", () => {});
it.todo("later");
it("runs", () => {});
`,
	);
	write(
		"skip-only.heavy.test.ts",
		`it.skip("skipped by hand", () => {});\nit("runs", () => {});\n`,
	);
	write("solo.heavy.test.ts", `it.only("chosen", () => {});\nit("left out", () => {});\n`);
	// A reserved heavy file: its name is built here, and the runs below select it as "zz-",
	// so no output names it unless it runs.
	write(
		`zz-${["si", "wc"].join("")}.heavy.test.ts`,
		`it("ran", () => { throw new Error("ran"); });\n`,
	);
	// A clean child: no outer Vitest state, colours (turbo forces them) or CI behaviour.
	const inherited =
		/^(?:VITEST|TEST$|NODE_ENV$|DRAFTYAK_(?:STRICT|RESERVED|TEST_COUNTS|TYPECHECK_MARKS)|FORCE_COLOR$|GITHUB_ACTIONS$|CI$)/i;
	// As under a gated launcher: the input gate has run on this checkout (routes.test.ts runs it).
	const env = {
		...Object.fromEntries(Object.entries(process.env).filter(([name]) => !inherited.test(name))),
		[GATE_ROOT_ENV]: realpathSync.native(repoRoot),
	};
	const run = (args: string[], extraEnv: NodeJS.ProcessEnv = {}) =>
		exec(process.execPath, [path.join(kitDir, "run.ts"), ...args, "--configLoader", "native"], {
			cwd: dir,
			env: { ...env, NO_COLOR: "1", ...extraEnv },
			timeoutMs: 120_000,
		});
	const strictMessage = "heavy test(s) skipped instead of running:";

	it("skips what can't run here, whatever the order of its tags, and passes", async () => {
		const result = await run(["--heavy", "cases"]);
		expect(result.stdout).toContain("1 passed | 6 skipped | 1 todo (8)");
		expect(result.code).toBe(0);
	}, 120_000);

	it("leaves a reserved test file out of the run unless DRAFTYAK_RESERVED_TESTS=1", async () => {
		const [off, optIn] = await Promise.all([
			run(["--heavy", "zz-"]),
			run(["--heavy", "zz-"], { DRAFTYAK_RESERVED_TESTS: "1" }),
		]);
		const output = (result: { stdout: string; stderr: string }) => result.stdout + result.stderr;
		expect([off.code, output(off).includes("No test files found")]).toEqual([0, true]);
		expect([optIn.code, output(optIn).includes("Tests  1 failed (1)")]).toEqual([1, true]);
	}, 120_000);

	it("under strict skips fails the Docker test by name, and every skip no tag routed", async () => {
		const result = await run(["--heavy", "--strict", "cases"], { GITHUB_ACTIONS: "true" });
		const output = result.stdout + result.stderr;
		expect(output).toMatch(/FAIL .*cases\.heavy\.test\.ts > needs Docker/);
		expect(output).toContain("cannot run: Docker unavailable");
		expect(output).toMatch(/1 heavy test\(s\) skipped instead of running:\n.* > skipped by hand\n/);
		expect(output).not.toMatch(/> (?:routed away|missing first|missing last|missing suite)/);
		expect(output).toContain("::error file=");
		expect(result.code).toBe(1);
	}, 120_000);

	it("fails a run whose only problem is a static skip, with any --reporter, after bash's `--`", async () => {
		const result = await run(["--heavy", "--", "--strict", "skip-only", "--reporter=dot"]);
		expect(result.stderr).toContain(
			`1 ${strictMessage}\n  skip-only.heavy.test.ts > skipped by hand`,
		);
		expect(result.code).toBe(1);
	}, 120_000);

	it("counts no filtered-out test in partial runs (.only, a line filter)", async () => {
		const partial = ["--allowOnly", "solo", "skip-only.heavy.test.ts:2"];
		const result = await run(["--heavy", "--strict", ...partial]);
		expect(result.stdout + result.stderr).not.toContain(strictMessage);
		expect(result.code).toBe(0);
	}, 120_000);
});
