import type { Phase } from "./options.ts";

const HOUR = 3_600_000;
const WEEK = 7 * 24 * HOUR;
const FIRST_REVIEW = Date.parse("2026-10-27T13:15:04Z");
const GLIB_EXPIRY = Date.parse("2026-11-03T13:15:04Z");
const OTHER_EXPIRY = Date.parse("2026-11-19T13:15:04Z");
const SOURCE = "registry+https://github.com/rust-lang/crates.io-index";
const DIGEST = /^[a-f0-9]{64}$/;
const BINDING_KEYS = [
	"graph",
	"lock",
	"inputs",
	"basis",
	"releases",
	"security",
	"policy",
] as const;
export type BindingKey = (typeof BINDING_KEYS)[number];
export type Binding = Readonly<Record<BindingKey, string>>;

export const BOUNDED_TUPLES: readonly (readonly [string, string, string, number])[] = [
	["glib", "0.18.5", "RUSTSEC-2024-0429", GLIB_EXPIRY],
	["proc-macro-error", "1.0.4", "RUSTSEC-2024-0370", OTHER_EXPIRY],
	["zvariant", "5.15.1", "RUSTSEC-2026-0370", OTHER_EXPIRY],
	["zbus_names", "4.3.5", "RUSTSEC-2026-0371", OTHER_EXPIRY],
	["zvariant_derive", "5.15.1", "RUSTSEC-2026-0372", OTHER_EXPIRY],
] as const;

export interface ScopedFinding {
	readonly name: string;
	readonly version: string;
	readonly source: string;
	readonly advisory: string;
	readonly ancestor: string;
}
interface ActiveDecision {
	readonly version: 1;
	readonly state: "active";
	readonly gate: "open";
	readonly evidenceKind: "actual-source";
	readonly confirmation: "unchanged-scope";
	readonly binding: Binding;
	readonly review: { readonly at: number; readonly due: number };
	readonly exceptions: readonly ScopedFinding[];
}
type Decision =
	| ActiveDecision
	| {
			readonly version: 1;
			readonly state: "refusal-only" | "removed" | "revoked" | "expired" | "gate-closed";
	  };
export type Reason =
	| "AUTHORITY_INVALID"
	| "ACTUAL_SOURCE_CONFIRMATION_REQUIRED"
	| "TERMINAL_STATE"
	| "CLOCK_INVALID"
	| "REVIEW_REQUIRED"
	| "EXPIRED"
	| "EVIDENCE_STALE"
	| "BINDING_CHANGED"
	| "GATE_EXCEPTIONS_FORBIDDEN"
	| "FINDINGS_CHANGED"
	| "AUDIT_INCOMPLETE";
export type PolicyVerdict =
	| { readonly verdict: "refuse"; readonly reason: Reason }
	| { readonly verdict: "strict-pass"; readonly accepted: readonly [] }
	| {
			readonly verdict: "pass-with-scoped-exceptions";
			readonly accepted: readonly ScopedFinding[];
	  };

class DecisionError extends Error {}
function invalid(): never {
	throw new DecisionError();
}
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return invalid();
	if (Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key)))
		return invalid();
	return value as Record<string, unknown>;
}
function instant(value: unknown): number {
	if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value))
		return invalid();
	const parsed = Date.parse(value);
	if (
		!Number.isSafeInteger(parsed) ||
		new Date(parsed).toISOString() !== value.replace("Z", ".000Z")
	)
		return invalid();
	return parsed;
}
function digest(value: unknown): string {
	if (typeof value !== "string" || !DIGEST.test(value)) return invalid();
	return value;
}
function binding(value: unknown): Binding {
	const input = object(value, BINDING_KEYS);
	return Object.fromEntries(
		BINDING_KEYS.map((key) => [key, digest(input[key])]),
	) as unknown as Binding;
}
function scoped(value: unknown): ScopedFinding {
	const input = object(value, ["name", "version", "source", "advisory", "ancestor"]);
	if (input.source !== SOURCE) return invalid();
	if (
		!BOUNDED_TUPLES.some(
			([name, version, advisory]) =>
				input.name === name && input.version === version && input.advisory === advisory,
		)
	)
		return invalid();
	return {
		name: input.name as string,
		version: input.version as string,
		source: SOURCE,
		advisory: input.advisory as string,
		ancestor: digest(input.ancestor),
	};
}
function identity(row: ScopedFinding): string {
	return JSON.stringify([row.name, row.version, row.source, row.advisory, row.ancestor]);
}
function decision(value: unknown): Decision {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return invalid();
	const state = (value as Record<string, unknown>).state;
	if (state === "refusal-only") {
		const input = object(value, ["version", "state", "reason"]);
		if (input.version !== 1 || input.reason !== "ACTUAL_SOURCE_CONFIRMATION_REQUIRED")
			return invalid();
		return { version: 1, state };
	}
	if (["removed", "revoked", "expired", "gate-closed"].includes(state as string)) {
		const input = object(value, ["version", "state"]);
		if (input.version !== 1) return invalid();
		return { version: 1, state: state as "removed" | "revoked" | "expired" | "gate-closed" };
	}
	const input = object(value, [
		"version",
		"state",
		"gate",
		"evidenceKind",
		"confirmation",
		"binding",
		"review",
		"exceptions",
	]);
	if (
		input.version !== 1 ||
		state !== "active" ||
		input.gate !== "open" ||
		input.evidenceKind !== "actual-source" ||
		input.confirmation !== "unchanged-scope"
	)
		return invalid();
	const review = object(input.review, ["at", "due"]);
	const at = instant(review.at),
		due = instant(review.due);
	if (due <= at || due - at > WEEK) return invalid();
	if (!Array.isArray(input.exceptions) || input.exceptions.length > BOUNDED_TUPLES.length)
		return invalid();
	const exceptions = input.exceptions.map(scoped);
	if (new Set(exceptions.map((row) => row.advisory)).size !== exceptions.length) return invalid();
	return {
		version: 1,
		state: "active",
		gate: "open",
		evidenceKind: "actual-source",
		confirmation: "unchanged-scope",
		binding: binding(input.binding),
		review: { at, due },
		exceptions,
	};
}

