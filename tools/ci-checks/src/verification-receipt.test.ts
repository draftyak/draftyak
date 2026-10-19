import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { tempRepo } from "../test/temp-repo.ts";
import {
	buildReceipt,
	jobNames,
	type ReceiptInput,
	renderSummary,
	type Source,
} from "./verification-receipt.ts";

const headSha = "a".repeat(40);
const baseSha = "b".repeat(40);
const mergeSha = "c".repeat(40);
const treeSha = "d".repeat(40);
const lockfileSha256 = "e".repeat(64);
const nodeVersion = "26.12.0";
type JobName = (typeof jobNames)[number];
interface TestJob {
	result: string;
	outputs: Record<string, unknown>;
}
type Needs = Record<JobName, TestJob>;

const source = (extra: Partial<Source> = {}): Source => ({
	checkoutSha: mergeSha,
	treeSha,
	lockfileSha256,
	nodeVersion,
	platform: "linux",
	...extra,
});
const job = (platform = "linux"): TestJob => ({
	result: "success",
	outputs: { source: JSON.stringify(source({ platform })) },
});
const needs = (docsOnly = false): Needs => ({
	changes: { ...job(), outputs: { ...job().outputs, "docs-only": String(docsOnly) } },
	cheap: job(),
	full: job(),
	windows: job("win32"),
});
const input = (extra: Partial<ReceiptInput> = {}, jobs = needs()): ReceiptInput => ({
	repository: "example/project",
	event: "pull_request",
	ref: "refs/pull/42/merge",
	eventSha: mergeSha,
	headSha,
	baseSha,
	draft: false,
	runId: "123",
	runAttempt: "2",
	nodeVersion,
	needs: JSON.stringify(jobs),
	...extra,
});
const skip = (jobs: Needs, name: JobName): void => {
	jobs[name] = { result: "skipped", outputs: {} };
};
const changeSource = (jobs: Needs, name: JobName, extra: Record<string, unknown>): void => {
	jobs[name].outputs.source = JSON.stringify({
		...source({ platform: name === "windows" ? "win32" : "linux" }),
		...extra,
	});
};

