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

describe("the native receipt execution contract", () => {
	const file = ".github/workflows/native-store.yml";
	const source = (): string => read(file).replaceAll("\r\n", "\n");
	it("admits only the complete owner-only native workflow and its one-day receipt upload", () => {
		expect(checkWorkflow(file, source(), toolchain)).toEqual([]);
	});
	it.each([
		["write permission", (text: string) => text.replace("contents: read", "contents: write")],
		[
			"another runner",
			(text: string) => text.replace("runs-on: macos-15", "runs-on: ubuntu-24.04"),
		],
		["another job", (text: string) => text.replace("  native-store:", "  other:")],
		["missing owner fence", (text: string) => text.replace("github.actor == 'nicksavov'", "true")],
		["another control ref", (text: string) => text.replace(`ref: \${{ github.sha }}`, "ref: m2")],
		[
			"changed admission",
			(text: string) => text.replace("native-store.ts admit", "native-store.ts run"),
		],
		[
			"changed verification",
			(text: string) => text.replace("native-store.ts verify-source", "native-store.ts admit"),
		],
		[
			"another source checkout",
			(text: string) => text.replace(`ref: \${{ steps.source.outputs.head }}`, "ref: m2"),
		],
		[
			"ignored native failure",
			(text: string) =>
				text.replace("        id: native", "        id: native\n        continue-on-error: true"),
		],
		["renamed producer", (text: string) => text.replace("id: native", "id: other")],
		[
			"unconditional upload",
			(text: string) =>
				text.replace(
					`\${{ success() && steps.native.outputs.receipt == 'ready' }}`,
					`\${{ always() }}`,
				),
		],
		[
			"missing readiness fence",
			(text: string) =>
				text.replace(
					`\${{ success() && steps.native.outputs.receipt == 'ready' }}`,
					`\${{ success() }}`,
				),
		],
		[
			"missing attempt identity",
			(text: string) =>
				text.replace(
					`native-store-receipt-\${{ github.run_id }}-\${{ github.run_attempt }}`,
					"native-store-receipt",
				),
		],
		[
			"raw native report",
			(text: string) =>
				text.replace(
					`path: \${{ runner.temp }}/native-store-receipt.json`,
					`path: \${{ runner.temp }}/native-store.json`,
				),
		],
		[
			"broader evidence path",
			(text: string) =>
				text.replace(
					`path: \${{ runner.temp }}/native-store-receipt.json`,
					"path: spikes/*/evidence/",
				),
		],
		[
			"extra upload path",
			(text: string) =>
				text.replace(
					`path: \${{ runner.temp }}/native-store-receipt.json`,
					`path: |\n            \${{ runner.temp }}/native-store-receipt.json\n            source/`,
				),
		],
		["longer retention", (text: string) => text.replace("retention-days: 1", "retention-days: 2")],
		[
			"missing-file success",
			(text: string) => text.replace("if-no-files-found: error", "if-no-files-found: warn"),
		],
		["another command", (text: string) => `${text}      - run: echo synthetic-extra\n`],
	] as const)("refuses %s", (_name, mutate) => {
		expect(checkWorkflow(file, mutate(source()), toolchain).join("\n")).toContain(
			"trusted native receipt contract",
		);
	});

	it("refuses the same receipt path outside the exact native workflow", () => {
		expect(
			checkWorkflow(".github/workflows/unrelated.yml", source(), toolchain).join("\n"),
		).toContain("trusted native receipt");
	});

	// The trusted gate runs first, and the same gate and pre-install check run with --root
	// on the admitted source before its install there.
	const gateStep =
		"      - name: Reserved paths and execution inputs\n        run: node tools/verify/gate.ts\n";
	const sourceGate =
		"      - name: Reserved paths and execution inputs of the source\n        run: node tools/verify/gate.ts --root source\n";
	const sourceCheck =
		"      - name: Pre-install script check of the source\n        run: node tools/verify/preinstall.ts --root source\n";
	const admit = "      - name: Admit the exact owner PR head\n";
	const admitted = "        run: node tools/ci-checks/src/native-store.ts admit\n";

	it("runs the gate first, and the gate and pre-install check on the source before its install", () => {
		const text = source();
		const at = (part: string): number => text.indexOf(part);
		expect([gateStep, sourceGate, sourceCheck].map((part) => text.split(part).length)).toEqual([
			2, 2, 2,
		]);
		expect(at(gateStep)).toBeLessThan(at(admit));
		expect(at("native-store.ts verify-source")).toBeLessThan(at(sourceGate));
		expect(at(sourceGate)).toBeLessThan(at(sourceCheck));
		expect(at(sourceCheck)).toBeLessThan(at("pnpm/action-setup@"));
	});

	it.each([
		["the gate removed", (text: string) => text.replace(gateStep, "")],
		[
			"the gate after the admission",
			(text: string) => text.replace(gateStep, "").replace(admitted, admitted + gateStep),
		],
		["the source gate removed", (text: string) => text.replace(sourceGate, "")],
		["the source check removed", (text: string) => text.replace(sourceCheck, "")],
		[
			"the source check without --root",
			(text: string) => text.replace("preinstall.ts --root source", "preinstall.ts"),
		],
		[
			"the checks in the other order",
			(text: string) => text.replace(sourceGate + sourceCheck, sourceCheck + sourceGate),
		],
	] as const)("refuses %s", (_name, mutate) => {
		const mutated = mutate(source());
		expect(mutated).not.toBe(source());
		expect(checkWorkflow(file, mutated, toolchain).join("\n")).toContain(
			"trusted native receipt contract",
		);
	});

	it("allows the second checkout and the source install only in the exact contract", () => {
		const elsewhere = checkWorkflow(".github/workflows/unrelated.yml", source(), toolchain);
		const install = "pnpm install --frozen-lockfile";
		expect(elsewhere).toEqual(
			expect.arrayContaining([
				expect.stringContaining("native-store must not check out again after the reserved gate"),
				expect.stringContaining(
					`native-store must run node tools/verify/preinstall.ts as the last command before ${install}`,
				),
				expect.stringContaining(`native-store's ${install} step may set only its name, if and run`),
			]),
		);
		// In the exact contract, the source install may not move to another folder either.
		const moved = source().replace("working-directory: source", "working-directory: other");
		expect(checkWorkflow(file, moved, toolchain).join("\n")).toContain(
			`native-store's ${install} step may set only its name, if and run`,
		);
	});
});

