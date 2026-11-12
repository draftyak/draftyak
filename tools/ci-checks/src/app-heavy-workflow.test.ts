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
	.value as unknown as { env?: Record<string, unknown>; jobs: { heavy: Job } };
const job = workflow.jobs.heavy;
const steps = job.steps;
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

function shellCondition(value: string | undefined): string {
	const terms = new Map([
		["needs.changes.outputs.docs-only != 'true'", '[ "$DOCS_ONLY" != true ]'],
		["github.event_name != 'pull_request'", '[ "$EVENT_NAME" != pull_request ]'],
		["!github.event.pull_request.draft", '[ "$PR_DRAFT" != true ]'],
		["needs.changes.outputs.ordinary-heavy != ''", '[ -n "$ORDINARY_HEAVY" ]'],
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
		const selected = classify(
			files,
			root,
			() => [],
			() => [],
		);
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
		const heavy = bindings.get(String(environment.HEAVY));
		if (heavy === undefined) throw new Error("unknown heavy environment binding");
		const condition = shellCondition(job.if);
		const capture = path.join(root, "capture.mjs");
		const output = path.join(root, "calls.jsonl");
		writeFileSync(
			capture,
			[
				'import {appendFileSync} from "node:fs";',
				'appendFileSync(process.env.CAPTURE_OUTPUT, JSON.stringify({args:process.argv.slice(2), strict:process.env.DRAFTYAK_STRICT_SKIPS})+"\\n");',
				'if(process.env.CAPTURE_FAIL==="1")process.exit(23);',
			].join("\n"),
		);
		// Absolute executable and script, no PATH interception or fallback. Only fixed argv metadata
		// reaches this stand-in: neither Turbo nor an application/heavy/live command is executed.
		const command = `node() { "$CAPTURE_NODE" "$CAPTURE_SCRIPT" "$@"; }\nreadonly -f node\nif ${condition}; then\n${run}\nfi`;
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
					DOCS_ONLY: String(context.docsOnly ?? false),
					EVENT_NAME: context.eventName ?? "pull_request",
					PR_DRAFT: String(context.draft ?? false),
					HEAVY: heavy,
					ORDINARY_HEAVY: ordinary,
					SMOKE: String(selected.templateSmoke),
					DRAFTYAK_STRICT_SKIPS: String(environment.DRAFTYAK_STRICT_SKIPS ?? ""),
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
	it("invalidates the CI test cache when either reviewed app manifest changes", () => {
		const config = JSON.parse(
			readFileSync(path.join(repository, "tools/ci-checks/turbo.json"), "utf8"),
		);
		expect(config.tasks.test.inputs).toContain("$TURBO_ROOT$/apps/cli/package.json");
		expect(config.tasks.test.inputs).toContain("$TURBO_ROOT$/apps/hub/package.json");
	});
});
