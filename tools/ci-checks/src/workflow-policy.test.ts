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

// The reviewed source contract, with a one-line condition within the current YAML subset.
const labelsFixture = `name: Sync approved labels
on:
  workflow_dispatch:
permissions:
  contents: read
env:
  DO_NOT_TRACK: '1'
  TURBO_TELEMETRY_DISABLED: '1'
jobs:
  sync-labels:
    if: \${{ github.event_name == 'workflow_dispatch' && github.repository == 'draftyak/draftyak' && github.actor == 'nicksavov' && github.triggering_actor == 'nicksavov' && github.ref == 'refs/heads/m11' }}
    permissions:
      contents: read
      issues: write
    runs-on: ubuntu-24.04
    steps:
      - name: Check out source
        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          ref: \${{ github.sha }}
          persist-credentials: false
      - name: Set up pnpm
        uses: pnpm/action-setup@ea17c68df8912ef543352723c149a84f56e3d413 # v6.1.0
      - name: Set up Node
        uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0
        with:
          node-version-file: .node-version
      - name: Install locked dependencies
        run: pnpm install --frozen-lockfile
      - name: Validate metadata
        run: pnpm --filter @draftyak/launch-checks --fail-if-no-match metadata
      - name: Validate issue drafts and labels
        run: pnpm --filter @draftyak/launch-checks --fail-if-no-match issues
      - name: Synchronize approved labels
        id: sync-approved-labels
        env:
          GH_TOKEN: \${{ github.token }}
        run: node tools/launch-checks/src/issues-cli.ts --sync-labels
`;
const labelsFile = ".github/workflows/labels.yml";
const labelsChange = (before: string, after: string): string => {
	if (!labelsFixture.includes(before)) throw new Error(`missing labels fixture anchor: ${before}`);
	return labelsFixture.replace(before, after);
};
const classifierChange = (before: string, after: string): string => {
	const source = read(".github/workflows/ci.yml").replaceAll("\r\n", "\n");
	const end = source.indexOf("\n  cheap:");
	const prefix = source.slice(0, end);
	if (end < 0 || !prefix.includes(before)) throw new Error("missing classifier fixture anchor");
	return prefix.replace(before, after) + source.slice(end);
};
const classifierOutputs = [
	["areas", `\${{ steps.areas.outputs.areas }}`],
	["docs-only", `\${{ steps.areas.outputs.docs-only }}`],
	["rust", `\${{ steps.areas.outputs.rust }}`],
	["spikes", `\${{ steps.areas.outputs.spikes }}`],
	["heavy", `\${{ steps.areas.outputs.heavy }}`],
	["template-smoke", `\${{ steps.areas.outputs.template-smoke }}`],
	["source", `\${{ steps.source.outputs.source }}`],
] as const;

