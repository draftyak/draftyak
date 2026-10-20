import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { actionPins, checkWorkflow } from "./workflow-policy.ts";
import { parseYaml } from "./yaml.ts";

const root = path.resolve(import.meta.dirname, "..", "..", "..");
const read = (file: string): string => readFileSync(path.join(root, file), "utf8");
const files = readdirSync(path.join(root, ".github", "workflows")).map(
	(f) => `.github/workflows/${f}`,
);
const toolchain = /^channel\s*=\s*"([^"]+)"/m.exec(read("rust-toolchain.toml"))?.[1] ?? "";

const pin = (action: string): string => `${action}@${actionPins[action]?.join(" # ")}`;
const sha = actionPins["actions/checkout"]?.[0];
const checkout = [
	`- uses: ${pin("actions/checkout")}`,
	"  with:",
	"    persist-credentials: false",
];
// A workflow with one job whose steps are the given lines.
const workflow = (on: string[], steps = checkout, permissions = ["contents: read"]): string =>
	[
		"on:",
		...on.map((line) => `  ${line}`),
		"permissions:",
		...permissions.map((line) => `  ${line}`),
		"env:",
		"  DO_NOT_TRACK: '1'",
		"  TURBO_TELEMETRY_DISABLED: '1'",
		"jobs:",
		"  a:",
		"    runs-on: ubuntu-24.04",
		"    steps:",
		...steps.map((line) => `      ${line}`),
	].join("\n");
const pr = ["pull_request:"];
const run = (expression: string): string[] => ["- run: |", `    echo "\${{ ${expression} }}"`];

