import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { loadRun, refereeEntryPoint, verifyCliPackage } from "./artifacts.ts";
import { evaluateRuns, parseBaseline, parseRun } from "./gate.ts";
import { CONFORMANCE_VERSION, ERAS, MUST_RUN, REQUIRED_PROTECTED, SCENARIOS } from "./policy.ts";

const baselineFile = new URL("../../security/mcp-conformance-baseline.json", import.meta.url);
const baseline = JSON.parse(readFileSync(baselineFile, "utf8"));
type FixtureCheck = { id: string; status: string; details?: unknown };
type FixtureRun = {
	era: string;
	conformanceVersion: string;
	exitCode: number;
	args: string[];
	checks: Record<string, FixtureCheck[]>;
};

// Synthetic referee outputs only. These fixtures neither serve tools nor test a product server.
function syntheticRuns(): FixtureRun[] {
	return ERAS.map((era) => {
		const checks: FixtureRun["checks"] = Object.fromEntries(
			SCENARIOS[era].map((scenario) => [scenario, [{ id: "synthetic-check", status: "SUCCESS" }]]),
		);
		for (const entry of baseline[era]) {
			const [scenario, id] = entry.id.split(":");
			checks[scenario]?.push({
				id,
				status: scenario.startsWith("server-sse") ? "WARNING" : "FAILURE",
			});
		}
		if (era === "2026-07-28") {
			const [scenario, id] = REQUIRED_PROTECTED.split(":") as [string, string];
			checks[scenario]?.push({ id, status: "SUCCESS" });
		}
		return {
			era,
			conformanceVersion: CONFORMANCE_VERSION,
			exitCode: 0,
			args: [
				"server",
				"--url",
				"http://127.0.0.1:47613/mcp",
				"--suite",
				"all",
				"--spec-version",
				era,
				"--output-dir",
				`synthetic-${era}`,
				"--expected-failures",
				`expected-${era}.json`,
			],
			checks,
		};
	});
}
const codes = (runs: unknown, entries: unknown = baseline): readonly string[] =>
	evaluateRuns(entries, runs).findings.map((finding) => finding.code);
const modern = (runs: FixtureRun[]): FixtureRun => runs[1] as FixtureRun;
const genuine = JSON.parse(
	readFileSync(new URL("./fixtures/referee-checks.json", import.meta.url), "utf8"),
) as { conformanceVersion: string; eras: Record<string, FixtureRun["checks"]> };

function genuineRuns(): FixtureRun[] {
	return syntheticRuns().map((run) => ({
		...run,
		checks: structuredClone(genuine.eras[run.era] ?? {}),
	}));
}

test("keeps the exact reviewed exceptions and applicable scenario sets", () => {
	assert.equal(
		readFileSync(baselineFile, "utf8"),
		readFileSync(
			new URL("../../spikes/s03-mcp-sdk/conformance-baseline.json", import.meta.url),
			"utf8",
		),
	);
	const historical = JSON.parse(
		readFileSync(
			new URL("../../spikes/s03-mcp-sdk/evidence/conformance.json", import.meta.url),
			"utf8",
		),
	);
	assert.equal(historical.data.conformanceVersion, CONFORMANCE_VERSION);
	for (const era of ERAS)
		assert.deepEqual(
			Object.keys(historical.data.eras[era].scenarios).sort(),
			[...SCENARIOS[era]].sort(),
		);
});

test("accepts a complete synthetic output with only live reviewed failures/warnings", () => {
	const report = evaluateRuns(baseline, syntheticRuns());
	assert.equal(report.passed, true);
	assert.deepEqual(report.findings, []);
	assert.deepEqual(
		report.eras.map((era) => era.scenarios),
		[33, 40],
	);
	assert.equal(report.eras[0]?.counts.WARNING, 2);
	assert.equal(Object.isFrozen(parseBaseline(baseline)[ERAS[0]]), true);
});

