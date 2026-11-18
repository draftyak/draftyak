import type { PluginErrorResult } from "@draftyak/protocol/errors";
import { describe, expect, it } from "vitest";
import {
	completeGmailPolling,
	type GmailPollingCompletion,
	type GmailPollingCompletionOutcome,
} from "../../src/channels/gmail/completion.ts";
import {
	advanceGmailPolling,
	createGmailPollingState,
	type GmailPollingSnapshot,
	type GmailPollingTransition,
	restoreGmailPollingState,
} from "../../src/channels/gmail/polling.ts";
import type { GmailPollRetryOptions } from "../../src/channels/gmail/retry.ts";

const invalid = "Invalid Gmail polling completion input";

/** Validated ordinary cadence DATA, without a scope or terminal-proof grant. */
function running(attempt = 1, startedAtMs = 30_000, deliverByMs?: number): GmailPollingSnapshot {
	return restoreGmailPollingState({
		version: 1,
		revision: attempt,
		attempt,
		...(deliverByMs === undefined ? {} : { deliverByMs }),
		phase: "running",
		active: { runRevision: attempt, attempt, startedAtMs },
	});
}

function report(
	snapshot: GmailPollingSnapshot,
	outcome: GmailPollingCompletionOutcome,
	nowMs = 40_000,
): GmailPollingCompletion {
	if (snapshot.phase !== "running" && snapshot.phase !== "uncertain") {
		throw new Error("Expected active DATA");
	}
	return {
		runRevision: snapshot.active.runRevision,
		attempt: snapshot.active.attempt,
		nowMs,
		outcome,
	};
}

function error(
	code: PluginErrorResult["code"],
	retryAfterMs?: number,
): GmailPollingCompletionOutcome {
	return { kind: "error", error: { code, retryAfterMs } };
}

function next(transition: GmailPollingTransition): GmailPollingSnapshot {
	expect(transition.kind).toBe("update");
	if (transition.kind !== "update") throw new Error("Expected a DATA update");
	return transition.nextSnapshot;
}

function refused(action: () => unknown): void {
	try {
		action();
		throw new Error("Expected completion refusal");
	} catch (caught) {
		expect(caught).toBeInstanceOf(TypeError);
		if (!(caught instanceof TypeError)) throw caught;
		expect(caught.message).toBe(invalid);
		expect(Object.hasOwn(caught, "cause")).toBe(false);
		expect(Object.hasOwn(caught, "reason")).toBe(false);
	}
}

function counted(
	values: Record<string, unknown>,
	reads: Record<string, number>,
): Record<string, unknown> {
	const result: Record<string, unknown> = {};
	for (const key of Object.keys(values)) {
		Object.defineProperty(result, key, {
			enumerable: true,
			get() {
				const count = (reads[key] ?? 0) + 1;
				reads[key] = count;
				if (count > 1) throw new Error("Repeated DATA getter read");
				return values[key];
			},
		});
	}
	return result;
}

