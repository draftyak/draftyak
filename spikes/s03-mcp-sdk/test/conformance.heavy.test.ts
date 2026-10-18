import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { freePort, writeEvidence } from "@draftyak/spike-kit";
import { expect, it } from "vitest";
import { createApp, listen, type ServerFactory } from "../src/server.ts";
import { conformanceFactory, NOT_SERVED } from "./conformance-fixtures.ts";
import { codeFingerprint, recording } from "./evidence.ts";
import { modern, serve } from "./harness.ts";

type Era = "2025-11-25" | "2026-07-28";
type Status = "SUCCESS" | "FAILURE" | "WARNING" | "SKIPPED" | "INFO";
type Checks = ReadonlyMap<string, readonly Check[]>;
interface Check {
	readonly id: string;
	readonly status: Status;
}
interface Entry {
	readonly id: string;
	readonly reason: string;
}

const ERAS: readonly Era[] = ["2025-11-25", "2026-07-28"];
const STATUSES: readonly Status[] = ["SUCCESS", "FAILURE", "WARNING", "SKIPPED", "INFO"];
// SEP-2549 caching, the SEP-2243 header scenarios and SEP-2164 must run, every check passing.
const MUST_RUN: Readonly<Record<Era, readonly string[]>> = {
	"2025-11-25": [],
	"2026-07-28": [
		"caching",
		"http-header-validation",
		"http-custom-header-server-validation",
		"sep-2164-resource-not-found",
	],
};
// Header, caching and SEP-2164 checks may never be baselined, in whichever scenario they sit:
// server-stateless also checks the header-mismatch rule.
const PROTECTED = /header|cach|2243|2549|2164/i;
const isProtected = (era: Era, id: string): boolean =>
	MUST_RUN[era].includes(id.split(":")[0] ?? "") || PROTECTED.test(id);

// Direct dependencies, as pnpm links them into the spike's node_modules.
const installed = (name: string): string =>
	fileURLToPath(new URL(`../node_modules/${name}/`, import.meta.url));
const versionOf = (name: string): string =>
	JSON.parse(readFileSync(path.join(installed(name), "package.json"), "utf8")).version;
const conformanceDir = installed("@modelcontextprotocol/conformance");
const cli = path.join(conformanceDir, "dist", "index.js");
const baselineFile = new URL("../conformance-baseline.json", import.meta.url);
const baseline = JSON.parse(readFileSync(baselineFile, "utf8")) as Record<Era, Entry[]>;

function conform(args: readonly string[], cwd: string): Promise<{ code: number; output: string }> {
	const env = { ...process.env, DO_NOT_TRACK: "1", NO_COLOR: "1" };
	const options = { cwd, env, timeout: 120_000, maxBuffer: 64 * 1024 * 1024, windowsHide: true };
	return new Promise((resolve) => {
		execFile(process.execPath, [cli, ...args], options, (error, stdout, stderr) => {
			const code = error === null ? 0 : typeof error.code === "number" ? error.code : -1;
			resolve({ code, output: `${stdout}\n${stderr}` });
		});
	});
}

// The CLI writes <dir>/server-<scenario>-<ISO time with - for : and .>/checks.json.
function checksOf(dir: string): Map<string, Check[]> {
	const found = new Map<string, Check[]>();
	for (const entry of existsSync(dir) ? readdirSync(dir) : []) {
		const scenario = /^server-(.+)-\d{4}-\d\d-\d\dT[\d-]+Z$/.exec(entry)?.[1];
		if (scenario)
			found.set(scenario, JSON.parse(readFileSync(path.join(dir, entry, "checks.json"), "utf8")));
	}
	return found;
}

const failing = (status: Status | undefined): boolean =>
	status === "FAILURE" || status === "WARNING";

