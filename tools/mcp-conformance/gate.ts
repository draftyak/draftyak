import { isProxy } from "node:util/types";
import {
	CONFORMANCE_VERSION,
	ERAS,
	type Era,
	MUST_RUN,
	PROTECTED_ID,
	REQUIRED_PROTECTED,
	SCENARIOS,
	STATUSES,
	type Status,
} from "./policy.ts";

export interface BaselineEntry {
	readonly id: string;
	readonly reason: string;
}
export type Baseline = Readonly<Record<Era, readonly BaselineEntry[]>>;
export interface Check {
	readonly id: string;
	readonly status: Status;
}
export interface Run {
	readonly era: Era;
	readonly conformanceVersion: string;
	readonly args: readonly string[];
	readonly exitCode: number;
	readonly checks: Readonly<Record<string, readonly Check[]>>;
}
export interface Finding {
	readonly code: string;
	readonly era?: Era;
	readonly scenario?: string;
	readonly baselineId?: string;
}
export interface GateReport {
	readonly schemaVersion: 1;
	readonly gate: "mcp-http-conformance-artifacts";
	readonly conformanceVersion: typeof CONFORMANCE_VERSION;
	readonly passed: boolean;
	readonly findings: readonly Finding[];
	readonly eras: readonly {
		readonly era: Era;
		readonly scenarios: number;
		readonly counts: Readonly<Record<Status, number>>;
	}[];
}

// Referee check IDs are bounded printable ASCII; ':' remains the baseline separator.
const checkId = /^[!-9;-~]{1,180}$/;
const baselineId = /^[a-z0-9-]{1,120}:[!-9;-~]{1,180}$/;

/** Refuse executable objects before looking at properties. Raw CLI details are discarded. */
function record(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || isProxy(value) || Array.isArray(value))
		throw new Error("Invalid conformance artifact");
	if (![Object.prototype, null].includes(Object.getPrototypeOf(value)))
		throw new Error("Invalid conformance artifact");
	if (Reflect.ownKeys(value).some((key) => typeof key !== "string"))
		throw new Error("Invalid conformance artifact");
	for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value)))
		if (!Object.hasOwn(descriptor, "value") || !descriptor.enumerable)
			throw new Error("Invalid conformance artifact");
	return value as Record<string, unknown>;
}
function vector(value: unknown, max: number): readonly unknown[] {
	if (!Array.isArray(value) || isProxy(value) || value.length > max)
		throw new Error("Invalid conformance artifact");
	if (Object.getPrototypeOf(value) !== Array.prototype)
		throw new Error("Invalid conformance artifact");
	const descriptors = Object.getOwnPropertyDescriptors(value);
	if (
		Reflect.ownKeys(descriptors).length !== value.length + 1 ||
		Array.from({ length: value.length }, (_, index) => descriptors[String(index)]).some(
			(descriptor) => !descriptor?.enumerable || !Object.hasOwn(descriptor, "value"),
		)
	)
		throw new Error("Invalid conformance artifact");
	return Array.from({ length: value.length }, (_, index) => descriptors[String(index)]?.value);
}
export function parseBaseline(input: unknown): Baseline {
	const object = record(input);
	if (Object.keys(object).length !== 2 || ERAS.some((era) => !Object.hasOwn(object, era)))
		throw new Error("Invalid conformance baseline");
	return Object.freeze(
		Object.fromEntries(
			ERAS.map((era) => {
				const seen = new Set<string>();
				const entries = vector(object[era], 100).map((item) => {
					const entry = record(item);
					if (
						Object.keys(entry).length !== 2 ||
						typeof entry.id !== "string" ||
						!baselineId.test(entry.id) ||
						!SCENARIOS[era].includes(entry.id.split(":")[0] ?? "") ||
						typeof entry.reason !== "string" ||
						entry.reason.trim().length < 20 ||
						entry.reason.length > 2000 ||
						!entry.reason.isWellFormed() ||
						PROTECTED_ID.test(entry.id) ||
						MUST_RUN[era].includes(entry.id.split(":")[0] ?? "") ||
						seen.has(entry.id)
					)
						throw new Error("Invalid conformance baseline");
					seen.add(entry.id);
					return Object.freeze({ id: entry.id, reason: entry.reason });
				});
				return [era, Object.freeze(entries)];
			}),
		) as unknown as Baseline,
	);
}

export function parseRun(input: unknown): Run {
	const object = record(input);
	if (!ERAS.includes(object.era as Era)) throw new Error("Invalid conformance artifact");
	const era = object.era as Era;
	const args = vector(object.args, 32);
	if (args.some((arg) => typeof arg !== "string" || arg.length > 8192))
		throw new Error("Invalid conformance artifact");
	if (typeof object.conformanceVersion !== "string" || !Number.isSafeInteger(object.exitCode))
		throw new Error("Invalid conformance artifact");
	const checks = record(object.checks);
	if (Object.keys(checks).length > 100) throw new Error("Invalid conformance artifact");
	const projected = Object.fromEntries(
		Object.entries(checks).map(([scenario, values]) => [
			scenario,
			Object.freeze(
				vector(values, 2000).map((value) => {
					const check = record(value);
					if (
						typeof check.id !== "string" ||
						!checkId.test(check.id) ||
						!STATUSES.includes(check.status as Status)
					)
						throw new Error("Invalid conformance artifact");
					return Object.freeze({ id: check.id, status: check.status as Status });
				}),
			),
		]),
	);
	return Object.freeze({
		era,
		conformanceVersion: object.conformanceVersion,
		exitCode: object.exitCode as number,
		args: Object.freeze(args.slice()) as readonly string[],
		checks: Object.freeze(projected),
	});
}