describe("workflow policy", () => {
	it.each(files)("%s follows the policy", (file) => {
		expect(checkWorkflow(file, read(file), toolchain)).toEqual([]);
	});

	it.each([
		`\${{ format('{0}{1}', 'requ', 'ired') }}`,
		`\${{ format('{0}{1}', 'pr-', 'title') }}`,
		`\${{ join(fromJSON('["required"]'), '') }}`,
		`\${{ github.job }}`,
		`\${{ matrix.name }}`,
		`prefix \${{ matrix.name }}`,
		`\${{ '' }}required`,
	])("refuses unreviewed computed job name %s", (name) => {
		const source = workflow(pr).replace("  a:\n", `  a:\n    name: ${name}\n`);
		expect(checkWorkflow("x.yml", source, toolchain).join("\n")).toContain(
			"unreviewed computed job name",
		);
	});

	it.each([
		`\${{ github.event.pull_request.draft && 'required (draft)' || 'required' }}`,
		`\${{ matrix.spike }} on \${{ matrix.os }}`,
	])("refuses a reviewed computed name on an unrelated job: %s", (name) => {
		const source = workflow(pr).replace("  a:\n", `  a:\n    name: ${name}\n`);
		expect(checkWorkflow("x.yml", source, toolchain).join("\n")).toContain(
			"unreviewed computed job name",
		);
	});

	it.each(["required", "required (draft)", "pr-title"])(
		"refuses the protected literal name %s in another workflow",
		(name) => {
			const source = workflow(pr).replace("  a:\n", `  a:\n    name: ${name}\n`);
			expect(checkWorkflow("x.yml", source, toolchain).join("\n")).toContain(
				"protected check name belongs",
			);
		},
	);
	it.each(["false", "0", "[]"])("refuses non-string job name %s", (name) => {
		const source = workflow(pr).replace("  a:\n", `  a:\n    name: ${name}\n`);
		expect(checkWorkflow("x.yml", source, toolchain).join("\n")).toContain(
			"unreviewed computed job name",
		);
	});

	it.each(["branches", "branches-ignore", "paths", "paths-ignore"])(
		"refuses top-level PR %s filters on required workflows",
		(filter) => {
			for (const file of ["ci.yml", "pr-title.yml"]) {
				const source = read(`.github/workflows/${file}`).replaceAll("\r\n", "\n");
				const mutated = source.replace(
					"  pull_request:\n",
					`  pull_request:\n    ${filter}: [disabled-ci]\n`,
				);
				expect(mutated).not.toBe(source);
				expect(checkWorkflow(`.github/workflows/${file}`, mutated, toolchain).join("\n")).toContain(
					"required PR events without path/branch filters",
				);
			}
		},
	);

	it.each(["ci.yml", "pr-title.yml"])("requires every current PR event type in %s", (file) => {
		const source = read(`.github/workflows/${file}`).replaceAll("\r\n", "\n");
		const line = /^ {4}types: \[([^\n]+)\]$/m.exec(source);
		expect(line).not.toBeNull();
		const types = (line?.[1] ?? "").split(", ");
		const variants = [
			source.replace("  pull_request:", "  issue_comment:"),
			source.replace(line?.[0] ?? "", ""),
			source.replace(line?.[0] ?? "", "    types: [edited]"),
			source.replace(line?.[0] ?? "", `    types: [${[...types, "opened"].join(", ")}]`),
			...types.map((missing) =>
				source.replace(
					line?.[0] ?? "",
					`    types: [${types.filter((type) => type !== missing).join(", ")}]`,
				),
			),
		];
		for (const mutated of variants) {
			expect(mutated).not.toBe(source);
			expect(checkWorkflow(`.github/workflows/${file}`, mutated, toolchain).join("\n")).toContain(
				"required PR events without path/branch filters",
			);
		}
	});

	it.each([
		["execution shell", "    shell: bash", "    shell: echo {0}"],
		["changes job condition", "  changes:\n", "  changes:\n    if: false\n"],
		["cheap job condition", "  cheap:\n", "  cheap:\n    if: false\n"],
		[
			"cheap job strategy",
			"  cheap:\n",
			"  cheap:\n    strategy:\n      matrix:\n        include: []\n",
		],
		[
			"docs command replacement",
			"run: node tools/verify/verify.ts --profile docs",
			"run: echo docs-disabled",
		],
		["docs command removal", "        run: node tools/verify/verify.ts --profile docs\n", ""],
		["docs condition", "if: needs.changes.outputs.docs-only == 'true'", "if: false"],
		["docs condition removal", "        if: needs.changes.outputs.docs-only == 'true'\n", ""],
		[
			"cheap install replacement",
			"run: pnpm install --frozen-lockfile",
			"run: echo install-disabled",
		],
		[
			"cheap command replacement",
			"run: pnpm verify --profile cheap",
			"run: echo cheap-suite-disabled",
		],
		["cheap command removal", "        run: pnpm verify --profile cheap\n", ""],
		[
			"cheap command condition",
			"      - if: needs.changes.outputs.docs-only != 'true'\n        run: pnpm verify --profile cheap",
			"      - if: false\n        run: pnpm verify --profile cheap",
		],
		[
			"cheap condition removal",
			"      - if: needs.changes.outputs.docs-only != 'true'\n        run: pnpm verify --profile cheap",
			"      - run: pnpm verify --profile cheap",
		],
		[
			"full job condition",
			"if: needs.changes.outputs.docs-only != 'true' && (github.event_name != 'pull_request' || !github.event.pull_request.draft)",
			"if: false",
		],
		[
			"full job condition removal",
			"    if: needs.changes.outputs.docs-only != 'true' && (github.event_name != 'pull_request' || !github.event.pull_request.draft)\n",
			"",
		],
		["build replacement", "run: pnpm build", "run: echo build-disabled"],
		["build removal", "      - run: pnpm build\n", ""],
		["build condition", "      - run: pnpm build", "      - if: false\n        run: pnpm build"],
		["build shell", "      - run: pnpm build", "      - run: pnpm build\n        shell: echo {0}"],
		[
			"build working directory",
			"      - run: pnpm build",
			"      - run: pnpm build\n        working-directory: elsewhere",
		],
		[
			"build before install",
			"      - run: pnpm install --frozen-lockfile\n      - run: pnpm build",
			"      - run: pnpm build\n      - run: pnpm install --frozen-lockfile",
		],
		["heavy condition", "if: needs.changes.outputs.spikes != ''", "if: false"],
		["heavy condition removal", "        if: needs.changes.outputs.spikes != ''\n", ""],
		[
			"heavy condition inversion",
			"if: needs.changes.outputs.spikes != ''",
			"if: needs.changes.outputs.spikes == ''",
		],
		[
			"heavy command replacement",
			`node tools/verify/turbo.ts run test:heavy "\${filters[@]}"`,
			"echo heavy-suite-disabled",
		],
		[
			"heavy filter removal",
			'          for dir in $SPIKES; do filters+=("--filter=./$dir"); done\n',
			"",
		],
		["heavy selection environment", `SPIKES: \${{ needs.changes.outputs.spikes }}`, "SPIKES: ''"],
		[
			"Windows condition",
			"      - run: pnpm verify\n",
			"      - if: false\n        run: pnpm verify\n",
		],
	])("refuses changed CI execution contract: %s", (_, before, after) => {
		const file = ".github/workflows/ci.yml";
		const source = read(file).replaceAll("\r\n", "\n");
		const mutated = source.replace(before, after);
		expect(mutated).not.toBe(source);
		expect(checkWorkflow(file, mutated, toolchain).join("\n")).toContain("must preserve");
	});

	it.each([
		["shell", "defaults:\n  run:\n    shell: echo {0}\n"],
		["working directory", "defaults:\n  run:\n    working-directory: elsewhere\n"],
		["unreviewed safe shell", "defaults:\n  run:\n    shell: bash\n"],
		["null", "defaults: null\n"],
	])("refuses inherited pr-title execution defaults: %s", (_, defaults) => {
		const file = ".github/workflows/pr-title.yml";
		const mutated = defaults + read(file);
		expect(checkWorkflow(file, mutated, toolchain).join("\n")).toContain(
			"pr-title.yml must not define workflow execution defaults",
		);
	});

	it.each([
		["condition", (run: string) => `        if: false\n${run}`],
		["soft failure", (run: string) => `        continue-on-error: true\n${run}`],
		["shell", (run: string) => `        shell: echo {0}\n${run}`],
		["working directory", (run: string) => `        working-directory: elsewhere\n${run}`],
		["removed command", (_: string) => ""],
		["replaced command", (_: string) => "        run: echo validation-disabled"],
	])("refuses changed pr-title validation step: %s", (label, mutate) => {
		const file = ".github/workflows/pr-title.yml";
		const source = read(file).replaceAll("\r\n", "\n");
		for (const command of [
			"node tools/ci-checks/src/pr-meta.ts",
			'node tools/vendor-guard/src/cli.ts --commits "$BASE_SHA..$HEAD_SHA"',
		]) {
			const mutated = source.replace(`        run: ${command}`, mutate(`        run: ${command}`));
			expect(mutated, label).not.toBe(source);
			expect(checkWorkflow(file, mutated, toolchain).join("\n"), command).toContain(
				"must preserve pr-title command",
			);
		}
	});

	it.each([
		["PR_TITLE", "github.event.pull_request.title"],
		["PR_BODY", "github.event.pull_request.body"],
		["PR_HEAD_REF", "github.event.pull_request.head.ref"],
		["PR_BASE_REF", "github.event.pull_request.base.ref"],
		["BASE_SHA", "github.event.pull_request.base.sha"],
		["HEAD_SHA", "github.event.pull_request.head.sha"],
	])("refuses changed pr-title validation input: %s", (key, expression) => {
		const file = ".github/workflows/pr-title.yml";
		const source = read(file).replaceAll("\r\n", "\n");
		const mutated = source.replace(`${key}: \${{ ${expression} }}`, `${key}: unchecked`);
		expect(mutated).not.toBe(source);
		expect(checkWorkflow(file, mutated, toolchain).join("\n")).toContain(
			"must preserve pr-title command",
		);
	});

	it("keeps the jobs that CI and later rulesets rely on", () => {
		const jobs = (name: string): Record<string, unknown> =>
			(parseYaml(read(`.github/workflows/${name}`)).value as { jobs: Record<string, unknown> })
				.jobs;
		const ci = jobs("ci.yml");
		expect(Object.keys(ci)).toEqual(["changes", "cheap", "full", "windows", "required"]);
		expect(ci.required).toMatchObject({
			if: "always()",
			name: `\${{ github.event.pull_request.draft && 'required (draft)' || 'required' }}`,
			needs: ["changes", "cheap", "full", "windows"],
		});
		const reportedJobs = files.flatMap((file) =>
			Object.entries(jobs(path.basename(file))).map(([id, job]) => ({
				file,
				id,
				name: (job as { name?: string }).name ?? id,
			})),
		);
		for (const [name, file, id] of [
			["required", ".github/workflows/ci.yml", "required"],
			["pr-title", ".github/workflows/pr-title.yml", "pr-title"],
		] as const) {
			expect(
				reportedJobs.filter((job) => job.name.includes(name)).map((job) => [job.file, job.id]),
			).toEqual([[file, id]]);
		}
		expect([jobs("dco.yml"), jobs("pr-title.yml")].map(Object.keys)).toEqual([
			["dco"],
			["pr-title"],
		]);
		expect(jobs("pr-title.yml")).toMatchObject({
			"pr-title": {
				steps: [
					{ with: { "fetch-depth": 0 } },
					{},
					{ run: "node tools/ci-checks/src/pr-meta.ts" },
					{ run: 'node tools/vendor-guard/src/cli.ts --commits "$BASE_SHA..$HEAD_SHA"' },
					{ run: "node tools/ci-checks/src/commit-identity.ts" },
				],
			},
		});
		// Pin the job and whole validation steps: conditions, soft failure or input changes bypass checks.
		const prTitle = jobs("pr-title.yml")["pr-title"] as { steps: unknown[] };
		expect(Object.keys(prTitle)).toEqual(["runs-on", "timeout-minutes", "steps"]);
		expect(prTitle.steps.slice(2)).toEqual([
			{
				env: {
					PR_TITLE: `\${{ github.event.pull_request.title }}`,
					PR_BODY: `\${{ github.event.pull_request.body }}`,
					PR_HEAD_REF: `\${{ github.event.pull_request.head.ref }}`,
					PR_BASE_REF: `\${{ github.event.pull_request.base.ref }}`,
				},
				run: "node tools/ci-checks/src/pr-meta.ts",
			},
			{
				env: {
					BASE_SHA: `\${{ github.event.pull_request.base.sha }}`,
					HEAD_SHA: `\${{ github.event.pull_request.head.sha }}`,
				},
				run: 'node tools/vendor-guard/src/cli.ts --commits "$BASE_SHA..$HEAD_SHA"',
			},
			{
				env: {
					BASE_SHA: `\${{ github.event.pull_request.base.sha }}`,
					HEAD_SHA: `\${{ github.event.pull_request.head.sha }}`,
					BASE_REPO: `\${{ github.repository }}`,
					HEAD_REPO: `\${{ github.event.pull_request.head.repo.full_name }}`,
					BASE_REF: `\${{ github.event.pull_request.base.ref }}`,
					HEAD_REF: `\${{ github.event.pull_request.head.ref }}`,
				},
				run: "node tools/ci-checks/src/commit-identity.ts",
			},
		]);
		expect(jobs("zizmor.yml")).toMatchObject({
			zizmor: {
				steps: [
					{},
					{ with: { version: "1.31.1", "online-audits": true, "advanced-security": false } },
				],
			},
		});
	});

	it("runs Windows on ready non-doc PRs and captures the tested source in every contributing job", () => {
		const ci = (
			parseYaml(read(".github/workflows/ci.yml")).value as {
				jobs: Record<
					string,
					{
						if?: string;
						outputs?: Record<string, string>;
						steps: Record<string, unknown>[];
					}
				>;
			}
		).jobs;
		expect(ci.windows?.if).toBe(
			"needs.changes.outputs.docs-only != 'true' && (github.ref == 'refs/heads/main' || (github.event_name == 'pull_request' && !github.event.pull_request.draft))",
		);
		expect(ci.windows?.steps.at(-1)).toEqual({
			run: "pnpm verify",
			env: { TURBO_CONCURRENCY: "1" },
		});
		for (const name of ["changes", "cheap", "full", "windows"]) {
			const job = ci[name];
			expect(job?.outputs?.source, name).toBe(`\${{ steps.source.outputs.source }}`);
			const steps = job?.steps ?? [];
			expect(steps[0], name).toMatchObject({
				with: { ref: `\${{ github.sha }}`, "persist-credentials": false },
			});
			const capture = steps.findIndex((step) => step.id === "source");
			expect(capture, name).toBe(2);
			expect(steps[capture], name).toEqual({
				id: "source",
				run: "node tools/ci-checks/src/verification-receipt.ts capture",
			});
		}
		expect(ci.required?.steps.at(-2)).toMatchObject({
			run: "node tools/ci-checks/src/verification-receipt.ts report",
			env: {
				CI_NEEDS: `\${{ toJSON(needs) }}`,
				CI_HEAD_SHA: `\${{ github.event.pull_request.head.sha || github.sha }}`,
				CI_BASE_SHA: `\${{ github.event.pull_request.base.sha || github.event.before }}`,
				CI_PR_DRAFT: `\${{ github.event.pull_request.draft == true }}`,
			},
		});
		expect(ci.required?.steps.at(-1)).toMatchObject({
			if: "always()",
			with: {
				name: `ci-verification-\${{ github.run_id }}-\${{ github.run_attempt }}`,
				path: `\${{ runner.temp }}/ci-verification.json`,
				"if-no-files-found": "error",
				"retention-days": 7,
			},
		});
	});

	it.each([
		["another workflow", ".github/workflows/other.yml", (source: string) => source],
		[
			"another job",
			".github/workflows/ci.yml",
			(source: string) => source.replace("  required:\n", "  report:\n"),
		],
		[
			"a directory",
			".github/workflows/ci.yml",
			(source: string) =>
				source.replace(`\${{ runner.temp }}/ci-verification.json`, `\${{ runner.temp }}/`),
		],
		[
			"a wildcard",
			".github/workflows/ci.yml",
			(source: string) =>
				source.replace(`\${{ runner.temp }}/ci-verification.json`, `\${{ runner.temp }}/*.json`),
		],
		[
			"a second upload path",
			".github/workflows/ci.yml",
			(source: string) =>
				source.replace(
					`          path: \${{ runner.temp }}/ci-verification.json`,
					`          path: |\n            \${{ runner.temp }}/ci-verification.json\n            apps/app/src-tauri/target/release/bundle/`,
				),
		],
		[
			"longer retention",
			".github/workflows/ci.yml",
			(source: string) => source.replace("retention-days: 7", "retention-days: 8"),
		],
		[
			"missing-file success",
			".github/workflows/ci.yml",
			(source: string) => source.replace("if-no-files-found: error", "if-no-files-found: warn"),
		],
	])("refuses receipt uploads with %s", (_, file, mutate) => {
		const source = read(".github/workflows/ci.yml").replaceAll("\r\n", "\n");
		expect(checkWorkflow(file, mutate(source), toolchain).join("\n")).toContain("fixed CI receipt");
	});

	it.each(["true", "false", `\${{ failure() }}`, "[]"])(
		"refuses job and step continue-on-error: %s in ci.yml regardless of its value",
		(value) => {
			const job = workflow(pr).replace(
				"    runs-on:",
				`    continue-on-error: ${value}\n    runs-on:`,
			);
			const step = workflow(pr, [...checkout, `  continue-on-error: ${value}`]);
			for (const source of [job, step]) {
				expect(checkWorkflow(".github/workflows/ci.yml", source, toolchain).join("\n")).toContain(
					"ci.yml must not contain continue-on-error",
				);
				expect(checkWorkflow(".github/workflows/spikes.yml", source, toolchain)).toEqual([]);
			}
		},
	);

	it("refuses continue-on-error outside jobs and steps in ci.yml too", () => {
		const source = `${workflow(pr)}\ncontinue-on-error: false\n`;
		expect(checkWorkflow(".github/workflows/ci.yml", source, toolchain).join("\n")).toContain(
			"ci.yml must not contain continue-on-error",
		);
	});

	it("runs spikes.yml on spikes-run/** pushes and dispatch only, and nothing else on those pushes", () => {
		const triggers = Object.fromEntries(
			files.map((file) => [
				path.basename(file),
				(parseYaml(read(file)).value as { on: unknown }).on,
			]),
		);
		for (const [file, on] of Object.entries(triggers)) {
			const branches = (on as { push?: { branches?: string[] } }).push?.branches ?? [];
			expect(branches.includes("spikes-run/**"), file).toBe(file === "spikes.yml");
		}
		const spikes = triggers["spikes.yml"] as Record<string, unknown>;
		expect(Object.keys(spikes)).toEqual(["push", "workflow_dispatch"]);
		expect(spikes.push).toEqual({ branches: ["spikes-run/**"] });
		expect(Object.keys(spikes.workflow_dispatch as object)).toEqual(["inputs"]);
		const inputs = (spikes.workflow_dispatch as { inputs: Record<string, unknown> }).inputs;
		expect(Object.keys(inputs)).toEqual(["spikes", "os", "node", "tests"]);
		// Dispatch matches a pushed spikes/run.json, where tests is optional too.
		expect(inputs.tests).toMatchObject({ required: false, type: "string" });
	});

	it("allows push to spikes-run/**, evidence uploads, read-only jobs and github.sha in run", () => {
		const steps = [
			`- uses: ${pin("actions/upload-artifact")}`,
			"  with:",
			"    path: spikes/*/evidence/",
		];
		const source = workflow(
			["push:", "  branches: ['spikes-run/**']"],
			[...steps, ...run("github.event_name"), ...run("github.sha")],
		).replace("    runs-on:", "    permissions:\n      contents: read\n    runs-on:");
		expect(checkWorkflow("x.yml", source, "1.95.0")).toEqual([]);
	});

	it.each([
		["write permissions", workflow(pr, checkout, ["contents: write"]), "exactly `contents: read`"],
		["extra permissions", workflow(pr, checkout, ["contents: read", "id-token: write"]), "exactly"],
		[
			"job permissions",
			workflow(pr).replace("    runs-on:", "    permissions: write-all\n    runs-on:"),
			"job permissions may only be",
		],
		["telemetry on", workflow(pr).replace("  DO_NOT_TRACK: '1'\n", ""), "DO_NOT_TRACK"],
		[
			"pull_request_target",
			workflow(["pull_request_target:"]),
			"pull_request_target is not allowed",
		],
		["workflow_run", workflow(["workflow_run:"]), "workflow_run is not allowed"],
		[
			"push to another branch",
			workflow(["push:", "  branches: [main, release]"]),
			"push may only run",
		],
		["push to every branch", workflow(["push:"]), "push may only run"],
		[
			"push to a spikes-run lookalike",
			workflow(["push:", "  branches: ['spikes-run/*', 'spikes-run-**']"]),
			"push may only run",
		],
		[
			"push with branches-ignore",
			workflow(["push:", "  branches-ignore: [main]"]),
			"push may only run",
		],
		[
			"push to spikes-run/** on tags",
			workflow(["push:", "  branches: ['spikes-run/**']", "  tags: ['*']"]),
			"push may only run",
		],
		[
			"push on tags",
			workflow(["push:", "  branches: [main]", "  tags: ['v*']"]),
			"push may only run",
		],
		["a tag ref", workflow(pr, ["- uses: actions/checkout@v7"]), "40-hex SHA"],
		["a SHA without a comment", workflow(pr, [`- uses: actions/checkout@${sha}`]), "# v7.0.1"],
		[
			"an unlisted action",
			workflow(pr, [`- uses: someone/thing@${sha} # v1`]),
			"not in the pinned",
		],
		[
			"persisted credentials",
			workflow(pr, [`- uses: ${pin("actions/checkout")}`]),
			"persist-credentials",
		],
		["github.event in run", workflow(pr, run("github.event.pull_request.title")), "through env"],
		["inputs in run", workflow(pr, run("inputs.name")), "through env"],
		["github.head_ref in run", workflow(pr, run("github.head_ref")), "through env"],
		["index syntax in run", workflow(pr, run("github['event']['pull_request']")), "through env"],
		["the github context in run", workflow(pr, run("toJSON(github)")), "through env"],
		["upper case in run", workflow(pr, run("GITHUB.EVENT.pull_request.title")), "through env"],
		[
			"an app upload",
			workflow(pr, [`- uses: ${pin("actions/upload-artifact")}`, "  with:", "    path: a.apk"]),
			"never",
		],
		[
			"Rust without its toolchain",
			workflow(pr, [`- uses: ${pin("dtolnay/rust-toolchain")}`]),
			"toolchain: 1.95.0",
		],
		["YAML outside the subset", workflow(pr, ["- uses: &pin x"]), "unsupported YAML syntax"],
		["a lone CR", workflow(["push:", "  branches: [main] #\r    tags: ['v*']"]), "U+000D"],
	])("refuses %s", (_, source, problem) => {
		expect(checkWorkflow("x.yml", source, "1.95.0").join("\n")).toContain(problem);
	});
});