// A check as the CLI scores it against the baseline: the worst of its non-INFO results.
function statusOf(checks: Checks, id: string): Status | undefined {
	const [scenario = "", check] = id.split(":");
	const rank = (status: Status): number => ["SUCCESS", "WARNING", "FAILURE"].indexOf(status);
	const results = (checks.get(scenario) ?? []).filter(
		(result) => result.id === check && result.status !== "INFO",
	);
	return results.toSorted((a, b) => rank(b.status) - rank(a.status))[0]?.status;
}

// Protected checks outside the must-run scenarios, with how they scored.
function protectedElsewhere(era: Era, checks: Checks): Record<string, Status | undefined> {
	const ids = [...checks].flatMap(([scenario, list]) =>
		MUST_RUN[era].includes(scenario)
			? []
			: list
					.filter((check) => check.status !== "INFO" && PROTECTED.test(`${scenario}:${check.id}`))
					.map((check) => `${scenario}:${check.id}`),
	);
	return Object.fromEntries([...new Set(ids)].toSorted().map((id) => [id, statusOf(checks, id)]));
}

// The CLI's frozen requirement set for the era: "required" for each scored scenario, else the
// reason it runs unscored under --requirements ("pending", "extension", "added-after-release").
function requirementsOf(era: Era): Map<string, string> {
	const file = path.join(conformanceDir, "requirements", `${era}.yaml`);
	const text = readFileSync(file, "utf8").replaceAll("\r\n", "\n");
	const classes = new Map<string, string>();
	const required = /^server:\n((?: {2}- \S+\n)+)/m.exec(text)?.[1] ?? "";
	for (const [, name = ""] of required.matchAll(/^ {2}- (\S+)$/gm)) classes.set(name, "required");
	const unscored = /^ {2}- scenario: (\S+)\n {4}leg: server\n {4}reason: (\S+)$/gm;
	for (const [, name = "", reason = ""] of text.matchAll(unscored)) classes.set(name, reason);
	return classes;
}

const tally = (checks: readonly Check[]): Record<Status, number> =>
	Object.fromEntries(
		STATUSES.map((status) => [status, checks.filter((check) => check.status === status).length]),
	) as Record<Status, number>;

// What a factory serves, by tool and prompt name, resource URI and template.
async function surface(factory?: ServerFactory): Promise<Record<string, string[]>> {
	const app = createApp(factory ? { factory } : {});
	const list = async (method: string, key: string, field: string): Promise<string[]> => {
		const items: Record<string, string>[] = (await serve(app, modern(method))).body.result[key];
		return items.map((item) => item[field] ?? "");
	};
	return {
		tools: await list("tools/list", "tools", "name"),
		prompts: await list("prompts/list", "prompts", "name"),
		resources: await list("resources/list", "resources", "uri"),
		templates: await list("resources/templates/list", "resourceTemplates", "uriTemplate"),
	};
}

// Every scenario applicable to the era, pending ones included. --requirements would leave the
// SEP-2243 header scenarios unscored (pending in 0.2.0-alpha.12).
async function runEra(era: Era, url: string, work: string, withBaseline: boolean) {
	const out = path.join(work, `${era}-${withBaseline ? "fixtures" : "production"}`);
	const args = [
		"server",
		"--url",
		url,
		"--suite",
		"all",
		"--spec-version",
		era,
		"--output-dir",
		out,
	];
	if (withBaseline) {
		const expected = path.join(work, `expected-${era}.json`);
		writeFileSync(expected, JSON.stringify({ server: baseline[era].map((entry) => entry.id) }));
		args.push("--expected-failures", expected);
	}
	const started = performance.now();
	const run = await conform(args, work);
	const checks = checksOf(out);
	const failed = [...checks]
		.filter(([, list]) => list.some((check) => failing(check.status)))
		.map(([scenario]) => scenario)
		.toSorted();
	return { run, checks, failed, durationMs: Math.round(performance.now() - started) };
}

