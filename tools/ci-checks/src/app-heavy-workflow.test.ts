import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { classify } from "./changes.ts";
import { nativeTransportFilter, nativeTransportSelection } from "./native-transport.ts";
import { parseYaml } from "./yaml.ts";

const repository = path.resolve(import.meta.dirname, "..", "..", "..");
interface Step {
	readonly id?: string;
	readonly name?: string;
	readonly run?: string;
	readonly if?: string;
	readonly env?: Record<string, unknown>;
}
interface Job {
	readonly needs?: string;
	readonly if?: string;
	readonly env?: Record<string, unknown>;
	readonly steps: Step[];
}
const workflow = parseYaml(readFileSync(path.join(repository, ".github/workflows/ci.yml"), "utf8"))
	.value as unknown as { env?: Record<string, unknown>; jobs: Record<"heavy" | "spike-run", Job> };
const job = workflow.jobs.heavy;
const steps = job.steps;
const ordinary = job;
const shard = workflow.jobs["spike-run"];
const shardMatches = shard.steps.filter((entry) => entry.id === "heavy-test");
const shardStep = shardMatches[0];
if (shardMatches.length !== 1 || !shardStep?.run)
	throw new Error("missing selected shard workflow step");
const shardRun = shardStep.run;
const readySelection =
	"needs.changes.outputs.docs-only != 'true' && (github.event_name != 'pull_request' || !github.event.pull_request.draft) && ";
const matches = steps.filter((entry) => entry.id === "heavy-test");
const step = matches[0];
if (matches.length !== 1 || !step?.run || !step.env)
	throw new Error("missing selected-heavy workflow step");
const run = step.run;
const environment = { ...workflow.env, ...job.env, ...step.env };

interface SelectionContext {
	readonly docsOnly?: boolean;
	readonly eventName?: string;
	readonly draft?: boolean;
}

function shellCondition(value: string | undefined, sharded: boolean): string {
	const terms = new Map([
		["needs.changes.outputs.docs-only != 'true'", '[ "$DOCS_ONLY" != true ]'],
		["github.event_name != 'pull_request'", '[ "$EVENT_NAME" != pull_request ]'],
		["!github.event.pull_request.draft", '[ "$PR_DRAFT" != true ]'],
		[
			sharded
				? "needs.changes.outputs.spike-count != '0'"
				: "needs.changes.outputs.ordinary-heavy != ''",
			sharded ? '[ "$SPIKE_COUNT" != 0 ]' : '[ -n "$ORDINARY_HEAVY" ]',
		],
	]);
	let condition = String(value);
	let grammar = condition;
	for (const [term, command] of terms) {
		if (grammar.split(term).length !== 2) throw new Error("unknown selected-heavy condition");
		grammar = grammar.replace(term, "T");
		condition = condition.replace(term, command);
	}
	if (!/^(?:T|\s|&&|\|\||[()])+$/.test(grammar))
		throw new Error("unknown selected-heavy condition");
	return condition.replaceAll("(", "( ").replaceAll(")", " )");
}
const bash = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "/bin/bash";

