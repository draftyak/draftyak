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
			name: `\${{ github.event.pull_request.draft && 'required (draft)' || 'required' }}`,
			needs: ["changes", "cheap", "full", "windows"],
		});
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
		// The whole step: an `if`, `continue-on-error` or a changed input would make it pass everywhere.
		const prTitle = jobs("pr-title.yml")["pr-title"] as { steps: unknown[] };
		expect(prTitle.steps.at(-1)).toEqual({
			env: {
				BASE_SHA: `\${{ github.event.pull_request.base.sha }}`,
				HEAD_SHA: `\${{ github.event.pull_request.head.sha }}`,
				BASE_REPO: `\${{ github.repository }}`,
				HEAD_REPO: `\${{ github.event.pull_request.head.repo.full_name }}`,
				BASE_REF: `\${{ github.event.pull_request.base.ref }}`,
				HEAD_REF: `\${{ github.event.pull_request.head.ref }}`,
			},
			run: "node tools/ci-checks/src/commit-identity.ts",
		});
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