describe("CI verification receipts", () => {
	it("keeps the PR head, base and tested merge commit distinct and serializes deterministically", () => {
		const receipt = buildReceipt(input());
		expect(receipt.passed).toBe(true);
		expect(receipt.problems).toEqual([]);
		expect(receipt.source).toEqual({ headSha, baseSha, testedSha: mergeSha });
		expect(receipt.run).toEqual({
			url: "https://github.com/example/project/actions/runs/123/attempts/2",
			id: "123",
			attempt: "2",
			event: "pull_request",
		});
		expect(Object.keys(receipt.jobResults)).toEqual(["changes", "cheap", "full", "windows"]);
		expect(Object.values(receipt.jobResults).every((entry) => entry.required)).toBe(true);
		expect(JSON.stringify(buildReceipt(input()))).toBe(JSON.stringify(receipt));
	});

	it.each([
		{ label: "ready PR", extra: {}, docs: false, skipped: [], coverage: "linux-and-windows" },
		{
			label: "draft PR",
			extra: { draft: true },
			docs: false,
			skipped: ["full", "windows"],
			coverage: "draft",
		},
		{ label: "docs PR", extra: {}, docs: true, skipped: ["full", "windows"], coverage: "docs" },
		{
			label: "main push",
			extra: { event: "push", ref: "refs/heads/main" },
			docs: false,
			skipped: [],
			coverage: "linux-and-windows",
		},
		{
			label: "docs main push",
			extra: { event: "push", ref: "refs/heads/main" },
			docs: true,
			skipped: ["full", "windows"],
			coverage: "docs",
		},
		{
			label: "main dispatch",
			extra: { event: "workflow_dispatch", ref: "refs/heads/main", baseSha: null },
			docs: false,
			skipped: [],
			coverage: "linux-and-windows",
		},
		{
			label: "item dispatch",
			extra: { event: "workflow_dispatch", ref: "refs/heads/m1", baseSha: null },
			docs: false,
			skipped: ["windows"],
			coverage: "linux",
		},
	] as const)("records the actual job scope for $label", ({ extra, docs, skipped, coverage }) => {
		const jobs = needs(docs);
		for (const name of skipped) skip(jobs, name);
		const receipt = buildReceipt(input(extra, jobs));
		expect(receipt.passed).toBe(true);
		expect(receipt.coverage).toBe(coverage);
		for (const name of jobNames) {
			const omitted = (skipped as readonly string[]).includes(name);
			expect(receipt.jobResults[name]).toMatchObject({
				result: omitted ? "skipped" : "success",
				required: !omitted,
			});
			if (omitted) expect(receipt.jobResults[name].source).toBeNull();
		}
	});

	it.each(jobNames)("fails when required %s is skipped, failed or cancelled", (name) => {
		for (const result of ["skipped", "failure", "cancelled"]) {
			const jobs = needs();
			jobs[name] = { result, outputs: {} };
			const receipt = buildReceipt(input({}, jobs));
			expect(receipt.passed, `${name}: ${result}`).toBe(false);
			expect(receipt.jobResults[name].result).toBe(result);
			expect(receipt.problems).toContain(`${name}: ${result}`);
		}
	});

	it.each(["failure", "cancelled"])("does not forgive an optional job's %s", (result) => {
		const jobs = needs(true);
		jobs.full = { result, outputs: {} };
		skip(jobs, "windows");
		const receipt = buildReceipt(input({}, jobs));
		expect(receipt.jobResults.full.required).toBe(false);
		expect(receipt.passed).toBe(false);
		expect(receipt.problems).toContain(`full: ${result}`);
	});

	it.each(jobNames)("requires source metadata for a successful %s", (name) => {
		const jobs = needs();
		delete jobs[name].outputs.source;
		const receipt = buildReceipt(input({}, jobs));
		expect(receipt.passed).toBe(false);
		expect(receipt.jobResults[name].source).toBeNull();
		expect(receipt.problems).toContain(`${name}: missing source metadata`);
	});

	it.each([
		["checkoutSha", headSha, "checkout differs from tested SHA"],
		["treeSha", "f".repeat(40), "tree differs between jobs"],
		["lockfileSha256", "f".repeat(64), "lockfile differs between jobs"],
		["nodeVersion", "26.5.1", "Node differs from the pin"],
		["platform", "win32", "unexpected runner platform"],
	])("refuses a child's changed %s", (field, value, problem) => {
		const jobs = needs();
		changeSource(jobs, "cheap", { [field]: value });
		const receipt = buildReceipt(input({}, jobs));
		expect(receipt.passed).toBe(false);
		expect(receipt.problems).toContain(`cheap: ${problem}`);
	});

	it("checks Windows platform metadata independently", () => {
		const jobs = needs();
		changeSource(jobs, "windows", { platform: "linux" });
		expect(buildReceipt(input({}, jobs)).problems).toContain("windows: unexpected runner platform");
	});

	it.each(["{", "null", "[]", "true", '"metadata"', " ".repeat(64 * 1024 + 1)])(
		"refuses malformed or oversized job metadata %#",
		(value) => expect(() => buildReceipt(input({ needs: value }))).toThrow(),
	);

	it("refuses missing jobs, invalid results and non-object output containers", () => {
		const omitted: Partial<Needs> = needs();
		delete omitted.full;
		expect(() => buildReceipt(input({ needs: JSON.stringify(omitted) }))).toThrow();
		for (const result of ["passed", "neutral", "timed_out", "", null, 0]) {
			const jobs = needs();
			const invalid = { ...jobs, cheap: { ...jobs.cheap, result } };
			expect(() => buildReceipt(input({ needs: JSON.stringify(invalid) }))).toThrow();
		}
		for (const outputs of [[], "", false]) {
			const jobs = needs();
			const invalid = { ...jobs, cheap: { result: "success", outputs } };
			expect(() => buildReceipt(input({ needs: JSON.stringify(invalid) }))).toThrow();
		}
	});

	it("refuses a successful classifier without its docs-only decision", () => {
		for (const value of [undefined, "", "yes", "FALSE"]) {
			const jobs = needs();
			jobs.changes.outputs["docs-only"] = value;
			expect(() => buildReceipt(input({}, jobs))).toThrow("docs-only output");
		}
	});

	it.each(["{", "null", "[]", "true", "x".repeat(1025)])(
		"refuses malformed or oversized source metadata %#",
		(value) => {
			const jobs = needs();
			jobs.cheap.outputs.source = value;
			expect(() => buildReceipt(input({}, jobs))).toThrow();
		},
	);

	it.each([
		["checkoutSha", "-HEAD"],
		["checkoutSha", "A".repeat(40)],
		["treeSha", "d".repeat(39)],
		["lockfileSha256", "e".repeat(63)],
		["nodeVersion", "26.12.0\nextra"],
		["platform", "darwin"],
	])("refuses invalid %s syntax", (field, value) => {
		const jobs = needs();
		changeSource(jobs, "cheap", { [field]: value });
		expect(() => buildReceipt(input({}, jobs))).toThrow();
	});

	it.each([
		{ repository: "example/project\n# injected" },
		{ event: "pull_request_target" },
		{ eventSha: "HEAD" },
		{ headSha: "a".repeat(41) },
		{ baseSha: null },
		{ runId: "0" },
		{ runAttempt: "2\ntext" },
		{ nodeVersion: "v26.12.0" },
	])("refuses invalid run metadata %#", (extra) => {
		expect(() => buildReceipt(input(extra))).toThrow();
	});

	it("does not copy unrecognized metadata into its JSON or Markdown", () => {
		const jobs = needs();
		jobs.cheap.outputs.unrelated = "unrelated-output-marker";
		changeSource(jobs, "cheap", { unrelated: "unrelated-source-marker" });
		const receipt = buildReceipt(input({}, jobs));
		expect(receipt.passed).toBe(true);
		for (const serialized of [JSON.stringify(receipt), renderSummary(receipt)]) {
			expect(serialized).not.toContain("unrelated-output-marker");
			expect(serialized).not.toContain("unrelated-source-marker");
		}
	});

	it("states scope, merge identity, skips and limits without claiming all tests passed", () => {
		const jobs = needs(true);
		skip(jobs, "full");
		skip(jobs, "windows");
		const summary = renderSummary(buildReceipt(input({}, jobs)));
		expect(summary).toContain("passed (docs)");
		expect(summary).toContain(`PR/source head: \`${headSha}\``);
		expect(summary).toContain(`Tested checkout: \`${mergeSha}\` (PR merge commit`);
		expect(summary).toContain("| full | skipped | no |");
		expect(summary).toContain("| windows | skipped | no |");
		expect(summary).toContain("A successful job does not establish that every test ran.");
		expect(summary).toContain(
			"Other workflows, live/device checks and owner acceptance remain separate.",
		);
		expect(summary).not.toMatch(/all (?:checks|tests) passed/i);
	});
});

