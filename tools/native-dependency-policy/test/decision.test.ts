import { describe, expect, it } from "vitest";
import {
	type Binding,
	BOUNDED_TUPLES,
	type EvaluationInput,
	evaluate,
	preflightDecision,
} from "../src/decision.ts";

const HOUR = 3_600_000;
const NOW = Date.parse("2026-10-20T14:00:00Z");
const SOURCE = "registry+https://github.com/rust-lang/crates.io-index";
const binding: Binding = {
	graph: "a".repeat(64),
	lock: "b".repeat(64),
	inputs: "c".repeat(64),
	basis: "d".repeat(64),
	releases: "e".repeat(64),
	security: "f".repeat(64),
	policy: "1".repeat(64),
};
const exceptions = BOUNDED_TUPLES.map(([name, version, advisory], index) => ({
	name,
	version,
	advisory,
	source: SOURCE,
	ancestor: String(index + 2).repeat(64),
}));
function fixture() {
	const record = {
		version: 1,
		state: "active",
		gate: "open",
		evidenceKind: "actual-source",
		confirmation: "unchanged-scope",
		binding: { ...binding },
		review: { at: "2026-10-20T13:15:04Z", due: "2026-10-27T13:15:04Z" },
		exceptions: exceptions.map((value) => ({ ...value })),
	};
	const input: EvaluationInput = {
		trustedRecord: record,
		phase: "item",
		startedAt: NOW,
		completedAt: NOW + 1000,
		evidenceObservedAt: NOW,
		binding: { ...binding },
		audit: {
			complete: true,
			fullExit: 1,
			advisoryExit: 1,
			unexpectedErrors: 0,
			findings: exceptions.map((value) => ({ ...value })),
		},
	};
	return { record, input };
}