// The supervisor's dispatch keeps the same order: the trusted gate first, then the admitted source
// verified, and the same gate and pre-install check on it with --root before pnpm starts.
describe("the native supervisor's gate and its admitted source's checks", () => {
	const file = ".github/workflows/native-supervisor.yml";
	const source = (): string => read(file).replaceAll("\r\n", "\n");
	const gateStep =
		"      - name: Reserved paths and execution inputs\n        run: node tools/verify/gate.ts\n";
	const verification = [
		"      - name: Verify the source checkout",
		"        env:",
		`          NATIVE_SUPERVISOR_PR: \${{ steps.source.outputs.pr }}`,
		`          NATIVE_SUPERVISOR_HEAD: \${{ steps.source.outputs.head }}`,
		`          NATIVE_SUPERVISOR_CONTROL_SHA: \${{ inputs.controlSha }}`,
		"        run: node tools/ci-checks/src/native-supervisor.ts verify-source",
		"",
	].join("\n");
	const sourceGate =
		"      - name: Reserved paths and execution inputs of the source\n        run: node tools/verify/gate.ts --root source\n";
	const sourceCheck =
		"      - name: Pre-install script check of the source\n        run: node tools/verify/preinstall.ts --root source\n";
	const setup = `      - name: Set up pinned pnpm\n        uses: ${pin("pnpm/action-setup")}\n`;
	const admit = "      - name: Admit the exact owner PR head\n";
	const admitted = "        run: node tools/ci-checks/src/native-supervisor.ts admit\n";
	const contract =
		"native-supervisor.yml must exactly match the trusted native supervisor contract";

	it("runs the gate first, then the source's verification, gate and pre-install check before pnpm", () => {
		const text = source();
		expect(checkWorkflow(file, text, toolchain)).toEqual([]);
		const at = (part: string): number => text.indexOf(part);
		const parts = [gateStep, verification, sourceGate, sourceCheck, setup];
		expect(parts.map((part) => text.split(part).length)).toEqual([2, 2, 2, 2, 2]);
		expect(at(gateStep)).toBeLessThan(at(admit));
		expect(at(admitted)).toBeLessThan(at("          path: source\n"));
		expect(at("          path: source\n")).toBeLessThan(at(verification));
		expect(text).toContain(verification + sourceGate + sourceCheck + setup);
		expect(at(setup)).toBeLessThan(at("native-supervisor.ts run"));
	});

	it.each([
		["the gate removed", (text: string) => text.replace(gateStep, "")],
		[
			"the gate after the admission",
			(text: string) => text.replace(gateStep, "").replace(admitted, admitted + gateStep),
		],
		["the source verification removed", (text: string) => text.replace(verification, "")],
		[
			"the source gate before the verification",
			(text: string) => text.replace(verification + sourceGate, sourceGate + verification),
		],
		["the source gate removed", (text: string) => text.replace(sourceGate, "")],
		["the source check removed", (text: string) => text.replace(sourceCheck, "")],
		[
			"the source gate without --root",
			(text: string) => text.replace("gate.ts --root source", "gate.ts"),
		],
		[
			"the source check without --root",
			(text: string) => text.replace("preinstall.ts --root source", "preinstall.ts"),
		],
		[
			"the checks in the other order",
			(text: string) => text.replace(sourceGate + sourceCheck, sourceCheck + sourceGate),
		],
		[
			"pnpm set up before the checks",
			(text: string) =>
				text.replace(sourceGate + sourceCheck + setup, setup + sourceGate + sourceCheck),
		],
		[
			"an install in the source before its checks",
			(text: string) =>
				text.replace(
					sourceGate,
					`      - working-directory: source\n        run: pnpm install --frozen-lockfile\n${sourceGate}`,
				),
		],
	] as const)("refuses %s", (_name, mutate) => {
		const mutated = mutate(source());
		expect(mutated).not.toBe(source());
		expect(checkWorkflow(file, mutated, toolchain).join("\n")).toContain(contract);
	});

	it("allows the second checkout and its checks before pnpm only in the exact contract", () => {
		const elsewhere = checkWorkflow(".github/workflows/unrelated.yml", source(), toolchain);
		expect(elsewhere).toEqual(
			expect.arrayContaining([
				expect.stringContaining(
					"native-supervisor must not check out again after the reserved gate",
				),
				expect.stringContaining(
					"native-supervisor must run node tools/verify/preinstall.ts before pnpm/action-setup",
				),
			]),
		);
		expect(elsewhere.join("\n")).not.toContain(contract);
	});
});

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
      - name: Set up Node
        uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0
        with:
          node-version-file: .node-version
      - name: Reserved paths and execution inputs
        run: node tools/verify/gate.ts
      - name: Pre-install script check
        run: node tools/verify/preinstall.ts
      - name: Set up pnpm
        uses: pnpm/action-setup@ea17c68df8912ef543352723c149a84f56e3d413 # v6.1.0
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
const ciJobSource = (source: string, job: string): string => {
	const header = `\n  ${job}:\n`;
	const start = source.indexOf(header);
	if (start < 0 || start !== source.lastIndexOf(header)) throw new Error("missing unique CI job");
	// A comment at the job indent opens the next job.
	const next = source.slice(start + header.length).search(/\n {2}(?:#|[a-z][a-z0-9-]*:\n)/);
	return source.slice(start, next < 0 ? source.length : start + header.length + next);
};
const ciJobChange = (source: string, job: string, before: string, after: string): string => {
	const block = ciJobSource(source, job);
	if (!block.includes(before)) throw new Error("missing CI job mutation anchor");
	const changed = block.replace(before, after);
	if (changed === block) throw new Error("unchanged CI job mutation");
	return source.replace(block, changed);
};
const classifierOutputs = [
	["areas", `\${{ steps.areas.outputs.areas }}`],
	["docs-only", `\${{ steps.areas.outputs.docs-only }}`],
	["rust", `\${{ steps.areas.outputs.rust }}`],
	["spikes", `\${{ steps.areas.outputs.spikes }}`],
	["spike-matrix", `\${{ steps.shards.outputs.matrix }}`],
	["spike-count", `\${{ steps.shards.outputs.count }}`],
	["heavy", `\${{ steps.areas.outputs.heavy }}`],
	["template-smoke", `\${{ steps.areas.outputs.template-smoke || 'false' }}`],
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
		["heavy condition", "&& needs.changes.outputs.spike-count != '0'", "&& false"],
		["heavy condition removal", " && needs.changes.outputs.spike-count != '0'", ""],
		[
			"heavy condition inversion",
			"&& needs.changes.outputs.spike-count != '0'",
			"&& needs.changes.outputs.spike-count == '0'",
		],
		[
			"heavy command replacement",
			`node tools/verify/turbo.ts run test:heavy --concurrency=1 --log-order=stream --log-prefix=task "\${filters[@]}"`,
			"echo heavy-suite-disabled",
		],
		[
			"heavy serial flag removal",
			`node tools/verify/turbo.ts run test:heavy --concurrency=1 --log-order=stream --log-prefix=task "\${filters[@]}"`,
			`node tools/verify/turbo.ts run test:heavy --log-order=stream --log-prefix=task "\${filters[@]}"`,
		],
		["heavy parallel execution", "test:heavy --concurrency=1", "test:heavy --concurrency=2"],
		[
			"heavy echo prefix",
			`node tools/verify/turbo.ts run test:heavy --concurrency=1 --log-order=stream --log-prefix=task "\${filters[@]}"`,
			`echo node tools/verify/turbo.ts run test:heavy --concurrency=1 --log-order=stream --log-prefix=task "\${filters[@]}"`,
		],
		["heavy filter removal", ' "--filter=./$SPIKE"', ""],
		["heavy selection environment", `      SPIKE: \${{ matrix.spike }}`, "      SPIKE: ''"],
		[
			"Windows condition",
			"      - run: pnpm verify\n",
			"      - if: false\n        run: pnpm verify\n",
		],
		// The reserved jobs and the opted-in steps.
		[
			"reserved unit proof without the flag",
			"        env:\n          DRAFTYAK_RESERVED_TESTS: '1'\n        run: node tools/verify/reserved-proof.ts --tier unit\n",
			"        run: node tools/verify/reserved-proof.ts --tier unit\n",
		],
		[
			"Windows reserved unit proof without the flag",
			"Write-Output \"Docker engine platform: $dockerOs\"\n      - name: Opt-in reserved unit suites and their execution proof\n        env:\n          DRAFTYAK_RESERVED_TESTS: '1'\n",
			'Write-Output "Docker engine platform: $dockerOs"\n      - name: Opt-in reserved unit suites and their execution proof\n',
		],
		[
			"reserved proof replaced",
			"run: node tools/verify/reserved-proof.ts --tier unit",
			"run: echo reserved-proof-disabled",
		],
		[
			"inventory check removal",
			"        run: node tools/ci-checks/src/reserved-inventory.ts\n",
			"",
		],
		[
			"heavy proof without the flag",
			"        env:\n          DRAFTYAK_RESERVED_TESTS: '1'\n        run: |\n          node tools/verify/reserved-proof.ts --tier heavy",
			"        run: |\n          node tools/verify/reserved-proof.ts --tier heavy",
		],
		[
			"reserved job condition",
			"    if: needs.changes.outputs.docs-only != 'true'\n    runs-on: ubuntu-24.04\n    timeout-minutes: 15\n",
			"    if: false\n    runs-on: ubuntu-24.04\n    timeout-minutes: 15\n",
		],
		[
			"required without the reserved jobs",
			"needs: [changes, cheap, full, spikes, heavy, windows, macos, reserved, reserved-windows]",
			"needs: [changes, cheap, full, spikes, heavy, windows, macos]",
		],
		// The gate, the pre-install check and the commands they guard.
		[
			"changes gate removal",
			"      - name: Reserved paths and execution inputs\n        run: node tools/verify/gate.ts\n      - id: source\n        run: node tools/ci-checks/src/verification-receipt.ts capture\n      - id: areas\n",
			"      - id: source\n        run: node tools/ci-checks/src/verification-receipt.ts capture\n      - id: areas\n",
		],
		[
			"changes source replacement",
			"run: node tools/ci-checks/src/verification-receipt.ts capture",
			"run: echo source-disabled",
		],
		["changes areas replacement", "run: node tools/ci-checks/src/changes.ts", "run: echo areas"],
		[
			"changes areas input",
			`HEAD_SHA: \${{ github.event.pull_request.head.sha || github.sha }}`,
			"HEAD_SHA: unchecked",
		],
		[
			"full pre-install check removal",
			"      - name: Pre-install script check\n        run: node tools/verify/preinstall.ts\n",
			"",
		],
		[
			"cheap pre-install check condition",
			"        if: needs.changes.outputs.docs-only != 'true'\n        run: node tools/verify/preinstall.ts\n",
			"        if: false\n        run: node tools/verify/preinstall.ts\n",
		],
		[
			"required gate removal",
			"      - name: Reserved paths and execution inputs\n        run: node tools/verify/gate.ts\n      - name: Write verification receipt",
			"      - name: Write verification receipt",
		],
		["required receipt input", `CI_NEEDS: \${{ toJSON(needs) }}`, "CI_NEEDS: '{}'"],
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
		expect(Object.keys(ci)).toEqual([
			"changes",
			"cheap",
			"full",
			"spike-run",
			"spikes",
			"heavy",
			"windows",
			"macos",
			"reserved",
			"reserved-windows",
			"required",
		]);
		expect(ci.required).toMatchObject({
			if: "always()",
			name: `\${{ github.event.pull_request.draft && 'required (draft)' || 'required' }}`,
			needs: [
				"changes",
				"cheap",
				"full",
				"spikes",
				"heavy",
				"windows",
				"macos",
				"reserved",
				"reserved-windows",
			],
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
					{ run: "node tools/verify/gate.ts" },
					{ run: "node tools/ci-checks/src/pr-meta.ts" },
					{ run: 'node tools/vendor-guard/src/cli.ts --commits "$BASE_SHA..$HEAD_SHA"' },
					{ run: "node tools/ci-checks/src/commit-identity.ts" },
				],
			},
		});
		// Pin the job and whole validation steps: conditions, soft failure or input changes bypass checks.
		const prTitle = jobs("pr-title.yml")["pr-title"] as { steps: unknown[] };
		expect(Object.keys(prTitle)).toEqual(["runs-on", "timeout-minutes", "steps"]);
		expect(prTitle.steps.slice(3)).toEqual([
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

	it("opts only the reserved job's proof and the heavy proof into the reserved suites", () => {
		type Step = Record<string, unknown> & { env?: Record<string, unknown>; run?: string };
		type Job = { env?: Record<string, unknown>; if?: string; steps: Step[] };
		const parsed = (name: string) =>
			parseYaml(read(`.github/workflows/${name}`)).value as {
				env?: Record<string, unknown>;
				jobs: Record<string, Job>;
			};
		const ci = parsed("ci.yml");
		const flag = "DRAFTYAK_RESERVED_TESTS";
		// Ordinary jobs and steps run as every other checkout does, so lint, typecheck and the default
		// tests leave reserved suites out and their logs never hold one.
		const envs = [ci.env?.[flag], ...Object.values(ci.jobs).map((job) => job.env?.[flag])];
		expect(envs.filter((value) => value !== undefined)).toEqual([]);
		const flagged = Object.entries(ci.jobs).flatMap(([job, { steps }]) =>
			steps.filter((step) => step.env?.[flag] !== undefined).map((step) => ({ job, step })),
		);
		expect(flagged.map(({ job, step }) => [job, step.env?.[flag]])).toEqual([
			["spike-run", "1"],
			["reserved", "1"],
			["reserved-windows", "1"],
		]);
		expect(ci.jobs.cheap?.steps.at(-1)).toEqual({
			if: "needs.changes.outputs.docs-only != 'true'",
			run: "pnpm verify --profile cheap",
		});
		// Each shard proves its own spike's reserved heavy suites, from the job's matrix entry.
		const heavyProof = flagged[0]?.step;
		expect(heavyProof?.env).toEqual({ [flag]: "1" });
		expect(heavyProof?.if).toBeUndefined();
		expect(heavyProof?.run).toBe(
			'node tools/verify/reserved-proof.ts --tier heavy "--filter=./$SPIKE"\n',
		);
		expect(ci.jobs["spike-run"]?.env?.SPIKE).toBe(`\${{ matrix.spike }}`);
		// Its own job and log: after the gate, the inventory check, then the unit suites opted in with
		// their proof.
		const reserved = ci.jobs.reserved;
		expect(reserved?.if).toBe("needs.changes.outputs.docs-only != 'true'");
		expect(reserved?.steps[0]).toMatchObject({ with: { "fetch-depth": 0 } });
		expect(reserved?.steps.slice(4).map((step) => step.run ?? step.uses)).toEqual([
			"node tools/ci-checks/src/reserved-inventory.ts",
			"node tools/verify/preinstall.ts",
			expect.stringMatching(/^pnpm\/action-setup@/),
			"pnpm install --frozen-lockfile",
			"node tools/verify/reserved-proof.ts --tier unit",
		]);
		expect(reserved?.steps[4]).toMatchObject({
			if: "github.event_name == 'pull_request'",
			env: {
				BASE_SHA: `\${{ github.event.pull_request.base.sha || github.event.before }}`,
				BASE_REPO: `\${{ github.repository }}`,
				HEAD_REPO: `\${{ github.event.pull_request.head.repo.full_name }}`,
				HEAD_REF: `\${{ github.event.pull_request.head.ref }}`,
			},
		});
		const unitProof = {
			name: "Opt-in reserved unit suites and their execution proof",
			env: { [flag]: "1" },
			run: "node tools/verify/reserved-proof.ts --tier unit",
		};
		expect(reserved?.steps.at(-1)).toEqual(unitProof);
		// The same proof on Windows, wherever the windows job runs, after the same engine warm-up.
		const windows = ci.jobs.windows;
		const reservedWindows = ci.jobs["reserved-windows"];
		expect(reservedWindows).toMatchObject({ "runs-on": "windows-2025", if: windows?.if });
		expect(reservedWindows?.steps.at(-1)).toEqual(unitProof);
		const warmUp = (job: Job | undefined) =>
			job?.steps.find((step) => step.name === "Initialize the Windows container service");
		expect(warmUp(reservedWindows)).toEqual(warmUp(windows));
		expect(warmUp(windows)).toBeDefined();
		// spikes.yml: only the heavy command of a spike whose folder is reserved gets the flag.
		const spikes = parsed("spikes.yml");
		const spikeEnvs = [
			spikes.env?.[flag],
			...Object.values(spikes.jobs).flatMap((job) => [
				job.env?.[flag],
				...job.steps.map((step) => step.env?.[flag]),
			]),
		];
		expect(spikeEnvs.filter((value) => value !== undefined)).toEqual([]);
		const heavyStep = spikes.jobs.run?.steps.find((step) => step.name === "test:heavy");
		expect(String(heavyStep?.run)).toContain(
			'node reserved-tests.ts --reserved "spikes/$SPIKE" || reserved=$?',
		);
		expect(String(heavyStep?.run)).toContain(`heavy=(env ${flag}=1 "\${heavy[@]}")`);
		expect(String(heavyStep?.run).match(new RegExp(flag, "g"))?.length).toBe(1);
		// The flag never brings the live or device tier into a workflow.
		const scripts = files.flatMap((file) =>
			Object.values(parsed(path.basename(file)).jobs).flatMap((job) =>
				(job.steps ?? []).map((step) => String(step.run ?? "")),
			),
		);
		expect(
			scripts.filter((script) => /test:(?:live|device)|--(?:live|device)\b/.test(script)),
		).toEqual([]);
	});

	it("runs Windows on ready non-doc PRs and captures the tested source in every contributing job after its gate", () => {
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
			"needs.changes.outputs.docs-only != 'true' && (github.ref == 'refs/heads/main' || (github.event_name == 'pull_request' && !github.event.pull_request.draft) || (github.event_name != 'pull_request' && needs.changes.outputs.native-transport == 'true'))",
		);
		expect(ci.windows?.steps.find((step) => step.run === "pnpm verify")).toEqual({
			run: "pnpm verify",
			env: { TURBO_CONCURRENCY: "1" },
		});
		expect(ci.windows?.steps.at(-1)?.run).toBe(
			"pnpm exec node tools/ci-checks/src/native-transport.ts run",
		);
		for (const name of [
			"changes",
			"cheap",
			"full",
			"spikes",
			"heavy",
			"windows",
			"macos",
			"reserved",
			"reserved-windows",
		]) {
			const job = ci[name];
			expect(job?.outputs?.source, name).toBe(`\${{ steps.source.outputs.source }}`);
			const steps = job?.steps ?? [];
			expect(steps[0], name).toMatchObject({
				with: { ref: `\${{ github.sha }}`, "persist-credentials": false },
			});
			expect(steps[2], name).toEqual({
				name: "Reserved paths and execution inputs",
				run: "node tools/verify/gate.ts",
			});
			const capture = steps.findIndex((step) => step.id === "source");
			expect(capture, name).toBe(3);
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
		const required = ciJobSource(source, "required");
		expect(
			checkWorkflow(file, source.replace(required, mutate(required)), toolchain).join("\n"),
		).toContain("fixed CI receipt");
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
			}
			// spikes.yml may soften its job or an ordinary step.
			const file = ".github/workflows/spikes.yml";
			const spikes = read(file).replaceAll("\r\n", "\n");
			for (const mutated of [
				spikes.replace(
					"  run:\n    needs: plan\n",
					`  run:\n    continue-on-error: ${value}\n    needs: plan\n`,
				),
				spikes.replace(
					"      - name: fetch-node\n",
					`      - name: fetch-node\n        continue-on-error: ${value}\n`,
				),
			]) {
				expect(mutated).not.toBe(spikes);
				expect(checkWorkflow(file, mutated, toolchain)).toEqual([]);
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
			[
				...checkout,
				"- run: node tools/verify/gate.ts",
				...steps,
				...run("github.event_name"),
				...run("github.sha"),
			],
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
		it("admits the reviewed nine-step source, gated like every other job, without executing future commands", () => {
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
				"      - name: Install locked dependencies",
				"        with:\n          version: '11'\n      - name: Install locked dependencies",
			],
			[
				"gate removed",
				"      - name: Reserved paths and execution inputs\n        run: node tools/verify/gate.ts\n",
				"",
			],
			[
				"pre-install check removed",
				"      - name: Pre-install script check\n        run: node tools/verify/preinstall.ts\n",
				"",
			],
			[
				"pnpm set up before the check",
				"      - name: Pre-install script check\n        run: node tools/verify/preinstall.ts\n      - name: Set up pnpm\n        uses: pnpm/action-setup@ea17c68df8912ef543352723c149a84f56e3d413 # v6.1.0\n",
				"      - name: Set up pnpm\n        uses: pnpm/action-setup@ea17c68df8912ef543352723c149a84f56e3d413 # v6.1.0\n      - name: Pre-install script check\n        run: node tools/verify/preinstall.ts\n",
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
			"Reserved paths and execution inputs",
			"Pre-install script check",
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

		it("requires exactly nine ordered steps without artifacts or an earlier token step", () => {
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

describe("selected browser provisioning contract", () => {
	const file = ".github/workflows/ci.yml";
	it.each([
		["missing plan", "node tools/ci-checks/src/browser-setup.ts plan", "echo no-plan"],
		["wrong plan source", "id: browser-setup", "id: another-plan"],
		[
			"unconditional cache",
			"id: browser-cache\n        if: steps.browser-setup.outputs.required == 'true'",
			"id: browser-cache\n        if: true",
		],
		[
			"different cache path",
			"path: ${{ steps.browser-setup.outputs.path }}",
			"path: another-cache",
		],
		[
			"different lock cache key",
			"key: playwright-${{ runner.os }}-${{ runner.arch }}-${{ hashFiles('pnpm-lock.yaml') }}",
			"key: playwright-unlocked",
		],
		[
			"ignored setup failure",
			"run: node tools/ci-checks/src/browser-setup.ts install",
			"run: node tools/ci-checks/src/browser-setup.ts install || true",
		],
		[
			"cache-hit install bypass",
			"name: Install browser prerequisites\n        if: steps.browser-setup.outputs.required == 'true'",
			"name: Install browser prerequisites\n        if: steps.browser-cache.outputs.cache-hit != 'true'",
		],
	])("rejects %s in each heavy job", (_, before, after) => {
		const source = read(file).replaceAll("\r\n", "\n");
		for (const job of ["spike-run", "heavy"]) {
			const mutated = ciJobChange(source, job, before, after);
			expect(checkWorkflow(file, mutated, toolchain).join("\n"), job).toContain("must preserve");
		}
	});
	it("requires each browser cache between its plan and install", () => {
		const source = read(file).replaceAll("\r\n", "\n");
		for (const job of ["spike-run", "heavy"]) {
			const block = ciJobSource(source, job);
			const start = block.indexOf("      - name: Cache Playwright browsers\n");
			const end = block.indexOf("      - name: Install browser prerequisites\n", start);
			expect(start).toBeGreaterThan(0);
			expect(end).toBeGreaterThan(start);
			const cache = block.slice(start, end);
			const without = block.slice(0, start) + block.slice(end);
			// Move the whole action after browser installation, while keeping valid YAML.
			const heavyStart = without.indexOf("      - name: test:heavy");
			expect(heavyStart).toBeGreaterThan(0);
			const reordered = without.slice(0, heavyStart) + cache + without.slice(heavyStart);
			expect(reordered).not.toBe(block);
			expect(
				checkWorkflow(file, source.replace(block, reordered), toolchain).join("\n"),
				job,
			).toContain("must preserve the selected browser cache");
		}
	});
});

describe("authenticated offline Node provisioning contract", () => {
	const file = ".github/workflows/ci.yml";
	const source = () => read(file).replaceAll("\r\n", "\n");
	const preparation = (value: string, job: string): string => {
		const block = ciJobSource(value, job);
		const start = block.indexOf("      - name: Prepare authenticated offline Node fixture\n");
		const marker = "          NODE\n";
		const end = block.indexOf(marker, start);
		expect(start).toBeGreaterThan(0);
		expect(end).toBeGreaterThan(start);
		return block.slice(start, end + marker.length);
	};
	it("accepts authenticated preparation and both selected-heavy bindings", () => {
		expect(checkWorkflow(file, source(), toolchain)).toEqual([]);
	});
	it.each([
		[
			"extracted binary directory instead of version root",
			"const cache = path.join(process.env.DRAFTYAK_CACHE_DIR, 'node', bundled);",
			"const cache = path.join(process.env.DRAFTYAK_CACHE_DIR, 'node', bundled, 'linux-x64');",
		],
		[
			"fake preparation instead of the authenticated producer",
			"pnpm fetch-node --version bundled --platform linux --arch x64",
			"echo fake-offline-node",
		],
		[
			"ignored authenticated producer failure",
			"pnpm fetch-node --version bundled --platform linux --arch x64",
			"pnpm fetch-node --version bundled --platform linux --arch x64 || true",
		],
	])("rejects %s in both preparations", (_, before, after) => {
		const current = source();
		for (const job of ["spike-run", "heavy"]) {
			const block = preparation(current, job);
			const changed = block.replace(before, after);
			expect(changed).not.toBe(block);
			expect(
				checkWorkflow(file, current.replace(block, changed), toolchain).join("\n"),
				job,
			).toContain(`must preserve ${job} command and its execution controls`);
		}
	});
	it("does not skip the ordinary producer when no spike is selected", () => {
		const current = source();
		const mutated = ciJobChange(
			current,
			"heavy",
			"        id: offline-node\n",
			"        id: offline-node\n        if: needs.changes.outputs.spikes != ''\n",
		);
		expect(checkWorkflow(file, mutated, toolchain).join("\n")).toContain(
			"must preserve heavy command",
		);
	});
	it.each([
		[
			"offline version-root input",
			"          DRAFTYAK_TEST_NODE_CACHE: ${{ steps.offline-node.outputs.cache }}\n",
		],
		[
			"public scratch input",
			"          DRAFTYAK_CACHE_DIR: ${{ runner.temp }}/draftyak-node-scratch\n",
		],
	])("rejects missing selected-heavy %s", (_, binding) => {
		const current = source();
		for (const job of ["spike-run", "heavy"]) {
			const mutated = ciJobChange(current, job, binding, "");
			expect(checkWorkflow(file, mutated, toolchain).join("\n"), job).toContain(
				`must preserve ${job} command and its execution controls`,
			);
		}
	});
	it("requires each actual preparation before its heavy execution", () => {
		const current = source();
		for (const job of ["spike-run", "heavy"]) {
			const block = ciJobSource(current, job);
			const producer = preparation(current, job);
			const without = block.replace(producer, "");
			expect(
				checkWorkflow(file, current.replace(block, without), toolchain).join("\n"),
				job,
			).toContain(`must preserve ${job} command and its execution controls`);
			const marker = job === "spike-run" ? "      - id: receipt\n" : "      - id: complete\n";
			const afterHeavy = without.replace(marker, producer + marker);
			expect(afterHeavy).not.toBe(without);
			expect(
				checkWorkflow(file, current.replace(block, afterHeavy), toolchain).join("\n"),
				job,
			).toContain(`must preserve ${job} command and its execution controls`);
		}
	});
});

describe("one-task CI heavy shards", () => {
	const file = ".github/workflows/ci.yml";
	const source = () => read(file).replaceAll("\r\n", "\n");
	it("accepts the exact shard, collector and ordinary-heavy workflow", () => {
		expect(checkWorkflow(file, source(), toolchain)).toEqual([]);
	});
	it.each([
		["plan omission", "node tools/ci-checks/src/heavy-shards.ts plan", "echo no-shard-plan"],
		["plan identity", "id: shards", "id: other-shards"],
		["plan input", "SPIKES: ${{ steps.areas.outputs.spikes }}", "SPIKES: ''"],
		["conditional plan", "      - id: shards\n", "      - id: shards\n        if: false\n"],
	])("rejects changes-job %s", (_, before, after) => {
		expect(
			checkWorkflow(file, ciJobChange(source(), "changes", before, after), toolchain).join("\n"),
		).toContain("must preserve changes command");
	});
	it.each([
		["changed reported name", "name: Spike heavy (${{ matrix.id }})", "name: Other spike heavy"],
		[
			"path-valued reported name",
			"name: Spike heavy (${{ matrix.id }})",
			"name: Spike heavy (${{ matrix.spike }})",
		],
		[
			"protected reported name",
			"name: Spike heavy (${{ matrix.id }})",
			"name: required (${{ matrix.id }})",
		],
		["fail-fast", "fail-fast: false", "fail-fast: true"],
		["fanout bound", "max-parallel: 4", "max-parallel: 5"],
		[
			"matrix source",
			"fromJSON(needs.changes.outputs.spike-matrix)",
			"fromJSON(needs.changes.outputs.spikes)",
		],
		["strict skips", "DRAFTYAK_STRICT_SKIPS: '1'", "STRICT_SKIP: '1'"],
		["shard identity", "SHARD_ID: ${{ matrix.id }}", "SHARD_ID: arbitrary"],
		["single task", "SPIKE: ${{ matrix.spike }}", "SPIKE: ${{ needs.changes.outputs.spikes }}"],
		["selected plan", "SPIKES: ${{ needs.changes.outputs.spikes }}", "SPIKES: ''"],
		[
			"validation omission",
			"node tools/ci-checks/src/heavy-shards.ts validate",
			"echo no-validation",
		],
		[
			"conditional validation",
			"      - run: node tools/ci-checks/src/heavy-shards.ts validate",
			"      - if: false\n        run: node tools/ci-checks/src/heavy-shards.ts validate",
		],
		["Node version source", "node-version-file: .node-version", "node-version: latest"],
		["package setup", "cache: true", "cache: false"],
		["locked install", "pnpm install --frozen-lockfile", "pnpm install --no-frozen-lockfile"],
		["build omission", "run: pnpm build", "run: echo no-build"],
		["serial execution", "test:heavy --concurrency=1", "test:heavy --concurrency=2"],
		["one exact filter", '"--filter=./$SPIKE"', '"--filter=./spikes/*"'],
		["unquoted filter", '"--filter=./$SPIKE"', "--filter=./$SPIKE"],
		["completion step", "id: heavy-test", "id: other-heavy-test"],
		["receipt omission", "node tools/ci-checks/src/heavy-shards.ts receipt", "echo no-receipt"],
		["conditional receipt", "      - id: receipt\n", "      - id: receipt\n        if: false\n"],
		[
			"fabricated command outcome",
			"SHARD_COMMAND_RESULT: ${{ steps.heavy-test.outcome }}",
			"SHARD_COMMAND_RESULT: success",
		],
		[
			"conclusion instead of actual outcome",
			"steps.heavy-test.outcome",
			"steps.heavy-test.conclusion",
		],
		["upload directory", "path: ${{ steps.receipt.outputs.path }}", "path: ${{ runner.temp }}/"],
		[
			"extra upload path",
			"path: ${{ steps.receipt.outputs.path }}",
			"path: |\n            ${{ steps.receipt.outputs.path }}\n            another-file.json",
		],
		["missing receipt accepted", "if-no-files-found: error", "if-no-files-found: warn"],
		["long retention", "retention-days: 1", "retention-days: 2"],
		[
			"wrong artifact attempt",
			"ci-spike-${{ github.run_id }}-${{ github.run_attempt }}-${{ matrix.id }}",
			"ci-spike-${{ github.run_id }}-${{ matrix.id }}",
		],
		["nonstandard runner", "runs-on: ubuntu-24.04", "runs-on: ubuntu-latest"],
		["longer timeout", "timeout-minutes: 30", "timeout-minutes: 60"],
	])("rejects shard %s", (_, before, after) => {
		const mutated = ciJobChange(source(), "spike-run", before, after);
		expect(checkWorkflow(file, mutated, toolchain).join("\n")).toContain("must preserve");
	});
	it.each([
		["missing shard dependency", "needs: [changes, spike-run]", "needs: changes"],
		["collector result fence", "always() && needs.changes.result == 'success'", "always()"],
		[
			"success requirement omission",
			'if (process.env.SHARD_RESULT !== "success") process.exit(1)',
			"process.exit(0)",
		],
		[
			"fabricated job result",
			"SHARD_RESULT: ${{ needs.spike-run.result }}",
			"SHARD_RESULT: success",
		],
		[
			"wrong artifact attempt",
			"ci-spike-${{ github.run_id }}-${{ github.run_attempt }}-*",
			"ci-spike-${{ github.run_id }}-*",
		],
		[
			"broad artifact pattern",
			"pattern: ci-spike-${{ github.run_id }}-${{ github.run_attempt }}-*",
			"pattern: '*'",
		],
		["download omission", `uses: ${pin("actions/download-artifact")}`, "run: echo no-download"],
		["separate receipt folders", "merge-multiple: true", "merge-multiple: false"],
		["receipt directory", "path: ${{ runner.temp }}/spike-receipts", "path: another-receipts"],
		[
			"collection omission",
			"node tools/ci-checks/src/heavy-shards.ts collect",
			"echo no-collection",
		],
		["conditional collection", "      - id: collect\n", "      - id: collect\n        if: false\n"],
		["wrong collection plan", "SPIKES: ${{ needs.changes.outputs.spikes }}", "SPIKES: ''"],
		[
			"wrong collection directory",
			"SHARD_RECEIPTS: ${{ runner.temp }}/spike-receipts",
			"SHARD_RECEIPTS: another-receipts",
		],
		[
			"fabricated completion output",
			"completed: ${{ steps.collect.outputs.completed }}",
			"completed: '[]'",
		],
		[
			"wrong completed producer",
			"steps.collect.outputs.completed",
			"steps.source.outputs.completed",
		],
		["longer timeout", "timeout-minutes: 5", "timeout-minutes: 30"],
	])("rejects collector %s", (_, before, after) => {
		expect(
			checkWorkflow(file, ciJobChange(source(), "spikes", before, after), toolchain).join("\n"),
		).toContain("must preserve");
	});
	it("requires collection after the exact artifact download", () => {
		const current = source();
		const block = ciJobSource(current, "spikes");
		const start = block.indexOf("      - id: collect\n");
		expect(start).toBeGreaterThan(block.indexOf(pin("actions/download-artifact")));
		const collection = block.slice(start);
		const without = block.slice(0, start);
		const downloadAt = without.indexOf(`      - uses: ${pin("actions/download-artifact")}`);
		expect(downloadAt).toBeGreaterThan(0);
		const moved = without.slice(0, downloadAt) + collection + without.slice(downloadAt);
		expect(checkWorkflow(file, current.replace(block, moved), toolchain).join("\n")).toContain(
			"must preserve spikes command",
		);
	});
	it.each([
		["strict skips", "DRAFTYAK_STRICT_SKIPS: '1'", "DRAFTYAK_STRICT_SKIPS: '0'"],
		[
			"native filter leakage",
			"HEAVY: ${{ needs.changes.outputs.ordinary-heavy }}",
			"HEAVY: ${{ needs.changes.outputs.heavy }}",
		],
		[
			"smoke selection omitted",
			"          SMOKE: ${{ needs.changes.outputs.template-smoke == 'true' || github.ref == 'refs/heads/main' || github.base_ref == 'main' }}\n",
			"",
		],
		["smoke classifier ignored", "needs.changes.outputs.template-smoke == 'true'", "false"],
		["main push smoke omitted", " || github.ref == 'refs/heads/main'", ""],
		["main base smoke omitted", " || github.base_ref == 'main'", ""],
		["inverted smoke exclusion", 'if [ "$SMOKE" != true ]', 'if [ "$SMOKE" == true ]'],
		["missing template package guard", " && [ -f packages/create-plugin/package.json ]", ""],
		[
			"missing template exclusion",
			'            filters+=("--filter=!./packages/create-plugin")\n',
			"",
		],
		[
			"wrong template exclusion",
			'"--filter=!./packages/create-plugin"',
			'"--filter=!./packages/another-template"',
		],
		[
			"filter loss",
			'          while IFS= read -r filter; do filters+=("--filter=$filter"); done <<< "$HEAVY"\n',
			"",
		],
		["parallel execution", "test:heavy --concurrency=1", "test:heavy --concurrency=2"],
		[
			"fabricated completion",
			"HEAVY_COMMAND_RESULT: ${{ steps.heavy-test.outcome }}",
			"HEAVY_COMMAND_RESULT: success",
		],
		[
			"missing completion refusal",
			"          if (process.env.HEAVY_COMMAND_RESULT !== 'success') process.exit(1);\n",
			"",
		],
		[
			"fabricated completed output",
			"completed: ${{ steps.complete.outputs.completed }}",
			"completed: '[]'",
		],
		["longer timeout", "timeout-minutes: 30", "timeout-minutes: 60"],
	])("rejects ordinary-heavy %s", (_, before, after) => {
		expect(
			checkWorkflow(file, ciJobChange(source(), "heavy", before, after), toolchain).join("\n"),
		).toContain("must preserve");
	});
	it("requires receipts and ordinary completion after the actual command", () => {
		const current = source();
		for (const [job, marker] of [
			["spike-run", "      - id: receipt\n"],
			["heavy", "      - id: complete\n"],
		] as const) {
			const block = ciJobSource(current, job);
			const start = block.indexOf(marker);
			expect(start).toBeGreaterThan(block.indexOf("        id: heavy-test\n"));
			const nextStep = block.indexOf("\n      - ", start + marker.length);
			const end = nextStep < 0 ? block.length : nextStep + 1;
			const completion = block.slice(start, end);
			const without = block.replace(completion, "");
			const heavyAt = without.indexOf("      - name: test:heavy");
			expect(heavyAt).toBeGreaterThan(0);
			const mutated = current.replace(
				block,
				without.slice(0, heavyAt) + completion + without.slice(heavyAt),
			);
			expect(checkWorkflow(file, mutated, toolchain).join("\n"), job).toContain(
				`must preserve ${job} command`,
			);
		}
	});
	it.each(["spike-run", "heavy"])("keeps selected Rust setup/cache before install in %s", (job) => {
		const current = source();
		const rust = `      - uses: ${pin("dtolnay/rust-toolchain")}\n        if: needs.changes.outputs.rust != ''\n        with:\n          toolchain: ${toolchain}\n          components: clippy, rustfmt\n`;
		const cache = `      - uses: ${pin("Swatinem/rust-cache")}\n        if: needs.changes.outputs.rust != ''\n        with:\n          workspaces: \${{ needs.changes.outputs.rust }}\n`;
		for (const [before, after] of [
			[rust, ""],
			[cache, ""],
			[rust, rust.replace("if: needs.changes.outputs.rust != ''", "if: false")],
			[cache, cache.replace("${{ needs.changes.outputs.rust }}", "crates/unselected")],
		] as const) {
			expect(
				checkWorkflow(file, ciJobChange(current, job, before, after), toolchain).join("\n"),
			).toContain("must preserve selected Rust setup and cache");
		}
		const block = ciJobSource(current, job);
		const without = block.replace(rust + cache, "");
		expect(without).not.toBe(block);
		const moved = without.replace(
			"      - run: pnpm build\n",
			"      - run: pnpm build\n" + rust + cache,
		);
		expect(checkWorkflow(file, current.replace(block, moved), toolchain).join("\n")).toContain(
			"must preserve selected Rust setup and cache",
		);
	});
	it.each(["full", "spikes", "windows", "macos"])(
		"rejects misplaced heavy execution in %s",
		(job) => {
			const current = source();
			const block = ciJobSource(current, job);
			const mutated = current.replace(
				block,
				block +
					'      - run: node tools/verify/turbo.ts run test:heavy --concurrency=1 "--filter=./spikes/extra"\n',
			);
			expect(checkWorkflow(file, mutated, toolchain).join("\n")).toContain(
				"test:heavy must preserve the selected shard or ordinary-heavy command",
			);
		},
	);
	it.each(["spikes", "heavy"])("keeps %s in the required collector dependencies", (job) => {
		const current = source();
		const mutated = ciJobChange(current, "required", `, ${job}`, "");
		expect(checkWorkflow(file, mutated, toolchain).join("\n")).toContain(
			"must preserve required job execution controls",
		);
	});
});

// Every job that runs a command, in any workflow, runs the reserved gate first, and the
// pre-install check is the last command before each install. Each refusal starts from the real
// file, which passes.
describe("the reserved gate and the pre-install check in workflows", () => {
	const ciFile = ".github/workflows/ci.yml";
	const spikesFile = ".github/workflows/spikes.yml";
	const prTitleFile = ".github/workflows/pr-title.yml";
	const dcoFile = ".github/workflows/dco.yml";
	const nightlyFile = ".github/workflows/nightly.yml";
	const securityFile = ".github/workflows/security.yml";
	const ci = read(ciFile).replaceAll("\r\n", "\n");
	const spikes = read(spikesFile).replaceAll("\r\n", "\n");
	const prTitle = read(prTitleFile).replaceAll("\r\n", "\n");
	const dco = read(dcoFile).replaceAll("\r\n", "\n");
	const nightly = read(nightlyFile).replaceAll("\r\n", "\n");
	const security = read(securityFile).replaceAll("\r\n", "\n");
	const sources = new Map([
		[ciFile, ci],
		[spikesFile, spikes],
		[prTitleFile, prTitle],
		[dcoFile, dco],
		[nightlyFile, nightly],
		[securityFile, security],
	]);
	const sourceOf = (file: string): string => sources.get(file) ?? "";
	const gate = "node tools/verify/gate.ts";
	const preinstall = "node tools/verify/preinstall.ts";
	const install = "pnpm install --frozen-lockfile";
	const gateStep = `      - name: Reserved paths and execution inputs\n        run: ${gate}\n`;
	const captureStep =
		"      - id: source\n        run: node tools/ci-checks/src/verification-receipt.ts capture\n";
	const preinstallStep = `      - name: Pre-install script check\n        run: ${preinstall}\n`;
	const cheapPreinstall = `      - name: Pre-install script check\n        if: needs.changes.outputs.docs-only != 'true'\n        run: ${preinstall}\n`;
	const installStep = `      - run: ${install}\n`;
	const cheapInstall = `      - if: needs.changes.outputs.docs-only != 'true'\n        run: ${install}\n`;
	const census = `install commands must be exactly ${install}, or the reviewed Intel macOS pnpm step`;
	const ciJobs = [
		"changes",
		"cheap",
		"full",
		"spike-run",
		"spikes",
		"heavy",
		"windows",
		"macos",
		"reserved",
		"reserved-windows",
		"required",
	];
	// Every job of the real workflows that runs a command; zizmor.yml's job uses actions alone.
	const gatedJobs: readonly (readonly [string, string])[] = [
		...ciJobs.map((id) => [ciFile, id] as const),
		[spikesFile, "plan"],
		[spikesFile, "run"],
		[prTitleFile, "pr-title"],
		[dcoFile, "dco"],
		[nightlyFile, "approval-binding"],
		[securityFile, "approval-binding"],
	];
	const installs = [
		[ciFile, "cheap", cheapInstall, cheapPreinstall],
		[ciFile, "full", installStep, preinstallStep],
		[ciFile, "spike-run", installStep, preinstallStep],
		[ciFile, "heavy", installStep, preinstallStep],
		[ciFile, "windows", installStep, preinstallStep],
		[ciFile, "macos", installStep, preinstallStep],
		[ciFile, "reserved", installStep, preinstallStep],
		[ciFile, "reserved-windows", installStep, preinstallStep],
		[spikesFile, "run", installStep, preinstallStep],
		[nightlyFile, "approval-binding", installStep, preinstallStep],
		[securityFile, "approval-binding", installStep, preinstallStep],
	] as const;
	const problems = (file: string, source: string): string =>
		checkWorkflow(file, source, toolchain).join("\n");
	const first = (job: string): string =>
		`${job} must run the reserved gate (${gate}) first; only ${
			job === "run"
				? "checkout, setup-node and its reviewed start steps"
				: "checkout and setup-node"
		} may come before it`;
	// Replaces the first `before` inside one job of a workflow.
	const inJob = (source: string, job: string, before: string, after: string): string => {
		// After `jobs:`, since `defaults:` has a `run:` key too.
		const start = source.indexOf(`\n  ${job}:\n`, source.indexOf("\njobs:\n"));
		expect(start, job).toBeGreaterThan(0);
		const next = source.slice(start + 1).search(/\n {2}[\w-]+:\n/);
		const end = next < 0 ? source.length : start + 1 + next;
		const mutated = source.slice(start, end).replace(before, after);
		expect(mutated, `${job}: ${before}`).not.toBe(source.slice(start, end));
		return source.slice(0, start) + mutated + source.slice(end);
	};
	// A job `a` in another workflow: a checkout and the gate, then these lines.
	const job = (...lines: string[]): string =>
		workflow(pr, [...checkout, `- run: ${gate}`, ...lines]);
	const label = (step: Record<string, unknown>): string => {
		if (step.uses !== undefined) return String(step.uses).replace(/@.*/, "");
		const known: Record<string, string> = {
			[gate]: "gate",
			[preinstall]: "pre-install check",
			[install]: "install",
			"node tools/ci-checks/src/verification-receipt.ts capture": "source",
		};
		return known[String(step.run)] ?? String(step.id ?? step.name ?? step.run);
	};
	type Steps = { jobs: Record<string, { steps: Record<string, unknown>[] }> };

	it("passes the real ci.yml, spikes.yml, pr-title.yml, dco.yml, nightly.yml and security.yml", () => {
		for (const [file, source] of sources) expect(problems(file, source), file).toBe("");
	});

	it("orders every ci.yml job: the gate first, the pre-install check before pnpm", () => {
		const { jobs } = parseYaml(ci).value as Steps;
		const head = ["actions/checkout", "actions/setup-node", "gate"];
		const pnpm = ["pre-install check", "pnpm/action-setup"];
		const warmUp = "Initialize the Windows container service";
		const unitProof = "Opt-in reserved unit suites and their execution proof";
		const platform = "Require the selected native platform";
		const rust = ["dtolnay/rust-toolchain", "Swatinem/rust-cache"];
		const prepare = [
			"offline-node",
			"browser-setup",
			"actions/cache",
			"Install browser prerequisites",
		];
		expect(
			Object.fromEntries(Object.entries(jobs).map(([id, { steps }]) => [id, steps.map(label)])),
		).toEqual({
			changes: [...head, "source", "areas", "native", "shards"],
			cheap: [
				...head,
				"source",
				"Docs-only checks, without an install",
				...pnpm,
				"actions/cache",
				"install",
				"pnpm verify --profile cheap",
			],
			full: [
				...head,
				"source",
				platform,
				...pnpm,
				"actions/cache",
				...rust,
				"install",
				"pnpm build",
				"native",
			],
			"spike-run": [
				...head,
				"node tools/ci-checks/src/heavy-shards.ts validate",
				...pnpm,
				"actions/cache",
				...rust,
				"install",
				"pnpm build",
				...prepare,
				"heavy-test",
				"Opt-in heavy suites in the touched spikes",
				"receipt",
				"actions/upload-artifact",
			],
			spikes: [
				...head,
				"source",
				"Require every shard to succeed",
				"actions/download-artifact",
				"collect",
			],
			heavy: [
				...head,
				"source",
				...pnpm,
				"actions/cache",
				...rust,
				"install",
				"pnpm build",
				...prepare,
				"heavy-test",
				"complete",
			],
			windows: [
				...head,
				"source",
				platform,
				...rust,
				...pnpm,
				"actions/cache",
				"install",
				warmUp,
				"pnpm verify",
				"native",
			],
			macos: [...head, "source", platform, ...pnpm, ...rust, "install", "native"],
			reserved: [
				...head,
				"source",
				"Reserved-test inventory against the base",
				...pnpm,
				"install",
				unitProof,
			],
			"reserved-windows": [...head, "source", ...pnpm, "install", warmUp, unitProof],
			required: [
				...head,
				"Write verification receipt and enforce required jobs",
				"actions/upload-artifact",
			],
		});
	});

	it("runs spikes.yml's gate after the run job's start steps and before pnpm, and its check right before the install", () => {
		const { jobs } = parseYaml(spikes).value as Steps;
		expect(jobs.plan?.steps.map(label)).toEqual([
			"actions/checkout",
			"actions/setup-node",
			"gate",
			"plan",
		]);
		const steps = jobs.run?.steps.map(label) ?? [];
		const at = (name: string): number => steps.indexOf(name);
		expect(steps.slice(0, at("gate") + 1)).toEqual([
			"start",
			"actions/checkout",
			"Test the item's commit, below the one that adds spikes/run.json",
			"Clear the committed evidence, so the artifact holds only this job's",
			"Turn off Spotlight indexing (macOS)",
			"actions/setup-node",
			"gate",
		]);
		// The pre-install check right after the gate, before pnpm starts, and again last before the
		// install.
		const last = steps.lastIndexOf("pre-install check");
		expect(at("pre-install check")).toBe(at("gate") + 1);
		expect(at("pre-install check")).toBeLessThan(at("pnpm/action-setup"));
		expect(at("pnpm/action-setup")).toBeLessThan(
			at("Install pnpm from .github/pnpm-js (Intel macOS)"),
		);
		expect(at("Docker engine")).toBeLessThan(last);
		expect(at("install")).toBe(last + 1);
		expect(at("heavy")).toBeGreaterThan(at("install"));
	});

	it("runs the approval binding workflows' gate after setup-node, and their check before pnpm", () => {
		for (const source of [nightly, security]) {
			const steps = (parseYaml(source).value as Steps).jobs["approval-binding"]?.steps ?? [];
			expect(steps.map(label)).toEqual([
				"actions/checkout",
				"actions/setup-node",
				"gate",
				"pre-install check",
				"pnpm/action-setup",
				"install",
				"pnpm build --filter=@draftyak/hub...",
				"Check approval statement binding",
			]);
		}
	});

	it("keeps the approval binding workflows' env names to those two workflows", () => {
		const names = "  CI: 'true'\n  DRAFTYAK_APPROVAL_BINDING_RUNS: '1'\n";
		for (const [file, source] of sources) {
			if (file === nightlyFile || file === securityFile) continue;
			const mutated = source.replace(topEnv, `${topEnv}${names}`);
			expect(mutated, file).not.toBe(source);
			expect(problems(file, mutated), file).toContain(
				"env may hold only DO_NOT_TRACK and TURBO_TELEMETRY_DISABLED, since each reserved gate step inherits it",
			);
		}
		for (const file of [nightlyFile, securityFile]) {
			const moved = inJob(
				sourceOf(file),
				"approval-binding",
				"    runs-on:",
				"    env:\n      CI: 'true'\n    runs-on:",
			);
			expect(problems(file, moved), file).toContain(
				"approval-binding must not set env, since its reserved gate step inherits it",
			);
		}
	});

	it("runs pr-title.yml's and dco.yml's checks only after their gate", () => {
		const head = ["actions/checkout", "actions/setup-node", "gate"];
		const steps = (source: string, id: string) =>
			(parseYaml(source).value as Steps).jobs[id]?.steps ?? [];
		expect(steps(prTitle, "pr-title").map(label)).toEqual([
			...head,
			"node tools/ci-checks/src/pr-meta.ts",
			'node tools/vendor-guard/src/cli.ts --commits "$BASE_SHA..$HEAD_SHA"',
			"node tools/ci-checks/src/commit-identity.ts",
		]);
		expect(steps(dco, "dco").map(label)).toEqual([...head, "node tools/ci-checks/src/dco.ts"]);
		for (const [source, id] of [
			[prTitle, "pr-title"],
			[dco, "dco"],
		] as const) {
			expect(steps(source, id)[2], id).toEqual({
				name: "Reserved paths and execution inputs",
				run: gate,
			});
		}
	});

	it.each([
		[prTitleFile, "pr-title", "        run: node tools/ci-checks/src/commit-identity.ts\n"],
		[dcoFile, "dco", "        run: node tools/ci-checks/src/dco.ts\n"],
	] as const)(
		"refuses %s's %s job without its gate, or with the gate after its checks",
		(file, id, last) => {
			const source = sourceOf(file);
			expect(problems(file, source)).toBe("");
			const dropped = inJob(source, id, gateStep, "");
			expect(problems(file, dropped)).toContain(first(id));
			const moved = inJob(dropped, id, last, last + gateStep);
			expect(problems(file, moved)).toContain(first(id));
		},
	);

	it("needs the gate in any workflow's job that runs a command, but not in a job of actions alone", () => {
		const command = "- run: node tools/x.ts";
		expect(checkWorkflow("x.yml", job(command), toolchain)).toEqual([]);
		for (const steps of [[...checkout, command], [command]]) {
			expect(checkWorkflow("x.yml", workflow(pr, steps), toolchain).join("\n")).toContain(
				first("a"),
			);
		}
		const zizmor = [`- uses: ${pin("zizmorcore/zizmor-action")}`, "  with:", "    inputs: .github"];
		expect(checkWorkflow("x.yml", workflow(pr, [...checkout, ...zizmor]), toolchain)).toEqual([]);
		expect(
			checkWorkflow(
				".github/workflows/zizmor.yml",
				read(".github/workflows/zizmor.yml"),
				toolchain,
			),
		).toEqual([]);
	});

	it.each(ciJobs.filter((id) => id !== "required" && id !== "spike-run"))(
		"refuses ci.yml's %s capturing its source before its gate",
		(id) => {
			expect(problems(ciFile, ci)).toBe("");
			const mutated = inJob(ci, id, gateStep + captureStep, captureStep + gateStep);
			expect(problems(ciFile, mutated)).toContain(first(id));
		},
	);

	it("refuses the required job's receipt before its gate, since it runs on refused trees too", () => {
		const report = "        run: node tools/ci-checks/src/verification-receipt.ts report\n";
		const mutated = inJob(
			inJob(ci, "required", gateStep, ""),
			"required",
			report,
			report + gateStep,
		);
		const found = problems(ciFile, mutated);
		expect(found).toContain(first("required"));
		expect(found).toContain(
			"must preserve required command and its execution controls: node tools/ci-checks/src/verification-receipt.ts report",
		);
	});

	it.each([
		["a command before the gate", (step: string) => `      - run: echo first\n${step}`],
		[
			"pnpm/action-setup before the gate",
			(step: string) =>
				`      - uses: ${pin("pnpm/action-setup")}\n        with:\n          cache: true\n${step}`,
		],
		[
			"a cache restored before the gate",
			(step: string) =>
				`      - uses: ${pin("actions/cache")}\n        with:\n          path: .turbo/cache\n          key: x\n${step}`,
		],
		["no gate", (_: string) => ""],
		["a gate with other arguments", (step: string) => step.replace(gate, `${gate} --names`)],
	])("refuses a job with %s", (_, mutate) => {
		for (const [file, id] of gatedJobs) {
			const mutated = inJob(sourceOf(file), id, gateStep, mutate(gateStep));
			expect(problems(file, mutated), `${file} ${id}`).toContain(first(id));
		}
	});

	it.each([
		["a condition", "        if: false\n"],
		["a soft failure", "        continue-on-error: true\n"],
		["an environment", "        env:\n          NODE_OPTIONS: --require ./x.cjs\n"],
		["a shell", "        shell: sh\n"],
		["a working directory", "        working-directory: tools\n"],
	])("refuses a gate step with %s", (_, line) => {
		for (const [file, id] of [
			[ciFile, "changes"],
			[ciFile, "required"],
			[spikesFile, "plan"],
			[spikesFile, "run"],
			[prTitleFile, "pr-title"],
			[dcoFile, "dco"],
		] as const) {
			expect(problems(file, sourceOf(file)), id).toBe("");
			const mutated = inJob(sourceOf(file), id, gateStep, gateStep + line);
			expect(problems(file, mutated), id).toContain(
				`${id}'s reserved gate step may set only its name and run, with no if, env or continue-on-error`,
			);
		}
	});

	const late = (id: string): string =>
		`${id}'s steps after the reserved gate may not use always(), failure() or cancelled(), or success() other than first before &&, except its reviewed ones`;

	it.each([
		"always()",
		"failure()",
		"cancelled()",
		`\${{ !cancelled() }}`,
		`\${{ always() }}`,
		"success() || failure()",
		"Always ()",
		// success() inverted, or not the whole condition's first conjunct, runs after a failure too.
		`\${{ !success() }}`,
		`\${{ success() || true }}`,
		`\${{ success() == false }}`,
		`\${{ !(success()) }}`,
		"success() && always()",
		"success() && steps.a.outputs.b == 'x' || true",
		"(success() && true) || true",
		`\${{ success() }} && true`,
		"Success () || true",
	])(
		"refuses a step after the gate that runs with %s, in every job that runs a command",
		(when) => {
			const step = `      - if: ${when}\n        run: node tools/x.ts\n`;
			for (const [file, id] of gatedJobs) {
				expect(problems(file, sourceOf(file)), `${file} ${id}`).toBe("");
				const mutated = inJob(sourceOf(file), id, gateStep, gateStep + step);
				expect(problems(file, mutated), `${file} ${id}`).toContain(late(id));
			}
			const action = [`- uses: ${pin("actions/cache")}`, `  if: ${when}`, "  with:", "    path: x"];
			expect(checkWorkflow("x.yml", job(...action, "    key: y"), toolchain).join("\n")).toContain(
				late("a"),
			);
		},
	);

	it("refuses an install, or its check, that runs after a failure in any workflow", () => {
		for (const when of ["always()", "failure()", `\${{ !cancelled() }}`]) {
			for (const lines of [
				[`- run: ${preinstall}`, `- if: ${when}`, `  run: ${install}`],
				[`- if: ${when}`, `  run: ${preinstall}`, `- if: ${when}`, `  run: ${install}`],
			]) {
				const found = checkWorkflow("x.yml", job(...lines), toolchain);
				expect(found.length, when).toBeGreaterThan(0);
				expect(
					found.every((problem) => problem.endsWith(late("a"))),
					when,
				).toBe(true);
			}
		}
	});

	it("accepts later steps that run only on success, whatever their condition names", () => {
		for (const when of [
			"success()",
			`\${{ success() }}`,
			"success() && steps.heavy.outcome == 'failure'",
			`\${{ success() && (steps.a.outcome == 'success' || steps.b.outcome == 'skipped') }}`,
			"success() && steps.a.outputs.b == 'it''s || (not a status call()'",
			"steps.heavy.outcome == 'failure'",
			"github.event.action != 'cancelled'",
			"inputs.always == 'x'",
		]) {
			const lines = [`- if: ${when}`, "  run: node tools/x.ts"];
			expect(checkWorkflow("x.yml", job(...lines), toolchain), when).toEqual([]);
		}
	});

	it.each([
		[
			ciFile,
			"required",
			"        if: always()\n        uses: actions/upload-artifact@",
			"        if: always() || true\n        uses: actions/upload-artifact@",
		],
		[
			spikesFile,
			"run",
			"run: node tools/ci-checks/src/spikes-run.ts --check-evidence\n",
			"run: node tools/ci-checks/src/spikes-run.ts --check-evidence && node tools/x.ts\n",
		],
		[
			spikesFile,
			"run",
			"        if: always() && steps.evidence.outcome == 'success'\n",
			"        if: always()\n",
		],
		[
			spikesFile,
			"run",
			'          echo "$line"\n',
			'          echo "$line"\n          node tools/x.ts\n',
		],
	] as const)(
		"accepts %s's reviewed %s step that runs after a failure only as it is",
		(file, id, before, after) => {
			expect(problems(file, sourceOf(file))).toBe("");
			expect(problems(file, inJob(sourceOf(file), id, before, after))).toContain(late(id));
		},
	);

	it("refuses a checkout after the gate, which would test a tree the gate never saw", () => {
		const again = `      - uses: ${pin("actions/checkout")}\n        with:\n          persist-credentials: false\n          ref: other\n`;
		for (const id of ["cheap", "required"]) {
			const mutated = inJob(ci, id, gateStep, gateStep + again);
			expect(problems(ciFile, mutated)).toContain(
				`${id} must not check out again after the reserved gate`,
			);
		}
		const mutated = inJob(spikes, "run", installStep, again + installStep);
		expect(problems(spikesFile, mutated)).toContain(
			"run must not check out again after the reserved gate",
		);
	});

	it("refuses a git command after the gate that changes the working tree, which would test a tree the gate never saw", () => {
		const message = (id: string): string =>
			`${id} must not change its working tree with git after the reserved gate`;
		const step = (command: string): string => `      - run: ${command}\n`;
		const fetched = step(
			"git fetch --depth=1 origin main && git checkout --quiet --detach FETCH_HEAD",
		);
		for (const id of ["cheap", "required"]) {
			expect(problems(ciFile, inJob(ci, id, gateStep, gateStep + fetched))).toContain(message(id));
		}
		for (const command of [
			"git checkout --quiet --detach HEAD^",
			"git -C . reset --hard HEAD^",
			"git -c core.autocrlf=true restore .",
			"git switch -",
			"git stash pop",
			"git worktree add ../w",
			"git apply x.patch",
			"git submodule update --init",
			"echo x && git pull --ff-only",
		]) {
			const mutated = inJob(ci, "reserved", installStep, installStep + step(command));
			expect([command, problems(ciFile, mutated).includes(message("reserved"))]).toEqual([
				command,
				true,
			]);
		}
		expect(
			problems(spikesFile, inJob(spikes, "run", installStep, installStep + fetched)),
		).toContain(message("run"));
		// A git command that only reads leaves the tree as the gate saw it.
		const reads = step("git diff --name-only HEAD^ HEAD && git log -1 --format=%H");
		expect(problems(ciFile, inJob(ci, "reserved", installStep, installStep + reads))).not.toContain(
			message("reserved"),
		);
	});

	it.each([
		[
			"a changed start step",
			'run: echo "at=$(date +%s)" >> "$GITHUB_OUTPUT"',
			'run: echo "at=$(date +%s)" >> "$GITHUB_OUTPUT"; node tools/x.ts',
		],
		[
			"a start step with an environment",
			"      - name: Clear the committed evidence, so the artifact holds only this job's\n",
			"      - name: Clear the committed evidence, so the artifact holds only this job's\n        env:\n          GIT_CONFIG_PARAMETERS: x\n",
		],
		["a start step without its condition", "        if: runner.os == 'macOS'\n", ""],
	])("refuses spikes.yml's run job with %s before the gate", (_, before, after) => {
		expect(problems(spikesFile, spikes)).toBe("");
		expect(problems(spikesFile, inJob(spikes, "run", before, after))).toContain(first("run"));
	});

	it.each(installs)(
		"refuses a command between the pre-install check and the install in %s's %s",
		(file, id, step) => {
			expect(problems(file, sourceOf(file))).toBe("");
			const mutated = inJob(sourceOf(file), id, step, `      - run: echo between\n${step}`);
			expect(problems(file, mutated)).toContain(
				`${id} must run ${preinstall} as the last command before ${install}`,
			);
		},
	);

	it.each(installs)("refuses %s's %s without its pre-install check", (file, id, _, check) => {
		const mutated = inJob(sourceOf(file), id, check, "");
		expect(problems(file, mutated)).toContain(
			`${id} must run ${preinstall} as the last command before ${install}`,
		);
	});

	it.each(installs.filter(([file]) => file === ciFile))(
		"refuses %s's %s with its pre-install check after pnpm/action-setup",
		(file, id, step, check) => {
			const moved = inJob(inJob(ci, id, check, ""), id, step, check + step);
			const found = problems(file, moved);
			expect(found).toContain(`${id} must run ${preinstall} before pnpm/action-setup`);
			expect(found).not.toContain("as the last command before");
		},
	);

	const spikesSetup = `      - uses: ${pin("pnpm/action-setup")}\n        if: runner.os != 'macOS' || runner.arch != 'X64'\n        with:\n          cache: \${{ github.ref == 'refs/heads/main' }}\n`;
	const earlyCheck = `      # pnpm/action-setup starts pnpm in this checkout, so the pre-install check runs before it too.\n      - name: Pre-install script check before pnpm starts\n        run: ${preinstall}\n`;

	it("refuses spikes.yml's run job setting up pnpm before its gate", () => {
		expect(spikes).toContain(gateStep + earlyCheck + spikesSetup);
		const mutated = spikes.replace(
			gateStep + earlyCheck + spikesSetup,
			spikesSetup + gateStep + earlyCheck,
		);
		expect(problems(spikesFile, mutated)).toContain(
			`run must run ${gate} before pnpm/action-setup`,
		);
	});

	// pnpm/action-setup starts pnpm, which reads the workspace, so in spikes.yml too the check comes
	// before it as well as last before the install.
	it("refuses spikes.yml's run job without its pre-install check before pnpm/action-setup", () => {
		expect(spikes).toContain(gateStep + earlyCheck + spikesSetup);
		for (const mutated of [
			spikes.replace(earlyCheck, ""),
			spikes.replace(earlyCheck + spikesSetup, spikesSetup + earlyCheck),
		]) {
			const found = problems(spikesFile, mutated);
			expect(found).toContain(`run must run ${preinstall} before pnpm/action-setup`);
		}
		expect(problems(spikesFile, spikes.replace(earlyCheck, ""))).toContain(
			`must preserve run command and its execution controls: ${preinstall}`,
		);
	});

	const setupPnpm = [`- uses: ${pin("pnpm/action-setup")}`, "  with:", "    cache: true"];
	const beforeSetup = (what: string): string => `a must run ${what} before pnpm/action-setup`;

	it("needs the gate and the pre-install check before pnpm/action-setup in any workflow", () => {
		const accepted = [`- run: ${preinstall}`, ...setupPnpm, `- run: ${install}`];
		expect(checkWorkflow("x.yml", job(...accepted), toolchain)).toEqual([]);
		const unchecked = checkWorkflow("x.yml", job(...setupPnpm), toolchain).join("\n");
		expect(unchecked).toContain(beforeSetup(preinstall));
		expect(unchecked).not.toContain(beforeSetup(gate));
		const ungated = workflow(pr, [...checkout, ...setupPnpm, `- run: ${preinstall}`]);
		const found = checkWorkflow("x.yml", ungated, toolchain).join("\n");
		expect(found).toContain(beforeSetup(gate));
		expect(found).toContain(beforeSetup(preinstall));
		for (const [file, id] of [
			[prTitleFile, "pr-title"],
			[dcoFile, "dco"],
		] as const) {
			const setup = `      - uses: ${pin("pnpm/action-setup")}\n`;
			const mutated = inJob(sourceOf(file), id, gateStep, gateStep + setup);
			expect(problems(file, mutated), id).toContain(
				`${id} must run ${preinstall} before pnpm/action-setup`,
			);
		}
	});

	const pnpmAt = (id: string, what: string): string =>
		`${id}'s pre-install check before ${what} must run whenever it does, with no if or the same if`;

	it("needs the pre-install check before pnpm/action-setup under no condition or the same one", () => {
		const docsOnly =
			"        if: needs.changes.outputs.docs-only != 'true'\n        with:\n          cache: true\n";
		const unconditioned = inJob(ci, "cheap", docsOnly, "        with:\n          cache: true\n");
		expect(problems(ciFile, unconditioned)).toContain(pnpmAt("cheap", "pnpm/action-setup"));
		const linux = ["- if: runner.os == 'Linux'", `  run: ${preinstall}`];
		const found = checkWorkflow("x.yml", job(...linux, ...setupPnpm), toolchain).join("\n");
		expect(found).toContain(pnpmAt("a", "pnpm/action-setup"));
		const same = [...setupPnpm.slice(0, 1), "  if: runner.os == 'Linux'", ...setupPnpm.slice(1)];
		expect(checkWorkflow("x.yml", job(...linux, ...same), toolchain)).toEqual([]);
		const both = job(...linux, `- run: ${preinstall}`, ...setupPnpm);
		expect(checkWorkflow("x.yml", both, toolchain)).toEqual([]);
	});

	it("counts only a plain pre-install check before a package manager starts, never one marked continue-on-error or given an env", () => {
		const plainOnly = (what: string): string =>
			`a's pre-install check before ${what} may set only its name, if and run`;
		const soft = [`- run: ${preinstall}`, "  continue-on-error: true"];
		const withEnv = [`- run: ${preinstall}`, "  env:", "    X: '1'"];
		for (const [what, start] of [
			["pnpm/action-setup", setupPnpm],
			["a command that names a package manager", ["- run: pnpm exec tsc -b"]],
		] as const) {
			for (const check of [soft, withEnv]) {
				const found = checkWorkflow("x.yml", job(...check, ...start), toolchain).join("\n");
				expect(found, `${what}: ${check.join(" ")}`).toContain(plainOnly(what));
			}
			const plain = job(...soft, `- run: ${preinstall}`, ...start);
			expect(checkWorkflow("x.yml", plain, toolchain), what).toEqual([]);
		}
	});

	const flagOnly =
		"DRAFTYAK_RESERVED_TESTS may appear only on the reviewed reserved proof steps, unchanged";

	it("refuses the opt-in flag anywhere but the reviewed proof steps, unchanged in their own jobs, in any workflow", () => {
		for (const [file, source] of sources)
			expect(problems(file, source), file).not.toContain(flagOnly);
		const cheapLast = "        run: pnpm verify --profile cheap\n";
		const unitStep =
			"      - name: Opt-in reserved unit suites and their execution proof\n        env:\n          DRAFTYAK_RESERVED_TESTS: '1'\n        run: node tools/verify/reserved-proof.ts --tier unit\n";
		expect(ci).toContain(unitStep);
		// One more step in the cheap job: the flag in its env, its command or its env in lower case,
		// or an exact copy of the reserved job's proof step.
		for (const step of [
			"      - if: needs.changes.outputs.docs-only != 'true'\n        env:\n          DRAFTYAK_RESERVED_TESTS: '1'\n        run: pnpm test\n",
			"      - run: DRAFTYAK_RESERVED_TESTS=1 pnpm test\n",
			"      - env:\n          draftyak_reserved_tests: '1'\n        run: pnpm test\n",
			unitStep,
		]) {
			const mutated = inJob(ci, "cheap", cheapLast, cheapLast + step);
			expect(problems(ciFile, mutated), step).toContain(flagOnly);
		}
		// The reviewed steps changed in their own jobs.
		const changed = unitStep.replace("--tier unit", "--tier unit --names");
		expect(problems(ciFile, inJob(ci, "reserved", unitStep, changed))).toContain(flagOnly);
		const everySpike = inJob(
			spikes,
			"run",
			"          reserved=0\n",
			"          reserved=0\n          export DRAFTYAK_RESERVED_TESTS=1\n",
		);
		expect(problems(spikesFile, everySpike)).toContain(flagOnly);
		// A job of actions alone, a whole workflow, and another workflow's copy of a reviewed step.
		const jobEnv = workflow(pr).replace(
			"    runs-on: ubuntu-24.04\n",
			"    runs-on: ubuntu-24.04\n    env:\n      DRAFTYAK_RESERVED_TESTS: '1'\n",
		);
		const workflowEnv = workflow(pr).replace(
			"  TURBO_TELEMETRY_DISABLED: '1'\n",
			"  TURBO_TELEMETRY_DISABLED: '1'\n  DRAFTYAK_RESERVED_TESTS: '1'\n",
		);
		const copy = job(
			"- env:",
			"    DRAFTYAK_RESERVED_TESTS: '1'",
			"  run: node tools/verify/reserved-proof.ts --tier unit",
		);
		for (const source of [jobEnv, workflowEnv, copy]) {
			expect(source).toContain("DRAFTYAK_RESERVED_TESTS: '1'");
			expect(checkWorkflow("x.yml", source, toolchain).join("\n")).toContain(flagOnly);
		}
	});

	it("needs the gate and the pre-install check before setup-node with more than the pinned version", () => {
		const what = "setup-node with more than the pinned Node version";
		const cached = [
			`- uses: ${pin("actions/setup-node")}`,
			"  with:",
			"    node-version-file: .node-version",
			"    cache: pnpm",
		];
		expect(checkWorkflow("x.yml", job(...cached), toolchain).join("\n")).toContain(
			`a must run ${preinstall} before ${what}`,
		);
		expect(checkWorkflow("x.yml", job(`- run: ${preinstall}`, ...cached), toolchain)).toEqual([]);
		const plain = [
			`- uses: ${pin("actions/setup-node")}`,
			"  with:",
			"    node-version-file: .node-version",
		];
		expect(checkWorkflow("x.yml", job(...plain), toolchain)).toEqual([]);
		const step = `      - uses: ${pin("actions/setup-node")}\n        with:\n          node-version-file: .node-version\n          cache: pnpm\n`;
		const mutated = inJob(ci, "full", gateStep, gateStep + step);
		expect(problems(ciFile, mutated)).toContain(`full must run ${preinstall} before ${what}`);
	});

	it("needs the pre-install check, under no condition or the same one, before a command that names a package manager", () => {
		const what = "a command that names a package manager";
		const early = inJob(ci, "full", gateStep, `${gateStep}      - run: pnpm --version\n`);
		expect(problems(ciFile, early)).toContain(`full must run ${preinstall} before ${what}`);
		for (const command of ["pnpm --version", "npx tsx x.ts", "PNPM --version", "corepack enable"]) {
			expect(
				checkWorkflow("x.yml", job(`- run: ${command}`), toolchain).join("\n"),
				command,
			).toContain(`a must run ${preinstall} before ${what}`);
			expect(
				checkWorkflow("x.yml", job(`- run: ${preinstall}`, `- run: ${command}`), toolchain),
				command,
			).toEqual([]);
		}
		const linux = ["- if: runner.os == 'Linux'", `  run: ${preinstall}`, "- run: pnpm --version"];
		expect(checkWorkflow("x.yml", job(...linux), toolchain).join("\n")).toContain(
			pnpmAt("a", what),
		);
	});

	it("needs the gate in a job of actions alone that sets up pnpm, or setup-node beyond the pinned version", () => {
		const setupNode = (...inputs: string[]): string[] => [
			`- uses: ${pin("actions/setup-node")}`,
			"  with:",
			...inputs.map((input) => `    ${input}`),
		];
		for (const steps of [
			setupPnpm,
			setupNode("node-version-file: .node-version", "cache: pnpm"),
			setupNode("node-version: '26'"),
		]) {
			const found = checkWorkflow("x.yml", workflow(pr, [...checkout, ...steps]), toolchain);
			expect(found.join("\n"), steps.join(" ")).toContain(first("a"));
		}
		const zizmor = [`- uses: ${pin("zizmorcore/zizmor-action")}`, "  with:", "    inputs: .github"];
		const plain = [...checkout, ...setupNode("node-version-file: .node-version"), ...zizmor];
		expect(checkWorkflow("x.yml", workflow(pr, plain), toolchain)).toEqual([]);
	});

	const setupNodeStep = `      - uses: ${pin("actions/setup-node")}\n        with:\n          node-version-file: .node-version\n`;
	const plainSetup = (id: string): string =>
		`${id}'s checkout and setup-node before the reserved gate may set only their name, uses and with, and setup-node only node-version-file: .node-version`;

	it.each([
		["a cache", setupNodeStep, `${setupNodeStep}          cache: pnpm\n`],
		[
			"another Node version",
			"node-version-file: .node-version\n",
			"node-version-file: .node-version\n          node-version: '26'\n",
		],
		[
			"an environment",
			setupNodeStep,
			`${setupNodeStep}        env:\n          NODE_OPTIONS: --require ./x.cjs\n`,
		],
		["a condition", setupNodeStep, `${setupNodeStep}        if: false\n`],
	])(
		"refuses setup-node before the gate with %s, in every job that runs a command",
		(_, before, after) => {
			for (const [file, id] of gatedJobs) {
				expect(problems(file, sourceOf(file)), `${file} ${id}`).toBe("");
				const mutated = inJob(sourceOf(file), id, before, after);
				expect(problems(file, mutated), `${file} ${id}`).toContain(plainSetup(id));
			}
		},
	);

	it("refuses a checkout before the gate with an environment, which its Node reads", () => {
		const env = ["  env:", "    NODE_OPTIONS: --require ./x.cjs"];
		for (const steps of [
			[...checkout, ...env, `- run: ${gate}`],
			[...checkout, ...checkout, ...env, `- run: ${gate}`],
		]) {
			const found = checkWorkflow("x.yml", workflow(pr, steps), toolchain);
			expect(found.join("\n")).toContain(plainSetup("a"));
		}
		expect(
			checkWorkflow("x.yml", workflow(pr, [...checkout, `- run: ${gate}`]), toolchain),
		).toEqual([]);
	});

	const onceBefore = (id: string): string =>
		`${id} may check out only once before the reserved gate, at the root and with no path or repository`;
	const checkoutStep = (...inputs: string[]): string =>
		`      - uses: ${pin("actions/checkout")}\n        with:\n${[...inputs, "persist-credentials: false"].map((input) => `          ${input}\n`).join("")}`;

	it.each([
		["a second checkout", checkoutStep()],
		[
			"a second checkout into an ignored folder",
			checkoutStep("repository: draftyak/draftyak", "ref: other", "path: node_modules/.other"),
		],
		["a second checkout of another ref at the root", checkoutStep("ref: other")],
	])("refuses %s before the gate, in every job that runs a command", (_, extra) => {
		for (const [file, id] of gatedJobs) {
			expect(problems(file, sourceOf(file)), `${file} ${id}`).toBe("");
			const mutated = inJob(sourceOf(file), id, setupNodeStep, extra + setupNodeStep);
			expect(problems(file, mutated), `${file} ${id}`).toContain(onceBefore(id));
		}
	});

	it("refuses dco.yml's second checkout before the gate and the command it would feed", () => {
		const other = checkoutStep(
			"repository: draftyak/draftyak",
			"ref: other",
			"path: node_modules/.other",
		);
		const fed = inJob(
			inJob(dco, "dco", setupNodeStep, other + setupNodeStep),
			"dco",
			"run: node tools/ci-checks/src/dco.ts",
			"run: node node_modules/.other/tools/ci-checks/src/dco.ts",
		);
		expect(problems(dcoFile, fed)).toContain(onceBefore("dco"));
	});

	it.each(["path: sub", "repository: other/repo", "Path: sub", "REPOSITORY: other/repo"])(
		"refuses the one checkout before the gate with %s",
		(input) => {
			const steps = [...checkout, `    ${input}`, `- run: ${gate}`];
			expect(checkWorkflow("x.yml", workflow(pr, steps), toolchain).join("\n")).toContain(
				onceBefore("a"),
			);
			const plain = [...checkout, "    ref: other", "    fetch-depth: 0", `- run: ${gate}`];
			expect(checkWorkflow("x.yml", workflow(pr, plain), toolchain)).toEqual([]);
		},
	);

	it.each([
		["an environment", "        env:\n          NODE_OPTIONS: --require ./x.cjs\n"],
		["a soft failure", "        continue-on-error: true\n"],
		["a condition its install doesn't share", "        if: false\n"],
		["a shell", "        shell: sh\n"],
	])("refuses a pre-install check with %s", (_, line) => {
		for (const [file, id] of [
			[ciFile, "full"],
			[spikesFile, "run"],
		] as const) {
			const mutated = inJob(sourceOf(file), id, preinstallStep, preinstallStep + line);
			expect(problems(file, mutated), id).toContain(
				`${id}'s pre-install check may set only its name, run and its install's if`,
			);
		}
	});

	it.each([
		["an environment", "        env:\n          npm_config_ignore_scripts: 'false'\n"],
		["a shell", "        shell: sh\n"],
		["a working directory", "        working-directory: tools\n"],
		["a soft failure", "        continue-on-error: true\n"],
	])("refuses an install step with %s", (_, line) => {
		for (const [file, id] of [
			[ciFile, "full"],
			[spikesFile, "run"],
		] as const) {
			const mutated = inJob(sourceOf(file), id, installStep, installStep + line);
			expect(problems(file, mutated), id).toContain(
				`${id}'s ${install} step may set only its name, if and run`,
			);
		}
	});

	it("accepts the pre-install check right before an install, with only actions between, in any workflow", () => {
		const cache = [`- uses: ${pin("actions/cache")}`, "  with:", "    path: x", "    key: y"];
		for (const lines of [
			[`- run: ${preinstall}`, `- run: ${install}`],
			[`- run: ${preinstall}`, ...cache, `- run: ${install}`],
			["- if: success()", `  run: ${preinstall}`, "- if: success()", `  run: ${install}`],
			[`- run: ${preinstall}`, "- if: success()", `  run: ${install}`],
		]) {
			expect(checkWorkflow("x.yml", job(...lines), toolchain)).toEqual([]);
		}
		for (const lines of [
			[`- run: ${install}`],
			[`- run: ${preinstall}`, "- run: echo between", `- run: ${install}`],
			[...cache, `- run: ${install}`],
		]) {
			expect(checkWorkflow("x.yml", job(...lines), toolchain).join("\n")).toContain(
				`a must run ${preinstall} as the last command before ${install}`,
			);
		}
		expect(
			checkWorkflow(
				"x.yml",
				job("- if: success()", `  run: ${preinstall}`, `- run: ${install}`),
				toolchain,
			).join("\n"),
		).toContain(`a's pre-install check may set only its name, run and its install's if`);
	});

	it.each([
		"pnpm i --frozen-lockfile",
		"pnpm install",
		"pnpm install --frozen-lockfile --ignore-scripts=false",
		"pnpm install --frozen-lockfile && node x.js",
		"pnpm add left-pad",
		"pnpm ci",
		"npm install",
		"npm i",
		"npm ci",
		"yarn install",
		"yarn add left-pad",
		"corepack pnpm install --frozen-lockfile",
		"npx pnpm install --frozen-lockfile",
		"pnpm --dir . install --frozen-lockfile",
		"pnpm -C . i",
	])("refuses the install command %s", (command) => {
		expect(
			checkWorkflow("x.yml", job(`- run: ${preinstall}`, `- run: ${install}`), toolchain),
		).toEqual([]);
		const source = job(`- run: ${preinstall}`, `- run: ${command}`);
		expect(checkWorkflow("x.yml", source, toolchain).join("\n")).toContain(census);
	});

	it.each([
		["a line continuation", ["pnpm \\", "  install --frozen-lockfile"]],
		["a second command", [install, "pnpm install"]],
		["a block of its own", [install]],
	])("refuses an install in a script with %s", (_, lines) => {
		const source = job(`- run: ${preinstall}`, "- run: |", ...lines.map((line) => `    ${line}`));
		expect(checkWorkflow("x.yml", source, toolchain).join("\n")).toContain(census);
	});

	it("refuses pnpm i in place of the install in ci.yml and spikes.yml", () => {
		for (const [file, id] of [
			[ciFile, "full"],
			[spikesFile, "run"],
		] as const) {
			const mutated = inJob(
				sourceOf(file),
				id,
				installStep,
				`      - run: pnpm i --frozen-lockfile\n`,
			);
			expect(problems(file, mutated), id).toContain(census);
		}
	});

	it("accepts the exact install, Intel macOS's scriptless pnpm and commands that only name a package manager", () => {
		const intelMac = (parseYaml(spikes).value as Steps).jobs.run?.steps.find(
			(step) => step.name === "Install pnpm from .github/pnpm-js (Intel macOS)",
		)?.run;
		expect(String(intelMac)).toContain('npm ci --prefix "$dest" --ignore-scripts');
		const block = String(intelMac).trimEnd().split("\n");
		// Each names a package manager, so the pre-install check comes first.
		const checked = (...lines: string[]): string => job(`- run: ${preinstall}`, ...lines);
		expect(
			checkWorkflow("x.yml", checked("- run: |", ...block.map((line) => `    ${line}`)), toolchain),
		).toEqual([]);
		for (const command of [
			"pnpm verify --profile cheap",
			'pnpm --filter "./spikes/s01" --fail-if-no-match run test:heavy',
			"sudo apt-get install --yes --no-install-recommends xvfb",
			'echo "::error::.github/pnpm-js installs pnpm 11, but packageManager pins 12"',
			"node tools/ci-checks/src/spikes-run.ts --plan",
		]) {
			expect(checkWorkflow("x.yml", checked(`- run: ${command}`), toolchain), command).toEqual([]);
		}
	});

	it.each([
		["without --ignore-scripts", " --ignore-scripts", ""],
		["into the checkout", '--prefix "$dest"', "--prefix ."],
		[
			"with another command",
			'          echo "$dest/node_modules/.bin" >> "$GITHUB_PATH"\n',
			'          echo "$dest/node_modules/.bin" >> "$GITHUB_PATH"\n          npm install\n',
		],
	])("refuses the Intel macOS pnpm step %s", (_, before, after) => {
		expect(problems(spikesFile, spikes)).toBe("");
		expect(problems(spikesFile, inJob(spikes, "run", before, after))).toContain(census);
	});

	it.each(["run_install: true", "run_install: false", "RUN_INSTALL: 'true'"])(
		"refuses pnpm/action-setup with %s",
		(input) => {
			for (const [file, id, cache] of [
				[ciFile, "full", "          cache: true\n"],
				[ciFile, "cheap", "          cache: true\n"],
				[spikesFile, "run", `          cache: \${{ github.ref == 'refs/heads/main' }}\n`],
			] as const) {
				expect(problems(file, sourceOf(file)), id).toBe("");
				const mutated = inJob(sourceOf(file), id, cache, `${cache}          ${input}\n`);
				expect(problems(file, mutated), id).toContain("pnpm/action-setup must not set run_install");
			}
		},
	);

	it.each([
		["the plan step's input", `RUN_OS: \${{ inputs.os }}`, "RUN_OS: ubuntu-24.04"],
		[
			"the plan command",
			"run: node tools/ci-checks/src/spikes-run.ts --plan",
			"run: echo plan-disabled",
		],
		[
			"the reserved check",
			'          node reserved-tests.ts --reserved "spikes/$SPIKE" || reserved=$?\n',
			"",
		],
		[
			"the opt-in for a reserved spike only",
			'          if [ "$reserved" = 0 ]; then\n',
			"          if true; then\n",
		],
		[
			"the stop when the check fails",
			'          elif [ "$reserved" != 1 ]; then\n            exit "$reserved"\n',
			"",
		],
		[
			"the flag on every spike's heavy step",
			`          TESTS: \${{ matrix.tests }}\n`,
			`          TESTS: \${{ matrix.tests }}\n          DRAFTYAK_RESERVED_TESTS: '1'\n`,
		],
		[
			"the Intel macOS condition",
			"        if: runner.os == 'macOS' && runner.arch == 'X64'\n        run: |\n",
			"        run: |\n",
		],
		["the pre-install check", preinstallStep, ""],
		["a second gate", installStep, `${gateStep}${installStep}`],
	])("refuses a changed spikes.yml contract: %s", (_, before, after) => {
		expect(problems(spikesFile, spikes)).toBe("");
		const mutated = spikes.replace(before, after);
		expect(mutated).not.toBe(spikes);
		expect(problems(spikesFile, mutated)).toContain("must preserve");
	});

	it.each([
		["another shell", "defaults:\n  run:\n    shell: sh\n"],
		["no shell", ""],
	])("refuses spikes.yml with %s, which could skip its gate", (_, after) => {
		expect(problems(spikesFile, spikes)).toBe("");
		const mutated = spikes.replace("defaults:\n  run:\n    shell: bash\n", after);
		expect(mutated).not.toBe(spikes);
		expect(problems(spikesFile, mutated)).toContain("must preserve the spikes execution shell");
	});

	it.each(gatedJobs)(
		"refuses %s's %s job setting defaults, which its gate step inherits",
		(file, id) => {
			expect(problems(file, sourceOf(file))).toBe("");
			const defaults = "    defaults:\n      run:\n        shell: bash\n";
			const mutated = inJob(sourceOf(file), id, "    runs-on:", `${defaults}    runs-on:`);
			expect(problems(file, mutated)).toContain(
				`${id} must not set defaults, since its reserved gate step inherits them`,
			);
		},
	);

	it.each([
		["another shell", "defaults:\n  run:\n    shell: echo {0}\n"],
		["a working folder", "defaults:\n  run:\n    working-directory: tools\n"],
		[
			"bash in a working folder",
			"defaults:\n  run:\n    shell: bash\n    working-directory: tools\n",
		],
		["null", "defaults: null\n"],
	])(
		"refuses dco.yml's workflow defaults with %s, which its gate step would inherit",
		(_, defaults) => {
			expect(problems(dcoFile, `defaults:\n  run:\n    shell: bash\n${dco}`)).toBe("");
			expect(problems(dcoFile, defaults + dco)).toContain(
				"workflow defaults may set only the bash shell, since each reserved gate step inherits them",
			);
		},
	);

	// Each gate step inherits the workflow's env and its job's: these would load a file of the
	// checkout, or change what runs, before the gate.
	const inherited = [
		["NODE_OPTIONS with --require", "NODE_OPTIONS", "--require ./tools/x.cjs"],
		["NODE_OPTIONS with --import", "NODE_OPTIONS", "--import ./tools/x.mjs"],
		["node_options in lower case", "node_options", "--require ./tools/x.cjs"],
		["NODE_PATH", "NODE_PATH", "./tools"],
		["BASH_ENV", "BASH_ENV", "./tools/x.sh"],
		["ENV", "ENV", "./tools/x.sh"],
		["PATH", "PATH", "./tools/bin"],
		["GIT_CONFIG_GLOBAL", "GIT_CONFIG_GLOBAL", "./tools/gitconfig"],
	] as const;
	const topEnv = "env:\n  DO_NOT_TRACK: '1'\n  TURBO_TELEMETRY_DISABLED: '1'\n";
	const bindingEnv = ", CI, DRAFTYAK_STRICT_SKIPS and DRAFTYAK_APPROVAL_BINDING_RUNS";
	const workflowEnv = (file: string): string =>
		[nightlyFile, securityFile].includes(file)
			? `DO_NOT_TRACK, TURBO_TELEMETRY_DISABLED${bindingEnv}`
			: "DO_NOT_TRACK and TURBO_TELEMETRY_DISABLED";
	const noPreload =
		"may not set NODE_OPTIONS, NODE_PATH, BASH_ENV or ENV, which make Node or bash load a file before a step's command";
	const reviewedEnv: Readonly<Record<string, string>> = {
		[`${spikesFile} run`]: "DRAFTYAK_STRICT_SKIPS, DRAFTYAK_NODES and DRAFTYAK_CACHE_DIR",
		[`${ciFile} spike-run`]: "DRAFTYAK_STRICT_SKIPS, SHARD_ID, SPIKE and SPIKES",
		[`${ciFile} heavy`]: "DRAFTYAK_STRICT_SKIPS",
	};
	const ownEnv = (file: string, id: string): string => {
		const names = reviewedEnv[`${file} ${id}`];
		return names === undefined
			? `${id} must not set env, since its reserved gate step inherits it`
			: `${id}'s env may hold only ${names}, since its reserved gate step inherits it`;
	};
	// Adds `line` to a gated job's env, the reviewed ones' own included.
	const withJobEnv = (file: string, id: string, line: string): string => {
		const reviewed = "      DRAFTYAK_STRICT_SKIPS: '1'\n";
		return reviewedEnv[`${file} ${id}`] !== undefined
			? inJob(sourceOf(file), id, reviewed, `${reviewed}${line}`)
			: inJob(sourceOf(file), id, "    runs-on:", `    env:\n${line}    runs-on:`);
	};

	it.each(inherited)(
		"refuses %s in the workflow env of every workflow that runs the gate",
		(_, name, value) => {
			for (const [file, source] of sources) {
				expect(problems(file, source), file).toBe("");
				const mutated = source.replace("\nenv:\n", `\nenv:\n  ${name}: ${value}\n`);
				expect(mutated, file).not.toBe(source);
				expect(problems(file, mutated), file).toContain(
					`env may hold only ${workflowEnv(file)}, since each reserved gate step inherits it`,
				);
			}
		},
	);

	it.each(inherited)("refuses %s in the env of every job that runs the gate", (_, name, value) => {
		for (const [file, id] of gatedJobs) {
			expect(problems(file, sourceOf(file)), `${file} ${id}`).toBe("");
			const mutated = withJobEnv(file, id, `      ${name}: ${value}\n`);
			expect(problems(file, mutated), `${file} ${id}`).toContain(ownEnv(file, id));
		}
	});

	it("keeps spikes.yml's reviewed job env names to its run job", () => {
		const { jobs } = parseYaml(spikes).value as { jobs: Record<string, { env?: object }> };
		expect(Object.keys(jobs.run?.env ?? {})).toEqual([
			"DRAFTYAK_STRICT_SKIPS",
			"DRAFTYAK_NODES",
			"DRAFTYAK_CACHE_DIR",
		]);
		const moved = withJobEnv(spikesFile, "plan", "      DRAFTYAK_STRICT_SKIPS: '1'\n");
		expect(problems(spikesFile, moved)).toContain(ownEnv(spikesFile, "plan"));
		const flagged = withJobEnv(spikesFile, "run", "      DRAFTYAK_RESERVED_TESTS: '1'\n");
		expect(problems(spikesFile, flagged)).toContain(ownEnv(spikesFile, "run"));
	});

	it("refuses a container for every job that runs the gate, whose env and options it inherits", () => {
		for (const [file, id] of gatedJobs) {
			const mutated = inJob(
				sourceOf(file),
				id,
				"    runs-on:",
				"    container: node:24\n    runs-on:",
			);
			expect(problems(file, mutated), `${file} ${id}`).toContain(
				`${id} must not run in a container, whose env and options its reserved gate step would inherit`,
			);
		}
	});

	it("refuses only the preload names in the env of a workflow whose jobs run no command", () => {
		const zizmor = [`- uses: ${pin("zizmorcore/zizmor-action")}`, "  with:", "    inputs: .github"];
		const actions = workflow(pr, [...checkout, ...zizmor]);
		const telemetry = "  TURBO_TELEMETRY_DISABLED: '1'\n";
		expect(checkWorkflow("x.yml", actions, toolchain)).toEqual([]);
		expect(
			checkWorkflow("x.yml", actions.replace(telemetry, `${telemetry}  OTHER: x\n`), toolchain),
		).toEqual([]);
		for (const [, name, value] of inherited.filter(([, name]) =>
			["NODE_OPTIONS", "NODE_PATH", "BASH_ENV", "ENV"].includes(name.toUpperCase()),
		)) {
			const top = actions.replace(telemetry, `${telemetry}  ${name}: ${value}\n`);
			expect(checkWorkflow("x.yml", top, toolchain).join("\n"), name).toContain(`env ${noPreload}`);
			const own = actions.replace(
				"    runs-on:",
				`    env:\n      ${name}: ${value}\n    runs-on:`,
			);
			expect(checkWorkflow("x.yml", own, toolchain).join("\n"), name).toContain(
				`a's env ${noPreload}`,
			);
		}
	});
});
