import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { appendSummary, git, runCli, setOutputs, UsageError } from "./lib.ts";

export const jobNames = ["changes", "cheap", "full", "windows"] as const;
type JobName = (typeof jobNames)[number];
type JobResult = "success" | "failure" | "cancelled" | "skipped";
type Event = "pull_request" | "push" | "workflow_dispatch";

export interface Source {
	readonly checkoutSha: string;
	readonly treeSha: string;
	readonly lockfileSha256: string;
	readonly nodeVersion: string;
	readonly platform: string;
}

export interface ReceiptInput {
	readonly repository: string;
	readonly event: string;
	readonly ref: string;
	readonly eventSha: string;
	readonly headSha: string;
	readonly baseSha: string | null;
	readonly draft: boolean;
	readonly runId: string;
	readonly runAttempt: string;
	readonly nodeVersion: string;
	readonly needs: string;
}

export interface Selection {
	readonly areas: readonly string[];
	readonly rust: readonly string[];
	readonly spikes: readonly string[];
	readonly heavy: readonly string[];
	readonly templateSmoke: boolean;
}

export interface Receipt {
	readonly version: 1;
	readonly run: {
		readonly url: string;
		readonly id: string;
		readonly attempt: string;
		readonly event: Event;
	};
	readonly source: {
		readonly headSha: string;
		readonly baseSha: string | null;
		readonly testedSha: string;
	};
	readonly coverage: "docs" | "draft" | "linux" | "linux-and-windows";
	readonly selection: Selection | null;
	readonly jobResults: Readonly<
		Record<
			JobName,
			{
				readonly result: JobResult;
				readonly required: boolean;
				readonly source: Source | null;
			}
		>
	>;
	readonly passed: boolean;
	readonly problems: readonly string[];
}

function object(value: unknown): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new UsageError("expected an object in CI metadata");
	}
	return value as Record<string, unknown>;
}

function text(value: unknown, pattern: RegExp, name: string): string {
	if (typeof value !== "string" || pattern.exec(value)?.[0] !== value) {
		throw new UsageError(`invalid ${name} in CI metadata`);
	}
	return value;
}

const sha = (value: unknown): string => text(value, /^[a-f0-9]{40}$/, "commit or tree SHA");

function parseJson(value: string, name: string): unknown {
	try {
		return JSON.parse(value);
	} catch {
		throw new UsageError(`invalid ${name} JSON`);
	}
}

function parseSource(value: unknown): Source | null {
	if (value === undefined || value === "") return null;
	if (typeof value !== "string" || value.length > 1024) {
		throw new UsageError("invalid source metadata size");
	}
	const source = object(parseJson(value, "source"));
	return {
		checkoutSha: sha(source.checkoutSha),
		treeSha: sha(source.treeSha),
		lockfileSha256: text(source.lockfileSha256, /^[a-f0-9]{64}$/, "lockfile hash"),
		nodeVersion: text(source.nodeVersion, /^\d+\.\d+\.\d+$/, "Node version"),
		platform: text(source.platform, /^(linux|win32)$/, "runner platform"),
	};
}

// Record bounded repository paths, rather than a copy of the classifier's current vocabulary.
// The closing brace also ends a segment inside a dependent-package filter.
const segment = "(?!\\.{1,2}(?:/|\\}|$))[a-z0-9._-]+";
const repositoryPath = `${segment}(?:/${segment})*`;
const pathPattern = new RegExp(`^${repositoryPath}$`);
const heavyFilter = `(?:\\./${repositoryPath}|\\.\\.\\.\\{\\./${repositoryPath}\\})`;
const heavyPattern = new RegExp(`^${heavyFilter}$`);
const areaPattern = new RegExp(
	`^(?:${repositoryPath}|[a-z0-9][a-z0-9_-]*:(?:${repositoryPath}|${heavyFilter}))$`,
);

function selectionList(value: unknown, name: string, pattern: RegExp): readonly string[] {
	// Empty job outputs may be absent from GitHub's needs object.
	if (value === undefined || value === "") return [];
	if (typeof value !== "string" || value.length > 16 * 1024) {
		throw new UsageError(`invalid ${name} selection size`);
	}
	return selectionItems(value.split(/\r?\n/), name, pattern, 100, 200);
}

function selectionItems(
	value: unknown,
	name: string,
	pattern: RegExp,
	maximumItems: number,
	maximumLength: number,
): readonly string[] {
	if (!Array.isArray(value) || value.length > maximumItems) {
		throw new UsageError(`invalid ${name} selection count`);
	}
	const items = value.map((entry: unknown) => {
		if (
			typeof entry !== "string" ||
			entry.length > maximumLength ||
			pattern.exec(entry)?.[0] !== entry
		) {
			throw new UsageError(`invalid ${name} selection item`);
		}
		return entry;
	});
	if (new Set(items).size !== items.length) {
		throw new UsageError(`duplicate ${name} selection item`);
	}
	return items;
}

