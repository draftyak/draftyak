import {
	AuthorityError,
	type AuthoritySnapshot,
	type AuthorityTransport,
	assertAuthorityCurrent,
	loadCurrentAuthority,
} from "./authority.ts";
import type { AuditCategory, CategoryCounts } from "./cargo-deny.ts";
import {
	type Binding,
	BOUNDED_TUPLES,
	type EvaluationInput,
	evaluate as evaluateDecision,
	type PolicyVerdict,
	preflightDecision,
	type Reason,
	type ScopedFinding,
} from "./decision.ts";
import type { Phase } from "./options.ts";

export type ProducerCode =
	| "BASIS_UNAVAILABLE"
	| "BASIS_INVALID"
	| "BASIS_STALE"
	| "AUDIT_INVALID"
	| "CAPTURE_FAILED"
	| "INPUTS_CHANGED"
	| "TOOLS_INVALID"
	| "SOURCE_CHANGED"
	| "EVIDENCE_INVALID"
	| "PRODUCER_UNAVAILABLE";
export type RunnerReason =
	| Reason
	| ProducerCode
	| "INVALID_ARGUMENTS"
	| "AUTHORITY_UNAVAILABLE"
	| "AUTHORITY_CHANGED";
export class ProducerError extends Error {
	readonly code: ProducerCode;
	constructor(code: ProducerCode) {
		super("native policy producer refused");
		this.name = "ProducerError";
		this.code = code;
	}
}
export interface RawAuditExit {
	readonly exitCode: number | null;
	readonly signal: string | null;
}
export interface RawAuditExits {
	readonly full: RawAuditExit | null;
	readonly advisory: RawAuditExit | null;
}
type EvaluationAudit = EvaluationInput["audit"];
export interface ValidatedAudit extends EvaluationAudit {
	readonly complete: true;
	readonly counts: Readonly<Record<AuditCategory, CategoryCounts>>;
}
export interface SourceRevisions {
	readonly database: string;
	readonly releases: string;
	readonly security: string;
}
export interface ProducedPolicyEvidence {
	readonly runId: string;
	readonly reportDigest: string | null;
	readonly binding: Binding | null;
	readonly audit: ValidatedAudit | null;
	readonly rawExits: RawAuditExits;
	readonly evidenceObservedAt: number | null;
	readonly sourceRevisions: SourceRevisions | null;
	readonly failure: ProducerCode | null;
}
export interface CurrentEvidenceBinding {
	readonly reportDigest: string | null;
	readonly binding: Binding | null;
	readonly sourceRevisions: SourceRevisions | null;
}
declare const contextBrand: unique symbol;
declare const evidenceBrand: unique symbol;
export interface NativeRunContext {
	readonly phase: Phase;
	readonly startedAt: number;
	readonly [contextBrand]: true;
}
export interface NativePolicyEvidence {
	readonly runId: string;
	readonly [evidenceBrand]: true;
}
export interface NativePolicyProducer {
	produce(context: NativeRunContext): Promise<NativePolicyEvidence>;
}
export interface NativePolicyCollector {
	collect(context: NativeRunContext): Promise<ProducedPolicyEvidence>;
	revalidate(
		context: NativeRunContext,
		evidence: ProducedPolicyEvidence,
	): Promise<CurrentEvidenceBinding>;
}
export interface RunnerInput {
	readonly phase: Phase;
	readonly authority: AuthorityTransport;
	readonly producer: NativePolicyProducer;
	readonly completionClock?: () => number;
}
export interface RunnerOutput {
	readonly version: 1;
	readonly phase: Phase;
	readonly verdict: PolicyVerdict["verdict"];
	readonly reason: RunnerReason | null;
	readonly authorityRevision: string | null;
	readonly authorityRecordDigest: string | null;
	readonly runId: string | null;
	readonly reportDigest: string | null;
	readonly binding: Binding | null;
	readonly audit: ValidatedAudit | null;
	readonly rawExits: RawAuditExits | null;
	readonly accepted: readonly ScopedFinding[];
}
export interface RunnerResult {
	readonly exitCode: 0 | 1 | 2;
	readonly output: RunnerOutput;
}
interface ProducerState {
	readonly collect: NativePolicyCollector["collect"];
	readonly revalidate: NativePolicyCollector["revalidate"];
}
interface ReceiptState {
	readonly producer: NativePolicyProducer;
	readonly context: NativeRunContext;
	readonly data: ProducedPolicyEvidence;
	used: boolean;
}
const producers = new WeakMap<NativePolicyProducer, ProducerState>();
const receipts = new WeakMap<NativePolicyEvidence, ReceiptState>();
const contexts = new WeakSet<NativeRunContext>();
const collected = new WeakSet<NativeRunContext>();
const runIds = new Set<string>();
const categories: readonly AuditCategory[] = ["advisories", "bans", "licenses", "sources"];
const bindingKeys = ["graph", "lock", "inputs", "basis", "releases", "security", "policy"] as const;
const producerCodes: readonly ProducerCode[] = [
	"BASIS_UNAVAILABLE",
	"BASIS_INVALID",
	"BASIS_STALE",
	"AUDIT_INVALID",
	"CAPTURE_FAILED",
	"INPUTS_CHANGED",
	"TOOLS_INVALID",
	"SOURCE_CHANGED",
	"EVIDENCE_INVALID",
	"PRODUCER_UNAVAILABLE",
];
const signals = new Set([
	"SIGABRT",
	"SIGALRM",
	"SIGBUS",
	"SIGFPE",
	"SIGHUP",
	"SIGILL",
	"SIGINT",
	"SIGKILL",
	"SIGPIPE",
	"SIGQUIT",
	"SIGSEGV",
	"SIGSYS",
	"SIGTERM",
	"SIGTRAP",
	"SIGUSR1",
	"SIGUSR2",
	"SIGXCPU",
	"SIGXFSZ",
	"SIGBREAK",
]);
const SOURCE = "registry+https://github.com/rust-lang/crates.io-index";
function invalid(): never {
	throw new ProducerError("EVIDENCE_INVALID");
}
function record(
	value: unknown,
	keys: readonly string[],
	optional: readonly string[] = [],
): Record<string, unknown> {
	if (
		value === null ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		![null, Object.prototype].includes(Object.getPrototypeOf(value))
	)
		invalid();
	const own = Reflect.ownKeys(value);
	if (own.length > keys.length + optional.length) invalid();
	const result: Record<string, unknown> = Object.create(null);
	for (const key of own) {
		if (typeof key !== "string" || (!keys.includes(key) && !optional.includes(key))) invalid();
		const d = Object.getOwnPropertyDescriptor(value, key);
		if (!d || !("value" in d)) invalid();
		result[key] = d.value;
	}
	if (keys.some((k) => !Object.hasOwn(result, k))) invalid();
	return result;
}
function integer(value: unknown, max = Number.MAX_SAFE_INTEGER): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > max)
		invalid();
	return value;
}
function digest(value: unknown): string {
	if (typeof value !== "string" || !/^[a-f0-9]{64}$(?![\s\S])/.test(value)) invalid();
	return value;
}
function revision(value: unknown): string {
	if (typeof value !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$(?![\s\S])/.test(value))
		invalid();
	return value;
}
function uuid(value: unknown): string {
	if (
		typeof value !== "string" ||
		!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$(?![\s\S])/.test(value)
	)
		invalid();
	return value;
}
function freeze<T>(value: T): T {
	if (value !== null && typeof value === "object") {
		for (const child of Object.values(value)) freeze(child);
		Object.freeze(value);
	}
	return value;
}
function binding(value: unknown): Binding | null {
	if (value === null) return null;
	const v = record(value, bindingKeys);
	return Object.fromEntries(bindingKeys.map((k) => [k, digest(v[k])])) as unknown as Binding;
}
function revisions(value: unknown): SourceRevisions | null {
	if (value === null) return null;
	const v = record(value, ["database", "releases", "security"]);
	return {
		database: revision(v.database),
		releases: revision(v.releases),
		security: revision(v.security),
	};
}
function rawExit(value: unknown): RawAuditExit | null {
	if (value === null) return null;
	const v = record(value, ["exitCode", "signal"]);
	const exitCode = v.exitCode === null ? null : integer(v.exitCode, 255);
	if (v.signal !== null && (typeof v.signal !== "string" || !signals.has(v.signal))) invalid();
	if (exitCode !== null && v.signal !== null) invalid();
	return { exitCode, signal: v.signal as string | null };
}
function rawExits(value: unknown): RawAuditExits {
	const v = record(value, ["full", "advisory"]);
	return { full: rawExit(v.full), advisory: rawExit(v.advisory) };
}
function counts(value: unknown): Readonly<Record<AuditCategory, CategoryCounts>> {
	const v = record(value, categories);
	return Object.fromEntries(
		categories.map((c) => {
			const x = record(v[c], ["errors", "warnings", "notes", "helps"]);
			return [
				c,
				{
					errors: integer(x.errors, 1_000_000),
					warnings: integer(x.warnings, 1_000_000),
					notes: integer(x.notes, 1_000_000),
					helps: integer(x.helps, 1_000_000),
				},
			];
		}),
	) as Record<AuditCategory, CategoryCounts>;
}
function findings(value: unknown): ScopedFinding[] {
	if (!Array.isArray(value) || value.length > BOUNDED_TUPLES.length) invalid();
	const descriptors = Object.getOwnPropertyDescriptors(value as object);
	if (Reflect.ownKeys(value).length !== value.length + 1) invalid();
	const result: ScopedFinding[] = [];
	for (let i = 0; i < value.length; i++) {
		const d = descriptors[String(i)];
		if (!d || !("value" in d)) invalid();
		const v = record(d.value, ["name", "version", "source", "advisory", "ancestor"]);
		if (
			v.source !== SOURCE ||
			!BOUNDED_TUPLES.some(([n, ver, id]) => v.name === n && v.version === ver && v.advisory === id)
		)
			invalid();
		result.push({
			name: v.name as string,
			version: v.version as string,
			source: SOURCE,
			advisory: v.advisory as string,
			ancestor: digest(v.ancestor),
		});
	}
	if (new Set(result.map((f) => f.advisory)).size !== result.length) invalid();
	return result;
}
function audit(value: unknown, raw: RawAuditExits): ValidatedAudit | null {
	if (value === null) return null;
	const v = record(value, [
		"complete",
		"fullExit",
		"advisoryExit",
		"unexpectedErrors",
		"findings",
		"counts",
	]);
	if (v.complete !== true) invalid();
	const fullExit = integer(v.fullExit, 15),
		advisoryExit = integer(v.advisoryExit, 1),
		stats = counts(v.counts),
		scoped = findings(v.findings),
		unexpectedErrors = integer(v.unexpectedErrors, 4_000_000);
	const errors = categories.reduce((n, c) => n + stats[c].errors, 0);
	if (
		stats.advisories.errors < scoped.length ||
		errors !== scoped.length + unexpectedErrors ||
		(fullExit === 0) !== (errors === 0) ||
		advisoryExit !== (stats.advisories.errors > 0 ? 1 : 0)
	)
		invalid();
	if (
		categories.filter((c) => stats[c].errors > 0).every((c) => c === "advisories") &&
		errors > 0 &&
		fullExit !== 1
	)
		invalid();
	if (
		!raw.full ||
		!raw.advisory ||
		raw.full.exitCode !== fullExit ||
		raw.advisory.exitCode !== advisoryExit ||
		raw.full.signal !== null ||
		raw.advisory.signal !== null
	)
		invalid();
	return {
		complete: true,
		fullExit,
		advisoryExit,
		unexpectedErrors,
		findings: scoped,
		counts: stats,
	};
}
function evidence(value: unknown): ProducedPolicyEvidence {
	const v = record(value, [
		"runId",
		"reportDigest",
		"binding",
		"audit",
		"rawExits",
		"evidenceObservedAt",
		"sourceRevisions",
		"failure",
	]);
	const runId = uuid(v.runId),
		reportDigest = v.reportDigest === null ? null : digest(v.reportDigest),
		raw = rawExits(v.rawExits),
		validatedAudit = audit(v.audit, raw),
		bound = binding(v.binding),
		sourceRevisions = revisions(v.sourceRevisions),
		observed = v.evidenceObservedAt === null ? null : integer(v.evidenceObservedAt);
	if (v.failure !== null && !producerCodes.includes(v.failure as ProducerCode)) invalid();
	if (
		(validatedAudit !== null || raw.full !== null || raw.advisory !== null) &&
		reportDigest === null
	)
		invalid();
	if (
		v.failure === null &&
		(!validatedAudit || !bound || !sourceRevisions || observed === null || reportDigest === null)
	)
		invalid();
	return freeze({
		runId,
		reportDigest,
		binding: bound,
		audit: validatedAudit,
		rawExits: raw,
		evidenceObservedAt: observed,
		sourceRevisions,
		failure: v.failure as ProducerCode | null,
	});
}
function current(value: unknown): CurrentEvidenceBinding {
	const v = record(value, ["reportDigest", "binding", "sourceRevisions"]);
	return freeze({
		reportDigest: v.reportDigest === null ? null : digest(v.reportDigest),
		binding: binding(v.binding),
		sourceRevisions: revisions(v.sourceRevisions),
	});
}

