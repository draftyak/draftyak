import { InputError, parseStrictJson } from "./strict-json.ts";

export type AuditCategory = "advisories" | "bans" | "licenses" | "sources";
export type AuditSeverity = "error" | "warning" | "note" | "help";
export interface CategoryCounts {
	readonly errors: number;
	readonly warnings: number;
	readonly notes: number;
	readonly helps: number;
}
export interface CargoDenyCapture {
	readonly stdout: Uint8Array;
	readonly stderr: Uint8Array;
	readonly exitCode: number | null;
	readonly signal: string | null;
}
export interface RenderedCrate {
	readonly name: string;
	readonly version: string;
	readonly kind: "build" | "dev" | null;
	readonly parents: readonly RenderedCrate[];
	readonly repeat: boolean;
}
export interface AdvisoryClassification {
	readonly id: string;
	readonly package: string;
	readonly informational: "notice" | "unmaintained" | "unsound" | null;
	readonly categories: readonly string[];
	readonly collection: "crates";
	readonly source: string | null;
	readonly date: string;
	readonly withdrawn: string | null;
	readonly cvss: string | null;
}
export interface CargoDenyDiagnostic {
	readonly category: AuditCategory;
	readonly severity: AuditSeverity;
	readonly code: string;
	readonly graphs: readonly RenderedCrate[];
	readonly advisory: AdvisoryClassification | null;
}
export interface AuditFinding {
	readonly classification: "vulnerability" | "notice" | "unmaintained" | "unsound";
	readonly advisory: AdvisoryClassification;
	readonly source: string;
	readonly name: string;
	readonly version: string;
	readonly affected: {
		readonly arch: readonly string[];
		readonly os: readonly string[];
		readonly functions: readonly (readonly [string, readonly string[]])[];
	} | null;
	readonly patched: readonly string[];
	readonly unaffected: readonly string[];
}
export interface CargoDenyReports {
	readonly version: 1;
	readonly complete: true;
	readonly fullExitCode: number;
	readonly advisoryExitCode: number;
	readonly denyWarnings: boolean;
	readonly counts: Readonly<Record<AuditCategory, CategoryCounts>>;
	readonly diagnostics: readonly CargoDenyDiagnostic[];
	readonly advisoryDiagnostics: readonly CargoDenyDiagnostic[];
	readonly findings: readonly AuditFinding[];
	readonly dependencyCount: number;
}
export interface CargoDenyInputs {
	readonly full: CargoDenyCapture;
	readonly advisory: CargoDenyCapture;
	readonly denyWarnings: boolean;
}

const categories: readonly AuditCategory[] = ["advisories", "bans", "licenses", "sources"];
const severities: readonly AuditSeverity[] = ["error", "warning", "note", "help"];
const countKey = { error: "errors", warning: "warnings", note: "notes", help: "helps" } as const;
// This compatibility table is intentionally closed. Unrecognized diagnostics refuse.
const codes: Readonly<Record<string, AuditCategory>> = {
	vulnerability: "advisories",
	unmaintained: "advisories",
	unsound: "advisories",
	notice: "advisories",
	yanked: "advisories",
	duplicate: "bans",
	"no-license-field": "licenses",
	unlicensed: "licenses",
};
const MAX_BYTES = 32 * 1024 * 1024;
const MAX_RECORDS = 100_000;
const byteLength = Object.getOwnPropertyDescriptor(
	Object.getPrototypeOf(Uint8Array.prototype),
	"byteLength",
)?.get;
const encoder = new TextEncoder();
const utf8Compare = (a: string, b: string): number =>
	Buffer.compare(Buffer.from(a), Buffer.from(b));