function invocation(run: Run): boolean {
	const args = run.args;
	if (
		args.length !== 11 ||
		args[0] !== "server" ||
		args[1] !== "--url" ||
		args[3] !== "--suite" ||
		args[4] !== "all" ||
		args[5] !== "--spec-version" ||
		args[6] !== run.era ||
		args[7] !== "--output-dir" ||
		!args[8] ||
		args[9] !== "--expected-failures" ||
		!args[10]
	)
		return false;
	try {
		const rawUrl = args[2] ?? "";
		if (!/^http:\/\/(?:127\.0\.0\.1|\[::1\])(?::[1-9][0-9]{0,4})?\/mcp$/.test(rawUrl)) return false;
		const url = new URL(rawUrl);
		return (
			url.protocol === "http:" &&
			["127.0.0.1", "[::1]"].includes(url.hostname) &&
			!url.username &&
			!url.password &&
			!url.search &&
			!url.hash &&
			url.pathname === "/mcp"
		);
	} catch {
		return false;
	}
}
const failing = (status: Status): boolean => status === "FAILURE" || status === "WARNING";

/** Evaluate both actual suite outputs. Exceptions never excuse another check in that scenario. */
export function evaluateRuns(baselineInput: unknown, runInputs: unknown): GateReport {
	const findings: Finding[] = [];
	const eras: GateReport["eras"][number][] = [];
	let baseline: Baseline;
	let runs: readonly Run[];
	try {
		baseline = parseBaseline(baselineInput);
		runs = vector(runInputs, 2).map(parseRun);
	} catch {
		return {
			schemaVersion: 1,
			gate: "mcp-http-conformance-artifacts",
			conformanceVersion: CONFORMANCE_VERSION,
			passed: false,
			findings: [{ code: "INVALID_INPUT" }],
			eras,
		};
	}
	for (const era of ERAS) {
		const matching = runs.filter((run) => run.era === era);
		if (matching.length !== 1) {
			findings.push({ code: "ERA_RUN_COUNT", era });
			continue;
		}
		const run = matching[0] as Run;
		if (run.conformanceVersion !== CONFORMANCE_VERSION) findings.push({ code: "CLI_VERSION", era });
		if (!invocation(run)) findings.push({ code: "INVOCATION", era });
		if (run.exitCode !== 0) findings.push({ code: "CLI_EXIT", era });
		const actual = Object.keys(run.checks);
		if (
			actual.length !== SCENARIOS[era].length ||
			SCENARIOS[era].some((scenario) => !Object.hasOwn(run.checks, scenario))
		)
			findings.push({ code: "SCENARIO_SET", era });
		const expected = new Set(baseline[era].map((entry) => entry.id));
		const matched = new Set<string>();
		const counts = Object.fromEntries(STATUSES.map((status) => [status, 0])) as Record<
			Status,
			number
		>;
		for (const scenario of SCENARIOS[era]) {
			const list = run.checks[scenario] ?? [];
			if (list.length === 0) findings.push({ code: "EMPTY_SCENARIO", era, scenario });
			const scored = list.filter((check) => check.status !== "INFO");
			if (MUST_RUN[era].includes(scenario) && scored.length === 0)
				findings.push({ code: "MUST_RUN_EMPTY", era, scenario });
			for (const check of list) {
				counts[check.status]++;
				const id = `${scenario}:${check.id}`;
				if (check.status === "INFO") continue;
				if (
					(MUST_RUN[era].includes(scenario) || PROTECTED_ID.test(id)) &&
					check.status !== "SUCCESS"
				)
					findings.push({ code: "PROTECTED_CHECK", era, scenario });
				if (failing(check.status)) {
					if (expected.has(id)) matched.add(id);
					else findings.push({ code: "UNEXPECTED_FAILURE", era, scenario });
				}
			}
		}
		if (era === "2026-07-28") {
			const [scenario = "", id] = REQUIRED_PROTECTED.split(":");
			const checks = (run.checks[scenario] ?? []).filter(
				(check) => check.id === id && check.status !== "INFO",
			);
			if (!checks.length || checks.some((check) => check.status !== "SUCCESS"))
				findings.push({ code: "REQUIRED_HEADER_CHECK", era, scenario });
		}
		for (const entry of baseline[era])
			if (!matched.has(entry.id))
				findings.push({ code: "STALE_BASELINE", era, baselineId: entry.id });
		eras.push({ era, scenarios: actual.length, counts });
	}
	return {
		schemaVersion: 1,
		gate: "mcp-http-conformance-artifacts",
		conformanceVersion: CONFORMANCE_VERSION,
		passed: findings.length === 0,
		findings,
		eras,
	};
}