/** Only the fixed production factory supplies this collector; no report input is accepted by the CLI. */
export function createNativePolicyProducer(collector: NativePolicyCollector): NativePolicyProducer {
	const selected = record(collector, ["collect", "revalidate"]);
	if (typeof selected.collect !== "function" || typeof selected.revalidate !== "function")
		invalid();
	const state: ProducerState = {
		collect: selected.collect as NativePolicyCollector["collect"],
		revalidate: selected.revalidate as NativePolicyCollector["revalidate"],
	};
	const producer: NativePolicyProducer = {
		produce: async (context) => {
			if (!contexts.has(context) || collected.has(context)) invalid();
			collected.add(context);
			const data = evidence(await state.collect(context));
			if (runIds.has(data.runId) || runIds.size >= 100_000) invalid();
			runIds.add(data.runId);
			const receipt = Object.freeze({ runId: data.runId }) as NativePolicyEvidence;
			receipts.set(receipt, { producer, context, data, used: false });
			return receipt;
		},
	};
	producers.set(producer, state);
	return producer;
}
function failureCode(error: unknown): RunnerReason {
	try {
		if (error instanceof AuthorityError)
			return ["AUTHORITY_UNAVAILABLE", "AUTHORITY_INVALID", "AUTHORITY_CHANGED"].includes(
				error.code,
			)
				? error.code
				: "AUTHORITY_UNAVAILABLE";
		if (error instanceof ProducerError && producerCodes.includes(error.code)) return error.code;
	} catch {
		return "PRODUCER_UNAVAILABLE";
	}
	return "PRODUCER_UNAVAILABLE";
}
function exitFor(reason: RunnerReason): 1 | 2 {
	return [
		"ACTUAL_SOURCE_CONFIRMATION_REQUIRED",
		"TERMINAL_STATE",
		"REVIEW_REQUIRED",
		"EXPIRED",
		"EVIDENCE_STALE",
		"BINDING_CHANGED",
		"GATE_EXCEPTIONS_FORBIDDEN",
		"FINDINGS_CHANGED",
		"AUDIT_INCOMPLETE",
		"AUTHORITY_CHANGED",
		"SOURCE_CHANGED",
		"INPUTS_CHANGED",
		"BASIS_STALE",
	].includes(reason)
		? 1
		: 2;
}
function result(
	phase: Phase,
	authority: AuthoritySnapshot | null,
	data: ProducedPolicyEvidence | null,
	verdict: PolicyVerdict | RunnerReason,
): RunnerResult {
	const decision: PolicyVerdict =
		typeof verdict === "string" ? { verdict: "refuse", reason: verdict as Reason } : verdict;
	const reason =
		typeof verdict === "string" ? verdict : decision.verdict === "refuse" ? decision.reason : null;
	const output: RunnerOutput = {
		version: 1,
		phase,
		verdict: decision.verdict,
		reason,
		authorityRevision: authority?.revision ?? null,
		authorityRecordDigest: authority?.recordDigest ?? null,
		runId: data?.runId ?? null,
		reportDigest: data?.reportDigest ?? null,
		binding: data?.binding ?? null,
		audit: data?.audit ?? null,
		rawExits: data?.rawExits ?? null,
		accepted: decision.verdict === "pass-with-scoped-exceptions" ? decision.accepted : [],
	};
	if (Buffer.byteLength(JSON.stringify(output)) > 32_768)
		return result(phase, null, null, "EVIDENCE_INVALID");
	return freeze({ exitCode: reason === null ? 0 : exitFor(reason), output });
}

