import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { types } from "node:util";
import { AuthorityError, type AuthoritySnapshot } from "./authority.ts";
import {
	BasisError,
	type CurrentBasisV2,
	currentBasisV2Scope,
	normalizeCurrentBasisV2,
} from "./current-basis.ts";
import { type Binding, BOUNDED_TUPLES, preflightReleaseBasisV2Authority } from "./decision.ts";
import {
	createGitHubSecuritySource,
	GitHubSecurityError,
	type GitHubSecurityObservation,
	type GitHubSecuritySource,
} from "./github-security-source.ts";
import {
	createNativeAuditSource,
	type NativeAuditData,
	type NativeAuditObservation,
	type NativeAuditSource,
	NativeAuditSourceError,
} from "./native-audit-source.ts";
import {
	createNativeProtectedManualAssessmentSource,
	ProtectedManualAssessmentError,
	type ProtectedManualAssessmentFacts,
	type ProtectedManualAssessmentObservation,
	type ProtectedManualAssessmentSource,
} from "./protected-manual-assessment-source.ts";
import { C2Error } from "./release-c2-data.ts";
import {
	type C2Collector,
	type C2SourceReceipt,
	createNativeC2Collector,
} from "./release-c2-source.ts";
import {
	type CurrentEvidenceBinding,
	createNativePolicyProducer,
	type NativePolicyProducer,
	type NativeRunContext,
	nativeRunAuthority,
	type ProducedPolicyEvidence,
	ProducerError,
	type ValidatedAudit,
} from "./runner.ts";

const HOUR = 3_600_000;
const REGISTRY = "registry+https://github.com/rust-lang/crates.io-index";
const CACHE_CHILD = "advisory-db-3157b0e258782691";
const ENVIRONMENT_KEYS = [
	"SystemRoot",
	"SYSTEMROOT",
	"PATH",
	"HOME",
	"USERPROFILE",
	"TEMP",
	"TMP",
	"TMPDIR",
	"CARGO",
	"CARGO_HOME",
	"RUSTUP_HOME",
	"RUSTUP_TOOLCHAIN",
	"CARGO_NET_OFFLINE",
	"CARGO_TERM_COLOR",
	"NO_COLOR",
] as const;