describe("bounded native dependency policy decisions", () => {
	it("labels an exact allowance without hiding the strict audit exit", () => {
		const { input } = fixture();
		expect(evaluate(input)).toEqual({
			verdict: "pass-with-scoped-exceptions",
			accepted: exceptions,
		});
		expect(input.audit.fullExit).toBe(1);
	});
	it("allows strict pass only after the trusted record explicitly has no exceptions", () => {
		const { input, record } = fixture();
		record.exceptions = [];
		expect(
			evaluate({ ...input, audit: { ...input.audit, fullExit: 0, advisoryExit: 0, findings: [] } }),
		).toEqual({ verdict: "strict-pass", accepted: [] });
		expect(evaluate({ ...input, audit: { ...input.audit, findings: [] } })).toMatchObject({
			reason: "AUDIT_INCOMPLETE",
		});
	});
	it("does not activate the initial research/refusal record", () => {
		const { input } = fixture();
		expect(
			evaluate({
				...input,
				trustedRecord: {
					version: 1,
					state: "refusal-only",
					reason: "ACTUAL_SOURCE_CONFIRMATION_REQUIRED",
				},
			}),
		).toMatchObject({ reason: "ACTUAL_SOURCE_CONFIRMATION_REQUIRED" });
	});
	it.each(["removed", "revoked", "expired", "gate-closed"])(
		"keeps %s terminal in every phase",
		(state) => {
			const { input } = fixture();
			for (const phase of ["item", "m4-gate"] as const) {
				expect(evaluate({ ...input, phase, trustedRecord: { version: 1, state } })).toMatchObject({
					reason: "TERMINAL_STATE",
				});
			}
		},
	);
	it.each([
		{ approved: true },
		{ gate: "closed" },
		{ gate: "unknown" },
		{ evidenceKind: "research" },
		{ confirmation: "pending" },
		{ version: 2 },
		{ state: "unknown" },
		{ review: { at: "2026-10-20T13:15:04Z", due: "2026-11-19T13:15:04Z" } },
		{ review: { at: "2026-02-30T13:15:04Z", due: "2026-10-27T13:15:04Z" } },
		{ review: { at: "2026-10-20T13:15:04Z", due: "2026-10-20T13:15:04Z" } },
	])("refuses malformed authority or widened approval", (change) => {
		const { input, record } = fixture();
		expect(evaluate({ ...input, trustedRecord: { ...record, ...change } })).toMatchObject({
			reason: "AUTHORITY_INVALID",
		});
	});
	it.each(["graph", "lock", "inputs", "basis", "releases", "security", "policy"] as const)(
		"binds fresh %s evidence",
		(key) => {
			const { input } = fixture();
			expect(
				evaluate({ ...input, binding: { ...input.binding, [key]: "0".repeat(64) } }),
			).toMatchObject({ reason: "BINDING_CHANGED" });
		},
	);
	it.each([
		{ version: "0.18.6" },
		{ name: "different" },
		{ advisory: "RUSTSEC-2026-9999" },
		{ source: "git+https://example.invalid/source" },
		{ ancestor: "invalid" },
	])("keeps immutable tuple bounds even when a trusted record and findings agree", (change) => {
		const { input, record } = fixture();
		const changed = { ...record.exceptions[0]!, ...change };
		record.exceptions = [changed];
		expect(evaluate({ ...input, audit: { ...input.audit, findings: [changed] } })).toMatchObject({
			reason: "AUTHORITY_INVALID",
		});
	});
	it("refuses duplicate and expanded exception records", () => {
		const { input, record } = fixture();
		record.exceptions = [record.exceptions[0]!, record.exceptions[0]!];
		expect(
			evaluate({ ...input, audit: { ...input.audit, findings: record.exceptions } }),
		).toMatchObject({ reason: "AUTHORITY_INVALID" });
		record.exceptions = [...exceptions, exceptions[0]!];
		expect(evaluate(input)).toMatchObject({ reason: "AUTHORITY_INVALID" });
	});
	it.each([
		{ version: "0.18.6" },
		{ name: "different" },
		{ advisory: "RUSTSEC-2026-9999" },
		{ source: "git+https://example.invalid/source" },
		{ ancestor: "0".repeat(64) },
	])("refuses changed finding identity and complete ancestry", (change) => {
		const { input } = fixture();
		const findings = input.audit.findings.map((row, index) =>
			index === 0 ? { ...row, ...change } : row,
		);
		expect(evaluate({ ...input, audit: { ...input.audit, findings } })).toMatchObject({
			reason: "FINDINGS_CHANGED",
		});
	});
	it("refuses disappeared, added or duplicate findings", () => {
		const { input } = fixture();
		for (const findings of [
			exceptions.slice(1),
			[...exceptions, exceptions[0]!],
			[...exceptions.slice(1), exceptions[1]!],
		]) {
			expect(evaluate({ ...input, audit: { ...input.audit, findings } })).toMatchObject({
				reason: "FINDINGS_CHANGED",
			});
		}
	});
	it("requires gate-phase zero exceptions before terminal closure too", () => {
		const { input } = fixture();
		expect(evaluate({ ...input, phase: "m4-gate" })).toMatchObject({
			reason: "GATE_EXCEPTIONS_FORBIDDEN",
		});
	});
	it.each([
		{ complete: false },
		{ unexpectedErrors: 1 },
		{ fullExit: 2 },
		{ advisoryExit: -1 },
		{ fullExit: 0 },
		{ advisoryExit: 0 },
	])("preserves complete report and underlying result requirements", (change) => {
		const { input } = fixture();
		expect(evaluate({ ...input, audit: { ...input.audit, ...change } })).toMatchObject({
			reason: "AUDIT_INCOMPLETE",
		});
	});
	it.each([
		{ completedAt: NOW - 1 },
		{ startedAt: Number.NaN },
		{ evidenceObservedAt: NOW + 1001 },
		{ evidenceObservedAt: -1 },
		{ completedAt: Number.POSITIVE_INFINITY },
		{ startedAt: -1 },
	])("refuses clock rollback, future evidence or invalid time", (change) => {
		const { input } = fixture();
		expect(evaluate({ ...input, ...change })).toMatchObject({ reason: "CLOCK_INVALID" });
	});
	it("accepts fresh evidence collected between actual start and completion", () => {
		const { input } = fixture();
		expect(evaluate({ ...input, evidenceObservedAt: NOW + 500 }).verdict).toBe(
			"pass-with-scoped-exceptions",
		);
	});
	it("bounds evidence freshness at completion with no grace", () => {
		const { input } = fixture();
		expect(evaluate({ ...input, completedAt: NOW + HOUR - 1 }).verdict).toBe(
			"pass-with-scoped-exceptions",
		);
		expect(evaluate({ ...input, completedAt: NOW + HOUR })).toMatchObject({
			reason: "EVIDENCE_STALE",
		});
	});
	it("ends the initial review at its exact due instant", () => {
		const { input } = fixture();
		const due = Date.parse("2026-10-27T13:15:04Z");
		expect(
			evaluate({ ...input, startedAt: due - 1, completedAt: due - 1, evidenceObservedAt: due - 1 })
				.verdict,
		).toBe("pass-with-scoped-exceptions");
		expect(
			evaluate({ ...input, startedAt: due - 1, completedAt: due, evidenceObservedAt: due - 1 }),
		).toMatchObject({ reason: "REVIEW_REQUIRED" });
	});
	it.each(BOUNDED_TUPLES.map(([name, , advisory, expiry]) => ({ name, advisory, expiry })))(
		"preserves the immutable $name expiry after a later trusted weekly review",
		({ advisory, expiry }) => {
			const { input, record } = fixture();
			record.exceptions = record.exceptions.filter((row) => row.advisory === advisory);
			record.review = {
				at: new Date(expiry - 24 * HOUR).toISOString().replace(".000Z", "Z"),
				due: new Date(expiry + 24 * HOUR).toISOString().replace(".000Z", "Z"),
			};
			const audit = { ...input.audit, findings: record.exceptions };
			expect(
				evaluate({
					...input,
					audit,
					startedAt: expiry - 1,
					completedAt: expiry - 1,
					evidenceObservedAt: expiry - 1,
				}).verdict,
			).toBe("pass-with-scoped-exceptions");
			expect(
				evaluate({
					...input,
					audit,
					startedAt: expiry - 1,
					completedAt: expiry,
					evidenceObservedAt: expiry - 1,
				}),
			).toMatchObject({ reason: "EXPIRED" });
		},
	);
});

