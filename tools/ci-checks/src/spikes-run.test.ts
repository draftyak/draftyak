import { spawnSync } from "node:child_process";
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from "vitest";
import {
	artifactName,
	type Cli,
	checkEvidence,
	checkEvidenceStep,
	type Deps,
	describePlan,
	type Entry,
	githubRepo,
	type Plan,
	PlanError,
	type Proc,
	parseCli,
	planRun,
	planStep,
	type Run,
	refPart,
	runners,
	runOnGitHub,
	type Signals,
	stamp,
	type Tree,
	worstCase,
} from "./spikes-run.ts";
import { parseYaml } from "./yaml.ts";

const repoRoot = path.resolve(import.meta.dirname, "..", "..", "..");
const ci = (os: Record<string, unknown>): string => JSON.stringify({ os });
const heavy = JSON.stringify({ scripts: { "test:heavy": "node ../kit/run.ts --heavy" } });
const memoryTree = (files: Readonly<Record<string, string | undefined>>): Tree => ({
	files: (dir) =>
		Object.keys(files)
			.filter((file) => file.startsWith(`${dir}/`) && files[file] !== undefined)
			.sort(),
	read: (file) => files[file],
});

const spikes: Readonly<Record<string, string>> = {
	"spikes/kit/package.json": heavy,
	"spikes/kit/ci.json": ci({
		"ubuntu-24.04": { timeout: 10, docker: true },
		"macos-15": { timeout: 10 },
	}),
	"spikes/s01-sqlite3mc/package.json": heavy,
	"spikes/s01-sqlite3mc/ci.json": ci({
		"ubuntu-24.04-arm": { timeout: 15, docker: true },
		"windows-11-arm": { timeout: 15 },
		"macos-15": { timeout: 15 },
	}),
	"spikes/s03-mcp-sdk/package.json": heavy,
	"spikes/s03-mcp-sdk/ci.json": ci({ "ubuntu-24.04": { timeout: 5 } }),
	"spikes/s03b-bridge-elicitation/package.json": heavy,
	"spikes/s03b-bridge-elicitation/ci.json": ci({ "ubuntu-24.04": { timeout: 5 } }),
	"spikes/s05-desktop/package.json": heavy,
	"spikes/s05-desktop/ci.json": ci({
		"ubuntu-24.04": { timeout: 30, tauriLinux: true, apt: ["libfoo-dev"], rust: {} },
		"macos-15": { timeout: 30, rust: { targets: ["aarch64-apple-darwin"] } },
	}),
	"spikes/s05-desktop/rust/Cargo.toml": "[workspace]\nmembers = ['ekm']\n",
	"spikes/s05-desktop/rust/ekm/Cargo.toml": "[package]\nname = 'ekm'\n",
	"spikes/s05-desktop/tauri-app/src-tauri/Cargo.toml": "[package]\nname = 'app'\n",
	"spikes/s10-mobile/package.json": heavy,
	"spikes/s10-mobile/Cargo.toml": "[package]\nname = 'mobile'\n",
	"spikes/s10-mobile/ci.json": ci({
		"ubuntu-24.04": {
			timeout: 45,
			java: true,
			android: { packages: ["platforms;android-37", "build-tools;37.0.0"] },
			rust: { targets: ["aarch64-linux-android"] },
		},
	}),
	"spikes/sched-clock/package.json": heavy,
	"spikes/sched-clock/ci.json": ci({ "windows-2025": { timeout: 10 } }),
	"spikes/notes/readme.md": "no package.json, so not a spike",
};

const plan = (request: unknown, files: Record<string, string | undefined> = spikes): Plan =>
	planRun(request, memoryTree(files));

function problems(request: object, files: Record<string, string | undefined> = spikes): string {
	try {
		plan({ spikes: ["kit"], os: ["ubuntu-24.04"], node: "both", ...request }, files);
	} catch (error) {
		if (error instanceof PlanError) return error.problems.join("\n");
		throw error;
	}
	return "";
}

const job = (overrides: Partial<Entry>): Entry => ({
	spike: "kit",
	os: "ubuntu-24.04",
	timeout: 10,
	rate: 1,
	docker: false,
	java: false,
	tauriLinux: false,
	apt: "",
	androidPackages: "",
	rust: false,
	rustTargets: "",
	rustKey: "kit",
	rustWorkspaces: "",
	...overrides,
});