/** Physical placement and command environment only; none of these fields supplies authority. */
export interface ProductionProducerOptions {
	readonly repositoryRoot: string;
	readonly evidenceDirectory?: string;
	readonly databaseRoot?: string;
	readonly cargoHome?: string;
	readonly environment?: Readonly<Record<string, string>>;
}
function invalid(): never {
	throw new ProducerError("EVIDENCE_INVALID");
}
function data(value: unknown): Record<string, unknown> {
	if (
		value === null ||
		typeof value !== "object" ||
		types.isProxy(value) ||
		![null, Object.prototype].includes(Object.getPrototypeOf(value))
	)
		invalid();
	const result: Record<string, unknown> = Object.create(null);
	const keys = Reflect.ownKeys(value);
	if (keys.length > ENVIRONMENT_KEYS.length) invalid();
	for (const key of keys) {
		if (typeof key !== "string") invalid();
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) invalid();
		result[key] = descriptor.value;
	}
	return result;
}
function text(value: unknown): string {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.length > 32_768 ||
		// biome-ignore lint/suspicious/noControlCharactersInRegex: Reject control characters in paths and command environments.
		/[\x00-\x1f\x7f]/.test(value)
	)
		invalid();
	return value;
}
function location(value: unknown): string {
	const selected = text(value);
	if (!path.isAbsolute(selected)) invalid();
	return path.resolve(selected);
}
function environment(value: unknown): Readonly<Record<string, string>> {
	const selected = data(value),
		result: Record<string, string> = Object.create(null);
	const aliases = new Set<string>();
	let bytes = 0;
	for (const [key, value] of Object.entries(selected)) {
		if (!(ENVIRONMENT_KEYS as readonly string[]).includes(key) || aliases.has(key.toLowerCase()))
			invalid();
		aliases.add(key.toLowerCase());
		const entry = text(value);
		bytes += Buffer.byteLength(key) + Buffer.byteLength(entry);
		if (bytes > 65_536) invalid();
		result[key] = entry;
	}
	for (const [key, required] of [
		["CARGO_NET_OFFLINE", "true"],
		["CARGO_TERM_COLOR", "never"],
		["NO_COLOR", "1"],
	] as const) {
		if (result[key] !== undefined && result[key] !== required) invalid();
		result[key] = required;
	}
	return Object.freeze(result);
}
function options(input: ProductionProducerOptions): ProductionProducerOptions {
	const selected = data(input);
	if (
		Object.keys(selected).some(
			(key) =>
				![
					"repositoryRoot",
					"evidenceDirectory",
					"databaseRoot",
					"cargoHome",
					"environment",
				].includes(key),
		)
	)
		invalid();
	const result: ProductionProducerOptions = {
		repositoryRoot: location(selected.repositoryRoot),
		...(selected.evidenceDirectory === undefined
			? {}
			: { evidenceDirectory: location(selected.evidenceDirectory) }),
		...(selected.databaseRoot === undefined
			? {}
			: { databaseRoot: location(selected.databaseRoot) }),
		...(selected.cargoHome === undefined ? {} : { cargoHome: location(selected.cargoHome) }),
		...(selected.environment === undefined
			? {}
			: { environment: environment(selected.environment) }),
	};
	if (
		result.cargoHome &&
		result.environment?.CARGO_HOME !== undefined &&
		location(result.environment.CARGO_HOME) !== result.cargoHome
	)
		invalid();
	return Object.freeze(result);
}
/** Called only after protected authority and the fixed protected assessment have been observed. */
function nativeOptions(selected: ProductionProducerOptions) {
	const ambient: Record<string, string> = Object.create(null);
	if (selected.environment === undefined) {
		for (const key of ENVIRONMENT_KEYS) {
			const value = process.env[key];
			// Windows resolves the SystemRoot aliases case-insensitively.
			if (value !== undefined && !(key === "SYSTEMROOT" && ambient.SystemRoot !== undefined))
				ambient[key] = value;
		}
	}
	const chosen = selected.environment ?? environment(ambient);
	const cargoHome =
		selected.cargoHome ??
		(chosen.CARGO_HOME === undefined
			? path.join(os.homedir(), ".cargo")
			: location(chosen.CARGO_HOME));
	if (chosen.CARGO_HOME !== undefined && location(chosen.CARGO_HOME) !== cargoHome) invalid();
	const commandEnvironment = environment({ ...chosen, CARGO_HOME: cargoHome });
	return {
		repositoryRoot: selected.repositoryRoot,
		databaseRoot: selected.databaseRoot ?? path.join(cargoHome, "advisory-dbs", CACHE_CHILD),
		cargoHome,
		evidenceDirectory:
			selected.evidenceDirectory ??
			path.join(os.tmpdir(), `draftyak-native-policy-${randomUUID()}`),
		environment: commandEnvironment,
	};
}
function failure(error: unknown): ProducerError | AuthorityError {
	if (error instanceof ProducerError || error instanceof AuthorityError) return error;
	if (error instanceof BasisError) return new ProducerError(error.code);
	if (error instanceof NativeAuditSourceError) {
		if (error.code === "NATIVE_AUDIT_CHANGED") return new ProducerError("INPUTS_CHANGED");
		if (error.code === "NATIVE_AUDIT_STALE") return new ProducerError("BASIS_STALE");
		if (
			[
				"NATIVE_AUDIT_RESOURCE_PENDING",
				"NATIVE_AUDIT_PROCESS_UNCONFIRMED",
				"NATIVE_AUDIT_CLOSED",
			].includes(error.code)
		)
			return new ProducerError("CAPTURE_FAILED");
		return new ProducerError("AUDIT_INVALID");
	}
	if (error instanceof C2Error) {
		return new ProducerError(
			error.code === "SOURCE_CHANGED"
				? "SOURCE_CHANGED"
				: error.code === "C2_EXPIRED"
					? "BASIS_STALE"
					: error.code === "C2_UNAVAILABLE"
						? "BASIS_UNAVAILABLE"
						: "BASIS_INVALID",
		);
	}
	if (error instanceof GitHubSecurityError) {
		return new ProducerError(
			error.code === "GITHUB_SECURITY_CHANGED"
				? "SOURCE_CHANGED"
				: error.code === "GITHUB_SECURITY_STALE"
					? "BASIS_STALE"
					: [
								"GITHUB_SECURITY_UNAVAILABLE",
								"GITHUB_SECURITY_RATE_LIMIT",
								"GITHUB_SECURITY_DEADLINE",
							].includes(error.code)
						? "BASIS_UNAVAILABLE"
						: "BASIS_INVALID",
		);
	}
	if (error instanceof ProtectedManualAssessmentError) {
		return new ProducerError(
			error.code === "MANUAL_ASSESSMENT_CHANGED"
				? "SOURCE_CHANGED"
				: error.code === "MANUAL_ASSESSMENT_EXPIRED"
					? "BASIS_STALE"
					: ["MANUAL_ASSESSMENT_UNAVAILABLE", "MANUAL_ASSESSMENT_REVIEW_REQUIRED"].includes(
								error.code,
							)
						? "BASIS_UNAVAILABLE"
						: "BASIS_INVALID",
		);
	}
	return new ProducerError("PRODUCER_UNAVAILABLE");
}
function sameAuthority(facts: ProtectedManualAssessmentFacts, authority: AuthoritySnapshot): void {
	if (
		facts.origin !== "NATIVE" ||
		facts.authority !== false ||
		facts.reusableNativeSourceBasis !== false ||
		facts.delivery.revision !== authority.revision ||
		facts.delivery.authorityRecordSha256 !== authority.recordDigest
	)
		throw new AuthorityError("AUTHORITY_CHANGED");
}
function audit(data: NativeAuditData): ValidatedAudit {
	const report = data.report;
	const findings = report.findings
		.filter(
			(finding) =>
				finding.source === REGISTRY &&
				BOUNDED_TUPLES.some(
					([name, version, advisory]) =>
						finding.name === name &&
						finding.version === version &&
						finding.advisory.id === advisory,
				),
		)
		.map((finding) => {
			const ancestors = data.graph.ancestorDigests.filter(
				({ target }) =>
					target.source === finding.source &&
					target.name === finding.name &&
					target.version === finding.version,
			);
			if (ancestors.length !== 1) throw new ProducerError("BASIS_INVALID");
			return {
				source: finding.source,
				name: finding.name,
				version: finding.version,
				advisory: finding.advisory.id,
				ancestor: ancestors[0]!.digest,
			};
		});
	const errors = Object.values(report.counts).reduce((sum, counts) => sum + counts.errors, 0);
	if (errors < findings.length) throw new ProducerError("AUDIT_INVALID");
	return {
		complete: true,
		fullExit: report.fullExitCode,
		advisoryExit: report.advisoryExitCode,
		unexpectedErrors: errors - findings.length,
		findings,
		counts: report.counts,
	};
}
function exits(data: NativeAuditData): ProducedPolicyEvidence["rawExits"] {
	function one(id: string, expected: number) {
		const rows = data.captures.filter((capture) => capture.id === id);
		if (rows.length !== 1 || rows[0]!.exitCode !== expected)
			throw new ProducerError("CAPTURE_FAILED");
		// NativeAuditData is issued only after the actual sealed processes settled without signals/failures.
		return { exitCode: expected, signal: null };
	}
	return {
		full: one("strict-full", data.report.fullExitCode),
		advisory: one("strict-advisory", data.report.advisoryExitCode),
	};
}
function binding(data: NativeAuditData, basis: CurrentBasisV2): Binding {
	return {
		graph: data.graphDigest,
		lock: data.lockDigest,
		inputs: data.inputDigest,
		basis: basis.basisDigest,
		releases: basis.releasesDigest,
		security: basis.securityDigest,
		policy: data.policySha256,
	};
}