it("passes MCP conformance in both eras apart from the reviewed baseline", {
	timeout: 280_000,
}, async (ctx) => {
	const work = mkdtempSync(path.join(tmpdir(), "draftyak-s03-conformance-"));
	ctx.onTestFinished(() => rmSync(work, { recursive: true, force: true }));
	const fixtures = conformanceFactory();
	const withFixtures = await listen(await freePort(), { factory: fixtures });
	ctx.onTestFinished(() => withFixtures.close());
	const production = await listen(await freePort());
	ctx.onTestFinished(() => production.close());

	const eras: Record<string, unknown> = {};
	for (const era of ERAS) {
		const entries = baseline[era];
		// One check per entry, so the rest of each scenario still counts; each with its reason.
		expect(entries.filter((entry) => !/^[a-z0-9-]+:[a-z0-9-]+$/.test(entry.id))).toEqual([]);
		expect(entries.filter((entry) => entry.reason.trim().length < 20)).toEqual([]);
		expect(entries.filter((entry) => isProtected(era, entry.id))).toEqual([]);
		const requirements = requirementsOf(era);
		expect([...requirements.values()]).toContain("required");
		expect(MUST_RUN[era].filter((scenario) => !requirements.has(scenario))).toEqual([]);

		const { run, checks, failed, durationMs } = await runEra(era, withFixtures.url, work, true);
		expect(run.code, run.output.slice(-6_000)).toBe(0);
		expect(checks.size).toBeGreaterThan(0);
		// The CLI ignores an entry whose check never ran, so each must still match a failure.
		const matched = Object.fromEntries(
			entries.map((entry) => [entry.id, statusOf(checks, entry.id)]),
		);
		expect(Object.entries(matched).filter(([, status]) => !failing(status))).toEqual([]);
		// Each must-run scenario ran and every check in it succeeded: a skipped check fails it.
		for (const scenario of MUST_RUN[era]) {
			const ran = (checks.get(scenario) ?? []).filter((check) => check.status !== "INFO");
			expect(ran.length, `${scenario} ran`).toBeGreaterThan(0);
			expect(
				ran.filter((check) => check.status !== "SUCCESS"),
				`${scenario} passed`,
			).toEqual([]);
		}
		const guarded = protectedElsewhere(era, checks);
		expect(Object.entries(guarded).filter(([, status]) => status !== "SUCCESS")).toEqual([]);

		const bare = await runEra(era, production.url, work, false);
		eras[era] = {
			specVersion: era,
			scenariosRun: checks.size,
			scenariosClean: checks.size - failed.length,
			scenariosWithFailures: failed,
			checkCounts: tally([...checks.values()].flat()),
			durationMs,
			baseline: matched,
			mustRun: Object.fromEntries(
				MUST_RUN[era].map((scenario) => [scenario, requirements.get(scenario)]),
			),
			protectedChecks: guarded,
			scenarios: Object.fromEntries(
				[...checks.keys()].toSorted().map((scenario) => [
					scenario,
					{
						requirement: requirements.get(scenario) ?? "unlisted",
						...tally(checks.get(scenario) ?? []),
					},
				]),
			),
			withoutFixtures: { scenariosRun: bare.checks.size, scenariosWithFailures: bare.failed },
		};
	}
	const [served, base] = [await surface(fixtures), await surface()];
	const fixtureNames = Object.fromEntries(
		Object.entries(served).map(([kind, names]) => [
			kind,
			names.filter((name) => !base[kind]?.includes(name)),
		]),
	);
	// Written only when asked (DRAFTYAK_RECORD_EVIDENCE=1) or in CI, after every check above passed.
	if (!recording()) return;
	const data = {
		conformanceVersion: versionOf("@modelcontextprotocol/conformance"),
		serverSdkVersion: versionOf("@modelcontextprotocol/server"),
		honoVersion: versionOf("hono"),
		nodeServerVersion: versionOf("@hono/node-server"),
		invocation: "server --suite all --spec-version <era> --expected-failures <baseline for era>",
		eras,
		fixtureNames,
		fixtureNamesNotServed: NOT_SERVED,
	};
	const file = new URL("../evidence/conformance.json", import.meta.url);
	const written = await writeEvidence(file, data, { fingerprint: await codeFingerprint() });
	console.log(`evidence: ${written}`);
});