test("accepts content-free check IDs and statuses from genuine pinned-referee runs in both eras", () => {
	assert.equal(genuine.conformanceVersion, CONFORMANCE_VERSION);
	const report = evaluateRuns(baseline, genuineRuns());
	assert.equal(report.passed, true);
	assert.deepEqual(report.findings, []);
	assert.deepEqual(
		report.eras.map((era) => era.scenarios),
		[33, 40],
	);
	assert.deepEqual(
		report.eras.map((era) => era.counts),
		[
			{ SUCCESS: 58, FAILURE: 9, WARNING: 2, SKIPPED: 0, INFO: 5 },
			{ SUCCESS: 146, FAILURE: 1, WARNING: 0, SKIPPED: 5, INFO: 1 },
		],
	);
	for (const run of genuineRuns()) {
		assert.ok(
			run.checks["json-schema-2020-12"]?.some(
				(check) => check.id === "json-schema-2020-12-$schema",
			),
		);
		assert.ok(
			run.checks["json-schema-2020-12"]?.some((check) => check.id === "json-schema-2020-12-$defs"),
		);
	}
});

test("accepts genuine referee JSON Schema IDs without loosening the baseline separator", () => {
	const runs = syntheticRuns();
	for (const run of runs)
		run.checks["json-schema-2020-12"] = [
			{ id: "json-schema-2020-12-$schema", status: "SUCCESS" },
			{ id: "json-schema-2020-12-$defs", status: "SUCCESS" },
		];
	assert.equal(evaluateRuns(baseline, runs).passed, true);
	for (const id of [
		"",
		"with space",
		"with:separator",
		"tab\t",
		"line\n",
		"\u007f",
		"é",
		"x".repeat(181),
	]) {
		const invalid = syntheticRuns();
		modern(invalid).checks["json-schema-2020-12"] = [{ id, status: "SUCCESS" }];
		assert.ok(codes(invalid).includes("INVALID_INPUT"));
	}
	const entries = structuredClone(baseline);
	entries[ERAS[0]].push({
		id: "tools-call-with-progress:check-$defs",
		reason: "Synthetic parser-only exception; never an approved baseline change.",
	});
	assert.doesNotThrow(() => parseBaseline(entries));
	entries[ERAS[0]].at(-1).id = "tools-call-with-progress:check:other";
	assert.throws(() => parseBaseline(entries));
});

test("refuses custom array prototypes without evaluating inherited hooks", () => {
	let invoked = 0;
	const prototype = Object.create(Array.prototype);
	Object.defineProperty(prototype, "map", {
		get() {
			invoked++;
			return Array.prototype.map;
		},
	});
	const runs = syntheticRuns();
	Object.setPrototypeOf(runs, prototype);
	assert.deepEqual(codes(runs), ["INVALID_INPUT"]);
	const entries = structuredClone(baseline);
	Object.setPrototypeOf(entries[ERAS[0]], prototype);
	assert.throws(() => parseBaseline(entries));
	assert.equal(invoked, 0);
});

test("requires exactly one run per era, not a successful modern-only or duplicated run", () => {
	const runs = syntheticRuns();
	assert.ok(codes([modern(runs)]).includes("ERA_RUN_COUNT"));
	assert.ok(codes([modern(runs), modern(runs)]).includes("ERA_RUN_COUNT"));
	assert.equal(evaluateRuns(baseline, [...runs, runs[0]]).passed, false);
});

test("refuses a changed referee pin, nonzero process status, and requirements-only invocation", () => {
	for (const mutation of [
		(run: FixtureRun) => {
			run.conformanceVersion = "0.2.0-alpha.13";
		},
		(run: FixtureRun) => {
			run.exitCode = 1;
		},
		(run: FixtureRun) => {
			run.args[5] = "--requirements";
		},
		(run: FixtureRun) => {
			run.args[6] = ERAS[0];
		},
		(run: FixtureRun) => {
			run.args.push("--force");
		},
		(run: FixtureRun) => {
			run.args[4] = "core";
		},
	]) {
		const runs = syntheticRuns();
		mutation(modern(runs));
		assert.equal(evaluateRuns(baseline, runs).passed, false);
	}
});