/** A single-use composition of the fixed sources. Construction snapshots data without I/O. */
export function createProductionProducer(input: ProductionProducerOptions): NativePolicyProducer {
	const selected = options(input);
	let context: NativeRunContext | undefined, authority: AuthoritySnapshot | undefined;
	let manual: ProtectedManualAssessmentSource | undefined,
		manualToken: ProtectedManualAssessmentObservation | undefined;
	let native: NativeAuditSource | undefined,
		nativeToken: NativeAuditObservation | undefined,
		nativeData: NativeAuditData | undefined;
	let releases: C2Collector | undefined, releaseReceipt: C2SourceReceipt | undefined;
	let github: GitHubSecuritySource | undefined, githubToken: GitHubSecurityObservation | undefined;
	let produced: ProducedPolicyEvidence | undefined,
		entered = false,
		closed = false;
	let finalization: Promise<void> | undefined;
	function open(): void {
		if (closed) throw new ProducerError("CAPTURE_FAILED");
	}
	function current(): CurrentBasisV2 {
		if (
			!context ||
			!authority ||
			!manual ||
			!manualToken ||
			!native ||
			!nativeToken ||
			!releaseReceipt ||
			!github ||
			!githubToken
		)
			invalid();
		const assessment = manual.facts(manualToken);
		sameAuthority(assessment, authority);
		return normalizeCurrentBasisV2({
			audit: native.data(nativeToken),
			releases: releaseReceipt.basis,
			github: github.facts(githubToken),
			manual: assessment,
			currentAuthority: authority,
			startedAt: context.startedAt,
			completedAt: Date.now(),
			maxAgeMs: HOUR,
		});
	}
	return createNativePolicyProducer({
		async collect(run) {
			if (entered) throw new ProducerError("EVIDENCE_INVALID");
			entered = true;
			context = run;
			try {
				authority = nativeRunAuthority(run);
				if (preflightReleaseBasisV2Authority(authority.record) !== null)
					throw new AuthorityError("AUTHORITY_INVALID");
				open();
				manual = createNativeProtectedManualAssessmentSource();
				manualToken = await manual.observe();
				open();
				sameAuthority(manual.facts(manualToken), authority);
				native = createNativeAuditSource(nativeOptions(selected));
				nativeToken = await native.observe();
				open();
				nativeData = native.data(nativeToken);
				const validatedAudit = audit(nativeData),
					rawExits = exits(nativeData);
				releases = createNativeC2Collector();
				releaseReceipt = await releases.collect(currentBasisV2Scope(nativeData));
				open();
				github = createGitHubSecuritySource();
				githubToken = await github.observe();
				open();
				const basis = current();
				produced = {
					runId: nativeData.runId,
					reportDigest: nativeData.reportDigest,
					binding: binding(nativeData, basis),
					audit: validatedAudit,
					rawExits,
					evidenceObservedAt: basis.observedAt,
					sourceRevisions: basis.sourceRevisions,
					failure: null,
				};
				return produced;
			} catch (error) {
				const reason = failure(error);
				if (!nativeData || reason instanceof AuthorityError) throw reason;
				// Preserve complete failing audit DATA without manufacturing missing source bindings.
				produced = {
					runId: nativeData.runId,
					reportDigest: nativeData.reportDigest,
					binding: null,
					audit: audit(nativeData),
					rawExits: exits(nativeData),
					evidenceObservedAt: nativeData.observedAt,
					sourceRevisions: null,
					failure: reason.code,
				};
				return produced;
			}
		},
		async revalidate(run, evidence): Promise<CurrentEvidenceBinding> {
			try {
				open();
				if (
					run !== context ||
					!produced ||
					evidence.runId !== produced.runId ||
					nativeRunAuthority(run) !== authority
				)
					invalid();
				if (produced.failure !== null)
					return { reportDigest: produced.reportDigest, binding: null, sourceRevisions: null };
				if (
					!native ||
					!nativeToken ||
					!releases ||
					!releaseReceipt ||
					!github ||
					!githubToken ||
					!manual ||
					!manualToken ||
					!nativeData
				)
					invalid();
				await native.revalidate(nativeToken);
				open();
				await releases.revalidate(releaseReceipt);
				open();
				// The source returns a new recheck token; the original delivery and its age remain bound.
				await github.revalidate(githubToken);
				open();
				await manual.revalidate(manualToken);
				open();
				const basis = current();
				return {
					reportDigest: native.data(nativeToken).reportDigest,
					binding: binding(native.data(nativeToken), basis),
					sourceRevisions: basis.sourceRevisions,
				};
			} catch (error) {
				throw failure(error);
			}
		},
		finalize() {
			closed = true;
			finalization ??= (async () => {
				try {
					if (native && !(await native.closeResources()).complete)
						throw new ProducerError("CAPTURE_FAILED");
				} catch {
					throw new ProducerError("CAPTURE_FAILED");
				}
			})();
			return finalization;
		},
	});
}