describe("workflow policy", () => {
	it.each(["&evt pull_request_target", "!event pull_request_target", "!!str workflow_run"])(
		"refuses unsupported unquoted flow event %s",
		(event) => {
			const source = workflow(pr).replace("on:\n  pull_request:\n", `on: [${event}]\n`);
			expect(source).toContain(`on: [${event}]`);
			expect(checkWorkflow("x.yml", source, toolchain).join("\n")).toContain(
				"unsupported flow sequence item",
			);
		},
	);

	it("keeps an ordinary flow event readable", () => {
		const source = workflow(pr).replace("on:\n  pull_request:\n", "on: [pull_request]\n");
		expect(source).toContain("on: [pull_request]");
		expect(checkWorkflow("x.yml", source, toolchain)).toEqual([]);
	});

	it.each(files)("%s follows the policy", (file) => {
		expect(checkWorkflow(file, read(file), toolchain)).toEqual([]);
	});

	it.each(classifierOutputs)("refuses changed classifier job output: %s", (name, value) => {
		for (const replacement of [
			"''",
			"'true'",
			`\${{ steps.other.outputs.${name} }}`,
			`\${{ steps.areas.outputs.unknown }}`,
		]) {
			if (replacement === value) continue;
			const mutated = classifierChange(`      ${name}: ${value}`, `      ${name}: ${replacement}`);
			expect(checkWorkflow(".github/workflows/ci.yml", mutated, toolchain).join("\n")).toContain(
				"must preserve classifier job output mappings",
			);
		}
	});

	it.each(classifierOutputs)("refuses a missing classifier job output: %s", (name, value) => {
		const mutated = classifierChange(`      ${name}: ${value}\n`, "");
		expect(checkWorkflow(".github/workflows/ci.yml", mutated, toolchain).join("\n")).toContain(
			"must preserve classifier job output mappings",
		);
	});

	it.each([
		["missing mapping", "    outputs:\n", "    ignored:\n"],
		["null mapping", "    outputs:\n", "    outputs: null\n    ignored:\n"],
		["extra output", "    outputs:\n", "    outputs:\n      extra: 'false'\n"],
	])("refuses %s on the classifier job", (_, before, after) => {
		const mutated = classifierChange(before, after);
		expect(checkWorkflow(".github/workflows/ci.yml", mutated, toolchain).join("\n")).toContain(
			"must preserve classifier job output mappings",
		);
	});

	it.each([
		["renamed ID", "      - id: areas", "      - id: other"],
		["missing ID", "      - id: areas\n        env:", "      - env:"],
		[
			"duplicate ID",
			"      - id: areas",
			"      - id: areas\n        run: echo classifier-disabled\n      - id: areas",
		],
		[
			"replaced command",
			"run: node tools/ci-checks/src/changes.ts",
			"run: echo classifier-disabled",
		],
		[
			"echoed command",
			"run: node tools/ci-checks/src/changes.ts",
			"run: echo node tools/ci-checks/src/changes.ts",
		],
		["condition", "      - id: areas", "      - id: areas\n        if: false"],
		["shell", "      - id: areas", "      - id: areas\n        shell: echo {0}"],
		[
			"working directory",
			"      - id: areas",
			"      - id: areas\n        working-directory: elsewhere",
		],
		["soft failure", "      - id: areas", "      - id: areas\n        continue-on-error: true"],
		[
			"base revision",
			`BASE_SHA: \${{ github.event.pull_request.base.sha || github.event.before }}`,
			`BASE_SHA: \${{ github.event.pull_request.head.sha || github.sha }}`,
		],
		[
			"head revision",
			`HEAD_SHA: \${{ github.event.pull_request.head.sha || github.sha }}`,
			"HEAD_SHA: HEAD",
		],
		[
			"missing base revision",
			`          BASE_SHA: \${{ github.event.pull_request.base.sha || github.event.before }}\n`,
			"",
		],
		[
			"extra environment",
			"      - id: areas\n        env:",
			"      - id: areas\n        env:\n          EXTRA: value",
		],
	])("refuses changed classifier producer: %s", (_, before, after) => {
		const mutated = classifierChange(before, after);
		expect(checkWorkflow(".github/workflows/ci.yml", mutated, toolchain).join("\n")).toContain(
			"must preserve changes command and its execution controls",
		);
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

	it.each(["__proto__", '"__proto__"', "'__proto__'"])("refuses a job keyed %s", (id) => {
		const source = workflow(pr, [...checkout, ...run("github.event.pull_request.title")]).replace(
			"  a:\n",
			"  a:\n    name: required\n    permissions: write-all\n",
		);
		const problems = checkWorkflow("x.yml", source, toolchain).join("\n");
		for (const problem of ["protected check name", "job permissions", "run must not expand"]) {
			expect(problems).toContain(problem);
		}
		expect(checkWorkflow("x.yml", source.replace("  a:\n", `  ${id}:\n`), toolchain)).toEqual([
			"x.yml: line 9: __proto__ keys are not supported",
		]);
	});

	// Each workflow puts `sep` before a value on the given line; without a tab there, it has the
	// given problem.
	const withOn = (on: string): string => workflow(pr).replace("on:\n  pull_request:\n", `${on}\n`);
	it.each([
		[
			"an on event",
			(sep: string) => withOn(`on: ${sep}pull_request_target`),
			1,
			"pull_request_target is not allowed",
		],
		[
			"another on event",
			(sep: string) => withOn(`on: ${sep}workflow_run`),
			1,
			"workflow_run is not allowed",
		],
		[
			"an on flow sequence",
			(sep: string) => withOn(`on: ${sep}[push, workflow_run]`),
			1,
			"workflow_run is not allowed",
		],
		[
			"an on flow mapping",
			(sep: string) => withOn(`on: ${sep}{pull_request_target}`),
			1,
			"unsupported YAML syntax",
		],
		[
			"an on sequence item",
			(sep: string) => withOn(`on:\n  - ${sep}pull_request_target`),
			2,
			"pull_request_target is not allowed",
		],
		[
			"an on flow sequence with push",
			(sep: string) => withOn(`on: ${sep}[push, pull_request]`),
			1,
			"push may only run on the branches main or spikes-run/**",
		],
		[
			"the jobs",
			(sep: string) =>
				workflow(pr).replace(/^jobs:[\s\S]*/m, `jobs: ${sep}{"a":{"runs-on":"ubuntu-24.04"}}`),
			8,
			"unsupported YAML syntax",
		],
		[
			"the steps",
			(sep: string) =>
				workflow(pr, []).replace("    steps:", `    steps: ${sep}[{"uses":"actions/checkout@v7"}]`),
			11,
			"unsupported flow sequence item",
		],
	] as const)("refuses a tab before %s", (_, source, line, problem) => {
		expect(checkWorkflow("x.yml", source(""), toolchain).join("\n")).toContain(problem);
		expect(checkWorkflow("x.yml", source("\t"), toolchain)).toEqual([
			`x.yml: line ${line}: tabs before a value are not supported`,
		]);
	});

	it.each([
		["run", `echo "\${{ github.event.pull_request.title }}"`, "run must not expand"],
		["uses", "someone/thing@main", "uses must be owner/repo@<40-hex SHA>"],
	])("refuses a tab after a step's %s key", (key, value, problem) => {
		const source = (sep: string): string => workflow(pr, [`- ${key}:${sep}${value}`]);
		expect(checkWorkflow("x.yml", source(" "), toolchain).join("\n")).toContain(problem);
		for (const sep of ["\t", " \t", "\t "]) {
			expect(checkWorkflow("x.yml", source(sep), toolchain)).toEqual([
				"x.yml: line 12: tabs before a value are not supported",
			]);
		}
	});

	it("refuses a step in a flow sequence with a space or a tab after its key", () => {
		for (const sep of [" ", "\t"]) {
			const source = workflow(pr, []).replace(
				"    steps:",
				`    steps: [uses:${sep}someone/thing@main]`,
			);
			expect(checkWorkflow("x.yml", source, toolchain)).toEqual([
				"x.yml: line 11: unsupported flow sequence item",
			]);
		}
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
		[
			"heavy condition removal",
			"        if: needs.changes.outputs.spikes != '' || needs.changes.outputs.heavy != ''\n",
			"",
		],
		[
			"heavy condition inversion",
			"if: needs.changes.outputs.spikes != ''",
			"if: needs.changes.outputs.spikes == ''",
		],
		[
			"heavy command replacement",
			`node tools/verify/turbo.ts run test:heavy --concurrency=1 "\${filters[@]}"`,
			"echo heavy-suite-disabled",
		],
		[
			"heavy serial flag removal",
			`node tools/verify/turbo.ts run test:heavy --concurrency=1 "\${filters[@]}"`,
			`node tools/verify/turbo.ts run test:heavy "\${filters[@]}"`,
		],
		["heavy parallel execution", "test:heavy --concurrency=1", "test:heavy --concurrency=2"],
		[
			"heavy echo prefix",
			`node tools/verify/turbo.ts run test:heavy --concurrency=1 "\${filters[@]}"`,
			`echo node tools/verify/turbo.ts run test:heavy --concurrency=1 "\${filters[@]}"`,
		],
		[
			"heavy filter removal",
			'          for dir in $SPIKES; do filters+=("--filter=./$dir"); done\n',
			"",
		],
		["heavy selection environment", `SPIKES: \${{ needs.changes.outputs.spikes }}`, "SPIKES: ''"],
		[
			"heavy package condition removal",
			"if: needs.changes.outputs.spikes != '' || needs.changes.outputs.heavy != ''",
			"if: needs.changes.outputs.spikes != ''",
		],
		[
			"heavy package selection environment",
			`HEAVY: \${{ needs.changes.outputs.heavy }}`,
			"HEAVY: ''",
		],
		[
			"heavy package selection environment removal",
			`          HEAVY: \${{ needs.changes.outputs.heavy }}\n`,
			"",
		],
		[
			"heavy smoke selection environment",
			`SMOKE: \${{ needs.changes.outputs.template-smoke == 'true' || github.ref == 'refs/heads/main' || github.base_ref == 'main' }}`,
			"SMOKE: 'true'",
		],
		[
			"heavy strict skips",
			"          DRAFTYAK_STRICT_SKIPS: '1'",
			"          DRAFTYAK_STRICT_SKIPS: '0'",
		],
		["heavy strict skips removal", "          DRAFTYAK_STRICT_SKIPS: '1'\n", ""],
		[
			"heavy package filter loop removal",
			'          while IFS= read -r filter; do\n            if [ -n "$filter" ]; then filters+=("--filter=$filter"); fi\n          done <<< "$HEAVY"\n',
			"",
		],
		[
			"heavy package filter blank guard",
			'if [ -n "$filter" ]; then filters+=("--filter=$filter"); fi',
			'if false; then filters+=("--filter=$filter"); fi',
		],
		[
			"heavy smoke exclusion removal",
			'          if [ "$SMOKE" != true ] && [ -f packages/create-plugin/package.json ]; then\n            filters+=("--filter=!./packages/create-plugin")\n          fi\n',
			"",
		],
		["heavy smoke exclusion inversion", 'if [ "$SMOKE" != true ]', 'if [ "$SMOKE" == true ]'],
		[
			"heavy shell override",
			"      - name: test:heavy for the touched spikes and the selected packages\n",
			"      - name: test:heavy for the touched spikes and the selected packages\n        shell: echo {0}\n",
		],
		[
			"heavy working directory",
			"      - name: test:heavy for the touched spikes and the selected packages\n",
			"      - name: test:heavy for the touched spikes and the selected packages\n        working-directory: elsewhere\n",
		],
		[
			"heavy soft failure",
			"      - name: test:heavy for the touched spikes and the selected packages\n",
			"      - name: test:heavy for the touched spikes and the selected packages\n        continue-on-error: true\n",
		],
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

	describe("M10 candidate tag filters", () => {
		const candidateFiles = [".github/workflows/release.yml", ".github/workflows/mobile.yml"];
		const tags = "  tags: ['m10-rc-*']";
		const tagged = (extra: string[] = [], steps = checkout): string =>
			workflow(["push:", tags, ...extra], steps);

		it.each(candidateFiles)(
			"admits the exact tag filter and existing events/branches in %s",
			(file) => {
				for (const on of [
					["push:", tags],
					["push:", "  tags:", "    - 'm10-rc-*'"],
					["push:", "  branches: [main]", tags],
					["push:", "  branches: ['spikes-run/**']", tags],
					["push:", "  branches: [main, 'spikes-run/**']", tags],
					["push:", "  branches: [main]"],
					["push:", "  branches: ['spikes-run/**']"],
					[
						"push:",
						tags,
						"workflow_dispatch:",
						"pull_request:",
						"schedule:",
						"  - cron: '0 0 * * 0'",
					],
				]) {
					expect(checkWorkflow(file, workflow(on), toolchain), on.join("\n")).toEqual([]);
				}
				expect(checkWorkflow(file, tagged(["  paths: ['apps/**']"]), toolchain)).toEqual([]);
				expect(checkWorkflow(file, tagged(["  paths-ignore: ['docs/**']"]), toolchain)).toEqual([]);
			},
		);

		it.each(candidateFiles)("admits quoted own tag keys in %s", (file) => {
			for (const key of ["'tags'", '"tags"']) {
				const source = workflow(["push:", `  ${key}: ['m10-rc-*']`]);
				expect(checkWorkflow(file, source, toolchain)).toEqual([]);
			}
		});

		it.each(candidateFiles)("refuses prototype and duplicate tag fields in %s", (file) => {
			for (const key of ["__proto__", "'__proto__'", '"__proto__"']) {
				const inherited = [`  ${key}:`, "    tags: ['m10-rc-*']"];
				for (const fields of [
					inherited,
					["  branches: [main]", ...inherited],
					[...inherited, ...inherited],
				]) {
					expect(checkWorkflow(file, workflow(["push:", ...fields]), toolchain)).not.toEqual([]);
				}
			}
			for (const key of ["tags", "'tags'", '"tags"']) {
				const source = workflow(["push:", tags, `  ${key}: ['m10-rc-*']`]);
				expect(checkWorkflow(file, source, toolchain)).not.toEqual([]);
			}
		});

		it.each([
			"x.yml",
			".github/workflows/ci.yml",
			".github/workflows/spikes.yml",
			".github/workflows/release.yaml",
			".github/workflows/mobile.yaml",
			".github/workflows/Release.yml",
			".github/workflows/Mobile.yml",
			".github/workflows/release-extra.yml",
			".github/workflows/subdir/release.yml",
			"./.github/workflows/release.yml",
			"release.yml",
			"mobile.yml",
		])("refuses the candidate tag pattern in another exact filename: %s", (file) => {
			for (const extra of [[], ["  branches: [main]"]]) {
				expect(checkWorkflow(file, tagged(extra), toolchain).join("\n")).toContain(
					"push may only run",
				);
			}
		});

		it.each(candidateFiles)(
			"refuses broad, wrong, extra and malformed tag patterns in %s",
			(file) => {
				for (const value of [
					"['*']",
					"['**']",
					"['v*']",
					"['m10-*']",
					"['m10-rc-**']",
					"['m10-rc-1']",
					"['!m10-rc-*']",
					"['m10-rc-*', 'v*']",
					"['m10-rc-*', 'm10-rc-*']",
					"['m10-rc-*', 'm10-rc-1']",
					"['m10-rc-* ']",
					`['\${{ inputs.tag }}']`,
					"[]",
					"'m10-rc-*'",
					"null",
					"true",
					"42",
					"[42]",
					"[null]",
				]) {
					for (const branches of [[], ["  branches: [main]"]]) {
						const source = workflow(["push:", `  tags: ${value}`, ...branches]);
						expect(checkWorkflow(file, source, toolchain).join("\n"), value).toContain(
							"push may only run",
						);
					}
				}
			},
		);

		it.each(candidateFiles)("retains branch validation beside valid tags in %s", (file) => {
			for (const value of [
				"[m10]",
				"[main, m10]",
				"['*']",
				"['main*']",
				"['refs/heads/main']",
				"['spikes-run/*']",
				"[]",
				"main",
				"null",
				"[true]",
				"[42]",
			]) {
				expect(
					checkWorkflow(file, tagged([`  branches: ${value}`]), toolchain).join("\n"),
					value,
				).toContain("push may only run");
			}
		});

		it.each(candidateFiles)("refuses a map masquerading as the one-tag list in %s", (file) => {
			for (const branches of [[], ["  branches: [main]"]]) {
				const source = workflow([
					"push:",
					"  tags:",
					"    0: 'm10-rc-*'",
					"    length: 1",
					...branches,
				]);
				expect(checkWorkflow(file, source, toolchain).join("\n")).toContain("push may only run");
			}
		});

		it.each(candidateFiles)(
			"refuses ignored filters, extra filters and unfiltered pushes in %s",
			(file) => {
				for (const filter of ["tags-ignore: ['*']", "branches-ignore: [m10]", "unknown: [main]"]) {
					expect(checkWorkflow(file, tagged([`  ${filter}`]), toolchain).join("\n")).toContain(
						"push may only run",
					);
				}
				for (const on of [
					["push:"],
					["push:", "  paths: ['apps/**']"],
					["push:", "  paths-ignore: ['docs/**']"],
					["push:", "  tags-ignore: ['v*']"],
					["push:", "  branches-ignore: [m10]"],
				]) {
					expect(checkWorkflow(file, workflow(on), toolchain).join("\n")).toContain(
						"push may only run",
					);
				}
				for (const on of ["push", "[push]", "[push, workflow_dispatch]"]) {
					const source = workflow(["push:"]).replace("on:\n  push:", `on: ${on}`);
					expect(checkWorkflow(file, source, toolchain).join("\n")).toContain("push may only run");
				}
			},
		);

		it.each(candidateFiles)(
			"retains security and artifact refusals with permitted tags in %s",
			(file) => {
				const source = tagged();
				const upload = (path: string): string =>
					tagged([], [`- uses: ${pin("actions/upload-artifact")}`, "  with:", `    path: ${path}`]);
				for (const [changed, problem] of [
					[
						source.replace("permissions:\n  contents: read", "permissions:\n  contents: write"),
						"exactly `contents: read`",
					],
					[
						source.replace("    runs-on:", "    permissions: write-all\n    runs-on:"),
						"job permissions may only be",
					],
					[source.replace("  DO_NOT_TRACK: '1'\n", ""), "DO_NOT_TRACK"],
					[tagged(["pull_request_target:"]), "pull_request_target is not allowed"],
					[tagged(["workflow_run:"]), "workflow_run is not allowed"],
					[tagged([], ["- uses: actions/checkout@v7"]), "40-hex SHA"],
					[tagged([], [`- uses: actions/checkout@${sha}`]), "# v7.0.1"],
					[tagged([], [`- uses: ${pin("actions/checkout")}`]), "persist-credentials"],
					[tagged([], run("github.event.pull_request.title")), "through env"],
					[tagged([], run("inputs.name")), "through env"],
					[upload("app.apk"), "never an installable build"],
					[upload(`\${{ runner.temp }}/ci-verification.json`), "fixed CI receipt"],
				]) {
					expect(checkWorkflow(file, changed ?? "", toolchain).join("\n")).toContain(problem);
				}
				expect(checkWorkflow(file, upload("spikes/*/evidence/"), toolchain)).toEqual([]);
			},
		);
	});

	describe("the exact labels contract", () => {
		it("admits the reviewed seven-step source without executing future commands", () => {
			expect(checkWorkflow(labelsFile, labelsFixture, toolchain)).toEqual([]);
		});

		it("accepts comments, CRLF and reordered mappings with identical parsed values", () => {
			for (const source of [
				labelsChange(
					"      contents: read\n      issues: write",
					"      issues: write\n      contents: read",
				),
				labelsFixture.replaceAll("\n", "\r\n"),
				`# labels\n${labelsFixture}`,
			])
				expect(checkWorkflow(labelsFile, source, toolchain)).toEqual([]);
		});

		it.each([
			"labels.yml",
			".github/workflows/labels.yaml",
			".github/workflows/Labels.yml",
			".github/workflows/labels-extra.yml",
			".github/workflows/subdir/labels.yml",
			"./.github/workflows/labels.yml",
			".github/workflows/ci.yml",
			".github/workflows/release.yml",
			".github/workflows/mobile.yml",
			".github/workflows/x.yml",
		])("does not grant label writes to another exact filename: %s", (file) => {
			expect(checkWorkflow(file, labelsFixture, toolchain)).not.toEqual([]);
		});

		it.each(["x.yml", ".github/workflows/release.yml", ".github/workflows/mobile.yml"])(
			"keeps ordinary read-only workflows accepted in %s",
			(file) => {
				for (const events of [
					pr,
					["workflow_dispatch:"],
					["schedule:", "  - cron: '0 0 * * 0'"],
					["push:", "  branches: [main]"],
					["push:", "  branches: ['spikes-run/**']"],
				]) {
					const source = workflow(events).replace(
						"    runs-on:",
						"    permissions:\n      contents: read\n    runs-on:",
					);
					expect(checkWorkflow(file, source, toolchain)).toEqual([]);
				}
				expect(checkWorkflow(file, labelsChange("      issues: write\n", ""), toolchain)).toEqual(
					[],
				);
			},
		);

		it("requires the contract even when labels.yml is read-only", () => {
			expect(checkWorkflow(labelsFile, workflow(["workflow_dispatch:"]), toolchain)).not.toEqual(
				[],
			);
			expect(
				checkWorkflow(labelsFile, labelsChange("      issues: write\n", ""), toolchain),
			).not.toEqual([]);
		});

		it.each([
			["another job", "  sync-labels:", "  another-job:"],
			[
				"extra job",
				"jobs:",
				"jobs:\n  extra:\n    runs-on: ubuntu-24.04\n    steps:\n      - run: echo extra",
			],
			["no dispatch", "  workflow_dispatch:", "  pull_request:"],
			["push event", "  workflow_dispatch:", "  workflow_dispatch:\n  push:\n    branches: [main]"],
			[
				"schedule event",
				"  workflow_dispatch:",
				"  workflow_dispatch:\n  schedule:\n    - cron: '0 0 * * 0'",
			],
			["workflow call", "  workflow_dispatch:", "  workflow_dispatch:\n  workflow_call:"],
			["forbidden event", "  workflow_dispatch:", "  workflow_dispatch:\n  pull_request_target:"],
			["empty inputs", "  workflow_dispatch:", "  workflow_dispatch:\n    inputs:"],
			[
				"ref input",
				"  workflow_dispatch:",
				"  workflow_dispatch:\n    inputs:\n      ref:\n        type: string",
			],
			[
				"dispatch extra property",
				"  workflow_dispatch:",
				"  workflow_dispatch:\n    unexpected: true",
			],
			["event scalar", "on:\n  workflow_dispatch:", "on: workflow_dispatch"],
			["event list", "on:\n  workflow_dispatch:", "on: [workflow_dispatch]"],
			["guard missing", "    if:", "    other-condition:"],
			["event guard", "github.event_name == 'workflow_dispatch'", "github.event_name == 'push'"],
			[
				"repository guard",
				"github.repository == 'draftyak/draftyak'",
				"github.repository == 'draftyak/other'",
			],
			["original actor", "github.actor == 'nicksavov'", "github.actor == 'other-owner'"],
			[
				"rerun actor",
				"github.triggering_actor == 'nicksavov'",
				"github.triggering_actor == 'other-owner'",
			],
			["rerun guard missing", " && github.triggering_actor == 'nicksavov'", ""],
			["main ref", "refs/heads/m11", "refs/heads/main"],
			["tag ref", "refs/heads/m11", "refs/tags/m11"],
			["item ref", "refs/heads/m11", "refs/heads/m11-12-labels"],
			["weakened guard", " && github.repository", " || github.repository"],
			[
				"guard suffix",
				"github.ref == 'refs/heads/m11' }}",
				"github.ref == 'refs/heads/m11' || always() }}",
			],
			["top write", "permissions:\n  contents: read", "permissions:\n  contents: write"],
			[
				"top issues write",
				"permissions:\n  contents: read",
				"permissions:\n  contents: read\n  issues: write",
			],
			["job contents write", "      contents: read", "      contents: write"],
			["job extra write", "      issues: write", "      issues: write\n      actions: write"],
			[
				"job scalar write",
				"    permissions:\n      contents: read\n      issues: write",
				"    permissions: write-all",
			],
			["wrong runner", "runs-on: ubuntu-24.04", "runs-on: self-hosted"],
			["checkout moving ref", `ref: \${{ github.sha }}`, "ref: m11"],
			["checkout input ref", `ref: \${{ github.sha }}`, `ref: \${{ inputs.ref }}`],
			["checkout credentials", "persist-credentials: false", "persist-credentials: true"],
			["checkout credential string", "persist-credentials: false", "persist-credentials: 'false'"],
			[
				"checkout alternate token",
				"          persist-credentials: false",
				`          persist-credentials: false\n          token: \${{ secrets.ALTERNATE_TOKEN }}`,
			],
			["Node override", "node-version-file: .node-version", "node-version: '26'"],
			[
				"pnpm override",
				"      - name: Set up Node",
				"        with:\n          version: '11'\n      - name: Set up Node",
			],
			["unlocked install", "run: pnpm install --frozen-lockfile", "run: pnpm install"],
			[
				"metadata omitted",
				"run: pnpm --filter @draftyak/launch-checks --fail-if-no-match metadata",
				"run: echo validated",
			],
			[
				"issues omitted",
				"run: pnpm --filter @draftyak/launch-checks --fail-if-no-match issues",
				"run: echo validated",
			],
			["metadata masked", "--fail-if-no-match metadata", "--fail-if-no-match metadata || true"],
			[
				"wrong CLI",
				"node tools/launch-checks/src/issues-cli.ts --sync-labels",
				"node tools/launch-checks/src/other.ts --sync-labels",
			],
			[
				"extra CLI argument",
				"issues-cli.ts --sync-labels",
				"issues-cli.ts --sync-labels --repo other",
			],
			[
				"mutating command masked",
				"issues-cli.ts --sync-labels",
				"issues-cli.ts --sync-labels || true",
			],
			["step id", "id: sync-approved-labels", "id: another-step"],
			["missing final token", `          GH_TOKEN: \${{ github.token }}\n`, ""],
			["PAT token", `GH_TOKEN: \${{ github.token }}`, `GH_TOKEN: \${{ secrets.ALTERNATE_TOKEN }}`],
			["token context", `GH_TOKEN: \${{ github.token }}`, `GH_TOKEN: \${{ github.event.token }}`],
			[
				"extra token",
				`GH_TOKEN: \${{ github.token }}`,
				`GH_TOKEN: \${{ github.token }}\n          GITHUB_TOKEN: \${{ github.token }}`,
			],
			[
				"token command",
				"run: node tools/launch-checks/src/issues-cli.ts --sync-labels",
				`run: node tools/launch-checks/src/issues-cli.ts --sync-labels \${{ github.token }}`,
			],
			[
				"workflow token",
				"env:\n  DO_NOT_TRACK",
				`env:\n  GH_TOKEN: \${{ github.token }}\n  DO_NOT_TRACK`,
			],
			["job token", "    runs-on:", `    env:\n      GH_TOKEN: \${{ github.token }}\n    runs-on:`],
			["workflow shell default", "jobs:", "defaults:\n  run:\n    shell: sh\njobs:"],
			[
				"workflow directory default",
				"jobs:",
				"defaults:\n  run:\n    working-directory: other\njobs:",
			],
			["workflow environment", "jobs:", "environment: other\njobs:"],
			["workflow shell environment", "  DO_NOT_TRACK:", "  BASH_ENV: override.sh\n  DO_NOT_TRACK:"],
			["workflow path environment", "  DO_NOT_TRACK:", "  PATH: other\n  DO_NOT_TRACK:"],
			["workflow token host", "  DO_NOT_TRACK:", "  GH_HOST: other.invalid\n  DO_NOT_TRACK:"],
			["telemetry off removed", "  DO_NOT_TRACK: '1'\n", ""],
			["step name changed", "name: Validate metadata", "name: Other validation"],
			["workflow name changed", "name: Sync approved labels", "name: Other labels"],
		])("refuses a changed labels contract: %s", (_name, before, after) => {
			expect(
				checkWorkflow(labelsFile, labelsChange(before ?? "", after ?? ""), toolchain),
			).not.toEqual([]);
		});

		it.each([
			"defaults:\n      run:\n        shell: sh",
			"defaults:\n      run:\n        working-directory: other",
			"environment: other",
			"continue-on-error: false",
			"continue-on-error: true",
			"container: other",
			"strategy:\n      matrix:\n        node: [26]",
			"needs: other",
			"env:\n      NODE_OPTIONS: --import=other.mjs",
		])("refuses effective job execution overrides: %s", (field) => {
			expect(
				checkWorkflow(
					labelsFile,
					labelsChange("    runs-on:", `    ${field}\n    runs-on:`),
					toolchain,
				),
			).not.toEqual([]);
		});

		it.each([
			"Check out source",
			"Set up pnpm",
			"Set up Node",
			"Install locked dependencies",
			"Validate metadata",
			"Validate issue drafts and labels",
			"Synchronize approved labels",
		])("pins execution fields and token placement at the %s step", (name) => {
			for (const extra of [
				"if: false",
				"if: always()",
				"continue-on-error: true",
				"continue-on-error: false",
				"shell: sh",
				"working-directory: other",
				"environment: other",
				`env:\n          GH_TOKEN: \${{ github.token }}`,
				"env:\n          BASH_ENV: other.sh",
				"run: echo extra",
				`uses: ${pin("actions/cache")}`,
			]) {
				const source = labelsChange(
					`      - name: ${name}`,
					`      - name: ${name}\n        ${extra}`,
				);
				expect(checkWorkflow(labelsFile, source, toolchain), `${name}: ${extra}`).not.toEqual([]);
			}
		});

		it("requires exactly seven ordered steps without artifacts or an earlier token step", () => {
			for (const extra of [
				"      - run: echo extra\n",
				`      - uses: ${pin("actions/upload-artifact")}\n        with:\n          path: spikes/*/evidence/\n`,
				`      - uses: ${pin("actions/upload-artifact")}\n        with:\n          path: app.apk\n`,
				`      - env:\n          GH_TOKEN: \${{ github.token }}\n        run: echo earlier\n`,
			]) {
				for (const source of [
					labelsFixture + extra,
					labelsChange("    steps:\n", `    steps:\n${extra}`),
				]) {
					expect(checkWorkflow(labelsFile, source, toolchain)).not.toEqual([]);
				}
			}
			const install =
				"      - name: Install locked dependencies\n        run: pnpm install --frozen-lockfile\n";
			expect(checkWorkflow(labelsFile, labelsChange(install, ""), toolchain)).not.toEqual([]);
			const reordered = labelsFixture
				.replace(install, "")
				.replace("      - name: Check out source", `${install}      - name: Check out source`);
			expect(checkWorkflow(labelsFile, reordered, toolchain)).not.toEqual([]);
		});

		it.each(["actions/checkout", "pnpm/action-setup", "actions/setup-node"])(
			"retains existing action pins and version comments for %s",
			(action) => {
				for (const changed of [
					`${action}@v1`,
					`${action}@${"a".repeat(40)} # v1`,
					`${action}@${actionPins[action]?.[0]}`,
					`${action}@${actionPins[action]?.[0]} # v0`,
					pin("actions/cache"),
				])
					expect(
						checkWorkflow(labelsFile, labelsChange(pin(action), changed), toolchain),
					).not.toEqual([]);
			},
		);

		it.each(
			["__proto__", "'__proto__'", '"__proto__"', "extra"].flatMap((key) => [
				{
					name: `${key} job`,
					source: labelsChange(
						"jobs:\n",
						`jobs:\n  ${key}:\n    permissions: write-all\n    runs-on: ubuntu-24.04\n    steps:\n      - run: echo extra\n`,
					),
				},
				{
					name: `${key} environment entry`,
					source: labelsChange("env:\n", `env:\n  ${key}: \${{ github.token }}\n`),
				},
				{
					name: `${key} action input`,
					source: labelsChange(
						"          persist-credentials: false\n",
						`          persist-credentials: false\n          ${key}: x\n`,
					),
				},
			]),
		)("refuses extra labels fields under $name", ({ source }) => {
			expect(checkWorkflow(labelsFile, source, toolchain)).not.toEqual([]);
		});

		it("retains parser refusal of folded conditions, aliases and duplicate keys", () => {
			for (const source of [
				labelsChange("    if: ", "    if: >-\n      "),
				labelsChange("jobs:", "jobs: &jobs"),
				labelsChange("  sync-labels:", "  sync-labels:\n  sync-labels:"),
			])
				expect(checkWorkflow(labelsFile, source, toolchain)).not.toEqual([]);
		});
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