describe("verification receipt CLI", () => {
	const script = path.join(import.meta.dirname, "verification-receipt.ts");
	const invoke = (cwd: string, args: string[], env: Record<string, string>) =>
		spawnSync(process.execPath, [script, ...args], {
			cwd,
			env: { ...process.env, ...env },
			encoding: "utf8",
			timeout: 15_000,
			windowsHide: true,
		});

	it("captures real committed metadata, writes an aggregate receipt and preserves a failure", () => {
		const repo = tempRepo();
		try {
			const lock = "lockfileVersion: '9.0'\nimporters: {}\n";
			repo.write("pnpm-lock.yaml", lock);
			repo.write(".node-version", `${process.versions.node}\n`);
			const commit = repo.commit("test: seed verification metadata");
			const output = path.join(repo.dir, "github-output");
			const capture = invoke(repo.dir, ["capture"], { GITHUB_SHA: commit, GITHUB_OUTPUT: output });
			expect(capture.status, capture.stderr).toBe(0);
			const encoded = /^source=(.+)\n$/.exec(readFileSync(output, "utf8"))?.[1];
			expect(encoded).toBeDefined();
			const captured = JSON.parse(encoded ?? "null") as Source;
			expect(captured).toEqual({
				checkoutSha: commit,
				treeSha: repo.git("rev-parse", "HEAD^{tree}"),
				lockfileSha256: createHash("sha256").update(lock).digest("hex"),
				nodeVersion: process.versions.node,
				platform: process.platform,
			});
			const jobs = needs();
			for (const name of jobNames) {
				jobs[name].outputs.source = JSON.stringify({
					...captured,
					platform: name === "windows" ? "win32" : "linux",
				});
			}
			const runner = path.join(repo.dir, "runner");
			mkdirSync(runner);
			const summary = path.join(runner, "summary.md");
			const env = {
				GITHUB_REPOSITORY: "example/project",
				GITHUB_EVENT_NAME: "pull_request",
				GITHUB_REF: "refs/pull/42/merge",
				GITHUB_SHA: commit,
				CI_HEAD_SHA: headSha,
				CI_BASE_SHA: baseSha,
				CI_PR_DRAFT: "false",
				GITHUB_RUN_ID: "123",
				GITHUB_RUN_ATTEMPT: "2",
				CI_NEEDS: JSON.stringify(jobs),
				RUNNER_TEMP: runner,
				GITHUB_STEP_SUMMARY: summary,
			};
			const report = invoke(repo.dir, ["report"], env);
			expect(report.status, report.stderr).toBe(0);
			const artifact = path.join(runner, "ci-verification.json");
			const receipt = JSON.parse(readFileSync(artifact, "utf8"));
			expect(receipt.passed).toBe(true);
			expect(receipt.source).toEqual({ headSha, baseSha, testedSha: commit });
			expect(readFileSync(summary, "utf8")).toContain("CI verification: passed");

			const failedRunner = path.join(repo.dir, "failed-runner");
			mkdirSync(failedRunner);
			jobs.full.result = "failure";
			const failedSummary = path.join(failedRunner, "summary.md");
			const failed = invoke(repo.dir, ["report"], {
				...env,
				CI_NEEDS: JSON.stringify(jobs),
				RUNNER_TEMP: failedRunner,
				GITHUB_STEP_SUMMARY: failedSummary,
			});
			expect(failed.status, failed.stderr).toBe(1);
			const failure = JSON.parse(
				readFileSync(path.join(failedRunner, "ci-verification.json"), "utf8"),
			);
			expect(failure.passed).toBe(false);
			expect(failure.problems).toContain("full: failure");
			expect(readFileSync(failedSummary, "utf8")).toContain("| full | failure | yes |");
		} finally {
			repo.remove();
		}
	});

	it("refuses capture from a different checkout before publishing source metadata", () => {
		const repo = tempRepo();
		try {
			repo.write("pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
			repo.commit("test: seed capture mismatch");
			const output = path.join(repo.dir, "github-output");
			const result = invoke(repo.dir, ["capture"], { GITHUB_SHA: headSha, GITHUB_OUTPUT: output });
			expect(result.status).toBe(2);
			expect(result.stderr).toContain("checkout differs from event SHA");
			expect(existsSync(output)).toBe(false);
		} finally {
			repo.remove();
		}
	});
});
