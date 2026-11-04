import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthorityTransport } from "../src/authority.ts";
import type { NativeAuditData } from "../src/native-audit-source.ts";
import type { ProductionProducerOptions } from "../src/production.ts";

// These tests exercise the real runner/context/finalizer using inert fixed-source seams.
// Synthetic source DATA and the isolated normalizer are not native collection or authority proof.
const injected = vi.hoisted(() => ({
	manual: vi.fn(),
	audit: vi.fn(),
	c2: vi.fn(),
	github: vi.fn(),
	normalize: vi.fn(),
	scope: vi.fn(),
	request: vi.fn(() => {
		throw Error("unexpected test HTTPS operation");
	}),
	spawn: vi.fn(() => {
		throw Error("unexpected test process operation");
	}),
	files: vi.fn(() => {
		throw Error("unexpected test file operation");
	}),
}));
vi.mock("node:https", () => ({ request: injected.request }));
vi.mock("node:child_process", () => ({ spawn: injected.spawn, execFile: injected.spawn }));
vi.mock("node:fs/promises", async (original) => ({
	...(await original<typeof import("node:fs/promises")>()),
	open: injected.files,
	lstat: injected.files,
	stat: injected.files,
	realpath: injected.files,
	mkdir: injected.files,
	readFile: injected.files,
	writeFile: injected.files,
	readdir: injected.files,
}));
vi.mock("../src/protected-manual-assessment-source.ts", async (original) => ({
	...(await original<typeof import("../src/protected-manual-assessment-source.ts")>()),
	createNativeProtectedManualAssessmentSource: injected.manual,
}));
vi.mock("../src/native-audit-source.ts", async (original) => ({
	...(await original<typeof import("../src/native-audit-source.ts")>()),
	createNativeAuditSource: injected.audit,
}));
vi.mock("../src/release-c2-source.ts", async (original) => ({
	...(await original<typeof import("../src/release-c2-source.ts")>()),
	createNativeC2Collector: injected.c2,
}));
vi.mock("../src/github-security-source.ts", async (original) => ({
	...(await original<typeof import("../src/github-security-source.ts")>()),
	createGitHubSecuritySource: injected.github,
}));
vi.mock("../src/current-basis.ts", async (original) => ({
	...(await original<typeof import("../src/current-basis.ts")>()),
	normalizeCurrentBasisV2: injected.normalize,
	currentBasisV2Scope: injected.scope,
}));

import { BasisError } from "../src/current-basis.ts";
import { BOUNDED_TUPLES } from "../src/decision.ts";
import { GitHubSecurityError } from "../src/github-security-source.ts";
import { NativeAuditSourceError } from "../src/native-audit-source.ts";
import { createProductionProducer } from "../src/production.ts";
import { ProtectedManualAssessmentError } from "../src/protected-manual-assessment-source.ts";
import { C2Error } from "../src/release-c2-data.ts";
import { runNativePolicy } from "../src/runner.ts";

const NOW = Date.parse("2026-11-03T12:00:00Z"),
	REVISION = "a".repeat(40);
const SOURCE = "registry+https://github.com/rust-lang/crates.io-index";
const ROOT = path.resolve("synthetic-policy-checkout"),
	HOME = path.resolve("synthetic-cargo-home");
const BINDING = {
	graph: "1".repeat(64),
	lock: "2".repeat(64),
	inputs: "3".repeat(64),
	basis: "4".repeat(64),
	releases: "5".repeat(64),
	security: "6".repeat(64),
	policy: "7".repeat(64),
};
const REVISIONS = { database: "a".repeat(64), releases: "b".repeat(64), security: "c".repeat(64) };
const SCOPE = {
	graph: BINDING.graph,
	lock: BINDING.lock,
	inputs: BINDING.inputs,
	coverage: "d".repeat(64),
};
const counts = (errors = 0) => ({ errors, warnings: 0, notes: 0, helps: 0 });
const scoped = () =>
	BOUNDED_TUPLES.map(([name, version, advisory]) => ({
		name,
		version,
		advisory,
		source: SOURCE,
		ancestor: "f".repeat(64),
	}));