describe("planRun", () => {
	it("plans each spike on each runner, with that runner's setup and rate", () => {
		const result = plan({ spikes: ["kit", "s05"], os: ["ubuntu-24.04"], node: "both" });
		expect(result).toEqual({
			spikes: ["kit", "s05-desktop"],
			os: ["ubuntu-24.04"],
			node: "both",
			entries: [
				job({ docker: true }),
				job({
					spike: "s05-desktop",
					timeout: 30,
					tauriLinux: true,
					apt: "libfoo-dev",
					rust: true,
					rustKey: "s05-desktop",
					rustWorkspaces: "spikes/s05-desktop/rust\nspikes/s05-desktop/tauri-app/src-tauri",
				}),
			],
		});
	});

	it("passes Android packages, Rust targets and each runner's rate through", () => {
		const [mobile] = plan({ spikes: ["s10"], os: ["ubuntu-24.04"], node: "bundled" }).entries;
		expect(mobile).toMatchObject({
			java: true,
			androidPackages: "platforms;android-37 build-tools;37.0.0",
			rust: true,
			rustTargets: "aarch64-linux-android",
			rustKey: "s10-mobile-aarch64-linux-android",
			rustWorkspaces: "spikes/s10-mobile",
		});
		const [desktop] = plan({ spikes: ["s05"], os: ["macos-15"], node: "minimum" }).entries;
		expect(desktop).toMatchObject({ rate: 10, rustTargets: "aarch64-apple-darwin" });
		const [clock] = plan({ spikes: ["sched"], os: ["windows-2025"], node: "both" }).entries;
		expect(clock).toMatchObject({ spike: "sched-clock", rate: 2 });
	});

	it("takes a folder name as it is, and an id as the one folder named <id>-<slug>", () => {
		const request = { spikes: ["s03", "s03b", "kit"], os: ["ubuntu-24.04"], node: "both" };
		expect(plan(request).spikes).toEqual(["s03-mcp-sdk", "s03b-bridge-elicitation", "kit"]);
		const twins = { ...spikes, "spikes/x-a/package.json": heavy, "spikes/x-b/package.json": heavy };
		expect(problems({ spikes: ["x"] }, twins)).toContain("more than one spike matches x");
	});

	it.each([
		["an unknown spike", { spikes: ["s99"] }, "spikes: no spike matches s99 (spikes/ has kit, s01"],
		["a spike twice", { spikes: ["kit", "kit"] }, "spikes lists kit twice"],
		[
			"a spike by id and folder",
			{ spikes: ["s01", "s01-sqlite3mc"], os: ["macos-15"] },
			"spikes: s01-sqlite3mc names s01-sqlite3mc again",
		],
		["a malformed id", { spikes: ["../kit"] }, 'spikes: "../kit" is unknown or malformed'],
		["no spikes", { spikes: [] }, "spikes must be a non-empty list"],
		["an unknown runner", { os: ["macos-14"] }, 'os: "macos-14" is unknown or malformed'],
		["a runner twice", { os: ["ubuntu-24.04", "ubuntu-24.04"] }, "os lists ubuntu-24.04 twice"],
		["a runner as a string", { os: "ubuntu-24.04" }, "os must be a non-empty list"],
		["an unknown node", { node: "latest" }, "node must be both, minimum, bundled"],
		["an extra field", { branch: "m0-08" }, 'the request: unknown key "branch"'],
		[
			"a runner the spike doesn't list",
			{ os: ["windows-2025"] },
			"spikes/kit/ci.json doesn't run on windows-2025 (only ubuntu-24.04, macos-15)",
		],
	])("refuses %s", (_, request, problem) => {
		expect(problems(request)).toContain(problem);
	});

	it("refuses anything but an object", () => {
		expect(() => plan(["kit"])).toThrow("spikes must be a non-empty list");
	});

	it.each([
		["no scripts", "{}"],
		["no test:heavy script", JSON.stringify({ scripts: { test: "node ../kit/run.ts" } })],
		["a broken package.json", "{"],
	])("refuses a spike with %s, since spikes.yml runs test:heavy", (_, manifest) => {
		expect(problems({}, { ...spikes, "spikes/kit/package.json": manifest })).toContain(
			"spikes/kit/package.json has no test:heavy script, which spikes.yml runs",
		);
	});

	const linux = { "ubuntu-24.04": { timeout: 5 } };
	it.each([
		["no file", undefined, "spikes/kit/ci.json is missing, so kit can't run on GitHub"],
		["no JSON", "{", "spikes/kit/ci.json: "],
		["an unknown key", JSON.stringify({ os: linux, jobs: 1 }), 'ci.json: unknown key "jobs"'],
		["no runners", ci({}), 'spikes/kit/ci.json: "os" must map runners to their settings'],
		["an unknown runner", ci({ ...linux, "macos-14": {} }), 'unknown runner "macos-14"'],
		[
			"no timeout",
			ci({ "ubuntu-24.04": {} }),
			"ubuntu-24.04: timeout must be whole minutes from 1 to 60",
		],
		["a long timeout", ci({ "ubuntu-24.04": { timeout: 61 } }), "from 1 to 60"],
		["a macOS timeout over 30", ci({ ...linux, "macos-15": { timeout: 31 } }), "from 1 to 30"],
		["a part minute", ci({ "ubuntu-24.04": { timeout: 2.5 } }), "timeout must be whole minutes"],
		["an unknown setting", ci({ "ubuntu-24.04": { timeout: 5, node: 1 } }), 'unknown key "node"'],
		["a toggle as a string", ci({ "ubuntu-24.04": { timeout: 5, java: "yes" } }), "java must be"],
		[
			"docker on macOS",
			ci({ ...linux, "macos-15": { timeout: 5, docker: true } }),
			"macos-15: docker, tauriLinux and apt need an ubuntu runner",
		],
		[
			"Tauri packages on Windows",
			ci({ ...linux, "windows-2025": { timeout: 5, tauriLinux: true } }),
			"need an ubuntu runner",
		],
		["a shell in apt", ci({ "ubuntu-24.04": { timeout: 5, apt: ["x;id"] } }), 'apt: "x;id"'],
		[
			"an Android licence route, which the owner settled as sdkmanager",
			ci({ "ubuntu-24.04": { timeout: 5, android: { route: "preinstalled", packages: ["x"] } } }),
			'android: unknown key "route"',
		],
		[
			"Android without packages",
			ci({ "ubuntu-24.04": { timeout: 5, android: {} } }),
			"android.packages must be a non-empty list",
		],
		[
			"a shell in an Android package",
			ci({ "ubuntu-24.04": { timeout: 5, android: { packages: ["tools && id"] } } }),
			'android.packages: "tools && id"',
		],
		[
			"a malformed Rust target",
			ci({ "ubuntu-24.04": { timeout: 5, rust: { targets: ["x86_64 linux"] } } }),
			'rust.targets: "x86_64 linux"',
		],
		[
			"an unknown Rust key",
			ci({ "ubuntu-24.04": { timeout: 5, rust: { toolchain: "stable" } } }),
			'rust: unknown key "toolchain"',
		],
		[
			"Rust without a Cargo.toml",
			ci({ "ubuntu-24.04": { timeout: 5, rust: {} } }),
			"rust on ubuntu-24.04, but spikes/kit has no Cargo.toml",
		],
	])("refuses a ci.json with %s", (_, text, problem) => {
		expect(problems({}, { ...spikes, "spikes/kit/ci.json": text })).toContain(problem);
	});

	it("estimates the worst case: each timeout times its runner's rate, plus a minute for plan", () => {
		const os = ["macos-15", "windows-11-arm", "ubuntu-24.04-arm"];
		const result = plan({ spikes: ["s01"], os, node: "both" });
		expect(worstCase(result)).toBe(15 * 10 + 15 * 2 + 15 + 1);
		expect(describePlan(result)).toEqual([
			"spikes-run: 3 jobs, node both, at most 196 billed minutes (timeouts x runner rates, plus 1 for plan)",
			"  s01-sqlite3mc on macos-15: up to 15 min x 10; none",
			"  s01-sqlite3mc on windows-11-arm: up to 15 min x 2; none",
			"  s01-sqlite3mc on ubuntu-24.04-arm: up to 15 min x 1; docker",
		]);
		expect(describePlan(plan({ spikes: ["s10"], os: ["ubuntu-24.04"], node: "both" }))[1]).toBe(
			"  s10-mobile on ubuntu-24.04: up to 45 min x 1; JDK 21; Android SDK via sdkmanager (platforms;android-37 build-tools;37.0.0); Rust 1.95.0 + aarch64-linux-android",
		);
	});
});