function refuse(): never {
	throw new InputError();
}
function object(
	value: unknown,
	required: readonly string[],
	optional: readonly string[] = [],
): Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) refuse();
	const proto = Object.getPrototypeOf(value);
	if (proto !== null && proto !== Object.prototype) refuse();
	const result: Record<string, unknown> = Object.create(null);
	for (const key of Reflect.ownKeys(value)) {
		if (typeof key !== "string" || (!required.includes(key) && !optional.includes(key))) refuse();
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (!descriptor || !("value" in descriptor)) refuse();
		result[key] = descriptor.value;
	}
	if (required.some((key) => !Object.hasOwn(result, key))) refuse();
	return result;
}
function list(value: unknown): unknown[] {
	if (!Array.isArray(value) || value.length > MAX_RECORDS) refuse();
	return value;
}
function text(value: unknown): string {
	if (typeof value !== "string") refuse();
	return value;
}
function token(value: unknown): string {
	const s = text(value);
	if (!/^[A-Za-z0-9][A-Za-z0-9_.:+/-]*$(?![\s\S])/.test(s)) refuse();
	return s;
}
function name(value: unknown): string {
	const s = text(value);
	if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$(?![\s\S])/.test(s)) refuse();
	return s;
}
function version(value: unknown): string {
	const s = text(value);
	if (
		!/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$(?![\s\S])/.test(
			s,
		)
	)
		refuse();
	return s;
}
function count(value: unknown): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) refuse();
	return value;
}
function strings(value: unknown, parse: (v: unknown) => string = token): string[] {
	const result = list(value).map(parse).sort(utf8Compare);
	if (result.some((v, i) => i > 0 && v === result[i - 1])) refuse();
	return result;
}
function sourceUri(value: unknown): string {
	const s = text(value);
	if (!/^(?:(?:registry|sparse)\+)?https:\/\/[A-Za-z0-9:/._~%+?&=@#-]+$(?![\s\S])/.test(s))
		refuse();
	return s;
}
function cvss(value: unknown): string | null {
	if (value === null) return null;
	const s = text(value);
	if (!/^CVSS:(?:2\.0|3\.0|3\.1|4\.0)(?:\/[A-Za-z][A-Za-z0-9]*:[A-Za-z0-9.]+)+$(?![\s\S])/.test(s))
		refuse();
	return s;
}
function date(value: unknown): string {
	const s = text(value);
	if (
		!/^\d{4}-\d{2}-\d{2}$(?![\s\S])/.test(s) ||
		Number.isNaN(Date.parse(s)) ||
		new Date(s).toISOString().slice(0, 10) !== s
	)
		refuse();
	return s;
}
function nullableDate(value: unknown): string | null {
	return value === null ? null : date(value);
}
function informational(value: unknown): AdvisoryClassification["informational"] {
	if (value !== null && value !== "notice" && value !== "unmaintained" && value !== "unsound")
		refuse();
	return value;
}
function classification(value: unknown): AdvisoryClassification {
	const v = object(value, [
		"id",
		"package",
		"informational",
		"categories",
		"collection",
		"source",
		"date",
		"withdrawn",
		"aliases",
		"cvss",
		"description",
		"expect-deleted",
		"keywords",
		"license",
		"references",
		"related",
		"title",
		"url",
	]);
	const id = text(v.id);
	if (!/^RUSTSEC-\d{4}-\d{4,}$(?![\s\S])/.test(id) || v.collection !== "crates") refuse();
	// These fields are known presentation metadata. Their prose is never returned.
	for (const k of ["description", "title", "license", "url"]) if (Object.hasOwn(v, k)) text(v[k]);
	for (const k of ["aliases", "keywords", "references", "related"])
		if (Object.hasOwn(v, k)) list(v[k]).forEach(text);
	if (Object.hasOwn(v, "cvss") && v.cvss !== null) text(v.cvss);
	if (Object.hasOwn(v, "expect-deleted") && v["expect-deleted"] !== false) refuse();
	return {
		id,
		package: name(v.package),
		informational: informational(v.informational),
		categories: strings(v.categories),
		collection: "crates",
		source: v.source === null ? null : sourceUri(v.source),
		date: date(v.date),
		withdrawn: nullableDate(v.withdrawn),
		cvss: cvss(v.cvss),
	};
}
function graph(value: unknown): RenderedCrate {
	const v = object(value, ["Krate"], ["parents", "repeat"]);
	const krate = object(v.Krate, ["name", "version"], ["kind"]);
	if (Object.hasOwn(krate, "kind") && krate.kind !== "build" && krate.kind !== "dev") refuse();
	if (Object.hasOwn(v, "repeat") && (v.repeat !== true || Object.hasOwn(v, "parents"))) refuse();
	return {
		name: name(krate.name),
		version: version(krate.version),
		kind: (krate.kind as "build" | "dev" | undefined) ?? null,
		repeat: v.repeat === true,
		parents: Object.hasOwn(v, "parents") ? list(v.parents).map(graph) : [],
	};
}
function diagnostic(value: unknown): CargoDenyDiagnostic {
	const v = object(
		value,
		["code", "severity", "message"],
		["graphs", "labels", "notes", "advisory"],
	);
	const code = text(v.code),
		category = codes[code];
	if (!Object.hasOwn(codes, code) || !category || !severities.includes(v.severity as AuditSeverity))
		refuse();
	text(v.message);
	if (Object.hasOwn(v, "notes")) list(v.notes).forEach(text);
	if (Object.hasOwn(v, "labels"))
		for (const label of list(v.labels)) {
			const l = object(label, ["column", "line", "message", "span"]);
			count(l.column);
			count(l.line);
			text(l.message);
			text(l.span);
		}
	const advisory = Object.hasOwn(v, "advisory") ? classification(v.advisory) : null;
	const graphs = Object.hasOwn(v, "graphs") ? list(v.graphs).map(graph) : [];
	if (
		advisory &&
		(category !== "advisories" ||
			graphs.length !== 1 ||
			graphs[0]?.name !== advisory.package ||
			(advisory.informational ?? "vulnerability") !== code)
	)
		refuse();
	if (["vulnerability", "notice", "unmaintained", "unsound"].includes(code) && !advisory) refuse();
	return { category, severity: v.severity as AuditSeverity, code, graphs, advisory };
}
function bytes(value: unknown): Uint8Array {
	if (!byteLength) refuse();
	const length: unknown = byteLength.call(value);
	if (typeof length !== "number" || length > MAX_BYTES) refuse();
	const copy = new Uint8Array(length);
	Uint8Array.prototype.set.call(copy, value as Uint8Array);
	return copy;
}
function jsonl(value: unknown): unknown[] {
	const b = bytes(value);
	const decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(b);
	const lines = decoded.split("\n");
	if (lines.length > MAX_RECORDS) refuse();
	return lines
		.filter((line) => !/^[ \t\r]*$(?![\s\S])/.test(line))
		.map((line) => parseStrictJson(encoder.encode(line)));
}
function capture(value: unknown): { stdout: unknown[]; stderr: unknown[]; exitCode: number } {
	const v = object(value, ["stdout", "stderr", "exitCode", "signal"]);
	if (
		v.signal !== null ||
		typeof v.exitCode !== "number" ||
		!Number.isInteger(v.exitCode) ||
		v.exitCode < 0 ||
		v.exitCode > 15
	)
		refuse();
	return { stdout: jsonl(v.stdout), stderr: jsonl(v.stderr), exitCode: v.exitCode };
}
function counts(value: unknown): CategoryCounts {
	const v = object(value, ["errors", "warnings", "notes", "helps"]);
	return {
		errors: count(v.errors),
		warnings: count(v.warnings),
		notes: count(v.notes),
		helps: count(v.helps),
	};
}
function report(
	rows: unknown[],
	selected: readonly AuditCategory[],
): { diagnostics: CargoDenyDiagnostic[]; counts: Partial<Record<AuditCategory, CategoryCounts>> } {
	if (rows.length === 0) refuse();
	const diagnostics: CargoDenyDiagnostic[] = [];
	let summary: Partial<Record<AuditCategory, CategoryCounts>> | undefined;
	for (const row of rows) {
		const v = object(row, ["type", "fields"]);
		if (summary) refuse();
		if (v.type === "diagnostic") diagnostics.push(diagnostic(v.fields));
		else if (v.type === "summary") {
			const fields = object(v.fields, selected);
			summary = {};
			for (const category of selected) summary[category] = counts(fields[category]);
		} else refuse();
	}
	if (!summary) refuse();
	for (const d of diagnostics) if (!selected.includes(d.category)) refuse();
	for (const category of selected)
		for (const severity of severities) {
			const emitted = diagnostics.filter(
				(d) => d.category === category && d.severity === severity,
			).length;
			const expected = summary[category]?.[countKey[severity]];
			if (
				expected === undefined ||
				emitted > expected ||
				((severity === "error" || severity === "warning") && emitted !== expected)
			)
				refuse();
		}
	return { diagnostics, counts: summary };
}
function ranges(value: unknown): string[] {
	return strings(value, (value) => {
		const s = text(value);
		const component =
			"(?:[<>=~^]=? *)?(?:\\*|[0-9]+(?:\\.(?:[0-9]+|[xX*])){0,2}(?:-[0-9A-Za-z]+(?:\\.[0-9A-Za-z]+)*)?(?:\\+[0-9A-Za-z]+(?:\\.[0-9A-Za-z]+)*)?)";
		if (!new RegExp(`^${component}(?: *, *${component})*$(?![\\s\\S])`).test(s)) refuse();
		return s;
	});
}
function finding(value: unknown, kind: AuditFinding["classification"]): AuditFinding {
	const v = object(
		value,
		["advisory", "affected", "package", "versions"],
		kind === "vulnerability" ? [] : ["kind"],
	);
	if (kind !== "vulnerability" && v.kind !== kind) refuse();
	const advisory = classification(v.advisory);
	if ((advisory.informational ?? "vulnerability") !== kind || advisory.withdrawn !== null) refuse();
	const pkg = object(v.package, [
		"checksum",
		"dependencies",
		"name",
		"replace",
		"source",
		"version",
	]);
	if (pkg.replace !== null || pkg.checksum !== null || list(pkg.dependencies).length !== 0)
		refuse();
	const source = text(pkg.source);
	if (!/^registry\+https:\/\/[^\s]+$(?![\s\S])/.test(source) || name(pkg.name) !== advisory.package)
		refuse();
	const versions = object(v.versions, ["patched", "unaffected"]);
	let affected: AuditFinding["affected"] = null;
	if (v.affected !== null) {
		const a = object(v.affected, ["arch", "os", "functions"]);
		if (a.functions === null || typeof a.functions !== "object" || Array.isArray(a.functions))
			refuse();
		const functions: [string, string[]][] = Object.entries(a.functions).map(([key, value]) => [
			token(key),
			ranges(value),
		]);
		functions.sort((a, b) => utf8Compare(a[0], b[0]));
		affected = { arch: strings(a.arch), os: strings(a.os), functions };
	}
	return {
		classification: kind,
		advisory,
		source,
		name: name(pkg.name),
		version: version(pkg.version),
		affected,
		patched: ranges(versions.patched),
		unaffected: ranges(versions.unaffected),
	};
}
function audit(value: unknown): { dependencyCount: number; findings: AuditFinding[] } {
	const v = object(value, ["lockfile", "settings", "vulnerabilities", "warnings"]);
	const lockfile = object(v.lockfile, ["dependency-count"]);
	const settings = object(v.settings, [
		"ignore",
		"informational_warnings",
		"severity",
		"target_arch",
		"target_os",
	]);
	if (
		list(settings.ignore).length ||
		settings.severity !== null ||
		list(settings.target_arch).length ||
		list(settings.target_os).length ||
		JSON.stringify(strings(settings.informational_warnings)) !==
			JSON.stringify(["notice", "unmaintained", "unsound"])
	)
		refuse();
	const findings = list(v.vulnerabilities).map((value) => finding(value, "vulnerability"));
	const warnings = object(v.warnings, [], ["notice", "unmaintained", "unsound"]);
	for (const kind of ["notice", "unmaintained", "unsound"] as const)
		if (Object.hasOwn(warnings, kind))
			findings.push(...list(warnings[kind]).map((value) => finding(value, kind)));
	findings.sort((a, b) => utf8Compare(JSON.stringify(a), JSON.stringify(b)));
	const keys = findings.map((f) => JSON.stringify([f.advisory.id, f.source, f.name, f.version]));
	if (new Set(keys).size !== keys.length) refuse();
	const dependencyCount = count(lockfile["dependency-count"]);
	if (
		new Set(findings.map((f) => JSON.stringify([f.source, f.name, f.version]))).size >
		dependencyCount
	)
		refuse();
	return { dependencyCount, findings };
}
function key(d: CargoDenyDiagnostic): string {
	return JSON.stringify([d.severity, d.code, d.advisory, d.graphs]);
}
function exitConsistent(
	exitCode: number,
	stats: Partial<Record<AuditCategory, CategoryCounts>>,
	denyWarnings: boolean,
): void {
	const failed = categories.filter((c) => {
		const s = stats[c];
		return s && (s.errors > 0 || (denyWarnings && s.warnings > 0));
	});
	if ((failed.length === 0) !== (exitCode === 0)) refuse();
	// Observed pinned 0.20.2 captures prove these two single-category bits.
	if (
		failed.length === 1 &&
		((failed[0] === "advisories" && exitCode !== 1) || (failed[0] === "licenses" && exitCode !== 4))
	)
		refuse();
}

export function parseCargoDenyReports(input: CargoDenyInputs): CargoDenyReports {
	try {
		const i = object(input, ["full", "advisory", "denyWarnings"]);
		if (typeof i.denyWarnings !== "boolean") refuse();
		const full = capture(i.full),
			advisory = capture(i.advisory);
		if (full.stdout.length !== 0 || advisory.stdout.length !== 1) refuse();
		const f = report(full.stderr, categories),
			a = report(advisory.stderr, ["advisories"]);
		const audited = audit(advisory.stdout[0]);
		if (JSON.stringify(f.counts.advisories) !== JSON.stringify(a.counts.advisories)) refuse();
		const fullAdvisories = f.diagnostics
			.filter((d) => d.category === "advisories")
			.map(key)
			.sort(utf8Compare);
		if (JSON.stringify(fullAdvisories) !== JSON.stringify(a.diagnostics.map(key).sort(utf8Compare)))
			refuse();
		const findingKeys = audited.findings
			.map((f) => JSON.stringify([f.advisory, f.name, f.version]))
			.sort(utf8Compare);
		const diagnosticKeys = a.diagnostics
			.filter((d) => d.advisory)
			.map((d) => JSON.stringify([d.advisory, d.graphs[0]?.name, d.graphs[0]?.version]))
			.sort(utf8Compare);
		if (JSON.stringify(findingKeys) !== JSON.stringify(diagnosticKeys)) refuse();
		exitConsistent(full.exitCode, f.counts, i.denyWarnings);
		exitConsistent(advisory.exitCode, a.counts, i.denyWarnings);
		return {
			version: 1,
			complete: true,
			fullExitCode: full.exitCode,
			advisoryExitCode: advisory.exitCode,
			denyWarnings: i.denyWarnings,
			counts: f.counts as Record<AuditCategory, CategoryCounts>,
			diagnostics: f.diagnostics,
			advisoryDiagnostics: a.diagnostics,
			findings: audited.findings,
			dependencyCount: audited.dependencyCount,
		};
	} catch {
		throw new InputError();
	}
}