function active() {
	return {
		version: 2,
		releaseBasisSchemaVersion: 2,
		state: "active",
		termination: "release-or-validated-fix",
		evidenceKind: "actual-source",
		confirmation: "unchanged-scope",
		binding: BINDING,
		review: { at: "2026-11-03T11:59:00Z", due: "2026-11-03T13:00:00Z" },
		exceptions: scoped(),
	};
}
function auditData(): NativeAuditData {
	return {
		kind: "SAME_ROOT_STRICT_AUDIT_DATA",
		authority: false,
		reusableNativeSourceBasis: false,
		runId: randomUUID(),
		startedAt: NOW,
		completedAt: NOW,
		observedAt: NOW - 1,
		database: {
			delivery: "independent-current-head",
			commit: REVISION,
			currentCommit: REVISION,
			revision: "8".repeat(64),
			observedAt: NOW - 1,
		},
		graphDigest: BINDING.graph,
		graph: {
			version: 1,
			digest: BINDING.graph,
			packageCount: 6,
			tuplePayload: [],
			ancestorDigests: scoped().map(({ source, name, version, ancestor }) => ({
				target: { source, name, version },
				digest: ancestor,
				packageCount: 2,
				tuplePayload: [],
			})),
		},
		environmentDigest: "9".repeat(64),
		inputDigest: BINDING.inputs,
		lockDigest: BINDING.lock,
		toolsDigest: "8".repeat(64),
		policySha256: BINDING.policy,
		effectivePolicySha256: "e".repeat(64),
		reportDigest: "8".repeat(64),
		strictPass: false,
		report: {
			version: 1,
			complete: true,
			fullExitCode: 1,
			advisoryExitCode: 1,
			denyWarnings: false,
			counts: { advisories: counts(5), bans: counts(), licenses: counts(), sources: counts() },
			diagnostics: [],
			advisoryDiagnostics: [],
			dependencyCount: 6,
			findings: scoped().map(({ name, version, source, advisory }) => ({
				name,
				version,
				source,
				classification: "unmaintained",
				affected: null,
				patched: [],
				unaffected: [],
				advisory: {
					id: advisory,
					package: name,
					informational: "unmaintained",
					categories: [],
					collection: "crates",
					source: null,
					date: "2026-01-01",
					withdrawn: null,
					cvss: null,
				},
			})),
		},
		captures: ["strict-full", "strict-advisory"].map((id) => ({
			id,
			exitCode: 1,
			stdoutBytes: 1,
			stdoutSha256: "a".repeat(64),
			stderrBytes: 0,
			stderrSha256: "b".repeat(64),
		})),
	};
}

beforeEach(() => {
	for (const fn of Object.values(injected)) fn.mockClear();
	for (const fn of [
		injected.manual,
		injected.audit,
		injected.c2,
		injected.github,
		injected.normalize,
		injected.scope,
	])
		fn.mockReset();
	vi.spyOn(Date, "now").mockReturnValue(NOW);
});
afterEach(() => {
	expect(injected.request).not.toHaveBeenCalled();
	expect(injected.spawn).not.toHaveBeenCalled();
	expect(injected.files).not.toHaveBeenCalled();
	vi.restoreAllMocks();
});

