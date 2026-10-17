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

	it("keeps the jobs that CI and later rulesets rely on", () => {
		const jobs = (name: string): Record<string, unknown> =>
			(parseYaml(read(`.github/workflows/${name}`)).value as { jobs: Record<string, unknown> })
				.jobs;
		const ci = jobs("ci.yml");
		expect(Object.keys(ci)).toEqual(["changes", "cheap", "full", "windows", "required"]);
		expect(ci.required).toMatchObject({
			if: "always()",
			needs: ["changes", "cheap", "full", "windows"],
		});
		expect([jobs("dco.yml"), jobs("pr-title.yml")].map(Object.keys)).toEqual([
			["dco"],
			["pr-title"],
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