function exercise(
	files: string[],
	fail = false,
	includeNative = false,
	context: SelectionContext = {},
	overlay: Partial<Record<"spikes" | "heavy" | "rust", readonly string[]>> = {},
	sharded = false,
): { status: number | null; calls: unknown[] } {
	const root = mkdtempSync(path.join(tmpdir(), "draftyak-app-heavy-shell-"));
	try {
		for (const app of ["cli", "hub"]) {
			const directory = path.join(root, "apps", app);
			mkdirSync(directory, { recursive: true });
			writeFileSync(
				path.join(directory, "package.json"),
				JSON.stringify({
					name: `@draftyak/${app}`,
					scripts: { "test:heavy": "vitest run --mode heavy" },
				}),
			);
		}
		mkdirSync(path.join(root, "packages", "create-plugin"), { recursive: true });
		writeFileSync(path.join(root, "packages", "create-plugin", "package.json"), "{}");
		const selected = {
			...classify(
				files,
				root,
				() => [],
				() => [],
			),
			...overlay,
		};
		const selectedJob = sharded ? shard : job;
		const selectedStep = sharded ? shardStep : step;
		const effective = { ...workflow.env, ...selectedJob.env, ...selectedStep?.env };
		if (sharded && (effective.SPIKE !== "${{ matrix.spike }}" || selected.spikes.length !== 1))
			throw new Error("expected one selected shard importer");
		const rawHeavy = [...selected.heavy, ...(includeNative ? [nativeTransportFilter] : [])].join(
			"\n",
		);
		const ordinary = nativeTransportSelection(
			rawHeavy,
			includeNative ? "crates" : selected.rust.join("\n"),
		).ordinaryHeavy;
		const bindings = new Map([
			[`\${{ needs.changes.outputs.heavy }}`, rawHeavy],
			[`\${{ needs.changes.outputs.ordinary-heavy }}`, ordinary],
		]);
		const heavy = sharded ? "" : bindings.get(String(effective.HEAVY));
		if (heavy === undefined) throw new Error("unknown heavy environment binding");
		const condition = shellCondition(selectedJob.if, sharded);
		const selectedRun = sharded ? shardRun : run;
		const browserPath = path.join(root, "browsers");
		const capture = path.join(root, "capture.mjs");
		const output = path.join(root, "calls.jsonl");
		writeFileSync(
			capture,
			[
				'import {appendFileSync} from "node:fs";',
				"if(process.env.PLAYWRIGHT_BROWSERS_PATH!==process.env.CAPTURE_BROWSER_EXPECTED)process.exit(24);",
				'appendFileSync(process.env.CAPTURE_OUTPUT, JSON.stringify({args:process.argv.slice(2), strict:process.env.DRAFTYAK_STRICT_SKIPS})+"\\n");',
				'if(process.env.CAPTURE_FAIL==="1")process.exit(23);',
			].join("\n"),
		);
		// Absolute executable and script, no PATH interception or fallback. Only fixed argv metadata
		// reaches this stand-in: neither Turbo nor an application/heavy/live command is executed.
		const command = `node() { "$CAPTURE_NODE" "$CAPTURE_SCRIPT" "$@"; }\nreadonly -f node\nif ${condition}; then\n${selectedRun}\nfi`;
		const result = spawnSync(
			bash,
			["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", command],
			{
				cwd: root,
				encoding: "utf8",
				env: {
					...(process.platform === "win32"
						? { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR }
						: {}),
					PATH: "",
					CAPTURE_NODE: process.execPath.replaceAll("\\", "/"),
					CAPTURE_SCRIPT: capture.replaceAll("\\", "/"),
					CAPTURE_OUTPUT: output,
					CAPTURE_FAIL: fail ? "1" : "0",
					CAPTURE_BROWSER_EXPECTED: browserPath,
					SPIKE_COUNT: String(selected.spikes.length),
					SPIKES: selected.spikes.join("\n"),
					SPIKE: selected.spikes[0] ?? "",
					PLAYWRIGHT_BROWSERS_PATH:
						effective.PLAYWRIGHT_BROWSERS_PATH === "${{ steps.browser-setup.outputs.path }}"
							? browserPath
							: String(effective.PLAYWRIGHT_BROWSERS_PATH ?? ""),
					DOCS_ONLY: String(context.docsOnly ?? false),
					EVENT_NAME: context.eventName ?? "pull_request",
					PR_DRAFT: String(context.draft ?? false),
					HEAVY: heavy,
					ORDINARY_HEAVY: ordinary,
					SMOKE: String(selected.templateSmoke),
					DRAFTYAK_STRICT_SKIPS: String(effective.DRAFTYAK_STRICT_SKIPS ?? ""),
				},
			},
		);
		expect(result.error).toBeUndefined();
		expect(result.stderr).toBe("");
		const calls = existsSync(output)
			? readFileSync(output, "utf8")
					.trim()
					.split("\n")
					.map((line) => JSON.parse(line))
			: [];
		return { status: result.status, calls };
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

describe("actual selected-heavy workflow application arguments", () => {
	it("keeps the existing condition, build prerequisite and explicit strict skips", () => {
		expect(ordinary.if).toBe(`${readySelection}needs.changes.outputs.ordinary-heavy != ''`);
		expect(shard.if).toBe(`${readySelection}needs.changes.outputs.spike-count != '0'`);
		expect(step.if).toBeUndefined();
		expect(shardStep.if).toBeUndefined();
		expect(environment.HEAVY).toBe("${{ needs.changes.outputs.ordinary-heavy }}");
		expect(environment.PLAYWRIGHT_BROWSERS_PATH).toBe("${{ steps.browser-setup.outputs.path }}");
		expect(environment.DRAFTYAK_STRICT_SKIPS).toBe("1");
		expect(shard.env?.SPIKE).toBe("${{ matrix.spike }}");
		for (const [job, commandStep] of [
			[ordinary, step],
			[shard, shardStep],
		] as const) {
			expect(job.env?.DRAFTYAK_STRICT_SKIPS).toBe("1");
			expect(commandStep.env?.DRAFTYAK_STRICT_SKIPS).toBeUndefined();
			const build = job.steps.findIndex((entry) => entry.run === "pnpm build");
			expect(build).toBeGreaterThan(-1);
			expect(build).toBeLessThan(job.steps.indexOf(commandStep));
		}
	});
	it("keeps the job guard, build prerequisite and inherited strict skips", () => {
		expect(job.needs).toBe("changes");
		expect(job.if).toBe(
			"needs.changes.outputs.docs-only != 'true' && (github.event_name != 'pull_request' || !github.event.pull_request.draft) && needs.changes.outputs.ordinary-heavy != ''",
		);
		expect(step.if).toBeUndefined();
		expect(environment.HEAVY).toBe(`\${{ needs.changes.outputs.ordinary-heavy }}`);
		expect(environment.SMOKE).toBe(
			`\${{ needs.changes.outputs.template-smoke == 'true' || github.ref == 'refs/heads/main' || github.base_ref == 'main' }}`,
		);
		expect(job.env?.DRAFTYAK_STRICT_SKIPS).toBe("1");
		expect(step.env?.DRAFTYAK_STRICT_SKIPS).toBeUndefined();
		expect(environment.DRAFTYAK_STRICT_SKIPS).toBe("1");
		expect(steps.findIndex((entry) => entry.run === "pnpm build")).toBeGreaterThan(-1);
		expect(steps.findIndex((entry) => entry.run === "pnpm build")).toBeLessThan(
			steps.indexOf(step),
		);
		expect(exercise(["apps/hub/src/main.ts"], false, false, { docsOnly: true })).toEqual({
			status: 0,
			calls: [],
		});
		expect(exercise(["apps/hub/src/main.ts"], false, false, { draft: true })).toEqual({
			status: 0,
			calls: [],
		});
		expect(
			exercise(["apps/hub/src/main.ts"], false, false, { eventName: "push", draft: true }),
		).toEqual(exercise(["apps/hub/src/main.ts"]));
	});
	it.each(["cli", "hub"])("passes the dependent %s filter as one literal argument", (app) => {
		expect(exercise([`apps/${app}/src/main.ts`])).toEqual({
			status: 0,
			calls: [
				{
					args: [
						"tools/verify/turbo.ts",
						"run",
						"test:heavy",
						"--concurrency=1",
						"--log-order=stream",
						"--log-prefix=task",
						`--filter=...{./apps/${app}}`,
						"--filter=!./packages/create-plugin",
					],
					strict: "1",
				},
			],
		});
	});
	it("does not start ordinary heavy with empty selectors for a native-only selection", () => {
		expect(exercise([], false, true)).toEqual({ status: 0, calls: [] });
	});
	it("keeps a mixed app/native selection out of the ordinary native suite", () => {
		expect(exercise(["apps/hub/src/main.ts"], false, true)).toEqual(
			exercise(["apps/hub/src/main.ts"]),
		);
	});
	it("passes the exact bounded global targets without the optional-smoke exclusion", () => {
		expect(exercise(["package.json"])).toEqual({
			status: 0,
			calls: [
				{
					args: [
						"tools/verify/turbo.ts",
						"run",
						"test:heavy",
						"--concurrency=1",
						"--log-order=stream",
						"--log-prefix=task",
						"--filter=./apps/cli",
						"--filter=./apps/hub",
					],
					strict: "1",
				},
			],
		});
	});
	it("preserves the real command failure instead of accepting a summary-only result", () => {
		const result = exercise(["apps/hub/src/main.ts"], true);
		expect(result.status).toBe(23);
		expect(result.calls).toHaveLength(1);
	});
	it.each([
		["no work", { heavy: [] }],
		["native only", { heavy: ["./tools/transport-tests"], rust: ["crates"] }],
	] as const)("does not run an empty-filter ordinary command for %s", (_, overlay) => {
		expect(exercise([], false, false, {}, overlay)).toEqual({ status: 0, calls: [] });
	});
	it("excludes the dedicated native wrapper from real ordinary shell arguments", () => {
		const result = exercise(
			[],
			false,
			false,
			{},
			{
				heavy: ["./tools/transport-tests", "...{./apps/cli}"],
				rust: ["crates"],
			},
		);
		expect(result).toEqual({
			status: 0,
			calls: [
				{
					args: [
						"tools/verify/turbo.ts",
						"run",
						"test:heavy",
						"--concurrency=1",
						"--log-order=stream",
						"--log-prefix=task",
						"--filter=...{./apps/cli}",
						"--filter=!./packages/create-plugin",
					],
					strict: "1",
				},
			],
		});
	});
	it("retains the actual spike-only shell execution with empty ordinary selection", () => {
		const selected = { spikes: ["spikes/kit"], heavy: [] };
		expect(exercise([], false, false, {}, selected)).toEqual({ status: 0, calls: [] });
		expect(exercise([], false, false, {}, selected, true)).toEqual({
			status: 0,
			calls: [
				{
					args: [
						"tools/verify/turbo.ts",
						"run",
						"test:heavy",
						"--concurrency=1",
						"--log-order=stream",
						"--log-prefix=task",
						"--filter=./spikes/kit",
					],
					strict: "1",
				},
			],
		});
		const failure = exercise([], true, false, {}, selected, true);
		expect(failure.status).toBe(23);
		expect(failure.calls).toHaveLength(1);
	});
	it("invalidates the CI test cache when either reviewed app manifest changes", () => {
		const config = JSON.parse(
			readFileSync(path.join(repository, "tools/ci-checks/turbo.json"), "utf8"),
		);
		expect(config.tasks.test.inputs).toContain("$TURBO_ROOT$/apps/cli/package.json");
		expect(config.tasks.test.inputs).toContain("$TURBO_ROOT$/apps/hub/package.json");
	});
});
