import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { tempRepo } from "../test/temp-repo.ts";
import { areaNames, classify } from "./changes.ts";
import { UsageError } from "./lib.ts";
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
	changes: {
		...job(),
		outputs: {
			...job().outputs,
			"docs-only": String(docsOnly),
			areas: JSON.stringify(docsOnly ? ["docs-only"] : ["ts"]),
			"template-smoke": "false",
		},
	},
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
		expect(receipt.selection).toEqual({
			areas: ["ts"],
			rust: [],
			spikes: [],
			heavy: [],
			templateSmoke: false,
		});
		expect(Object.keys(receipt).sort()).toEqual(
			[
				"version",
				"run",
				"source",
				"coverage",
				"selection",
				"jobResults",
				"passed",
				"problems",
			].sort(),
		);
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
			if (name === "changes") expect(receipt.selection).toBeNull();
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

	it("refuses an unrecognized fifth job instead of ignoring its failure", () => {
		const jobs = { ...needs(), python: { result: "failure", outputs: {} } };
		expect(() => buildReceipt(input({ needs: JSON.stringify(jobs) }))).toThrow(
			new UsageError("unknown job in CI metadata"),
		);
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
		jobs.changes.outputs.unrelated = "unrelated-classifier-marker";
		changeSource(jobs, "cheap", { unrelated: "unrelated-source-marker" });
		const receipt = buildReceipt(input({}, jobs));
		expect(receipt.passed).toBe(true);
		for (const serialized of [JSON.stringify(receipt), renderSummary(receipt)]) {
			expect(serialized).not.toContain("unrelated-output-marker");
			expect(serialized).not.toContain("unrelated-classifier-marker");
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

describe("verification receipt selection metadata", () => {
	const selected = (outputs: Record<string, unknown>) => {
		const jobs = needs();
		Object.assign(jobs.changes.outputs, outputs);
		return buildReceipt(input({}, jobs));
	};

	it.each([undefined, ""])(
		"records explicitly empty selection when optional list outputs are %s",
		(value) => {
			const receipt = selected({ areas: "[]", rust: value, spikes: value, heavy: value });
			expect(receipt.passed).toBe(true);
			expect(receipt.selection).toEqual({
				areas: [],
				rust: [],
				spikes: [],
				heavy: [],
				templateSmoke: false,
			});
		},
	);

	it("preserves full Rust, spike, dependent-heavy and template-smoke selection in its JSON and summary", () => {
		const selection = {
			areas: [
				"ts",
				"workflows",
				"rust:crates",
				"rust:spikes/s05-desktop/rust",
				"spikes/s01-sqlite3mc",
				"heavy:./packages/protocol",
				"heavy:...{./packages/protocol}",
				"heavy:./plugins/calendar",
				"heavy:...{./plugins/calendar}",
				"heavy:./tools/verify",
				"template-smoke",
			],
			rust: ["crates", "spikes/s05-desktop/rust"],
			spikes: ["spikes/s01-sqlite3mc", "spikes/s11-python-runtime"],
			heavy: [
				"./packages/protocol",
				"...{./packages/protocol}",
				"./plugins/calendar",
				"...{./plugins/calendar}",
				"./tools/verify",
			],
			templateSmoke: true,
		};
		const receipt = selected({
			areas: JSON.stringify(selection.areas),
			rust: selection.rust.join("\n"),
			spikes: selection.spikes.join("\n"),
			heavy: selection.heavy.join("\n"),
			"template-smoke": "true",
		});
		expect(receipt.passed).toBe(true);
		expect(receipt.selection).toEqual(selection);
		expect(JSON.parse(JSON.stringify(receipt)).selection).toEqual(selection);
		const summary = renderSummary(receipt);
		for (const value of [
			...selection.areas,
			...selection.rust,
			...selection.spikes,
			...selection.heavy,
		]) {
			expect(summary).toContain(value);
		}
		expect(summary).toMatch(/template.smoke[^\n]*(?:yes|true|selected)/i);
	});

	it("states none for each unselected suite and no for template smoke", () => {
		const summary = renderSummary(selected({ areas: "[]" }));
		for (const label of ["Areas", "Rust workspaces", "Spike suites", "Heavy filters"]) {
			expect(summary).toMatch(new RegExp(`${label}[^\\n]*none`, "i"));
		}
		expect(summary).toMatch(/template.smoke[^\n]*(?:no|false|none)/i);
	});

	it.each(["failure", "cancelled", "skipped"])(
		"does not claim selection from a %s classifier, including malformed outputs",
		(result) => {
			const jobs = needs();
			jobs.changes = {
				result,
				outputs: {
					areas: "not-json-untrusted-marker",
					rust: ["crates"],
					spikes: "../not-a-spike",
					heavy: "./packages/not-a-package\n# injected",
					"template-smoke": true,
				},
			};
			const receipt = buildReceipt(input({}, jobs));
			expect(receipt.passed).toBe(false);
			expect(receipt.selection).toBeNull();
			const summary = renderSummary(receipt);
			expect(summary).toMatch(/selection[^\n]*(?:unavailable|not available|not recorded)/i);
			expect(summary).not.toContain("not-json-untrusted-marker");
		},
	);

	it.each([
		undefined,
		null,
		false,
		[],
		{},
		"",
		"{",
		"null",
		"{}",
		'"ts"',
		"true",
		"[1]",
		"[null]",
		'["ts", "ts"]',
		'["TS"]',
		'["unknown area"]',
		'["ts\\nworkflows"]',
		'["ts\\n"]',
		'["heavy:./packages/protocol\\n"]',
		'["heavy:...{./apps/../hub}"]',
		'["rust:crates/../outside"]',
		'["rust:crates/.."]',
		'["spikes/.."]',
		'["heavy:./packages/.."]',
		'["Rust:crates"]',
		'[":crates"]',
		'["-rust:crates"]',
		'["rust/x:crates"]',
		'["python:./apps/./hub"]',
		'["android-host:apps//hub"]',
		'["heavy:...{./apps/..}"]',
		'["heavy:...{./apps/.}"]',
		'["rust:apps/Hub"]',
		'["spikes/../outside"]',
	])("refuses malformed, non-string, duplicate or unsafe areas %#", (areas) => {
		expect(() => selected({ areas })).toThrow(UsageError);
	});

	it.each([undefined, null, true, false, 0, "", "TRUE", "False", "yes", "true\n", "true\nfalse"])(
		"requires the classifier's exact string template-smoke decision %#",
		(value) => {
			expect(() => selected({ "template-smoke": value })).toThrow(UsageError);
		},
	);

	it.each(["rust", "spikes", "heavy"])("rejects non-string %s output types", (name) => {
		for (const value of [null, false, true, 0, [], {}, ["crates"]]) {
			expect(() => selected({ [name]: value })).toThrow(UsageError);
		}
	});

	it.each([
		["rust", "crates/../outside"],
		["rust", "crates/.."],
		["rust", ".."],
		["rust", "."],
		["rust", "crates//member"],
		["rust", "crates/./member"],
		["rust", "crates/"],
		["rust", "/crates"],
		["rust", "crates\\member"],
		["rust", "Crates/member"],
		["rust", "apps/hub/../native"],
		["rust", "apps/Hub/native"],
		["rust", "crates\n\ncrates/member"],
		["rust", "crates\n"],
		["rust", "crates\ncrates"],
		["rust", '["crates"]'],
		["spikes", "apps/hub/../probe"],
		["spikes", "spikes/../outside"],
		["spikes", "spikes/."],
		["spikes", "spikes//s01"],
		["spikes", "spikes/S01"],
		["spikes", "spikes/s01\nspikes/s01"],
		["spikes", '["spikes/s01"]'],
		["heavy", "./apps/Hub"],
		["heavy", "./apps/./hub"],
		["heavy", "...{./apps/../hub}"],
		["heavy", "...{./apps/..}"],
		["heavy", "...{./apps/.}"],
		["heavy", "./packages/../protocol"],
		["heavy", "./packages/.."],
		["heavy", "./.."],
		["heavy", "./packages//protocol"],
		["heavy", "./packages/Protocol"],
		["heavy", "{./packages/protocol}"],
		["heavy", "...{./packages/protocol}..."],
		["heavy", "./packages/protocol\n./packages/protocol"],
		["heavy", '["./packages/protocol"]'],
	])("rejects unsafe, malformed or duplicate %s selection %#", (name, value) => {
		expect(() => selected({ [name as string]: value })).toThrow(UsageError);
	});

	it("accepts CRLF-separated lists without retaining carriage returns", () => {
		expect(
			selected({
				rust: "crates\r\nspikes/s05-desktop/rust",
				spikes: "spikes/s01-sqlite3mc\r\nspikes/s11-python-runtime",
				heavy: "./packages/protocol\r\n...{./plugins/calendar}",
			}).selection,
		).toEqual({
			areas: ["ts"],
			rust: ["crates", "spikes/s05-desktop/rust"],
			spikes: ["spikes/s01-sqlite3mc", "spikes/s11-python-runtime"],
			heavy: ["./packages/protocol", "...{./plugins/calendar}"],
			templateSmoke: false,
		});
	});

	it("allows underscores in bounded workspace, spike and package names", () => {
		const receipt = selected({
			areas: JSON.stringify([
				"rust:crates/draftyak_protocol",
				"spikes/s05_desktop",
				"heavy:...{./packages/protocol_v1}",
			]),
			rust: "crates/draftyak_protocol\nspikes/s05_desktop/rust_control",
			spikes: "spikes/s05_desktop",
			heavy: "...{./packages/protocol_v1}",
		});
		expect(receipt.passed).toBe(true);
		expect(receipt.selection?.rust).toEqual([
			"crates/draftyak_protocol",
			"spikes/s05_desktop/rust_control",
		]);
		expect(receipt.selection?.spikes).toEqual(["spikes/s05_desktop"]);
		expect(receipt.selection?.heavy).toEqual(["...{./packages/protocol_v1}"]);
	});

	it("records new area names and repository paths without a classifier vocabulary update", () => {
		const areas = [
			"python",
			"android-host",
			"rust:apps/android-host/native",
			"python:packages/runtime-python",
			"android-host:apps/android-host",
			"apps/android-host/probe",
			"heavy:./apps/hub",
			"heavy:...{./apps/android-host}",
		];
		const receipt = selected({
			areas: JSON.stringify(areas),
			rust: "apps/android-host/native\ntools/verification/native.workspace",
			spikes: "apps/android-host/probe\nexperiments/python-runtime",
			heavy: "./apps/hub\n...{./apps/android-host}\n./tools/ci-checks",
		});
		expect(receipt.selection).toEqual({
			areas,
			rust: ["apps/android-host/native", "tools/verification/native.workspace"],
			spikes: ["apps/android-host/probe", "experiments/python-runtime"],
			heavy: ["./apps/hub", "...{./apps/android-host}", "./tools/ci-checks"],
			templateSmoke: false,
		});
	});

	it("records the area names and suite selection produced by the actual classifier", () => {
		const repo = tempRepo();
		try {
			const fixture = {
				"pnpm-lock.yaml":
					"lockfileVersion: '9.0'\nimporters:\n  .: {}\n  spikes/native-probe: {}\n  packages/receipt-probe: {}\n",
				"apps/android-host/native/Cargo.toml": "[workspace]\nmembers = []\n",
				"spikes/native-probe/package.json": "{}",
				"spikes/native-probe/rust/Cargo.toml": "[workspace]\nmembers = []\n",
				"packages/receipt-probe/package.json": '{"scripts":{"test:heavy":"test"}}',
			};
			for (const [file, content] of Object.entries(fixture)) repo.write(file, content);
			const files = [
				".github/workflows/check.yml",
				"apps/android-host/native/src/lib.rs",
				"spikes/native-probe/rust/src/lib.rs",
				"packages/receipt-probe/src/index.ts",
			];
			const manifests = Object.keys(fixture).filter((file) => file.endsWith("Cargo.toml"));
			const classified = classify(files, repo.dir, () => manifests);
			const heavy =
				"heavy" in classified && Array.isArray(classified.heavy) ? classified.heavy : [];
			const templateSmoke = "templateSmoke" in classified && classified.templateSmoke === true;
			const jobs = needs(classified.docsOnly);
			Object.assign(jobs.changes.outputs, {
				areas: JSON.stringify(areaNames(classified)),
				rust: classified.rust.join("\n"),
				spikes: classified.spikes.join("\n"),
				heavy: heavy.join("\n"),
				"template-smoke": String(templateSmoke),
			});
			const receipt = buildReceipt(input({}, jobs));
			expect(receipt.passed).toBe(true);
			expect(receipt.selection).toEqual({
				areas: areaNames(classified),
				rust: classified.rust,
				spikes: classified.spikes,
				heavy,
				templateSmoke,
			});
			expect(receipt.selection?.areas).toContain("rust:apps/android-host/native");
		} finally {
			repo.remove();
		}
	});

	it.each([
		["rust", "crates/member-"],
		["spikes", "spikes/spike-"],
		["heavy", "./packages/package-"],
	] as const)(
		"bounds %s raw output independently of item count and item length",
		(name, prefix) => {
			const values = Array.from({ length: 100 }, (_, index) => {
				const item = `${prefix}${index}-`;
				return item + "a".repeat((index === 99 ? 148 : 163) - item.length);
			});
			const encoded = values.join("\n");
			expect(encoded.length).toBe(16 * 1024);
			expect(selected({ [name]: encoded }).selection?.[name]).toEqual(values);
			expect(() => selected({ [name]: `${encoded}a` })).toThrow(UsageError);
		},
	);

	it.each([
		["rust", (index: number) => `crates/member-${index}`],
		["spikes", (index: number) => `spikes/spike-${index}`],
		["heavy", (index: number) => `./packages/package-${index}`],
	] as const)("accepts 100 unique %s items and refuses 101", (name, item) => {
		const values = Array.from({ length: 100 }, (_, index) => item(index));
		expect(selected({ [name]: values.join("\n") }).selection?.[name]).toEqual(values);
		expect(() => selected({ [name]: [...values, item(100)].join("\n") })).toThrow(UsageError);
	});

	it.each([
		["rust", "crates/"],
		["spikes", "spikes/"],
		["heavy", "./packages/"],
	] as const)("accepts a 200-character %s item and refuses 201", (name, prefix) => {
		const value = prefix + "a".repeat(200 - prefix.length);
		expect(selected({ [name]: value }).selection?.[name]).toEqual([value]);
		expect(() => selected({ [name]: `${value}a` })).toThrow(UsageError);
	});

	it("accepts 300 unique areas and refuses 301", () => {
		const values = Array.from({ length: 300 }, (_, index) => `rust:crates/member-${index}`);
		expect(selected({ areas: JSON.stringify(values) }).selection?.areas).toEqual(values);
		expect(() =>
			selected({ areas: JSON.stringify([...values, "rust:crates/member-300"]) }),
		).toThrow(UsageError);
	});

	it("accepts a 240-character area and refuses 241", () => {
		const prefix = "rust:crates/";
		const value = prefix + "a".repeat(240 - prefix.length);
		expect(selected({ areas: JSON.stringify([value]) }).selection?.areas).toEqual([value]);
		expect(() => selected({ areas: JSON.stringify([`${value}a`]) })).toThrow(UsageError);
	});

	it("bounds areas JSON independently of its item count and item length", () => {
		const values = Array.from({ length: 200 }, (_, index) => {
			const item = `rust:crates/member-${index}-`;
			return item + "a".repeat((index === 199 ? 128 : 161) - item.length);
		});
		const encoded = JSON.stringify(values);
		expect(encoded.length).toBe(32 * 1024);
		expect(values.every((value) => value.length <= 240)).toBe(true);
		expect(selected({ areas: encoded }).selection?.areas).toEqual(values);
		values[199] += "a";
		expect(() => selected({ areas: JSON.stringify(values) })).toThrow(UsageError);
	});

	it("does not echo untrusted selection contents through a validation error", () => {
		const marker = "untrusted-value-marker";
		try {
			selected({ heavy: `./packages/protocol\n# ${marker}` });
			throw new Error("invalid selection was accepted");
		} catch (error) {
			expect(error).toBeInstanceOf(UsageError);
			expect(String(error)).not.toContain(marker);
		}
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

	it("exits 2 without publishing a receipt for an unrecognized failed job", () => {
		const repo = tempRepo();
		try {
			repo.write(".node-version", `${nodeVersion}\n`);
			const jobs = { ...needs(), python: { result: "failure", outputs: {} } };
			const result = invoke(repo.dir, ["report"], {
				GITHUB_REPOSITORY: "example/project",
				GITHUB_EVENT_NAME: "pull_request",
				GITHUB_REF: "refs/pull/42/merge",
				GITHUB_SHA: mergeSha,
				CI_HEAD_SHA: headSha,
				CI_BASE_SHA: baseSha,
				CI_PR_DRAFT: "false",
				GITHUB_RUN_ID: "123",
				GITHUB_RUN_ATTEMPT: "2",
				CI_NEEDS: JSON.stringify(jobs),
				RUNNER_TEMP: repo.dir,
				GITHUB_STEP_SUMMARY: path.join(repo.dir, "summary.md"),
			});
			expect(result.status).toBe(2);
			expect(result.stderr).toContain("unknown job in CI metadata");
			expect(existsSync(path.join(repo.dir, "ci-verification.json"))).toBe(false);
			expect(existsSync(path.join(repo.dir, "summary.md"))).toBe(false);
		} finally {
			repo.remove();
		}
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
			expect(receipt.selection).toEqual({
				areas: ["ts"],
				rust: [],
				spikes: [],
				heavy: [],
				templateSmoke: false,
			});
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
