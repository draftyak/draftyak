import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthorityTransport } from "../src/authority.ts";
import { type Binding, BOUNDED_TUPLES, type ScopedFinding } from "../src/decision.ts";
import type { Phase } from "../src/options.ts";
import type { NativeRunContext, ProducedPolicyEvidence } from "../src/runner.ts";

const external = vi.hoisted(() => ({
	request: vi.fn(() => {
		throw Error("unexpected network call in pure policy controls");
	}),
	spawn: vi.fn(() => {
		throw Error("unexpected native call in pure policy controls");
	}),
	execFile: vi.fn(() => {
		throw Error("unexpected native call in pure policy controls");
	}),
}));
vi.mock("node:https", () => ({ request: external.request }));
vi.mock("node:child_process", () => ({ spawn: external.spawn, execFile: external.execFile }));

const { createNativePolicyProducer, runNativePolicy } = await import("../src/runner.ts");
const NOW = Date.parse("2026-12-01T16:00:00Z");
const DUE = NOW + 3_600_000;
const CURRENT = "a".repeat(40);
const CLOSED = "b".repeat(40);
const PHASES: readonly Phase[] = ["item", "m4-gate"];
const BINDING: Binding = {
	graph: "1".repeat(64),
	lock: "2".repeat(64),
	inputs: "3".repeat(64),
	basis: "4".repeat(64),
	releases: "5".repeat(64),
	security: "6".repeat(64),
	policy: "7".repeat(64),
};
const iso = (at: number) => new Date(at).toISOString().replace(".000Z", "Z");
const findings = (): ScopedFinding[] =>
	BOUNDED_TUPLES.map(([name, version, advisory], index) => ({
		name,
		version,
		advisory,
		source: "registry+https://github.com/rust-lang/crates.io-index",
		ancestor: String(index + 2).repeat(64),
	}));

function active(rows = findings()) {
	return {
		version: 2,
		state: "active",
		termination: "release-or-validated-fix",
		evidenceKind: "actual-source",
		confirmation: "unchanged-scope",
		binding: { ...BINDING },
		review: { at: iso(NOW - 60_000), due: iso(DUE) },
		exceptions: rows,
	};
}

function evidence(rows = findings()): ProducedPolicyEvidence {
	const zero = { errors: 0, warnings: 0, notes: 0, helps: 0 };
	return {
		runId: randomUUID(),
		reportDigest: "8".repeat(64),
		binding: { ...BINDING },
		audit: {
			complete: true,
			fullExit: 1,
			advisoryExit: 1,
			unexpectedErrors: 0,
			findings: rows,
			counts: {
				advisories: { ...zero, errors: rows.length },
				bans: { ...zero },
				licenses: { ...zero },
				sources: { ...zero },
			},
		},
		rawExits: { full: { exitCode: 1, signal: null }, advisory: { exitCode: 1, signal: null } },
		evidenceObservedAt: NOW + 1,
		sourceRevisions: {
			database: "c".repeat(40),
			releases: "d".repeat(64),
			security: "e".repeat(64),
		},
		failure: null,
	};
}

function harness(record: unknown, data = evidence(), end = NOW + 20, deliverClosure = false) {
	let revision = CURRENT;
	let clockReads = 0;
	const events: string[] = [];
	const recordRequests: string[] = [];
	const authority: AuthorityTransport = {
		async currentRevision() {
			events.push("authority-current");
			return revision;
		},
		async recordAt(selected) {
			recordRequests.push(selected);
			return Buffer.from(
				JSON.stringify(selected === CLOSED ? { version: 2, state: "release-closed" } : record),
			);
		},
	};
	const collect = vi.fn(async () => {
		events.push("collect");
		return data;
	});
	const revalidate = vi.fn(async (_context: NativeRunContext, sealed: ProducedPolicyEvidence) => {
		events.push("revalidate");
		if (deliverClosure) revision = CLOSED;
		return {
			reportDigest: sealed.reportDigest,
			binding: sealed.binding,
			sourceRevisions: sealed.sourceRevisions,
		};
	});
	const producer = createNativePolicyProducer({ collect, revalidate });
	return {
		collect,
		revalidate,
		events,
		recordRequests,
		data,
		run: (phase: Phase = "item") =>
			runNativePolicy({
				phase,
				authority,
				producer,
				completionClock: () => (clockReads++ === 0 ? NOW : end),
			}),
	};
}

