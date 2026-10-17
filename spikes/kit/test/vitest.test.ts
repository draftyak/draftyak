import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { exec } from "../exec.ts";
import { kitDir } from "../repo.ts";
import { strictSkips } from "../skip.ts";
import { capabilities, spikeVitestConfig } from "../vitest.ts";

const extra = {
	nowhere: { description: "never", detect: () => false },
	here: { description: "always", detect: () => true },
};

describe("spikeVitestConfig", () => {
	const config = (mode: string, env: NodeJS.ProcessEnv = {}) =>
		spikeVitestConfig({ command: "serve", mode }, { env, capabilities: extra });

	it("keeps M0.1's tiers and adds a requires: tag per capability, skipping only missing ones", () => {
		const heavy = config("heavy").test;
		expect(heavy?.include).toEqual(["**/*.heavy.test.ts"]);
		const names = [...Object.keys(capabilities), "nowhere", "here"].map(
			(name) => `requires:${name}`,
		);
		expect(heavy?.tags?.map((tag) => tag.name)).toEqual(names);
		expect(heavy?.tags?.find((tag) => tag.name === "requires:nowhere")?.skip).toBe(true);
		expect(heavy?.tags?.find((tag) => tag.name === "requires:here")).not.toHaveProperty("skip");
		expect([config("test").test?.testTimeout, heavy?.testTimeout]).toEqual([undefined, 300_000]);
		expect(() => config("production")).toThrow('unknown test tier "production"');
	});

	it("adds the strict-skips plugin to heavy runs only, and refuses unknown strict values", () => {
		const strict = { DRAFTYAK_STRICT_SKIPS: "1" };
		expect(config("heavy", strict).plugins).toMatchObject([{ name: "draftyak:strict-skips" }]);
		expect([config("heavy").plugins, config("test", strict).plugins]).toEqual([[], []]);
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
	// A clean child: no outer Vitest state, colours (turbo forces them) or CI behaviour.
	const inherited = /^(?:VITEST|TEST$|NODE_ENV$|DRAFTYAK_STRICT|FORCE_COLOR$|GITHUB_ACTIONS$|CI$)/;
	const env = Object.fromEntries(
		Object.entries(process.env).filter(([name]) => !inherited.test(name)),
	);
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
