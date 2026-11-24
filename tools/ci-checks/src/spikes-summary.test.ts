import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseYaml } from "./yaml.ts";

interface Step {
	readonly name?: string;
	readonly if?: string;
	readonly env?: Readonly<Record<string, string>>;
	readonly run?: string;
}

const root = path.resolve(import.meta.dirname, "..", "..", "..");
const workflow = parseYaml(readFileSync(path.join(root, ".github/workflows/spikes.yml"), "utf8"))
	.value as unknown as { jobs: { run: { steps: Step[] } } };
const summaries = workflow.jobs.run.steps.filter((step) => step.env?.STARTED !== undefined);
const step = summaries[0];
const dirs: string[] = [];
const expression = (value: string): string => `\${{ ${value} }}`;
const rateCases = [
	["ubuntu-24.04", 1],
	["windows-2025", 2],
	["macos-15", 10],
] as const;
const roundingSeconds = [0, 1, 59, 60, 61, 120, 121] as const;
const inputs = [
	...rateCases.map(([runner, rate]) => ({ seconds: 60, runner, rate })),
	...roundingSeconds.map((seconds) => ({ seconds, runner: "macos-15", rate: 10 })),
];

interface Rendered {
	readonly stdout: string;
	readonly summary: string;
}

let batch: { readonly outputs: readonly Rendered[] } | { readonly error: unknown } | undefined;

// Match the workflow's Bash shell even when the child has an empty PATH.
// Windows' inherited PATH may instead resolve WSL's bash.
const bash =
	process.platform === "win32"
		? path.resolve(
				spawnSync("git", ["--exec-path"], { encoding: "utf8", windowsHide: true }).stdout.trim(),
				"../../../bin/bash.exe",
			)
		: "/bin/bash";

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function renderBatch(): readonly Rendered[] {
	const dir = mkdtempSync(path.join(tmpdir(), "draftyak-spike-summary-"));
	dirs.push(dir);
	const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
	const cases = inputs.map(({ seconds, runner, rate }, index) => {
		const stdout = path.join(dir, `${index}.stdout`).replaceAll("\\", "/");
		const summary = path.join(dir, `${index}.md`).replaceAll("\\", "/");
		return {
			stdout,
			summary,
			script: [
				`export STARTED=1000 NOW=${1000 + seconds} RUNNER=${quote(runner)} RATE=${rate} GITHUB_STEP_SUMMARY=${quote(summary)}`,
				`exec > ${quote(stdout)}`,
				String(step?.run),
			].join("\n"),
		};
	});
	// No external command is available; the exact formatter uses only shell builtins and this clock.
	const clock = 'date() { [ "$#" = 1 ] && [ "$1" = +%s ] || exit 91; printf "%s\\n" "$NOW"; }\n';
	const result = spawnSync(bash, ["--noprofile", "--norc", "-eo", "pipefail", "-s"], {
		// Keep each workflow body at top level, without a function or loop changing its syntax rules.
		input: clock + cases.map(({ script }) => script).join("\n"),
		env: {
			PATH: "",
			SystemRoot: process.env.SystemRoot,
		},
		encoding: "utf8",
		timeout: 5000,
		windowsHide: true,
	});
	expect(result.status, result.stderr || result.error?.message).toBe(0);
	return cases.map(({ stdout, summary }) => ({
		stdout: readFileSync(stdout, "utf8"),
		summary: readFileSync(summary, "utf8"),
	}));
}

function render(index: number): Rendered {
	if (batch === undefined) {
		try {
			batch = { outputs: renderBatch() };
		} catch (error) {
			batch = { error };
		}
	}
	if ("error" in batch) throw batch.error;
	const result = batch.outputs[index];
	if (result === undefined) throw new Error("missing elapsed-time summary case");
	return result;
}

describe("spike job elapsed-time summary", () => {
	it("reports time without taking an unclassified billing multiplier", () => {
		expect(summaries).toHaveLength(1);
		expect(step).toMatchObject({ name: "Elapsed runner time", if: "always()" });
		expect(step?.env).toEqual({
			STARTED: expression("steps.start.outputs.at"),
			RUNNER: expression("matrix.os"),
		});
	});

	it.each(rateCases.map(([runner, rate], index) => [runner, rate, index] as const))(
		"one elapsed minute on %s stays one minute regardless of rate %s",
		(runner, _rate, index) => {
			const line = `about 1 min of elapsed runner time on ${runner}, counted from the first step\n`;
			const result = render(index);
			expect(result.stdout).toBe(line);
			expect(result.summary).toBe(`### Elapsed runner time\n\n${line}`);
			expect(result.summary).not.toMatch(/billed|\bx\s*\d|\$/i);
		},
	);

	it.each(roundingSeconds.map((seconds, index) => [seconds, rateCases.length + index] as const))(
		"rounds %s elapsed seconds up to runner minutes",
		(seconds, index) => {
			const result = render(index);
			const minutes = Math.ceil(seconds / 60);
			expect(result.stdout).toBe(
				`about ${minutes} min of elapsed runner time on macos-15, counted from the first step\n`,
			);
			expect(result.summary).toBe(`### Elapsed runner time\n\n${result.stdout}`);
		},
	);
});