function renewedFixture() {
	const legacy = fixture();
	const record = {
		version: 2,
		state: "active",
		termination: "release-or-validated-fix",
		evidenceKind: legacy.record.evidenceKind,
		confirmation: legacy.record.confirmation,
		binding: legacy.record.binding,
		review: legacy.record.review,
		exceptions: legacy.record.exceptions,
	};
	return { record, input: { ...legacy.input, trustedRecord: record } };
}
const iso = (instant: number) => new Date(instant).toISOString().replace(".000Z", "Z");

describe("explicit release-or-validated-fix policy version", () => {
	it.each(BOUNDED_TUPLES.map(([name, , advisory, expiry]) => ({ name, advisory, expiry })))(
		"keeps only legacy $name bound to its old expiry and gate cutoff",
		({ advisory, expiry }) => {
			for (const version of [1, 2]) {
				const { record, input } = version === 1 ? fixture() : renewedFixture();
				record.exceptions = record.exceptions.filter((row) => row.advisory === advisory);
				record.review = { at: iso(expiry - 24 * HOUR), due: iso(expiry + 24 * HOUR) };
				for (const offset of [-1, 0, 1]) {
					for (const phase of ["item", "m4-gate"] as const) {
						const completedAt = expiry + offset;
						const result = evaluate({
							...input,
							phase,
							startedAt: completedAt,
							completedAt,
							evidenceObservedAt: completedAt,
							audit: { ...input.audit, findings: record.exceptions },
						});
						if (version === 2)
							expect(result).toEqual({
								verdict: "pass-with-scoped-exceptions",
								accepted: record.exceptions,
							});
						else if (offset < 0 && phase === "item")
							expect(result.verdict).toBe("pass-with-scoped-exceptions");
						else
							expect(result).toMatchObject({
								reason: offset >= 0 ? "EXPIRED" : "GATE_EXCEPTIONS_FORBIDDEN",
							});
					}
				}
			}
		},
	);

	it.each(["release-closed", "removed", "revoked"])(
		"keeps delivered v2 %s terminal before collection and in both phases",
		(state) => {
			const { input } = renewedFixture();
			const trustedRecord = { version: 2, state };
			expect(preflightDecision(trustedRecord)).toEqual({
				verdict: "refuse",
				reason: "TERMINAL_STATE",
			});
			for (const phase of ["item", "m4-gate"] as const)
				expect(evaluate({ ...input, phase, trustedRecord })).toEqual({
					verdict: "refuse",
					reason: "TERMINAL_STATE",
				});
		},
	);

	it.each([
		{ termination: undefined },
		{ termination: "never" },
		{ termination: "release" },
		{ gate: "open" },
		{ fixed: true },
		{ released: false },
		{ approved: true },
		{ version: 3 },
	])("requires the exact closed v2 schema without manufactured delivery", (change) => {
		const { record, input } = renewedFixture();
		expect(evaluate({ ...input, trustedRecord: { ...record, ...change } })).toMatchObject({
			reason: "AUTHORITY_INVALID",
		});
	});
	it("does not reinterpret a legacy gate marker as the renewed policy", () => {
		const { record, input } = fixture();
		expect(evaluate({ ...input, trustedRecord: { ...record, version: 2 } })).toMatchObject({
			reason: "AUTHORITY_INVALID",
		});
		for (const state of ["expired", "gate-closed"])
			expect(evaluate({ ...input, trustedRecord: { version: 2, state } })).toMatchObject({
				reason: "AUTHORITY_INVALID",
			});
		expect(
			evaluate({ ...input, trustedRecord: { version: 1, state: "release-closed" } }),
		).toMatchObject({
			reason: "AUTHORITY_INVALID",
		});
	});

	it("retains the first review deadline and never renews it from the policy marker", () => {
		const { record, input } = renewedFixture();
		const due = Date.parse("2026-10-27T13:15:04Z");
		const original = structuredClone(record.review);
		for (const offset of [-1, 0, 1]) {
			const at = due + offset;
			const result = evaluate({ ...input, startedAt: at, completedAt: at, evidenceObservedAt: at });
			if (offset < 0) expect(result.verdict).toBe("pass-with-scoped-exceptions");
			else expect(result).toMatchObject({ reason: "REVIEW_REQUIRED" });
		}
		expect(record.review).toEqual(original);
	});
	it("retains later weekly review bounds and exact completion-time cutoff", () => {
		const { record, input } = renewedFixture();
		const reviewedAt = Date.parse("2026-12-01T00:00:00Z");
		const due = reviewedAt + 7 * 24 * HOUR;
		record.review = { at: iso(reviewedAt), due: iso(due) };
		for (const offset of [-1, 0, 1]) {
			const completedAt = due + offset;
			const result = evaluate({
				...input,
				startedAt: due - 1,
				completedAt,
				evidenceObservedAt: due - 1,
			});
			if (offset < 0) expect(result.verdict).toBe("pass-with-scoped-exceptions");
			else expect(result).toMatchObject({ reason: "REVIEW_REQUIRED" });
		}
		record.review.due = iso(due + 1000);
		expect(
			evaluate({
				...input,
				startedAt: reviewedAt,
				completedAt: reviewedAt,
				evidenceObservedAt: reviewedAt,
			}),
		).toMatchObject({ reason: "AUTHORITY_INVALID" });
	});
	it("refuses a future review even with otherwise fresh renewed evidence", () => {
		const { record, input } = renewedFixture();
		record.review = { at: iso(NOW + 1000), due: iso(NOW + 2000) };
		expect(evaluate(input)).toMatchObject({ reason: "CLOCK_INVALID" });
	});

	it.each(["graph", "lock", "inputs", "basis", "releases", "security", "policy"] as const)(
		"requires review of changed v2 %s, not merely a new observation",
		(key) => {
			const { input } = renewedFixture();
			expect(evaluate({ ...input, binding: { ...binding, [key]: "0".repeat(64) } })).toMatchObject({
				reason: "BINDING_CHANGED",
			});
		},
	);
	it.each([
		{ name: "different" },
		{ version: "0.18.6" },
		{ advisory: "RUSTSEC-2026-9999" },
		{ source: "git+https://example.invalid/source" },
	])("cannot expand immutable tuples even when renewed authority and findings agree", (change) => {
		const { record, input } = renewedFixture();
		const changed = { ...record.exceptions[0]!, ...change };
		record.exceptions = [changed];
		expect(evaluate({ ...input, audit: { ...input.audit, findings: [changed] } })).toMatchObject({
			reason: "AUTHORITY_INVALID",
		});
	});
	it("requires exact actual findings after a trusted subset reduction", () => {
		const { record, input } = renewedFixture();
		record.exceptions = record.exceptions.slice(1);
		expect(evaluate(input)).toMatchObject({ reason: "FINDINGS_CHANGED" });
		expect(evaluate({ ...input, audit: { ...input.audit, findings: record.exceptions } })).toEqual({
			verdict: "pass-with-scoped-exceptions",
			accepted: record.exceptions,
		});
		const changedAncestor = record.exceptions.map((row, index) =>
			index === 0 ? { ...row, ancestor: "0".repeat(64) } : row,
		);
		expect(
			evaluate({ ...input, audit: { ...input.audit, findings: changedAncestor } }),
		).toMatchObject({ reason: "FINDINGS_CHANGED" });
	});
	it("does not turn removed findings or a terminal state into an automatic strict pass", () => {
		const { record, input } = renewedFixture();
		const audit = { ...input.audit, fullExit: 0, advisoryExit: 0, findings: [] };
		expect(evaluate({ ...input, audit })).toMatchObject({ reason: "FINDINGS_CHANGED" });
		record.exceptions = [];
		expect(evaluate({ ...input, audit })).toEqual({ verdict: "strict-pass", accepted: [] });
		expect(
			evaluate({ ...input, audit, trustedRecord: { version: 2, state: "removed" } }),
		).toMatchObject({ reason: "TERMINAL_STATE" });
	});
	it.each([{ complete: false }, { unexpectedErrors: 1 }, { fullExit: 2 }, { advisoryExit: 0 }])(
		"retains full strict audit requirements in v2",
		(change) => {
			const { input } = renewedFixture();
			expect(evaluate({ ...input, audit: { ...input.audit, ...change } })).toMatchObject({
				reason: "AUDIT_INCOMPLETE",
			});
		},
	);
});