describe("the committed ci.json files", () => {
	const listed = spawnSync(
		"git",
		["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "spikes"],
		{ cwd: repoRoot, encoding: "utf8" },
	)
		.stdout.split("\0")
		.filter(Boolean);
	const tree: Tree = {
		files: (dir) => listed.filter((file) => file.startsWith(`${dir}/`)),
		read: (file) =>
			existsSync(path.join(repoRoot, file))
				? readFileSync(path.join(repoRoot, file), "utf8")
				: undefined,
	};
	const withCi = listed.flatMap((file) => /^spikes\/([^/]+)\/ci\.json$/.exec(file)?.[1] ?? []);

	it.each(withCi)("spikes/%s/ci.json plans on each runner it lists", (spike) => {
		const { os } = JSON.parse(tree.read(`spikes/${spike}/ci.json`) ?? "{}");
		const request = { spikes: [spike], os: Object.keys(os ?? {}), node: "both" };
		expect(planRun(request, tree).entries.length).toBe(Object.keys(os).length);
	});

	it("runs the kit on every runner, so each one checks fetch-node and gpgv", () => {
		const { os } = JSON.parse(readFileSync(path.join(repoRoot, "spikes/kit/ci.json"), "utf8"));
		expect(Object.keys(os).sort()).toEqual([...runners].sort());
	});
});

describe("spikes.yml", () => {
	const source = readFileSync(path.join(repoRoot, ".github/workflows/spikes.yml"), "utf8");
	type Step = Readonly<Record<string, unknown>>;
	const workflow = parseYaml(source).value as {
		concurrency?: unknown;
		jobs: Record<string, Record<string, unknown> & { steps: Step[] }>;
	};
	const { jobs } = workflow;
	const steps = jobs.run?.steps ?? [];
	const uses =
		(action: string) =>
		(step: Step): boolean =>
			String(step.uses).startsWith(`${action}@`);
	const withId = (id: string) => (step: Step) => step.id === id;
	const expression = (body: string): string => `\${{ ${body} }}`;
	const onMain = "github.ref == 'refs/heads/main'";

	it("runs plan's matrix with strict skips, uploading checked evidence for 7 days", () => {
		expect(Object.keys(jobs)).toEqual(["plan", "run"]);
		// Every push ref is new; a shared group would cancel queued dispatches after the gate.
		expect(workflow.concurrency).toBeUndefined();
		expect(jobs.run).toMatchObject({
			needs: "plan",
			"runs-on": expression("matrix.os"),
			"timeout-minutes": expression("matrix.timeout"),
			strategy: {
				"fail-fast": false,
				matrix: expression("fromJSON(needs.plan.outputs.matrix)"),
			},
			env: {
				DRAFTYAK_STRICT_SKIPS: "1",
				DRAFTYAK_NODES: expression("needs.plan.outputs.node"),
			},
		});
		const check = steps.findIndex(withId("evidence"));
		const upload = steps.findIndex(uses("actions/upload-artifact"));
		expect(steps[check]).toMatchObject({
			run: "node tools/ci-checks/src/spikes-run.ts --check-evidence",
		});
		expect(steps[upload]).toMatchObject({
			if: "always() && steps.evidence.outcome == 'success'",
			with: {
				name: `evidence_${expression("matrix.spike")}_${expression("matrix.os")}`,
				path: "spikes/*/evidence/",
				// A re-run of a failed job uploads again under the same name.
				overwrite: true,
				"retention-days": 7,
			},
		});
		expect(check).toBeLessThan(upload);
		expect(steps.filter(uses("actions/upload-artifact"))).toHaveLength(1);
	});

	it("tests the item's commit and clears its evidence before any step that can fail", () => {
		const checkout = steps.findIndex(uses("actions/checkout"));
		expect(steps[checkout]?.with).toEqual({ "fetch-depth": 2, "persist-credentials": false });
		const [item, clear] = [steps[checkout + 1], steps[checkout + 2]];
		expect(item?.if).toBe("github.event_name == 'push'");
		expect(String(item?.run)).toContain("git checkout --quiet --detach HEAD^");
		expect(clear?.if).toBeUndefined();
		expect(String(clear?.run)).toContain(
			"git ls-files -z -- 'spikes/*/evidence/*' | git update-index -z --skip-worktree --stdin",
		);
		expect(String(clear?.run)).toContain("rm -rf spikes/*/evidence");
		// Without test:heavy, nothing is checked or uploaded: the clear step ran whenever it did.
		const heavyStep = steps.findIndex(withId("heavy"));
		expect(steps[steps.findIndex(withId("evidence"))]?.if).toBe(
			"always() && (steps.heavy.outcome == 'success' || steps.heavy.outcome == 'failure')",
		);
		expect(checkout).toBe(1);
		expect(heavyStep).toBeGreaterThan(checkout + 2);
	});

	it("runs test:heavy through pnpm, not turbo, so DISPLAY, RUNNER_* and GITHUB_* reach the tests", () => {
		const step = steps.find(withId("heavy"));
		const run = String(step?.run);
		expect(run).toContain('pnpm --filter "./spikes/$SPIKE" --fail-if-no-match run test:heavy');
		expect(run).toContain("heavy=(xvfb-run --auto-servernum ");
		expect(run).not.toMatch(/turbo/);
		expect(step?.env).toEqual({
			SPIKE: expression("matrix.spike"),
			XVFB: expression("matrix.tauriLinux"),
		});
	});

	it("fetches the Nodes that DRAFTYAK_NODES selects", () => {
		const run = String(steps.find((step) => step.name === "fetch-node")?.run);
		expect(run).toContain("versions=$DRAFTYAK_NODES");
		expect(run).toContain("if [ \"$versions\" = both ]; then versions='minimum bundled'; fi");
		expect(run).toContain('node tools/fetch-node/fetch-node.mjs --version "$version" --print-path');
	});

	// A run restores caches only from its own branch or the default branch, and every spikes-run
	// branch is new; pnpm/action-setup can't restore without saving, so its store cache is main's.
	it("saves caches only on the default branch, where later runs can restore them", () => {
		expect(steps.filter(uses("actions/cache"))).toEqual([]);
		const saves = steps.filter(uses("actions/cache/save"));
		expect(saves).toHaveLength(2);
		for (const step of saves) expect(String(step.if).startsWith(`${onMain} && `)).toBe(true);
		expect(steps.filter(uses("actions/cache/restore"))).toHaveLength(2);
		expect(steps.find(uses("Swatinem/rust-cache"))?.with).toMatchObject({
			"save-if": expression(onMain),
		});
		expect(steps.find(uses("pnpm/action-setup"))?.with).toEqual({ cache: expression(onMain) });
	});

	it("reads exactly the matrix keys that plan emits", () => {
		const read = new Set([...source.matchAll(/\bmatrix\.(\w+)/g)].map((match) => match[1]));
		const [entry] = plan({ spikes: ["kit"], os: ["ubuntu-24.04"], node: "both" }).entries;
		expect([...read].sort()).toEqual(Object.keys(entry ?? {}).sort());
	});

	it("installs xauth with xvfb, since xvfb-run needs it and recommends are off", () => {
		const step = String(steps.find((candidate) => candidate.name === "Linux packages")?.run);
		expect(step).toMatch(/\bxvfb xauth\b/);
		expect(step).toContain("--no-install-recommends");
	});
});

describe("parseCli", () => {
	it.each([
		[["--", "--spikes", "kit,s01", "--os", "ubuntu-24.04"], ["kit", "s01"], ["ubuntu-24.04"]],
		[
			["--spikes", "kit s01", "--os", "macos-15, ubuntu-24.04"],
			["kit", "s01"],
			["macos-15", "ubuntu-24.04"],
		],
		[
			["--spikes", "kit", "s01", "--os", "macos-15", "windows-2025"],
			["kit", "s01"],
			["macos-15", "windows-2025"],
		],
		[["--spikes=kit", "--spikes", "s02", "--os=ubuntu-24.04"], ["kit", "s02"], ["ubuntu-24.04"]],
	])("reads %j, as bash or PowerShell pass it", (argv, spikeList, osList) => {
		expect(parseCli(argv)).toEqual({
			mode: "run",
			spikes: spikeList,
			os: osList,
			node: "both",
			dryRun: false,
			yes: false,
		});
	});

	it("reads --node, --dry-run, --yes and the workflow's modes", () => {
		const cli = parseCli(["--spikes", "kit", "--os", "macos-15", "--node", "minimum", "--dry-run"]);
		expect(cli).toMatchObject({ node: "minimum", dryRun: true, yes: false });
		expect(parseCli(["--spikes", "kit", "--os", "macos-15", "--yes"]).yes).toBe(true);
		expect(parseCli(["--plan"]).mode).toBe("plan");
		expect(parseCli(["--", "--check-evidence"]).mode).toBe("check-evidence");
	});

	it.each([
		[["--spikes", "kit"], "--spikes and --os are required"],
		[["kit", "--os", "macos-15"], "unexpected kit"],
		[["--spikes", "kit", "--os", "macos-15", "--node", "both", "extra"], "unexpected extra"],
		[["--spikes", "kit", "--os", "macos-15", "--bogus"], "Unknown option '--bogus'"],
		[["--spikes"], "argument missing"],
	])("refuses %j", (argv, problem) => {
		expect(() => parseCli(argv)).toThrow(problem);
	});
});

describe("names", () => {
	it("stamps branches in UTC to the second and keeps them valid ref names", () => {
		expect(stamp(new Date("2026-10-17T09:05:03.999Z"))).toBe("20261017T090503Z");
		expect(refPart("m0-08-spikes-run")).toBe("m0-08-spikes-run");
		expect(refPart("Feature/Some..Thing.lock")).toBe("feature-some.thing.lock");
		expect(refPart("..")).toBe("head");
	});

	it("reads owner/repo from origin's URL", () => {
		expect(githubRepo("https://github.com/draftyak/draftyak.git")).toBe("draftyak/draftyak");
		expect(githubRepo("git@github.com:draftyak/draftyak.git\n")).toBe("draftyak/draftyak");
		expect(() => githubRepo("https://example.com/x/y.git")).toThrow("isn't a GitHub repository");
	});

	it("names artifacts unambiguously, as spikes.yml uploads them", () => {
		expect(artifactName(job({ spike: "s01-sqlite3mc", os: "macos-15-intel" }))).toBe(
			"evidence_s01-sqlite3mc_macos-15-intel",
		);
		const workflow = readFileSync(path.join(repoRoot, ".github/workflows/spikes.yml"), "utf8");
		const [spike, os] = ["matrix.spike", "matrix.os"].map((body) => `\${{ ${body} }}`);
		expect(workflow).toContain(`name: evidence_${spike}_${os}`);
	});
});

// Each test's folders go when it finishes, so an interrupted run leaves little behind.
const scratch = (prefix: string): string => {
	const dir = mkdtempSync(path.join(tmpdir(), `draftyak-spikes-run-test-${prefix}-`));
	onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
};

describe("planStep, spikes.yml's plan job", () => {
	const request = { spikes: ["kit"], os: ["ubuntu-24.04"], node: "both" };
	function step(env: NodeJS.ProcessEnv, files: Record<string, string | undefined>) {
		const dir = scratch("plan");
		const [output, summary] = [path.join(dir, "output"), path.join(dir, "summary")];
		writeFileSync(output, "");
		writeFileSync(summary, "");
		const lines: string[] = [];
		const github = { GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary, GITHUB_ACTIONS: "true" };
		const code = planStep(memoryTree(files), { ...github, ...env }, (line) => lines.push(line));
		const read = (file: string): string => readFileSync(file, "utf8");
		return { code, lines, output: read(output), summary: read(summary) };
	}

	it("emits the matrix and the Nodes for the pushed spikes/run.json", () => {
		const run = step(
			{ GITHUB_EVENT_NAME: "push" },
			{
				...spikes,
				"spikes/run.json": JSON.stringify(request),
			},
		);
		expect(run.code).toBe(0);
		const matrix = /^matrix=(.*)$/m.exec(run.output)?.[1] ?? "";
		expect(JSON.parse(matrix)).toEqual({ include: [job({ docker: true })] });
		expect(run.output).toMatch(/^node=both$/m);
		expect(run.summary).toContain("| kit | ubuntu-24.04 | 10 min | 1 | docker |");
		expect(run.summary).toContain("At most 11 billed minutes");
	});

	it("takes workflow_dispatch's inputs from RUN_SPIKES, RUN_OS and RUN_NODE", () => {
		const env = {
			GITHUB_EVENT_NAME: "workflow_dispatch",
			RUN_SPIKES: "kit, s03",
			RUN_OS: "ubuntu-24.04",
			RUN_NODE: "minimum",
		};
		const run = step(env, spikes);
		expect(run.code).toBe(0);
		expect(run.output).toContain('"spike":"s03-mcp-sdk"');
		expect(run.output).toMatch(/^node=minimum$/m);
	});

	it.each([
		[
			"no spikes/run.json",
			undefined,
			"spikes/run.json is missing: start runs with pnpm spikes:run",
		],
		["a broken spikes/run.json", "{", "spikes/run.json: "],
		["an unknown runner", JSON.stringify({ ...request, os: ["macos-13"] }), 'os: "macos-13"'],
		[
			"an unknown spike",
			JSON.stringify({ ...request, spikes: ["s42"] }),
			"spikes: no spike matches s42",
		],
	])("fails on %s, with an annotation and no outputs", (_, runJson, problem) => {
		const run = step({ GITHUB_EVENT_NAME: "push" }, { ...spikes, "spikes/run.json": runJson });
		expect(run.code).toBe(1);
		expect(run.lines.join("\n")).toContain(`::error::spikes-run: ${problem}`);
		expect([run.output, run.summary]).toEqual(["", ""]);
	});
});

describe("checkEvidence, before upload-artifact", () => {
	const put = (root: string, file: string, content: string | Buffer): void => {
		mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
		writeFileSync(path.join(root, file), content);
	};

	it("accepts JSON files in spikes/<id>/evidence/ and ignores other spike files", () => {
		const root = scratch("evidence");
		put(root, "spikes/kit/evidence/env.json", '{ "a": 1 }\n');
		put(root, "spikes/s01/evidence/load.json", "[]\n");
		put(root, "spikes/s01/src/open.ts", "export {};\n");
		put(root, "spikes/run.json", "{}\n");
		expect(checkEvidence(root)).toEqual({
			files: ["spikes/kit/evidence/env.json", "spikes/s01/evidence/load.json"],
			problems: [],
		});
	});

	it("refuses builds, other files, folders, links, big files and broken JSON", () => {
		const root = scratch("evidence");
		const outside = scratch("outside");
		put(outside, "secret/notes.json", "{}");
		put(root, "spikes/kit/evidence/ok.json", "{}");
		put(root, "spikes/kit/evidence/app.apk", "PK");
		put(root, "spikes/kit/evidence/.hidden.json", "{}");
		put(root, "spikes/kit/evidence/nested/x.json", "{}");
		put(root, "spikes/kit/evidence/big.json", `"${"x".repeat(1 << 20)}"`);
		put(root, "spikes/kit/evidence/broken.json", "{");
		symlinkSync(
			path.join(outside, "secret"),
			path.join(root, "spikes/kit/evidence/link"),
			"junction",
		);
		symlinkSync(path.join(outside), path.join(root, "spikes/linked"), "junction");
		const { files, problems: found } = checkEvidence(root);
		expect(files).toEqual(["spikes/kit/evidence/ok.json"]);
		expect(found.toSorted()).toEqual([
			"spikes/kit/evidence/.hidden.json: evidence is .json files only",
			"spikes/kit/evidence/app.apk: evidence is .json files only",
			"spikes/kit/evidence/big.json: over 1 MiB",
			"spikes/kit/evidence/broken.json: not JSON",
			"spikes/kit/evidence/link: evidence is .json files only",
			"spikes/kit/evidence/nested: evidence is .json files only",
			"spikes/linked is a link",
		]);
		const summary = path.join(root, "summary");
		const lines: string[] = [];
		const env = { GITHUB_STEP_SUMMARY: summary, GITHUB_ACTIONS: "true" };
		expect(checkEvidenceStep(root, env, (line) => lines.push(line))).toBe(1);
		expect(lines).toContain(
			"::error::spikes-run: spikes/kit/evidence/app.apk: evidence is .json files only",
		);
		expect(readFileSync(summary, "utf8")).toBe("### Evidence\n\n- spikes/kit/evidence/ok.json\n");
	});
});

// runOnGitHub against a real repository whose origin is redirected to a local bare repository, a
// recording git layer and a scripted gh.
interface FakeGh {
	readonly conclusion?: string;
	readonly appearsAfter?: number;
	readonly artifacts?: Record<string, Record<string, string>>;
	// gh run list fails this many times first.
	readonly failList?: number;
	// gh run view says in_progress this many times first, as when gh run watch stops early.
	readonly inProgress?: number;
	// This month's billed minutes before the run.
	readonly billed?: number;
	readonly noAccess?: boolean;
	readonly missing?: boolean;
}

const origin = "https://github.com/draftyak/draftyak.git";
const jobs = [
	{
		labels: ["ubuntu-24.04"],
		status: "completed",
		conclusion: "success",
		started_at: "2026-10-17T12:00:00Z",
		completed_at: "2026-10-17T12:00:30Z",
	},
	{
		labels: ["ubuntu-24.04"],
		status: "completed",
		conclusion: "success",
		started_at: "2026-10-17T12:01:00Z",
		completed_at: "2026-10-17T12:04:10Z",
	},
];
const now = new Date("2026-10-17T12:00:00.123Z");
const ref = "spikes-run/m0-08-spikes-run-20261017T120000Z";
const evidence = (value: number): string => `${JSON.stringify({ data: { value } }, null, 2)}\n`;
const findHint = (commit: string): string =>
	`spikes-run: find it with gh run list --repo draftyak/draftyak --commit ${commit}, then gh run cancel <id> --repo draftyak/draftyak`;

// A repository in <root>/repo whose origin pushes to the bare <root>/origin.git, with its own empty
// global config and none of git's repository variables (hooks, `rebase -x`).
const unrelated = Object.fromEntries(
	Object.entries(process.env).filter(([name]) => !/^GIT_/i.test(name)),
);
const slash = (file: string): string => file.split(path.sep).join("/");
function gitAt(root: string): Run {
	const env = {
		...unrelated,
		GIT_CONFIG_GLOBAL: path.join(root, "gitconfig"),
		GIT_CONFIG_NOSYSTEM: "1",
	};
	return (args, options = {}) => {
		const result = spawnSync("git", [...args], {
			cwd: options.cwd ?? path.join(root, "repo"),
			input: options.input,
			env: { ...env, ...options.env },
			encoding: "utf8",
		});
		return { code: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
	};
}
function must(git: Run, ...args: string[]): string {
	const result = git(args);
	if (result.code !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
	return result.stdout.trim();
}

describe("runOnGitHub, the local CLI", () => {
	// Built once and copied for each test: git runs synchronously, and each call costs time on Windows.
	const template = mkdtempSync(path.join(tmpdir(), "draftyak-spikes-run-test-template-"));
	afterAll(() => rmSync(template, { recursive: true, force: true }));
	let head = "";
	beforeAll(() => {
		const git = gitAt(template);
		writeFileSync(path.join(template, "gitconfig"), "");
		mkdirSync(path.join(template, "repo"));
		must(git, "init", "-q", "-b", "m0-08-spikes-run");
		must(git, "init", "-q", "--bare", path.join(template, "origin.git"));
		must(git, "config", "user.name", "Ada Lovelace");
		must(git, "config", "user.email", "ada@example.com");
		must(git, "remote", "add", "origin", origin);
		must(git, "config", `url.${slash(template)}/origin.git.insteadOf`, origin);
		const write = (file: string, content: string): void => {
			mkdirSync(path.dirname(path.join(template, "repo", file)), { recursive: true });
			writeFileSync(path.join(template, "repo", file), content);
		};
		write(".github/workflows/spikes.yml", "name: spikes\n");
		write("spikes/kit/package.json", `${heavy}\n`);
		write(
			"spikes/kit/ci.json",
			ci({ "ubuntu-24.04": { timeout: 10 }, "macos-15": { timeout: 10 } }),
		);
		must(git, "add", "-A");
		must(git, "commit", "-q", "-m", "chore: init");
		head = must(git, "rev-parse", "HEAD");
	});

	function setup(fake: FakeGh = {}) {
		const root = scratch("cli");
		cpSync(template, root, { recursive: true });
		const config = path.join(root, "repo", ".git", "config");
		writeFileSync(config, readFileSync(config, "utf8").replaceAll(slash(template), slash(root)));
		const dir = path.join(root, "repo");
		const bare = path.join(root, "origin.git");
		const plain = gitAt(root);
		const repo = {
			git: (...args: string[]): string => must(plain, ...args),
			write: (file: string, content: string): void => {
				mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
				writeFileSync(path.join(dir, file), content);
			},
			commit: (message: string): string => {
				must(plain, "add", "-A");
				must(plain, "commit", "-q", "-m", message);
				return must(plain, "rev-parse", "HEAD");
			},
			dir,
		};

		const gitCalls: { args: string[]; env?: Readonly<Record<string, string>> }[] = [];
		const git: Run = (args, options = {}) => {
			gitCalls.push({ args: [...args], env: options.env });
			return plain(args, options);
		};
		const remoteRefs = (): string[] =>
			repo
				.git("ls-remote", "origin")
				.split("\n")
				.filter(Boolean)
				.map((line) => line.split("\t")[1] ?? "");

		const ghCalls: string[][] = [];
		let [listed, listFailures, views] = [0, 0, 0];
		const gh: Run = (args) => {
			if (fake.missing) throw new Error("spawnSync gh ENOENT");
			ghCalls.push([...args]);
			const reply = (stdout: string, code = 0, stderr = ""): Proc => ({ code, stdout, stderr });
			const at = (flag: string): string => args[args.indexOf(flag) + 1] ?? "";
			const [group, action] = args;
			const endpoint = group === "api" ? (args.find((arg) => arg.startsWith("repos/")) ?? "") : "";
			if (endpoint === "repos/draftyak/draftyak") {
				if (fake.noAccess) return reply("", 1, "gh: Not Found (HTTP 404)");
				return reply("draftyak/draftyak\n");
			}
			if (endpoint.startsWith("repos/draftyak/draftyak/actions/runs?")) {
				expect(endpoint).toContain("&created=2026-10-01..2026-10-31");
				return reply("7\n8\n");
			}
			if (/\/runs\/[78]\/jobs\?.*filter=all$/.test(endpoint)) {
				const end = Date.parse("2026-10-02T00:00:00Z") + ((fake.billed ?? 0) / 2) * 60_000;
				const month = { ...jobs[0], started_at: "2026-10-02T00:00:00Z" };
				return reply(JSON.stringify({ ...month, completed_at: new Date(end).toISOString() }));
			}
			if (group === "run" && action === "list") {
				if (listFailures < (fake.failList ?? 0)) {
					listFailures++;
					return reply("", 4, "gh auth login\nauthentication required");
				}
				listed++;
				const found = listed > (fake.appearsAfter ?? 1);
				return reply(JSON.stringify(found ? [{ databaseId: 42, headSha: at("--commit") }] : []));
			}
			if (group === "run" && action === "view") {
				const url = "https://github.com/draftyak/draftyak/actions/runs/42";
				views++;
				const done = views > (fake.inProgress ?? 0);
				const conclusion = done ? (fake.conclusion ?? "success") : "";
				return reply(
					JSON.stringify({ status: done ? "completed" : "in_progress", conclusion, url }),
				);
			}
			if (group === "run" && action === "cancel") return reply("");
			if (endpoint.includes("/jobs?")) return reply(jobs.map((j) => JSON.stringify(j)).join("\n"));
			if (endpoint.endsWith("/artifacts"))
				return reply(Object.keys(fake.artifacts ?? {}).join("\n"));
			if (group === "run" && action === "download") {
				for (const [file, content] of Object.entries(fake.artifacts?.[at("--name")] ?? {})) {
					mkdirSync(path.dirname(path.join(at("--dir"), file)), { recursive: true });
					writeFileSync(path.join(at("--dir"), file), content);
				}
				return reply("");
			}
			return reply("", 1, `unexpected gh ${args.join(" ")}`);
		};

		let handler: ((signal: string) => void) | undefined;
		const signals: Signals = {
			on: (next) => {
				handler = next;
				return () => {
					handler = undefined;
				};
			},
		};
		const logs: string[] = [];
		const watchCalls: string[][] = [];
		let seenDuringWatch: string[] = [];
		const deps: Deps = {
			root: dir,
			git,
			gh,
			ghAsync: async (args) => gh(args),
			watch: async (args) => {
				watchCalls.push([...args]);
				seenDuringWatch = remoteRefs();
				return 0;
			},
			signals,
			now: () => now,
			wait: async () => {},
			log: (line) => logs.push(line),
		};
		const pushedCommit = (): string =>
			gitCalls
				.find(({ args }) => args[0] === "push" && !args.includes("--delete"))
				?.args.at(-1)
				?.split(":")[0] ?? "";
		return {
			repo,
			bare,
			head,
			deps,
			gitCalls,
			ghCalls,
			logs,
			watchCalls,
			remoteRefs,
			pushedCommit,
			seenDuringWatch: () => seenDuringWatch,
			fire: (name = "SIGINT") => handler?.(name),
			listening: () => handler !== undefined,
		};
	}

	const cli = (overrides: Partial<Cli> = {}): Cli => ({
		mode: "run",
		spikes: ["kit"],
		os: ["ubuntu-24.04"],
		node: "both",
		dryRun: false,
		yes: false,
		...overrides,
	});

	it("pushes HEAD plus spikes/run.json to a spikes-run branch, follows the run, writes the evidence and deletes the branch", async () => {
		const run = setup({
			artifacts: { "evidence_kit_ubuntu-24.04": { "kit/evidence/env.json": evidence(1) } },
		});
		const before = run.repo.git("status", "--porcelain");
		expect(await runOnGitHub(cli(), run.deps)).toBe(0);

		expect(run.seenDuringWatch()).toEqual([`refs/heads/${ref}`]);
		expect(run.remoteRefs()).toEqual([]);
		const commit = run.pushedCommit();
		const pushed = run.gitCalls.find(({ args }) => args.at(-1)?.startsWith(`${commit}:`));
		expect(pushed?.args).toEqual([
			"push",
			"--no-follow-tags",
			"origin",
			`${commit}:refs/heads/${ref}`,
		]);
		expect(run.repo.git("rev-parse", `${commit}^`)).toBe(run.head);
		expect(run.repo.git("diff", "--name-only", run.head, commit)).toBe("spikes/run.json");
		expect(JSON.parse(run.repo.git("show", `${commit}:spikes/run.json`))).toEqual({
			spikes: ["kit"],
			os: ["ubuntu-24.04"],
			node: "both",
		});
		expect(run.repo.git("log", "-1", "--format=%s", commit)).toBe(
			"ci(spikes-run): kit on ubuntu-24.04, node both",
		);

		// The item branch, the index and the working tree stay as they were; only the evidence is new.
		expect(run.repo.git("rev-parse", "HEAD")).toBe(run.head);
		expect(run.repo.git("rev-parse", "--abbrev-ref", "HEAD")).toBe("m0-08-spikes-run");
		expect(run.repo.git("for-each-ref", "--format=%(refname)")).toBe("refs/heads/m0-08-spikes-run");
		expect(before).toBe("");
		expect(run.repo.git("status", "--porcelain", "--untracked-files=all")).toBe(
			"?? spikes/kit/evidence/env.json",
		);
		const written = readFileSync(path.join(run.repo.dir, "spikes/kit/evidence/env.json"), "utf8");
		expect(written).toBe(evidence(1));
		for (const { args, env } of run.gitCalls) {
			if (["read-tree", "update-index", "write-tree"].includes(args[0] ?? "")) {
				expect(env?.GIT_INDEX_FILE?.startsWith(tmpdir())).toBe(true);
			}
		}
		// Every git command beyond reads: the temporary index, the commit object, the two pushes to the
		// spikes-run branch and the no-index diff of the evidence.
		const commands = run.gitCalls.map(({ args }) => (args[0] === "-c" ? args[4] : args[0]));
		const reads = ["rev-parse", "ls-tree", "cat-file", "config", "status", "hash-object"];
		expect(commands.filter((command) => !reads.includes(command ?? ""))).toEqual([
			"read-tree",
			"update-index",
			"write-tree",
			"commit-tree",
			"push",
			"push",
			"diff",
		]);
		const pushes = run.gitCalls
			.filter(({ args }) => args[0] === "push")
			.map(({ args }) => args.at(-1));
		expect(pushes).toEqual([`${commit}:refs/heads/${ref}`, `refs/heads/${ref}`]);

		// gh is checked, and the month's minutes counted, before anything else reaches GitHub.
		expect(run.ghCalls.slice(0, 2)).toEqual([
			["api", "repos/draftyak/draftyak", "--jq", ".full_name"],
			[
				"api",
				"--paginate",
				"repos/draftyak/draftyak/actions/runs?per_page=100&created=2026-10-01..2026-10-31",
				"--jq",
				".workflow_runs[].id",
			],
		]);
		expect(run.watchCalls).toEqual([
			[
				"run",
				"watch",
				"42",
				"--repo",
				"draftyak/draftyak",
				"--exit-status",
				"--compact",
				"--interval",
				"10",
			],
		]);
		const log = run.logs.join("\n");
		expect(log).toContain("spikes-run: 0 billed minutes this month; at most 11 after this run");
		expect(log).toContain(
			`spikes-run: pushed ${commit.slice(0, 12)} (HEAD plus spikes/run.json) to ${ref}`,
		);
		expect(log).toContain("spikes-run: run 42: success");
		expect(log).toContain("spikes-run: 5 billed minutes (linux 5, windows 0 x2, macos 0 x10)");
		expect(log).toContain(`spikes-run: deleted ${ref}`);
		expect(log).toContain("  new       spikes/kit/evidence/env.json");
		expect(log).toContain("+++ run-42/spikes/kit/evidence/env.json");
		expect(log).not.toContain("uncommitted");
		expect(run.listening()).toBe(false);
	});

	it("returns 1 for a failed run, still writing its evidence and deleting the branch", async () => {
		const files = { "kit/evidence/env.json": evidence(2) };
		const run = setup({ conclusion: "failure", artifacts: { "evidence_kit_ubuntu-24.04": files } });
		expect(await runOnGitHub(cli(), run.deps)).toBe(1);
		expect(run.remoteRefs()).toEqual([]);
		expect(existsSync(path.join(run.repo.dir, "spikes/kit/evidence/env.json"))).toBe(true);
		expect(run.logs).toContain(
			"spikes-run: run 42: failure (https://github.com/draftyak/draftyak/actions/runs/42)",
		);
	});

	it("checks gh before it creates or pushes anything", async () => {
		for (const fake of [{ noAccess: true }, { missing: true }]) {
			const run = setup(fake);
			const problem = fake.missing
				? "gh isn't available (spawnSync gh ENOENT): install it and run gh auth login"
				: "gh can't read draftyak/draftyak (gh: Not Found (HTTP 404)): run gh auth login with access to it";
			await expect(runOnGitHub(cli(), run.deps)).rejects.toThrow(problem);
			const written = ["hash-object", "commit-tree", "push"];
			expect(run.gitCalls.some(({ args }) => written.includes(args[0] ?? ""))).toBe(false);
			expect(run.remoteRefs()).toEqual([]);
		}
	});

	it("waits for the owner's OK once the month would reach 1,500 billed minutes", async () => {
		const run = setup({ billed: 1490 });
		expect(await runOnGitHub(cli(), run.deps)).toBe(1);
		expect(run.gitCalls.some(({ args }) => args[0] === "commit-tree")).toBe(false);
		expect(run.logs).toContain(
			"spikes-run: 1490 billed minutes this month; at most 1501 after this run",
		);
		expect(run.logs.join("\n")).toContain(
			"that reaches 1500, where spikes runs wait for next month or the owner's OK; with that OK, add --yes",
		);
		const ok = setup({ billed: 1490 });
		expect(await runOnGitHub(cli({ yes: true }), ok.deps)).toBe(0);
		expect(ok.pushedCommit()).not.toBe("");
		expect(ok.logs.join("\n")).toContain("the owner's OK; going ahead with it (--yes)");
		const below = setup({ billed: 1488 });
		expect(await runOnGitHub(cli(), below.deps)).toBe(0);
	});

	it("says which uncommitted and untracked files the run leaves out, but not evidence", async () => {
		const run = setup({ artifacts: {} });
		run.repo.write("spikes/kit/ci.json", ci({ "ubuntu-24.04": { timeout: 12 } }));
		run.repo.write("spikes/kit/test/new.heavy.test.ts", "export {};\n");
		run.repo.write("spikes/kit/evidence/env.json", evidence(0));
		expect(await runOnGitHub(cli(), run.deps)).toBe(0);
		expect(run.logs).toContain(
			"spikes-run: the run tests HEAD, without these uncommitted changes:\n   M spikes/kit/ci.json\n  ?? spikes/kit/test/",
		);
	});

	it("cancels the run and deletes the branch on Ctrl+C during gh run watch", async () => {
		const run = setup({
			artifacts: { "evidence_kit_ubuntu-24.04": { "kit/evidence/env.json": "{}" } },
		});
		const watch = async (): Promise<number> => {
			expect(run.remoteRefs()).toEqual([`refs/heads/${ref}`]);
			run.fire("SIGINT");
			return 2;
		};
		expect(await runOnGitHub(cli(), { ...run.deps, watch })).toBe(130);
		expect(run.ghCalls).toContainEqual(["run", "cancel", "42", "--repo", "draftyak/draftyak"]);
		expect(run.ghCalls.some(([, action]) => action === "download")).toBe(false);
		expect(run.remoteRefs()).toEqual([]);
		expect(run.logs).toContain(`spikes-run: SIGINT: cancelling the run and deleting ${ref}`);
		expect(run.logs).toContain("spikes-run: cancelled run 42");
		expect(run.logs).toContain(`spikes-run: deleted ${ref}`);
		expect(run.listening()).toBe(false);
	});

	it("cancels the run a push started when Ctrl+C interrupts git push", async () => {
		const run = setup();
		const git: Run = (args, options) => {
			const result = run.deps.git(args, options);
			if (args[0] !== "push" || args.includes("--delete")) return result;
			// git dies on the same Ctrl+C; Node handles the signal once the call returns.
			setImmediate(() => run.fire("SIGINT"));
			return { code: 130, stdout: "", stderr: "" };
		};
		expect(await runOnGitHub(cli(), { ...run.deps, git })).toBe(130);
		expect(run.ghCalls).toContainEqual(["run", "cancel", "42", "--repo", "draftyak/draftyak"]);
		expect(run.remoteRefs()).toEqual([]);
		expect(run.listening()).toBe(false);
	});

	it("deletes the branch on a signal while it waits for the run to start", async () => {
		const run = setup({ appearsAfter: 1_000 });
		const wait = async (): Promise<void> => {
			run.fire("SIGTERM");
		};
		expect(await runOnGitHub(cli(), { ...run.deps, wait })).toBe(130);
		expect(run.ghCalls.some(([, action]) => action === "cancel")).toBe(false);
		expect(run.logs).toContain(findHint(run.pushedCommit()));
		expect(run.remoteRefs()).toEqual([]);
	});

	it("gives up when no run starts within 2 minutes, says how to find one, and deletes the branch", async () => {
		const run = setup({ appearsAfter: 1_000 });
		await expect(runOnGitHub(cli(), run.deps)).rejects.toThrow(
			"no spikes.yml run within 2 minutes",
		);
		// 40 lookups while waiting, then 4 more before giving up on cancelling it.
		expect(run.ghCalls.filter(([, action]) => action === "list")).toHaveLength(44);
		expect(run.logs).toContain(findHint(run.pushedCommit()));
		expect(run.remoteRefs()).toEqual([]);
	});

	it("retries gh run list, and stops after ten failures in a row", async () => {
		const flaky = setup({ failList: 3, artifacts: {} });
		expect(await runOnGitHub(cli(), flaky.deps)).toBe(0);
		const broken = setup({ failList: 1_000 });
		await expect(runOnGitHub(cli(), broken.deps)).rejects.toThrow(
			"gh run list: authentication required",
		);
		expect(broken.ghCalls.filter(([, action]) => action === "list")).toHaveLength(14);
		expect(broken.logs).toContain(findHint(broken.pushedCommit()));
		expect(broken.logs).toContain(`spikes-run: deleted ${ref}`);
		expect(broken.remoteRefs()).toEqual([]);
	});

	it("checks the run every 15 s when gh run watch stops before it ends", async () => {
		const run = setup({ inProgress: 2, artifacts: {} });
		const waits: number[] = [];
		const wait = async (ms: number): Promise<void> => {
			waits.push(ms);
		};
		expect(await runOnGitHub(cli(), { ...run.deps, wait })).toBe(0);
		expect(run.ghCalls.filter(([, action]) => action === "view")).toHaveLength(3);
		expect(waits.filter((ms) => ms === 15_000)).toHaveLength(2);
		expect(run.logs.filter((line) => line.includes("checking it every 15 s"))).toEqual([
			"spikes-run: run 42 is in_progress; checking it every 15 s",
		]);
	});

	it("validates before it creates or pushes anything", async () => {
		const run = setup();
		expect(await runOnGitHub(cli({ os: ["macos-14"], spikes: ["kti"] }), run.deps)).toBe(1);
		const commands = run.gitCalls.map(({ args }) => args[0]);
		expect(commands.filter((command) => !["ls-tree", "cat-file"].includes(command ?? ""))).toEqual(
			[],
		);
		expect(run.logs).toContain('spikes-run: os: "macos-14" is unknown or malformed');
		expect(run.logs.join("\n")).toContain(
			"spikes-run: spikes: no spike matches kti (spikes/ has kit)",
		);
		expect(run.ghCalls).toEqual([]);
	});

	it("prints the plan, the branch and spikes/run.json on a dry run, and pushes nothing", async () => {
		const run = setup();
		run.repo.git("checkout", "-q", "--detach");
		const request = cli({ dryRun: true, os: ["macos-15", "ubuntu-24.04"], node: "minimum" });
		expect(await runOnGitHub(request, run.deps)).toBe(0);
		expect(
			run.gitCalls.some(({ args }) =>
				["push", "commit-tree", "hash-object"].includes(args[0] ?? ""),
			),
		).toBe(false);
		expect(run.ghCalls).toEqual([]);
		const log = run.logs.join("\n");
		expect(log).toContain("spikes-run: 2 jobs, node minimum, at most 111 billed minutes");
		expect(log).toContain(`to spikes-run/detached-${run.head.slice(0, 8)}-20261017T120000Z:`);
		expect(log).toContain('"os": [\n    "macos-15",\n    "ubuntu-24.04"\n  ],');
	});

	it("keeps each runner's file when jobs write different evidence under one name", async () => {
		const artifacts = {
			"evidence_kit_ubuntu-24.04": {
				"kit/evidence/env.json": evidence(1),
				"kit/evidence/same.json": "{}\n",
			},
			"evidence_kit_macos-15": {
				"kit/evidence/env.json": evidence(2),
				"kit/evidence/same.json": "{}\n",
			},
		};
		const run = setup({ artifacts });
		expect(await runOnGitHub(cli({ os: ["ubuntu-24.04", "macos-15"] }), run.deps)).toBe(0);
		const dir = path.join(run.repo.dir, "spikes/kit/evidence");
		expect(readFileSync(path.join(dir, "env.ubuntu-24.04.json"), "utf8")).toBe(evidence(1));
		expect(readFileSync(path.join(dir, "env.macos-15.json"), "utf8")).toBe(evidence(2));
		expect(existsSync(path.join(dir, "env.json"))).toBe(false);
		expect(readFileSync(path.join(dir, "same.json"), "utf8")).toBe("{}\n");
	});

	it("keeps an uncommitted local version it replaces, and overwrites committed ones", async () => {
		const artifacts = {
			"evidence_kit_ubuntu-24.04": {
				"kit/evidence/env.json": evidence(3),
				"kit/evidence/committed.json": evidence(4),
				"kit/evidence/unchanged.json": evidence(5),
			},
		};
		const run = setup({ artifacts });
		run.repo.write("spikes/kit/evidence/committed.json", evidence(0));
		run.repo.write("spikes/kit/evidence/unchanged.json", evidence(5));
		run.repo.commit("spike(kit): evidence");
		run.repo.write("spikes/kit/evidence/env.json", evidence(-1));
		expect(await runOnGitHub(cli(), run.deps)).toBe(0);
		const read = (file: string): string => readFileSync(path.join(run.repo.dir, file), "utf8");
		expect(read("spikes/kit/evidence/env.json")).toBe(evidence(3));
		expect(read(".cache/spikes-run/42/replaced/spikes/kit/evidence/env.json")).toBe(evidence(-1));
		expect(read("spikes/kit/evidence/committed.json")).toBe(evidence(4));
		expect(
			existsSync(
				path.join(run.repo.dir, ".cache/spikes-run/42/replaced/spikes/kit/evidence/committed.json"),
			),
		).toBe(false);
		const log = run.logs.join("\n");
		expect(log).toContain("  changed   spikes/kit/evidence/env.json");
		expect(log).toContain("  unchanged spikes/kit/evidence/unchanged.json");
		expect(log).toContain('-    "value": 0');
		expect(log).toContain('+    "value": 4');
		expect(log).toContain(
			"kept your uncommitted spikes/kit/evidence/env.json in .cache/spikes-run/42/replaced/",
		);
	});

	it("writes nothing when an artifact holds a build, another spike's files, folders or broken JSON", async () => {
		const files = {
			"kit/evidence/env.json": evidence(1),
			"kit/evidence/app.apk": "PK",
			"s01/evidence/x.json": "{}",
			"kit/evidence/a/b.json": "{}",
			"kit/evidence/broken.json": "{",
		};
		const run = setup({ artifacts: { "evidence_kit_ubuntu-24.04": files } });
		expect(await runOnGitHub(cli(), run.deps)).toBe(1);
		const unexpected = run.logs.filter((line) => line.includes(": unexpected "));
		expect(unexpected.toSorted()).toEqual(
			[
				"kit/evidence/a/b.json",
				"kit/evidence/app.apk",
				"kit/evidence/broken.json",
				"s01/evidence/x.json",
			].map((file) => `spikes-run: evidence_kit_ubuntu-24.04: unexpected ${file}`),
		);
		expect(run.logs).toContain(
			"spikes-run: nothing written; the run keeps its artifacts for 7 days (gh run download 42)",
		);
		expect(existsSync(path.join(run.repo.dir, "spikes/kit/evidence"))).toBe(false);
		expect(run.remoteRefs()).toEqual([]);
	});

	it("notes a job that uploaded nothing", async () => {
		const run = setup({ artifacts: {} });
		expect(await runOnGitHub(cli(), run.deps)).toBe(0);
		expect(run.logs).toContain("spikes-run: no evidence from kit on ubuntu-24.04");
	});

	it("deletes and cancels nothing after a failed push", async () => {
		const run = setup();
		run.repo.git("config", `url.${slash(run.bare)}-missing.insteadOf`, origin);
		run.repo.git("config", "--unset", `url.${slash(run.bare)}.insteadOf`);
		await expect(runOnGitHub(cli(), run.deps)).rejects.toThrow("git push: ");
		expect(run.gitCalls.some(({ args }) => args.includes("--delete"))).toBe(false);
		expect(run.ghCalls.filter(([group]) => group === "run")).toEqual([]);
	});

	it("needs spikes.yml in HEAD", async () => {
		const run = setup();
		run.repo.git("rm", "-q", ".github/workflows/spikes.yml");
		run.repo.commit("ci: drop spikes.yml");
		await expect(runOnGitHub(cli(), run.deps)).rejects.toThrow("rebase onto m0 first");
		expect(run.gitCalls.some(({ args }) => args[0] === "push")).toBe(false);
	});

	it("tells how to delete the branch when the remote refuses, and returns 1", async () => {
		const run = setup({ artifacts: {} });
		const hook =
			"#!/bin/sh\nwhile read old new ref; do\n  case $new in 0000000000000000000000000000000000000000) echo refused >&2; exit 1;; esac\ndone\n";
		writeFileSync(path.join(run.bare, "hooks", "pre-receive"), hook, { mode: 0o755 });
		expect(await runOnGitHub(cli(), run.deps)).toBe(1);
		expect(run.remoteRefs()).toEqual([`refs/heads/${ref}`]);
		expect(run.logs).toContain(`spikes-run: delete it with: git push origin --delete ${ref}`);
		expect(run.gitCalls.filter(({ args }) => args.includes("--delete"))).toHaveLength(2);
	});
});

describe("the spikes-run CLI", () => {
	const script = path.join(import.meta.dirname, "spikes-run.ts");
	const cliRun = (args: string[]) =>
		spawnSync(process.execPath, [script, ...args], { cwd: repoRoot, encoding: "utf8" });

	it("validates locally and exits 1 before touching git or GitHub", () => {
		const result = cliRun(["--", "--spikes", "nope", "--os", "ubuntu-24.04", "--dry-run"]);
		expect(result.status).toBe(1);
		expect(result.stdout).toContain("spikes-run: spikes: no spike matches nope");
	});

	it("exits 2 with the usage on a bad option", () => {
		const result = cliRun(["--spikes", "kit", "--os", "ubuntu-24.04", "--bogus"]);
		expect(result.status).toBe(2);
		expect(result.stderr).toContain("usage: pnpm spikes:run --spikes 'kit,s01' --os ubuntu-24.04");
	});
});