test("never validates remote, credential-bearing or query-bearing target receipts", () => {
	for (const url of [
		"https://example.test/mcp",
		"http://user:canary@127.0.0.1/mcp",
		"http://127.0.0.1/mcp?token=canary",
		"http://0x7f000001/mcp",
	]) {
		const runs = syntheticRuns();
		modern(runs).args[2] = url;
		assert.ok(codes(runs).includes("INVOCATION"));
	}
});

test("refuses an absent, extra, or empty scenario", () => {
	for (const mutation of [
		(run: FixtureRun) => {
			delete run.checks["tools-list"];
		},
		(run: FixtureRun) => {
			run.checks["unknown-scenario"] = [{ id: "x", status: "SUCCESS" }];
		},
		(run: FixtureRun) => {
			run.checks["tools-list"] = [];
		},
	]) {
		const runs = syntheticRuns();
		mutation(modern(runs));
		assert.equal(evaluateRuns(baseline, runs).passed, false);
	}
});

for (const scenario of MUST_RUN[ERAS[1]]) {
	for (const status of ["FAILURE", "WARNING", "SKIPPED"]) {
		test(`${scenario} refuses ${status} even alongside success`, () => {
			const runs = syntheticRuns();
			modern(runs).checks[scenario]?.push({ id: "another-check", status });
			assert.ok(codes(runs).includes("PROTECTED_CHECK"));
		});
	}
}

test("an INFO-only must-run scenario cannot satisfy the run requirement", () => {
	const runs = syntheticRuns();
	modern(runs).checks.caching = [{ id: "note", status: "INFO" }];
	assert.ok(codes(runs).includes("MUST_RUN_EMPTY"));
});

test("requires the explicit successful stateless header-mismatch check", () => {
	for (const status of [undefined, "INFO", "SKIPPED", "WARNING", "FAILURE"]) {
		const runs = syntheticRuns();
		const checks = modern(runs).checks["server-stateless"] as FixtureCheck[];
		checks.pop();
		if (status) checks.push({ id: REQUIRED_PROTECTED.split(":")[1] as string, status });
		assert.ok(codes(runs).includes("REQUIRED_HEADER_CHECK"));
	}
});

test("protects header/cache/SEP checks outside the named must-run scenarios in either era", () => {
	for (const eraIndex of [0, 1]) {
		for (const id of [
			"http-header-check",
			"caching-hint",
			"sep-2243-x",
			"sep-2549-x",
			"sep-2164-x",
		]) {
			const runs = syntheticRuns();
			runs[eraIndex]?.checks["tools-list"]?.push({ id, status: "SKIPPED" });
			assert.ok(codes(runs).includes("PROTECTED_CHECK"));
		}
	}
});

test("rejects baselining protected IDs, duplicate exceptions and weak explanations", () => {
	for (const id of [
		"tools-list:http-header-check",
		"tools-list:caching",
		"tools-list:sep-2164",
		"caching:synthetic-check",
	]) {
		const entries = structuredClone(baseline);
		entries[ERAS[1]].push({ id, reason: "This exception must always be refused by the guard." });
		assert.ok(codes(syntheticRuns(), entries).includes("INVALID_INPUT"));
	}
	const duplicate = structuredClone(baseline);
	duplicate[ERAS[1]].push(duplicate[ERAS[1]][0]);
	assert.throws(() => parseBaseline(duplicate));
	const weak = structuredClone(baseline);
	weak[ERAS[1]][0].reason = "known";
	assert.throws(() => parseBaseline(weak));
});

test("passing, skipped, informational and missing exceptions are stale", () => {
	for (const status of ["SUCCESS", "SKIPPED", "INFO", undefined]) {
		const runs = syntheticRuns();
		const checks = modern(runs).checks["tools-call-with-progress"] as FixtureCheck[];
		checks.pop();
		if (status) checks.push({ id: "tools-call-with-progress", status });
		assert.ok(codes(runs).includes("STALE_BASELINE"));
	}
});