function setup(record: unknown = active()) {
	const events: string[] = [],
		audit = auditData();
	const manualToken = Object.freeze({ testOnly: "manual" }),
		auditToken = Object.freeze({ testOnly: "audit" }),
		githubToken = Object.freeze({ testOnly: "github" });
	const newerGithub = Object.freeze({ testOnly: "newer-github" });
	const bytes = Buffer.from(JSON.stringify(record)),
		recordDigest = createHash("sha256").update(bytes).digest("hex");
	const manualFacts = {
		kind: "PROTECTED_MANUAL_ASSESSMENT_DATA",
		origin: "NATIVE",
		authority: false,
		reusableNativeSourceBasis: false,
		delivery: {
			revision: REVISION,
			authorityRecordSha256: recordDigest,
			assessmentContentDigest: "e".repeat(64),
		},
		oldestObservedAt: NOW - 2,
		assessment: { assessedAt: NOW - 100_000, originalObservation: { completedAt: NOW - 110_000 } },
	};
	const githubFacts = Object.freeze({ testOnly: "original-github-facts", observedAt: NOW - 3 });
	const releaseReceipt = Object.freeze({
		basis: Object.freeze({ testOnly: "original-c2-basis" }),
		semanticDigest: BINDING.releases,
	});
	const manual = {
		observe: vi.fn(async () => {
			events.push("M.observe");
			return manualToken;
		}),
		facts: vi.fn((token: unknown) => {
			expect(token).toBe(manualToken);
			return manualFacts;
		}),
		revalidate: vi.fn(async (token: unknown) => {
			expect(token).toBe(manualToken);
			events.push("M.revalidate");
		}),
	};
	const native = {
		observe: vi.fn(async () => {
			events.push("R.observe");
			return auditToken;
		}),
		data: vi.fn((token: unknown) => {
			expect(token).toBe(auditToken);
			return audit;
		}),
		revalidate: vi.fn(async (token: unknown) => {
			expect(token).toBe(auditToken);
			events.push("R.revalidate");
		}),
		closeResources: vi.fn(async () => {
			events.push("R.close");
			return {
				activeOperations: 0,
				activeToolOperations: 0,
				pendingToolFiles: 0,
				activeReaders: 0,
				pendingReaders: 0,
				pendingFiles: 0,
				processUnconfirmed: false,
				complete: true,
				dataRetained: true,
			};
		}),
	};
	const c2 = {
		collect: vi.fn(async (scope: unknown) => {
			expect(scope).toEqual(SCOPE);
			events.push("C2.collect");
			return releaseReceipt;
		}),
		revalidate: vi.fn(async (receipt: unknown) => {
			expect(receipt).toBe(releaseReceipt);
			events.push("C2.revalidate");
		}),
	};
	const github = {
		observe: vi.fn(async () => {
			events.push("G.observe");
			return githubToken;
		}),
		facts: vi.fn((token: unknown) => {
			expect(token).toBe(githubToken);
			return githubFacts;
		}),
		revalidate: vi.fn(async (token: unknown) => {
			expect(token).toBe(githubToken);
			events.push("G.revalidate");
			return newerGithub;
		}),
	};
	injected.manual.mockReturnValue(manual);
	injected.audit.mockReturnValue(native);
	injected.c2.mockReturnValue(c2);
	injected.github.mockReturnValue(github);
	injected.scope.mockImplementation((data) => {
		expect(data).toBe(audit);
		return SCOPE;
	});
	injected.normalize.mockImplementation((input) => {
		expect(input.audit).toBe(audit);
		expect(input.releases).toBe(releaseReceipt.basis);
		expect(input.github).toBe(githubFacts);
		expect(input.manual).toBe(manualFacts);
		expect(input.currentAuthority).toMatchObject({ revision: REVISION, recordDigest, record });
		expect(input.startedAt).toBe(NOW);
		expect(input.maxAgeMs).toBe(3_600_000);
		return {
			version: 2,
			releaseBasisSchemaVersion: 2,
			authority: false,
			reusableNativeSourceBasis: false,
			scope: SCOPE,
			basisDigest: BINDING.basis,
			releasesDigest: BINDING.releases,
			securityDigest: BINDING.security,
			observationDigest: "d".repeat(64),
			observedAt: NOW - 3,
			sourceRevisions: REVISIONS,
			components: input,
		};
	});
	let current = REVISION;
	const authority: AuthorityTransport = {
		async currentRevision() {
			return current;
		},
		async recordAt() {
			return bytes;
		},
	};
	function producer(overrides: Partial<ProductionProducerOptions> = {}) {
		return createProductionProducer({
			repositoryRoot: ROOT,
			evidenceDirectory: path.resolve("synthetic-evidence"),
			cargoHome: HOME,
			environment: { PATH: "synthetic-tools", CARGO_HOME: HOME },
			...overrides,
		});
	}
	return {
		events,
		audit,
		native,
		c2,
		github,
		manual,
		manualFacts,
		githubFacts,
		releaseReceipt,
		authority,
		producer,
		setCurrent(value: string) {
			current = value;
		},
		run: (overrides: Partial<ProductionProducerOptions> = {}) =>
			runNativePolicy({ phase: "item", authority, producer: producer(overrides) }),
	};
}
function noSources() {
	for (const fn of [injected.manual, injected.audit, injected.c2, injected.github])
		expect(fn).not.toHaveBeenCalled();
}