describe("Gmail polling completion DATA", () => {
	it("maps matching success through actual cadence and resets its failure attempt", () => {
		const snapshot = running(3);
		const completion = report(snapshot, { kind: "success" });
		const transition = completeGmailPolling(snapshot, completion);
		expect(transition).toEqual(
			advanceGmailPolling(snapshot, {
				kind: "complete",
				runRevision: completion.runRevision,
				attempt: completion.attempt,
				nowMs: completion.nowMs,
				outcome: { kind: "success" },
			}),
		);
		expect(next(transition)).toMatchObject({
			phase: "waiting",
			revision: 4,
			attempt: 0,
			nextDueMs: 70_000,
		});
	});

	it("maps TRANSIENT through actual retry policy without inferring cancellation", () => {
		const snapshot = running();
		const result = next(completeGmailPolling(snapshot, report(snapshot, error("TRANSIENT"))));
		expect(result).toMatchObject({
			phase: "waiting",
			revision: 2,
			attempt: 1,
			nextDueMs: 70_000,
		});
		expect(Object.hasOwn(result, "reason")).toBe(false);
	});

	it("retains a provider lower bound beyond the configured backoff cap", () => {
		const snapshot = running();
		const result = next(
			completeGmailPolling(snapshot, report(snapshot, error("RATE_LIMITED", 2_000_000)), {
				maxBackoffMs: 30_000,
			}),
		);
		expect(result).toMatchObject({ phase: "waiting", attempt: 1, nextDueMs: 2_040_000 });
		expect(restoreGmailPollingState(result)).toEqual(result);
	});

	it("anchors exponential retry after the recorded start when completion clocks roll back", () => {
		const snapshot = running(3, 100_000);
		const result = next(
			completeGmailPolling(snapshot, report(snapshot, error("TRANSIENT"), 10_000)),
		);
		expect(result).toMatchObject({ phase: "waiting", revision: 4, attempt: 3, nextDueMs: 220_000 });
	});

	it("anchors the entire provider delay under rollback rather than only clamping cadence", () => {
		const snapshot = running(1, 100_000);
		const result = next(
			completeGmailPolling(snapshot, report(snapshot, error("RATE_LIMITED", 90_000), 10_000)),
		);
		expect(result).toMatchObject({ phase: "waiting", nextDueMs: 190_000 });
	});

	it("maps quota and permanent errors to policy-stop without a retry", () => {
		for (const code of [
			"QUOTA_EXCEEDED",
			"AUTH_EXPIRED",
			"CURSOR_EXPIRED",
			"SEND_UNCERTAIN",
		] as const) {
			const snapshot = running();
			expect(next(completeGmailPolling(snapshot, report(snapshot, error(code))))).toMatchObject({
				phase: "stopped",
				reason: "policy-stop",
				attempt: 1,
				revision: 2,
			});
		}
	});

	it("uses the active attempt for the real total-attempt cap and configured limits", () => {
		const exhausted = running(8);
		expect(
			next(completeGmailPolling(exhausted, report(exhausted, error("TRANSIENT")))),
		).toMatchObject({
			phase: "stopped",
			reason: "policy-stop",
			attempt: 8,
			revision: 9,
		});
		const snapshot = running(2);
		expect(
			next(
				completeGmailPolling(snapshot, report(snapshot, error("TRANSIENT")), { maxAttempts: 2 }),
			),
		).toMatchObject({
			phase: "stopped",
			reason: "policy-stop",
			attempt: 2,
		});
		expect(
			next(
				completeGmailPolling(snapshot, report(snapshot, error("TRANSIENT")), { maxAttempts: 3 }),
			),
		).toMatchObject({
			phase: "waiting",
			attempt: 2,
			nextDueMs: 100_000,
		});
	});

	it("keeps a future retry-policy deadline stop distinct from an observed cadence deadline", () => {
		const snapshot = running(1, 30_000, 100_000);
		expect(
			next(completeGmailPolling(snapshot, report(snapshot, error("RATE_LIMITED", 60_000)))),
		).toMatchObject({
			phase: "stopped",
			reason: "policy-stop",
			deliverByMs: 100_000,
		});
	});

	it("preserves the real cadence deadline when its minimum next interval crosses it", () => {
		const snapshot = running(1, 100_000, 120_000);
		expect(
			next(completeGmailPolling(snapshot, report(snapshot, { kind: "success" }, 10_000))),
		).toMatchObject({
			phase: "stopped",
			reason: "deadline",
			deliverByMs: 120_000,
			attempt: 0,
		});
	});

	it("finalizes cancellation and deadline latches under rollback without inspecting an unused outcome", () => {
		const initial = running(1, 30_000, 100_000);
		const cancelled = next(advanceGmailPolling(initial, { kind: "cancel" }));
		const deadline = next(advanceGmailPolling(initial, { kind: "tick", nowMs: 100_000 }));
		for (const snapshot of [cancelled, deadline]) {
			let reads = 0;
			const completion = Object.defineProperty(
				{ runRevision: 1, attempt: 1, nowMs: 1 },
				"outcome",
				{
					get() {
						reads++;
						throw new Error("Unused latched outcome");
					},
				},
			) as GmailPollingCompletion;
			const result = next(completeGmailPolling(snapshot, completion));
			expect(result).toMatchObject({ phase: "stopped", revision: 3 });
			if (snapshot.phase !== "running") throw new Error("Expected latched active DATA");
			expect(result.phase === "stopped" && result.reason).toBe(snapshot.stopReason);
			expect(reads).toBe(0);
		}
	});

	it("lets an actually observed deadline win before an invalid provider outcome", () => {
		const snapshot = running(1, 30_000, 100_000);
		const completion = Object.defineProperty(
			{ runRevision: 1, attempt: 1, nowMs: 100_000 },
			"outcome",
			{
				get() {
					throw new Error("Unused expired outcome");
				},
			},
		) as GmailPollingCompletion;
		expect(next(completeGmailPolling(snapshot, completion))).toMatchObject({
			phase: "stopped",
			reason: "deadline",
		});
	});

	it("correlates an uncertain completion with active run tags rather than the snapshot revision", () => {
		const snapshot = restoreGmailPollingState({
			version: 1,
			revision: 5,
			attempt: 1,
			phase: "uncertain",
			active: { runRevision: 2, attempt: 1, startedAtMs: 30_000 },
		});
		const transition = completeGmailPolling(
			snapshot,
			report(snapshot, { kind: "success" }, 50_000),
		);
		expect(transition).toMatchObject({
			kind: "update",
			expectedRevision: 5,
			nextSnapshot: { phase: "waiting", revision: 6, attempt: 0, nextDueMs: 80_000 },
		});
	});

	it("ignores stale and inactive completions before time, outcome or option getters", () => {
		const active = running();
		const cases = [
			{ snapshot: createGmailPollingState(0), runRevision: 1, attempt: 1 },
			{
				snapshot: next(advanceGmailPolling(createGmailPollingState(0), { kind: "cancel" })),
				runRevision: 1,
				attempt: 1,
			},
			{ snapshot: active, runRevision: 2, attempt: 1 },
			{ snapshot: active, runRevision: 1, attempt: 2 },
		];
		for (const value of cases) {
			let unusedReads = 0;
			const poison = () => {
				unusedReads++;
				throw new Error("Unrelated completion DATA");
			};
			const completion = Object.defineProperties(
				{ runRevision: value.runRevision, attempt: value.attempt },
				{
					nowMs: { get: poison },
					outcome: { get: poison },
				},
			) as GmailPollingCompletion;
			const options = Object.defineProperties(
				{},
				{ maxAttempts: { get: poison }, maxBackoffMs: { get: poison } },
			);
			const transition = completeGmailPolling(value.snapshot, completion, options);
			expect(transition).toEqual({ kind: "unchanged", reason: "stale", snapshot: value.snapshot });
			if (transition.kind !== "unchanged") throw new Error("Expected unchanged DATA");
			expect(Object.isFrozen(transition)).toBe(true);
			expect(Object.isFrozen(transition.snapshot)).toBe(true);
			expect(unusedReads).toBe(0);
		}
	});

	it("ignores a replay after the previous completion has already left the run", () => {
		const snapshot = running();
		const completed = next(completeGmailPolling(snapshot, report(snapshot, { kind: "success" })));
		const replay = Object.defineProperty({ runRevision: 1, attempt: 1, nowMs: 40_000 }, "outcome", {
			get() {
				throw new Error("Unused replay outcome");
			},
		}) as GmailPollingCompletion;
		expect(completeGmailPolling(completed, replay)).toEqual({
			kind: "unchanged",
			reason: "stale",
			snapshot: completed,
		});
	});

	it("does not inspect provider errors or retry options on success", () => {
		const snapshot = running();
		const outcome = Object.defineProperty({ kind: "success" }, "error", {
			get() {
				throw new Error("Unused success error");
			},
		}) as GmailPollingCompletionOutcome;
		const options = Object.defineProperty({}, "maxAttempts", {
			get() {
				throw new Error("Unused success retry options");
			},
		});
		expect(next(completeGmailPolling(snapshot, report(snapshot, outcome), options))).toMatchObject({
			phase: "waiting",
			attempt: 0,
		});
	});

	it("captures caller snapshot, completion, normalized error and option getters once", () => {
		const runReads: Record<string, number> = {};
		const snapshotReads: Record<string, number> = {};
		const completionReads: Record<string, number> = {};
		const outcomeReads: Record<string, number> = {};
		const errorReads: Record<string, number> = {};
		const optionReads: Record<string, number> = {};
		const run = counted({ runRevision: 2, attempt: 2, startedAtMs: 30_000 }, runReads);
		const snapshot = counted(
			{ version: 1, revision: 2, attempt: 2, phase: "running", active: run },
			snapshotReads,
		);
		const normalized = counted({ code: "RATE_LIMITED", retryAfterMs: 50_000 }, errorReads);
		let detailReads = 0;
		for (const name of ["detail", "cause"])
			Object.defineProperty(normalized, name, {
				enumerable: true,
				get() {
					detailReads++;
					throw new Error("Unused error detail");
				},
			});
		const outcome = counted({ kind: "error", error: normalized }, outcomeReads);
		const completion = counted(
			{ runRevision: 2, attempt: 2, nowMs: 40_000, outcome },
			completionReads,
		);
		const options = counted({ maxAttempts: 8, maxBackoffMs: 30_000 }, optionReads);
		expect(
			next(
				completeGmailPolling(
					snapshot as unknown as GmailPollingSnapshot,
					completion as unknown as GmailPollingCompletion,
					options as GmailPollRetryOptions,
				),
			),
		).toMatchObject({ nextDueMs: 90_000 });
		for (const reads of [
			runReads,
			snapshotReads,
			completionReads,
			outcomeReads,
			errorReads,
			optionReads,
		]) {
			expect(Object.values(reads).every((count) => count === 1)).toBe(true);
			expect(Object.keys(reads).length).toBeGreaterThan(0);
		}
		expect(detailReads).toBe(0);
	});

	it("leaves valid caller DATA unfrozen and unmodified while returning frozen transitions", () => {
		const snapshot = structuredClone(running());
		const completion = report(snapshot, error("TRANSIENT"));
		const options = { maxAttempts: 3 };
		const before = structuredClone({ snapshot, completion, options });
		const result = completeGmailPolling(snapshot, completion, options);
		expect({ snapshot, completion, options }).toEqual(before);
		for (const value of [snapshot, completion, completion.outcome, options])
			expect(Object.isFrozen(value)).toBe(false);
		expect(Object.isFrozen(result)).toBe(true);
		expect(Object.isFrozen(next(result))).toBe(true);
	});

	it("keeps stale MAX revision DATA readable without increment or provider inspection", () => {
		const snapshot = restoreGmailPollingState({
			version: 1,
			revision: Number.MAX_SAFE_INTEGER,
			attempt: 0,
			phase: "waiting",
			nextDueMs: 30_000,
		});
		const completion = Object.defineProperty(
			{ runRevision: 1, attempt: 1, nowMs: 40_000 },
			"outcome",
			{
				get() {
					throw new Error("Unused MAX stale outcome");
				},
			},
		) as GmailPollingCompletion;
		expect(completeGmailPolling(snapshot, completion)).toEqual({
			kind: "unchanged",
			reason: "stale",
			snapshot,
		});
	});

	it("sanitizes matching revision overflow without changing the original snapshot", () => {
		const snapshot = restoreGmailPollingState({
			version: 1,
			revision: Number.MAX_SAFE_INTEGER,
			attempt: 1,
			phase: "running",
			active: { runRevision: 1, attempt: 1, startedAtMs: 30_000 },
		});
		refused(() => completeGmailPolling(snapshot, report(snapshot, { kind: "success" })));
		expect(snapshot.revision).toBe(Number.MAX_SAFE_INTEGER);
		expect(snapshot.phase).toBe("running");
	});

	it("sanitizes unsafe time arithmetic from the real retry policy", () => {
		const snapshot = running(1, Number.MAX_SAFE_INTEGER - 1);
		refused(() =>
			completeGmailPolling(
				snapshot,
				report(snapshot, error("TRANSIENT"), Number.MAX_SAFE_INTEGER - 1),
			),
		);
		expect(snapshot.revision).toBe(1);
	});

	it("refuses malformed identity, matching time, outcome, error and option DATA", () => {
		const snapshot = running();
		const valid = report(snapshot, error("TRANSIENT"));
		for (const field of ["runRevision", "attempt", "nowMs"] as const)
			for (const value of [undefined, null, "1", -1, 0.5, NaN, Infinity, 2 ** 53]) {
				refused(() =>
					completeGmailPolling(snapshot, { ...valid, [field]: value } as GmailPollingCompletion),
				);
			}
		for (const outcome of [
			null,
			[],
			{ kind: "other" },
			{ kind: "error", error: null },
			{ kind: "error", error: { code: "unknown" } },
			{ kind: "error", error: { code: "TRANSIENT", retryAfterMs: -1 } },
		]) {
			refused(() =>
				completeGmailPolling(snapshot, { ...valid, outcome } as GmailPollingCompletion),
			);
		}
		for (const options of [{ maxAttempts: 0 }, { maxAttempts: 33 }, { maxBackoffMs: 29_999 }]) {
			refused(() => completeGmailPolling(snapshot, valid, options));
		}
	});

	it("sanitizes caller getter failures without retaining their original reason", () => {
		const snapshot = running();
		const original = new Error("discard-this-synthetic-completion-reason");
		const completion = Object.defineProperty(
			{ runRevision: 1, attempt: 1, nowMs: 40_000 },
			"outcome",
			{
				get() {
					throw original;
				},
			},
		) as GmailPollingCompletion;
		refused(() => completeGmailPolling(snapshot, completion));
		const normalized = Object.defineProperty({}, "code", {
			get() {
				throw original;
			},
		});
		refused(() =>
			completeGmailPolling(
				snapshot,
				report(snapshot, { kind: "error", error: normalized } as GmailPollingCompletionOutcome),
			),
		);
		refused(() =>
			completeGmailPolling({ ...snapshot, revision: -1 }, report(snapshot, { kind: "success" })),
		);
	});
});