export interface EvaluationInput {
	readonly trustedRecord: unknown;
	readonly phase: Phase;
	readonly startedAt: number;
	readonly completedAt: number;
	readonly evidenceObservedAt: number;
	readonly binding: Binding;
	readonly audit: {
		readonly complete: boolean;
		readonly fullExit: number;
		readonly advisoryExit: number;
		readonly unexpectedErrors: number;
		readonly findings: readonly ScopedFinding[];
	};
}

/** Reject unavailable authority states before starting any native producer. */
export function preflightDecision(value: unknown): PolicyVerdict | null {
	try {
		const trusted = decision(value);
		if (trusted.state === "refusal-only")
			return { verdict: "refuse", reason: "ACTUAL_SOURCE_CONFIRMATION_REQUIRED" };
		if (trusted.state !== "active") return { verdict: "refuse", reason: "TERMINAL_STATE" };
		return null;
	} catch {
		return { verdict: "refuse", reason: "AUTHORITY_INVALID" };
	}
}

/** Pure policy logic; production authority and evidence are obtained by the runner. */
export function evaluate(input: EvaluationInput): PolicyVerdict {
	const refuse = (reason: Reason): PolicyVerdict => ({ verdict: "refuse", reason });
	let trusted: Decision;
	try {
		trusted = decision(input.trustedRecord);
	} catch {
		return refuse("AUTHORITY_INVALID");
	}
	if (trusted.state === "refusal-only") return refuse("ACTUAL_SOURCE_CONFIRMATION_REQUIRED");
	if (trusted.state !== "active") return refuse("TERMINAL_STATE");
	const { startedAt, completedAt, evidenceObservedAt, audit } = input;
	if (input.phase !== "item" && input.phase !== "m4-gate") return refuse("AUTHORITY_INVALID");
	if (
		![startedAt, completedAt, evidenceObservedAt].every(Number.isSafeInteger) ||
		startedAt < 0 ||
		completedAt < startedAt ||
		evidenceObservedAt < 0 ||
		evidenceObservedAt > completedAt ||
		trusted.review.at > startedAt
	)
		return refuse("CLOCK_INVALID");
	if (completedAt - evidenceObservedAt >= HOUR) return refuse("EVIDENCE_STALE");
	const reviewDeadline =
		trusted.review.at < FIRST_REVIEW
			? Math.min(FIRST_REVIEW, trusted.review.due)
			: trusted.review.due;
	if (completedAt >= reviewDeadline) return refuse("REVIEW_REQUIRED");
	if (
		BOUNDED_TUPLES.some(
			([, , advisory, expiry]) =>
				trusted.exceptions.some((row) => row.advisory === advisory) && completedAt >= expiry,
		)
	)
		return refuse("EXPIRED");
	if (BINDING_KEYS.some((key) => input.binding[key] !== trusted.binding[key]))
		return refuse("BINDING_CHANGED");
	if (
		audit.complete !== true ||
		audit.unexpectedErrors !== 0 ||
		![0, 1].includes(audit.fullExit) ||
		![0, 1].includes(audit.advisoryExit)
	)
		return refuse("AUDIT_INCOMPLETE");
	if (input.phase === "m4-gate" && (trusted.exceptions.length > 0 || audit.findings.length > 0))
		return refuse("GATE_EXCEPTIONS_FORBIDDEN");
	const actual = audit.findings.map(identity).sort();
	const expected = trusted.exceptions.map(identity).sort();
	if (actual.length !== expected.length || actual.some((row, index) => row !== expected[index]))
		return refuse("FINDINGS_CHANGED");
	if (actual.length === 0) {
		if (audit.fullExit !== 0 || audit.advisoryExit !== 0) return refuse("AUDIT_INCOMPLETE");
		return { verdict: "strict-pass", accepted: [] };
	}
	if (audit.fullExit !== 1 || audit.advisoryExit !== 1) return refuse("AUDIT_INCOMPLETE");
	return { verdict: "pass-with-scoped-exceptions", accepted: [...trusted.exceptions] };
}