test("an exception excuses only its check, not another failure in that scenario", () => {
	const runs = syntheticRuns();
	modern(runs).checks["tools-call-with-progress"]?.push({
		id: "result-malformed",
		status: "WARNING",
	});
	assert.ok(codes(runs).includes("UNEXPECTED_FAILURE"));
});

test("permits nonprotected skips and INFO like the reviewed stateless suite", () => {
	const runs = syntheticRuns();
	modern(runs).checks["server-stateless"]?.push({ id: "optional-session", status: "SKIPPED" });
	modern(runs).checks.caching?.push({ id: "header-note", status: "INFO" });
	assert.equal(evaluateRuns(baseline, runs).passed, true);
});

test("rejects malformed statuses, sparse arrays and accessors without evaluating code", () => {
	const invalid = syntheticRuns();
	modern(invalid).checks.caching = [{ id: "x", status: "PASSED" }];
	assert.ok(codes(invalid).includes("INVALID_INPUT"));
	let calls = 0;
	const accessor = Object.defineProperty({}, "era", {
		enumerable: true,
		get() {
			calls++;
			return ERAS[1];
		},
	});
	const proxy = new Proxy(
		{},
		{
			ownKeys() {
				calls++;
				return [];
			},
		},
	);
	for (const value of [accessor, proxy]) assert.throws(() => parseRun(value));
	const sparse = new Array(2);
	sparse[1] = modern(syntheticRuns());
	assert.ok(codes(sparse).includes("INVALID_INPUT"));
	assert.equal(calls, 0);
});

test("reports only counts and fixed findings, never raw diagnostics or invocation values", () => {
	const runs = syntheticRuns();
	modern(runs).checks["tools-list"]?.push({
		id: "synthetic-failure",
		status: "FAILURE",
		details: { secret: "DETAIL_CANARY" },
	});
	modern(runs).args[8] = "PATH_CANARY";
	const json = JSON.stringify(evaluateRuns(baseline, runs));
	assert.ok(json.includes("UNEXPECTED_FAILURE"));
	assert.ok(!json.includes("DETAIL_CANARY") && !json.includes("PATH_CANARY"));
});

function writeArtifacts(directory: string, run: FixtureRun): void {
	mkdirSync(directory, { recursive: true });
	const { checks, ...metadata } = run;
	const args = run.args.slice();
	args[8] = directory;
	writeFileSync(path.join(directory, "run.json"), JSON.stringify({ ...metadata, args }));
	for (const [scenario, values] of Object.entries(checks)) {
		const folder = path.join(directory, `server-${scenario}-2026-10-18T00-00-00-000Z`);
		mkdirSync(folder);
		writeFileSync(path.join(folder, "checks.json"), JSON.stringify(values));
	}
}

test("loads actual CLI directory layout and refuses complete duplicate artifacts", async (ctx) => {
	const directory = mkdtempSync(
		path.join(realpathSync.native(tmpdir()), "draftyak-conformance-unit-"),
	);
	ctx.onTestFinished(() => rmSync(directory, { recursive: true, force: true }));
	const run = modern(syntheticRuns());
	writeArtifacts(directory, run);
	assert.equal((await loadRun(directory, ERAS[1])).era, ERAS[1]);
	const duplicate = path.join(directory, "server-tools-list-2026-10-18T00-00-01-000Z");
	mkdirSync(duplicate);
	writeFileSync(
		path.join(duplicate, "checks.json"),
		JSON.stringify([{ id: "hidden", status: "SUCCESS" }]),
	);
	await assert.rejects(loadRun(directory, ERAS[1]));
});

test("loads genuine artifact runs concurrently without a shared admission latch", async (ctx) => {
	const directory = mkdtempSync(
		path.join(realpathSync.native(tmpdir()), "draftyak-conformance-concurrent-"),
	);
	ctx.onTestFinished(() => rmSync(directory, { recursive: true, force: true }));
	const runs = genuineRuns();
	const directories = runs.map((run) => path.join(directory, run.era));
	runs.forEach((run, index) => {
		writeArtifacts(directories[index] as string, run);
	});
	const settled = await Promise.allSettled(
		directories.map((selected, index) => loadRun(selected, ERAS[index] as (typeof ERAS)[number])),
	);
	assert.deepEqual(
		settled.map((result) => result.status),
		["fulfilled", "fulfilled"],
	);
	const loaded = settled.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
	const report = evaluateRuns(baseline, loaded);
	assert.equal(report.passed, true);
	assert.deepEqual(report.findings, []);
	assert.deepEqual(
		report.eras.map((era) => era.scenarios),
		[33, 40],
	);
});