/** Authority preflight precedes all native work; every final clock read follows asynchronous checks. */
export async function runNativePolicy(input: RunnerInput): Promise<RunnerResult> {
	let phase: Phase = "item",
		authority: AuthoritySnapshot | null = null,
		data: ProducedPolicyEvidence | null = null;
	let startedAt: number,
		clock: () => number,
		transport: AuthorityTransport,
		producer: NativePolicyProducer;
	try {
		const v = record(input, ["phase", "authority", "producer"], ["completionClock"]);
		if (v.phase !== "item" && v.phase !== "m4-gate")
			return result(phase, null, null, "INVALID_ARGUMENTS");
		phase = v.phase;
		clock = v.completionClock === undefined ? Date.now : (v.completionClock as () => number);
		if (typeof clock !== "function") return result(phase, null, null, "INVALID_ARGUMENTS");
		startedAt = integer(clock());
		transport = v.authority as AuthorityTransport;
		producer = v.producer as NativePolicyProducer;
		authority = await loadCurrentAuthority(transport);
		const preflight = preflightDecision(authority.record);
		if (preflight !== null) {
			const completedAt = integer(clock());
			return result(phase, authority, null, completedAt < startedAt ? "CLOCK_INVALID" : preflight);
		}
	} catch (error) {
		return result(
			phase,
			authority,
			null,
			error instanceof AuthorityError ? failureCode(error) : "INVALID_ARGUMENTS",
		);
	}
	const context = Object.freeze({ phase, startedAt }) as NativeRunContext;
	contexts.add(context);
	let pending: RunnerReason | null = null;
	try {
		const owner = producers.get(producer);
		if (!owner) invalid();
		const receipt = await producer.produce(context),
			state = receipts.get(receipt);
		if (!state || state.used || state.producer !== producer || state.context !== context) invalid();
		state.used = true;
		data = state.data;
		const checked = current(await owner.revalidate(context, data));
		if (
			checked.reportDigest !== data.reportDigest ||
			JSON.stringify(checked.binding) !== JSON.stringify(data.binding)
		)
			pending = "INPUTS_CHANGED";
		else if (JSON.stringify(checked.sourceRevisions) !== JSON.stringify(data.sourceRevisions))
			pending = "SOURCE_CHANGED";
		else pending = data.failure;
	} catch (error) {
		pending = failureCode(error);
	}
	try {
		await assertAuthorityCurrent(transport, authority);
	} catch (error) {
		pending = failureCode(error);
	}
	let completedAt: number;
	try {
		completedAt = integer(clock());
		if (completedAt < startedAt) return result(phase, authority, data, "CLOCK_INVALID");
	} catch {
		return result(phase, authority, data, "CLOCK_INVALID");
	}
	if (pending !== null) return result(phase, authority, data, pending);
	if (!data?.audit || !data.binding || data.evidenceObservedAt === null || !data.sourceRevisions)
		return result(phase, authority, data, "EVIDENCE_INVALID");
	return result(
		phase,
		authority,
		data,
		evaluateDecision({
			trustedRecord: authority.record,
			phase,
			startedAt,
			completedAt,
			evidenceObservedAt: data.evidenceObservedAt,
			binding: data.binding,
			audit: data.audit,
		}),
	);
}