afterEach(() => {
	expect(external.request).not.toHaveBeenCalled();
	expect(external.spawn).not.toHaveBeenCalled();
	expect(external.execFile).not.toHaveBeenCalled();
});

describe("renewed policy lifecycle boundaries", () => {
	it.each(PHASES)("retains the exact v2 allowance past old cutoffs in %s", async (phase) => {
		const f = harness(active());
		const result = await f.run(phase);
		expect(result.exitCode).toBe(0);
		expect(result.output.verdict).toBe("pass-with-scoped-exceptions");
		expect(result.output.accepted).toEqual(findings());
		expect(result.output.rawExits).toEqual(f.data.rawExits);
		expect(result.output.audit?.counts.advisories.errors).toBe(5);
		expect(f.collect).toHaveBeenCalledTimes(1);
	});

	it.each(PHASES)(
		"preflights release closure without calling the producer in %s",
		async (phase) => {
			const f = harness({ version: 2, state: "release-closed" });
			const result = await f.run(phase);
			expect(result.exitCode).toBe(1);
			expect(result.output.reason).toBe("TERMINAL_STATE");
			expect(result.output.runId).toBeNull();
			expect(result.output.audit).toBeNull();
			expect(result.output.rawExits).toBeNull();
			expect(result.output.accepted).toEqual([]);
			expect(f.collect).not.toHaveBeenCalled();
			expect(f.revalidate).not.toHaveBeenCalled();
			expect(f.recordRequests).toEqual([CURRENT]);
		},
	);

	it.each(PHASES)(
		"refuses a terminal revision delivered during revalidation in %s",
		async (phase) => {
			const f = harness(active(), evidence(), NOW + 20, true);
			const result = await f.run(phase);
			expect(result.exitCode).toBe(1);
			expect(result.output.reason).toBe("AUTHORITY_CHANGED");
			expect(result.output.accepted).toEqual([]);
			expect(result.output.audit?.findings).toEqual(findings());
			expect(result.output.rawExits).toEqual(f.data.rawExits);
			expect(f.events).toEqual([
				"authority-current",
				"authority-current",
				"collect",
				"revalidate",
				"authority-current",
			]);
			expect(f.recordRequests).toEqual([CURRENT]);
		},
	);

	it("accepts only the explicitly reviewed remaining subset", async () => {
		const remaining = findings().slice(1);
		const result = await harness(active(remaining), evidence(remaining)).run();
		expect(result.exitCode).toBe(0);
		expect(result.output.verdict).toBe("pass-with-scoped-exceptions");
		expect(result.output.accepted).toEqual(remaining);
		expect(result.output.audit?.counts.advisories.errors).toBe(4);
	});

	it("refuses a removed-row finding without rebuilding the complete tuple set", async () => {
		const remaining = findings().slice(1);
		const result = await harness(active(remaining), evidence()).run();
		expect(result.exitCode).toBe(1);
		expect(result.output.reason).toBe("FINDINGS_CHANGED");
		expect(result.output.accepted).toEqual([]);
		expect(result.output.audit?.findings).toEqual(findings());
		expect(result.output.audit?.counts.advisories.errors).toBe(5);
	});

	it("accepts one millisecond before the retained review deadline", async () => {
		const result = await harness(active(), evidence(), DUE - 1).run();
		expect(result.exitCode).toBe(0);
		expect(result.output.verdict).toBe("pass-with-scoped-exceptions");
	});

	it("refuses exact due equality without refreshing the observation", async () => {
		const result = await harness(active(), evidence(), DUE).run();
		expect(result.exitCode).toBe(1);
		expect(result.output.reason).toBe("REVIEW_REQUIRED");
		expect(result.output.audit?.fullExit).toBe(1);
		expect(result.output.audit?.advisoryExit).toBe(1);
		expect(result.output.accepted).toEqual([]);
	});
});