describe("fixed production composition through the real runner", () => {
	it("retains the current refusal-only preflight without source actions", async () => {
		const s = setup({
			version: 1,
			state: "refusal-only",
			reason: "ACTUAL_SOURCE_CONFIRMATION_REQUIRED",
		});
		expect((await s.run()).output.reason).toBe("ACTUAL_SOURCE_CONFIRMATION_REQUIRED");
		noSources();
		expect(s.native.closeResources).not.toHaveBeenCalled();
	});
	it.each(["v1", "unmarked-v2"])(
		"refuses historical %s authority before any source action",
		async (kind) => {
			const { releaseBasisSchemaVersion: _schema, ...unmarked } = active();
			const { termination: _termination, ...legacy } = unmarked;
			const s = setup(kind === "v1" ? { ...legacy, version: 1, gate: "open" } : unmarked);
			expect((await s.run()).output.reason).toBe("AUTHORITY_INVALID");
			noSources();
		},
	);
	it("composes original tokens, full audit and the runner's loaded authority, then closes before pass", async () => {
		const s = setup(),
			result = await s.run();
		expect(result.output.verdict).toBe("pass-with-scoped-exceptions");
		expect(result.output.binding).toEqual(BINDING);
		expect(result.output.audit?.findings).toEqual(scoped());
		expect(result.output.accepted).toEqual(scoped());
		expect(s.events).toEqual([
			"M.observe",
			"R.observe",
			"C2.collect",
			"G.observe",
			"R.revalidate",
			"C2.revalidate",
			"G.revalidate",
			"M.revalidate",
			"R.close",
		]);
		expect(s.native.closeResources).toHaveBeenCalledTimes(1);
		expect(injected.normalize).toHaveBeenCalledTimes(2);
		for (const call of injected.normalize.mock.calls)
			expect(call[0].manual.assessment.assessedAt).toBe(NOW - 100_000);
	});
	it("uses the same marked source composition for the milestone gate", async () => {
		const s = setup();
		const result = await runNativePolicy({
			phase: "m4-gate",
			authority: s.authority,
			producer: s.producer(),
		});
		expect(result.output.verdict).toBe("pass-with-scoped-exceptions");
		expect(s.native.closeResources).toHaveBeenCalledTimes(1);
	});
	it.each(["foreign-B", "test-only"])(
		"refuses %s assessment before audit resources exist",
		async (fault) => {
			const s = setup();
			if (fault === "foreign-B") s.manualFacts.delivery.authorityRecordSha256 = "0".repeat(64);
			else s.manualFacts.origin = "TEST_ONLY";
			expect((await s.run()).output.reason).toBe("AUTHORITY_CHANGED");
			expect(injected.audit).not.toHaveBeenCalled();
			expect(injected.c2).not.toHaveBeenCalled();
			expect(injected.github).not.toHaveBeenCalled();
			expect(s.native.closeResources).not.toHaveBeenCalled();
		},
	);
	it("stops when the protected assessment is absent without inventing an audit receipt", async () => {
		const s = setup();
		s.manual.observe.mockRejectedValue(
			new ProtectedManualAssessmentError("MANUAL_ASSESSMENT_UNAVAILABLE"),
		);
		const result = await s.run();
		expect(result.output).toMatchObject({
			verdict: "refuse",
			reason: "BASIS_UNAVAILABLE",
			runId: null,
			reportDigest: null,
			audit: null,
		});
		expect(injected.audit).not.toHaveBeenCalled();
	});
	it("preserves full7/advisory1, including both non-advisory category errors", async () => {
		const s = setup();
		Object.assign(s.audit.report, {
			fullExitCode: 7,
			counts: { ...s.audit.report.counts, bans: counts(1), licenses: counts(1) },
		});
		Object.assign(s.audit.captures[0]!, { exitCode: 7 });
		const result = await s.run();
		expect(result.output.reason).toBe("AUDIT_INCOMPLETE");
		expect(result.output.rawExits).toEqual({
			full: { exitCode: 7, signal: null },
			advisory: { exitCode: 1, signal: null },
		});
		expect(result.output.audit).toMatchObject({
			complete: true,
			fullExit: 7,
			advisoryExit: 1,
			unexpectedErrors: 2,
			counts: { bans: { errors: 1 }, licenses: { errors: 1 } },
		});
		expect(s.native.closeResources).toHaveBeenCalledTimes(1);
	});
	it("retains a complete license-only exit4 as failing DATA", async () => {
		const s = setup();
		Object.assign(s.audit.report, {
			fullExitCode: 4,
			advisoryExitCode: 0,
			findings: [],
			counts: { advisories: counts(), bans: counts(), licenses: counts(1), sources: counts() },
		});
		Object.assign(s.audit.captures[0]!, { exitCode: 4 });
		Object.assign(s.audit.captures[1]!, { exitCode: 0 });
		expect((await s.run()).output).toMatchObject({
			reason: "AUDIT_INCOMPLETE",
			audit: { complete: true, fullExit: 4, advisoryExit: 0, unexpectedErrors: 1, findings: [] },
		});
	});
	it("counts an unscoped report finding as unexpected instead of dropping its error", async () => {
		const s = setup(),
			original = s.audit.report.findings[0]!;
		Object.assign(s.audit.report, {
			findings: [
				...s.audit.report.findings,
				{
					...original,
					name: "unscoped",
					advisory: { ...original.advisory, id: "RUSTSEC-2026-9999" },
				},
			],
			counts: { ...s.audit.report.counts, advisories: counts(6) },
		});
		expect((await s.run()).output).toMatchObject({
			reason: "AUDIT_INCOMPLETE",
			audit: { unexpectedErrors: 1 },
		});
	});
	it("refuses missing exact ancestor evidence instead of using rendered parents", async () => {
		const s = setup();
		Object.assign(s.audit.graph, { ancestorDigests: s.audit.graph.ancestorDigests.slice(1) });
		expect((await s.run()).output.reason).toBe("BASIS_INVALID");
		expect(s.native.closeResources).toHaveBeenCalledTimes(1);
		expect(injected.c2).not.toHaveBeenCalled();
	});
	it("refuses a mismatched original full capture before release collection", async () => {
		const s = setup();
		Object.assign(s.audit.captures[0]!, { exitCode: 7 });
		expect((await s.run()).output.reason).toBe("CAPTURE_FAILED");
		expect(injected.c2).not.toHaveBeenCalled();
		expect(s.native.closeResources).toHaveBeenCalledTimes(1);
	});
	it("does not silently omit C2 currentness when its original receipt changes", async () => {
		const s = setup();
		s.c2.revalidate.mockRejectedValue(new C2Error("SOURCE_CHANGED"));
		const result = await s.run();
		expect(result.output.reason).toBe("SOURCE_CHANGED");
		expect(s.c2.revalidate).toHaveBeenCalledTimes(1);
		expect(s.github.revalidate).not.toHaveBeenCalled();
		expect(s.native.closeResources).toHaveBeenCalledTimes(1);
	});
	it("keeps the original G token and assessment times after a fresh recheck token is returned", async () => {
		const s = setup();
		expect((await s.run()).exitCode).toBe(0);
		expect(s.github.revalidate).toHaveBeenCalledTimes(1);
		expect(new Set(s.github.facts.mock.calls.map(([token]) => token)).size).toBe(1);
		expect(s.manualFacts.assessment.assessedAt).toBe(NOW - 100_000);
	});
	it("does not refresh expired original source observations during revalidation", async () => {
		const s = setup();
		injected.normalize
			.mockImplementationOnce(injected.normalize.getMockImplementation()!)
			.mockImplementationOnce(() => {
				throw new BasisError("BASIS_STALE");
			});
		expect((await s.run()).output.reason).toBe("BASIS_STALE");
		expect(s.native.closeResources).toHaveBeenCalledTimes(1);
	});
	it("retains complete audit DATA when G is unavailable without another network attempt", async () => {
		const s = setup();
		s.github.observe.mockRejectedValue(new GitHubSecurityError("GITHUB_SECURITY_RATE_LIMIT"));
		const result = await s.run();
		expect(result.output).toMatchObject({
			reason: "BASIS_UNAVAILABLE",
			runId: s.audit.runId,
			reportDigest: s.audit.reportDigest,
			binding: null,
			audit: { complete: true, fullExit: 1 },
		});
		expect(s.github.observe).toHaveBeenCalledTimes(1);
		expect(s.github.revalidate).not.toHaveBeenCalled();
		expect(s.native.closeResources).toHaveBeenCalledTimes(1);
	});
	it("finalizes resources after an audit observation throws", async () => {
		const s = setup();
		s.native.observe.mockRejectedValue(
			new NativeAuditSourceError("NATIVE_AUDIT_PROCESS_UNCONFIRMED"),
		);
		expect((await s.run()).output.reason).toBe("CAPTURE_FAILED");
		expect(s.native.closeResources).toHaveBeenCalledTimes(1);
		expect(injected.c2).not.toHaveBeenCalled();
	});
	it("never passes when the aggregate finalizer reports pending tool files", async () => {
		const s = setup();
		s.native.closeResources.mockResolvedValue({
			activeOperations: 0,
			activeToolOperations: 0,
			pendingToolFiles: 1,
			activeReaders: 0,
			pendingReaders: 0,
			pendingFiles: 0,
			processUnconfirmed: false,
			complete: false,
			dataRetained: true,
		});
		expect((await s.run()).output).toMatchObject({
			verdict: "refuse",
			reason: "CAPTURE_FAILED",
			finalizerFailure: "CAPTURE_FAILED",
		});
		expect(s.native.closeResources).toHaveBeenCalledTimes(1);
	});
	it("preserves a currentness failure when cleanup also fails", async () => {
		const s = setup();
		s.c2.revalidate.mockRejectedValue(new C2Error("SOURCE_CHANGED"));
		s.native.closeResources.mockResolvedValue({
			activeOperations: 0,
			activeToolOperations: 0,
			pendingToolFiles: 0,
			activeReaders: 0,
			pendingReaders: 1,
			pendingFiles: 0,
			processUnconfirmed: false,
			complete: false,
			dataRetained: true,
		});
		expect((await s.run()).output).toMatchObject({
			reason: "SOURCE_CHANGED",
			finalizerFailure: "CAPTURE_FAILED",
		});
	});
	it("refuses a throwing finalizer without exposing its private cause or retrying it", async () => {
		const s = setup();
		s.native.closeResources.mockRejectedValue(Error("synthetic private close cause"));
		const result = await s.run();
		expect(result.output).toMatchObject({
			verdict: "refuse",
			reason: "CAPTURE_FAILED",
			finalizerFailure: "CAPTURE_FAILED",
		});
		expect(JSON.stringify(result)).not.toContain("synthetic private close cause");
		expect(s.native.closeResources).toHaveBeenCalledTimes(1);
	});
	it("awaits the real owned finalizer before returning any pass", async () => {
		const s = setup();
		let release!: () => void;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const close = s.native.closeResources.getMockImplementation()!;
		s.native.closeResources.mockImplementation(async () => {
			await held;
			return close();
		});
		let returned = false;
		const pending = s.run().then((value) => {
			returned = true;
			return value;
		});
		try {
			for (let i = 0; i < 30 && s.native.closeResources.mock.calls.length === 0; i++)
				await Promise.resolve();
			expect(s.native.closeResources).toHaveBeenCalledTimes(1);
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(returned).toBe(false);
		} finally {
			release();
			await pending;
		}
		expect((await pending).exitCode).toBe(0);
	});
	it("checks authority after all owned resources are closed", async () => {
		const s = setup(),
			close = s.native.closeResources.getMockImplementation()!;
		s.native.closeResources.mockImplementation(async () => {
			const result = await close();
			s.setCurrent("b".repeat(40));
			return result;
		});
		expect((await s.run()).output.reason).toBe("AUTHORITY_CHANGED");
	});
	it("snapshots the explicit environment before authority awaits without mutating process.env", async () => {
		const s = setup(),
			commandEnvironment = { PATH: "original-tools", CARGO_HOME: HOME };
		const options = {
			repositoryRoot: ROOT,
			cargoHome: HOME,
			expectedCargo: path.resolve("original-cargo"),
			expectedDeny: path.resolve("original-deny"),
			evidenceDirectory: path.resolve("original-evidence"),
			environment: commandEnvironment,
		};
		const originalPath = process.env.PATH,
			producer = createProductionProducer(options);
		options.repositoryRoot = path.resolve("changed-checkout");
		options.expectedCargo = path.resolve("changed-cargo");
		options.expectedDeny = path.resolve("changed-deny");
		commandEnvironment.PATH = "changed-tools";
		expect(
			(await runNativePolicy({ phase: "item", authority: s.authority, producer })).exitCode,
		).toBe(0);
		expect(injected.audit.mock.calls[0]![0]).toMatchObject({
			repositoryRoot: ROOT,
			cargoHome: HOME,
			evidenceDirectory: path.resolve("original-evidence"),
			expectedCargo: path.resolve("original-cargo"),
			expectedDeny: path.resolve("original-deny"),
			environment: {
				PATH: "original-tools",
				CARGO_HOME: HOME,
				CARGO_NET_OFFLINE: "true",
				CARGO_TERM_COLOR: "never",
				NO_COLOR: "1",
			},
		});
		expect(Object.isFrozen(injected.audit.mock.calls[0]![0].environment)).toBe(true);
		expect(process.env.PATH === originalPath).toBe(true);
	});
	it("uses only the normal advisory cache child when no database root is supplied", async () => {
		const s = setup();
		await s.run();
		expect(injected.audit.mock.calls[0]![0].databaseRoot).toBe(
			path.join(HOME, "advisory-dbs", "advisory-db-3157b0e258782691"),
		);
	});
});