function parseSelection(outputs: Record<string, unknown>): Selection {
	if (typeof outputs.areas !== "string" || outputs.areas.length > 32 * 1024) {
		throw new UsageError("invalid areas selection size");
	}
	const areas = selectionItems(
		parseJson(outputs.areas, "areas selection"),
		"areas",
		areaPattern,
		300,
		240,
	);
	return {
		areas,
		rust: selectionList(outputs.rust, "rust", pathPattern),
		spikes: selectionList(outputs.spikes, "spikes", pathPattern),
		heavy: selectionList(outputs.heavy, "heavy", heavyPattern),
		templateSmoke:
			text(outputs["template-smoke"], /^(true|false)$/, "template-smoke output") === "true",
	};
}

// Only allowlisted, content-free metadata reaches the artifact or Markdown summary.
export function buildReceipt(input: ReceiptInput): Receipt {
	const repository = text(input.repository, /^[\w.-]+\/[\w.-]+$/, "repository");
	const event = text(input.event, /^(pull_request|push|workflow_dispatch)$/, "event") as Event;
	const testedSha = sha(input.eventSha);
	const headSha = sha(input.headSha);
	const baseSha = input.baseSha === null ? null : sha(input.baseSha);
	if (event === "pull_request" && baseSha === null) {
		throw new UsageError("a PR receipt needs its base SHA");
	}
	const id = text(input.runId, /^[1-9]\d*$/, "run id");
	const attempt = text(input.runAttempt, /^[1-9]\d*$/, "run attempt");
	const nodeVersion = text(input.nodeVersion, /^\d+\.\d+\.\d+$/, "Node pin");
	if (input.needs.length > 64 * 1024) throw new UsageError("CI job metadata exceeds 64 KiB");
	const needs = object(parseJson(input.needs, "job metadata"));
	const changes = object(needs.changes);
	const changesOutputs = object(changes.outputs ?? {});
	const docsOnly = changesOutputs["docs-only"] === "true";
	if (
		changes.result === "success" &&
		!["true", "false"].includes(String(changesOutputs["docs-only"]))
	) {
		throw new UsageError("successful changes job needs its docs-only output");
	}
	const selection = changes.result === "success" ? parseSelection(changesOutputs) : null;
	const full = !docsOnly && (event !== "pull_request" || !input.draft);
	const windows =
		!docsOnly && (input.ref === "refs/heads/main" || (event === "pull_request" && !input.draft));
	const required: Record<JobName, boolean> = { changes: true, cheap: true, full, windows };
	const problems: string[] = [];
	const entries = jobNames.map((name) => {
		const job = object(needs[name]);
		const result = text(
			job.result,
			/^(success|failure|cancelled|skipped)$/,
			"job result",
		) as JobResult;
		const outputs = object(job.outputs ?? {});
		const source = parseSource(outputs.source);
		if (
			(required[name] && result !== "success") ||
			result === "failure" ||
			result === "cancelled"
		) {
			problems.push(`${name}: ${result}`);
		}
		if (result === "success" && source === null) problems.push(`${name}: missing source metadata`);
		if (source !== null) {
			if (source.checkoutSha !== testedSha)
				problems.push(`${name}: checkout differs from tested SHA`);
			if (source.nodeVersion !== nodeVersion) problems.push(`${name}: Node differs from the pin`);
			const platform = name === "windows" ? "win32" : "linux";
			if (source.platform !== platform) problems.push(`${name}: unexpected runner platform`);
		}
		return [name, { result, required: required[name], source }] as const;
	});
	const jobResults = Object.fromEntries(entries) as Receipt["jobResults"];
	const reference = jobResults.changes.source;
	for (const [name, job] of entries) {
		if (job.source === null || reference === null) continue;
		if (job.source.treeSha !== reference.treeSha)
			problems.push(`${name}: tree differs between jobs`);
		if (job.source.lockfileSha256 !== reference.lockfileSha256)
			problems.push(`${name}: lockfile differs between jobs`);
	}
	return {
		version: 1,
		run: {
			url: `https://github.com/${repository}/actions/runs/${id}/attempts/${attempt}`,
			id,
			attempt,
			event,
		},
		source: { headSha, baseSha, testedSha },
		coverage: docsOnly ? "docs" : !full ? "draft" : windows ? "linux-and-windows" : "linux",
		selection,
		jobResults,
		passed: problems.length === 0,
		problems,
	};
}