test("pins the package-local referee and binds each receipt to its actual output directory", async (ctx) => {
	await assert.doesNotReject(verifyCliPackage());
	assert.equal(path.basename(refereeEntryPoint()), "index.js");
	assert.equal(path.basename(path.dirname(refereeEntryPoint())), "dist");
	const directory = mkdtempSync(
		path.join(realpathSync.native(tmpdir()), "draftyak-conformance-receipt-"),
	);
	ctx.onTestFinished(() => rmSync(directory, { recursive: true, force: true }));
	const run = modern(syntheticRuns());
	writeArtifacts(directory, run);
	const receipt = path.join(directory, "run.json");
	const metadata = JSON.parse(readFileSync(receipt, "utf8"));
	metadata.args[8] = path.join(directory, "elsewhere");
	writeFileSync(receipt, JSON.stringify(metadata));
	await assert.rejects(loadRun(directory, ERAS[1]));
});

test("CLI prints a bounded gate report and fails closed on missing receipts", (ctx) => {
	const directory = mkdtempSync(
		path.join(realpathSync.native(tmpdir()), "draftyak-conformance-unit-"),
	);
	ctx.onTestFinished(() => rmSync(directory, { recursive: true, force: true }));
	const [legacy, modernRun] = genuineRuns() as [FixtureRun, FixtureRun];
	const legacyDir = path.join(directory, "legacy"),
		modernDir = path.join(directory, "modern");
	writeArtifacts(legacyDir, legacy);
	writeArtifacts(modernDir, modernRun);
	const cli = fileURLToPath(new URL("./cli.ts", import.meta.url));
	const args = [cli, "--legacy", legacyDir, "--modern", modernDir];
	const result = spawnSync(process.execPath, args, { encoding: "utf8", windowsHide: true });
	assert.equal(result.status, 0, result.stderr);
	assert.equal(JSON.parse(result.stdout).gate, "mcp-http-conformance-artifacts");
	modernRun.checks["tools-list"]?.push({ id: "unexpected", status: "FAILURE" });
	rmSync(modernDir, { recursive: true });
	writeArtifacts(modernDir, modernRun);
	const failed = spawnSync(process.execPath, args, { encoding: "utf8", windowsHide: true });
	assert.equal(failed.status, 1, failed.stderr);
	assert.equal(JSON.parse(failed.stdout).passed, false);
	rmSync(path.join(modernDir, "run.json"));
	const refused = spawnSync(process.execPath, args, { encoding: "utf8", windowsHide: true });
	assert.equal(refused.status, 2);
	assert.equal(refused.stdout, "");
	assert.ok(!refused.stderr.includes(directory));
});

test("linked CLI entries refuse bad arguments and cannot select a caller package", (ctx) => {
	const directory = mkdtempSync(
		path.join(realpathSync.native(tmpdir()), "draftyak-conformance-entry-"),
	);
	ctx.onTestFinished(() => rmSync(directory, { recursive: true, force: true }));
	const link = path.join(directory, "entry");
	symlinkSync(fileURLToPath(new URL(".", import.meta.url)), link, "junction");
	for (const args of [
		["--legacy", "nowhere"],
		["--cli-package", directory, "--legacy", "a", "--modern", "b"],
	]) {
		const result = spawnSync(process.execPath, [path.join(link, "cli.ts"), ...args], {
			encoding: "utf8",
			windowsHide: true,
			timeout: 5_000,
		});
		assert.equal(result.status, 2, result.stderr);
		assert.equal(result.stdout, "");
		assert.ok(result.stderr.startsWith("Usage:"));
	}
});