export function renderSummary(receipt: Receipt): string {
	const selection = receipt.selection;
	const selected = (values: readonly string[]): string =>
		values.length === 0 ? "none" : values.map((value) => `\`${value}\``).join(", ");
	return [
		`### CI verification: ${receipt.passed ? "passed" : "failed"} (${receipt.coverage})`,
		"",
		`- PR/source head: \`${receipt.source.headSha}\``,
		`- Base: \`${receipt.source.baseSha ?? "not applicable"}\``,
		`- Tested checkout: \`${receipt.source.testedSha}\` (PR merge commit on pull requests)`,
		`- [Run ${receipt.run.id}, attempt ${receipt.run.attempt}](${receipt.run.url})`,
		"",
		"| Job | Result | Required for this run |",
		"| --- | --- | --- |",
		...jobNames.map(
			(name) =>
				`| ${name} | ${receipt.jobResults[name].result} | ${receipt.jobResults[name].required ? "yes" : "no"} |`,
		),
		"",
		...(selection === null
			? ["Selection unavailable: changes job did not succeed."]
			: [
					"| Selection | Value |",
					"| --- | --- |",
					`| Areas | ${selected(selection.areas)} |`,
					`| Rust workspaces | ${selected(selection.rust)} |`,
					`| Spike suites | ${selected(selection.spikes)} |`,
					`| Heavy filters | ${selected(selection.heavy)} |`,
					`| Template-smoke output | ${selection.templateSmoke ? "yes" : "no"} |`,
				]),
		"",
		"Selection is classifier output, not proof of execution. Compare GitHub's full-job step conclusions with the item's acceptance commands and run checks CI did not select.",
		"GitHub job records are authoritative; this receipt cannot establish its own trustworthiness.",
		"",
		"This receipt covers these CI jobs. A successful job does not establish that every test ran. Other workflows, live/device checks and owner acceptance remain separate.",
		...receipt.problems.map((problem) => `- ${problem}`),
	].join("\n");
}

function sourceAt(root: string): Source {
	return {
		checkoutSha: sha(git(["rev-parse", "HEAD"], root).trim()),
		treeSha: sha(git(["rev-parse", "HEAD^{tree}"], root).trim()),
		lockfileSha256: createHash("sha256")
			.update(readFileSync(path.join(root, "pnpm-lock.yaml")))
			.digest("hex"),
		nodeVersion: process.versions.node,
		platform: process.platform,
	};
}

function main(argv: readonly string[]): number {
	const root = process.cwd();
	if (argv.length === 1 && argv[0] === "capture") {
		const source = sourceAt(root);
		if (source.checkoutSha !== process.env.GITHUB_SHA)
			throw new UsageError("checkout differs from event SHA");
		setOutputs({ source: JSON.stringify(source) });
		console.log(`CI source: ${source.checkoutSha}, Node ${source.nodeVersion}, ${source.platform}`);
		return 0;
	}
	if (argv.length !== 1 || argv[0] !== "report") throw new UsageError("expected capture or report");
	const env = process.env;
	const base = env.CI_BASE_SHA;
	const draft = text(env.CI_PR_DRAFT, /^(true|false)$/, "draft state") === "true";
	const receipt = buildReceipt({
		repository: env.GITHUB_REPOSITORY ?? "",
		event: env.GITHUB_EVENT_NAME ?? "",
		ref: env.GITHUB_REF ?? "",
		eventSha: env.GITHUB_SHA ?? "",
		headSha: env.CI_HEAD_SHA ?? "",
		baseSha: !base || /^0+$/.test(base) ? null : base,
		draft,
		runId: env.GITHUB_RUN_ID ?? "",
		runAttempt: env.GITHUB_RUN_ATTEMPT ?? "",
		nodeVersion: readFileSync(path.join(root, ".node-version"), "utf8").trim(),
		needs: env.CI_NEEDS ?? "",
	});
	if (!env.RUNNER_TEMP) throw new UsageError("RUNNER_TEMP is required");
	writeFileSync(
		path.join(env.RUNNER_TEMP, "ci-verification.json"),
		`${JSON.stringify(receipt, null, 2)}\n`,
		{ flag: "wx" },
	);
	appendSummary(renderSummary(receipt));
	console.log(
		`CI verification: ${receipt.passed ? "passed" : "failed"} (${receipt.coverage}); ${receipt.run.url}`,
	);
	return receipt.passed ? 0 : 1;
}

if (import.meta.main) await runCli("verification-receipt", () => main(process.argv.slice(2)));
