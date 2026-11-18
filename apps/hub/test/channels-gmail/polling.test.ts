import { describe, expect, it } from "vitest";
import {
	advanceGmailPolling,
	createGmailPollingState,
	type GmailPollingEvent,
	type GmailPollingOutcome,
	type GmailPollingSnapshot,
	type GmailPollingTransition,
	restoreGmailPollingState,
} from "../../src/channels/gmail/polling.ts";

const invalidMessage = "Invalid Gmail polling state input";

function changed(transition: GmailPollingTransition): GmailPollingSnapshot {
	expect(transition.kind).toBe("update");
	if (transition.kind !== "update") throw new Error("Expected polling transition");
	return transition.nextSnapshot;
}

function started(nowMs = 30_000, deliverByMs?: number): GmailPollingSnapshot {
	return changed(
		advanceGmailPolling(createGmailPollingState(0, deliverByMs), { kind: "tick", nowMs }),
	);
}

function complete(
	state: GmailPollingSnapshot,
	nowMs: number,
	outcome: GmailPollingOutcome,
): GmailPollingSnapshot {
	if (state.phase !== "running" && state.phase !== "uncertain") {
		throw new Error("Expected unresolved polling state");
	}
	return changed(
		advanceGmailPolling(state, {
			kind: "complete",
			runRevision: state.active.runRevision,
			attempt: state.active.attempt,
			nowMs,
			outcome,
		}),
	);
}

function invalid(state: unknown, event: unknown): void {
	expect(() =>
		advanceGmailPolling(state as GmailPollingSnapshot, event as GmailPollingEvent),
	).toThrowError(new TypeError(invalidMessage));
}

describe("Gmail polling cadence journal DATA", () => {
	it("creates revision zero and maps the first due start to failed-attempt ordinal one", () => {
		const initial = createGmailPollingState(1_000);
		expect(initial).toEqual({
			version: 1,
			revision: 0,
			attempt: 0,
			phase: "waiting",
			nextDueMs: 31_000,
		});
		expect(advanceGmailPolling(initial, { kind: "tick", nowMs: 30_999 })).toEqual({
			kind: "unchanged",
			reason: "not-due",
			snapshot: initial,
		});
		const plan = advanceGmailPolling(initial, { kind: "tick", nowMs: 31_000 });
		expect(plan).toEqual({
			kind: "update",
			expectedRevision: 0,
			nextSnapshot: {
				version: 1,
				revision: 1,
				attempt: 1,
				phase: "running",
				active: { runRevision: 1, attempt: 1, startedAtMs: 31_000 },
			},
		});
	});

	it("emits one late start and no overlapping replacement or catch-up burst", () => {
		const running = started(1_000_000);
		expect(running.attempt).toBe(1);
		expect(advanceGmailPolling(running, { kind: "tick", nowMs: 2_000_000 })).toEqual({
			kind: "unchanged",
			reason: "active",
			snapshot: running,
		});
		const next = complete(running, 1_000_500, { kind: "success" });
		expect(next).toMatchObject({ phase: "waiting", nextDueMs: 1_030_500, attempt: 0 });
		expect(advanceGmailPolling(next, { kind: "tick", nowMs: 1_000_501 }).kind).toBe("unchanged");
	});

	it("preserves a future retry lower bound across restore and honors its exact due boundary", () => {
		const retry = complete(started(), 40_000, { kind: "retry", notBeforeMs: 250_000 });
		expect(retry).toMatchObject({ phase: "waiting", nextDueMs: 250_000, attempt: 1 });
		const restored = restoreGmailPollingState(JSON.parse(JSON.stringify(retry)));
		for (const nowMs of [90_000, 200_000, 249_999]) {
			expect(advanceGmailPolling(restored, { kind: "tick", nowMs })).toEqual({
				kind: "unchanged",
				reason: "not-due",
				snapshot: retry,
			});
		}
		const next = changed(advanceGmailPolling(restored, { kind: "tick", nowMs: 250_000 }));
		expect(next).toMatchObject({
			phase: "running",
			attempt: 2,
			active: { attempt: 2, startedAtMs: 250_000 },
		});
	});

	it("waits later than an earlier supplied retry bound rather than rejecting or shortening the cadence", () => {
		const next = complete(started(), 40_000, { kind: "retry", notBeforeMs: 1_000 });
		expect(next).toMatchObject({ phase: "waiting", nextDueMs: 70_000, attempt: 1 });
	});

	it("retains recorded due times during clock rollback and anchors completion after the recorded start", () => {
		const waiting = restoreGmailPollingState(createGmailPollingState(100_000));
		for (const nowMs of [90_000, 100_000, 120_000]) {
			expect(advanceGmailPolling(waiting, { kind: "tick", nowMs })).toEqual({
				kind: "unchanged",
				reason: "not-due",
				snapshot: waiting,
			});
		}
		const running = changed(advanceGmailPolling(waiting, { kind: "tick", nowMs: 130_000 }));
		expect(complete(running, 90_000, { kind: "success" })).toMatchObject({ nextDueMs: 160_000 });
		expect(complete(running, 90_000, { kind: "retry", notBeforeMs: 80_000 })).toMatchObject({
			nextDueMs: 160_000,
		});
	});

	it("increments attempts only on starts and starts a new retry series after success", () => {
		const first = started();
		const retry = complete(first, 40_000, { kind: "retry", notBeforeMs: 70_000 });
		const second = changed(advanceGmailPolling(retry, { kind: "tick", nowMs: 70_000 }));
		expect(second.attempt).toBe(2);
		const afterSuccess = complete(second, 75_000, { kind: "success" });
		expect(afterSuccess.attempt).toBe(0);
		const newSeries = changed(advanceGmailPolling(afterSuccess, { kind: "tick", nowMs: 105_000 }));
		expect(newSeries).toMatchObject({ attempt: 1, active: { attempt: 1 } });
	});

	it("returns competing revision plans without claiming either was durably committed", () => {
		const initial = createGmailPollingState(0);
		const a = advanceGmailPolling(initial, { kind: "tick", nowMs: 30_000 });
		const b = advanceGmailPolling(restoreGmailPollingState(initial), {
			kind: "tick",
			nowMs: 30_000,
		});
		expect(a).toEqual(b);
		expect(a).toMatchObject({ kind: "update", expectedRevision: 0 });
		expect(initial).toMatchObject({ revision: 0, attempt: 0, phase: "waiting" });
	});

	it("cancels waiting work permanently without creating an operation", () => {
		const cancelled = changed(advanceGmailPolling(createGmailPollingState(0), { kind: "cancel" }));
		expect(cancelled).toMatchObject({ phase: "stopped", reason: "cancelled", attempt: 0 });
		for (const event of [{ kind: "cancel" }, { kind: "tick", nowMs: 1_000_000 }] as const) {
			expect(advanceGmailPolling(cancelled, event)).toEqual({
				kind: "unchanged",
				reason: "stopped",
				snapshot: cancelled,
			});
		}
	});

	it("latches active cancellation without retiring or replacing unresolved work", () => {
		const running = started(30_000, 200_000);
		const cancelled = changed(advanceGmailPolling(running, { kind: "cancel" }));
		expect(cancelled).toMatchObject({
			phase: "running",
			stopReason: "cancelled",
			deliverByMs: 200_000,
			active: { runRevision: 1, attempt: 1, startedAtMs: 30_000 },
		});
		for (const event of [{ kind: "cancel" }, { kind: "tick", nowMs: 300_000 }] as const) {
			expect(advanceGmailPolling(cancelled, event)).toMatchObject({
				kind: "unchanged",
				snapshot: cancelled,
			});
		}
		const uncertain = changed(
			advanceGmailPolling(cancelled, { kind: "uncertain", runRevision: 1, attempt: 1 }),
		);
		expect(uncertain).toMatchObject({
			phase: "uncertain",
			stopReason: "cancelled",
			active: { runRevision: 1, attempt: 1, startedAtMs: 30_000 },
		});
		expect(complete(uncertain, 40_000, { kind: "success" })).toMatchObject({
			phase: "stopped",
			reason: "cancelled",
		});
	});

	it("latches an active deadline while retaining the original run and deadline through rollback", () => {
		const running = started(30_000, 200_000);
		const fenced = changed(advanceGmailPolling(running, { kind: "tick", nowMs: 200_000 }));
		expect(fenced).toMatchObject({
			phase: "running",
			stopReason: "deadline",
			deliverByMs: 200_000,
			active: { runRevision: 1, attempt: 1, startedAtMs: 30_000 },
		});
		expect(advanceGmailPolling(fenced, { kind: "tick", nowMs: 200_001 })).toMatchObject({
			kind: "unchanged",
			snapshot: fenced,
		});
		expect(advanceGmailPolling(fenced, { kind: "cancel" })).toMatchObject({ snapshot: fenced });
		expect(complete(fenced, 40_000, { kind: "success" })).toMatchObject({
			phase: "stopped",
			reason: "deadline",
			deliverByMs: 200_000,
		});
	});

	it("restores running and uncertain work without fabricating retirement", () => {
		const running = started();
		const uncertain = changed(
			advanceGmailPolling(running, { kind: "uncertain", runRevision: 1, attempt: 1 }),
		);
		for (const state of [running, uncertain]) {
			const restored = restoreGmailPollingState(JSON.parse(JSON.stringify(state)));
			expect(restored).toEqual(state);
			expect(advanceGmailPolling(restored, { kind: "tick", nowMs: 1_000_000 })).toMatchObject({
				kind: "unchanged",
				snapshot: state,
			});
			expect(Object.isFrozen(restored)).toBe(true);
			if (restored.phase === "running" || restored.phase === "uncertain") {
				expect(Object.isFrozen(restored.active)).toBe(true);
			}
		}
		expect(complete(uncertain, 40_000, { kind: "success" })).toMatchObject({
			phase: "waiting",
			nextDueMs: 70_000,
		});
	});

	it("ignores all fields of stale completion for another run, even beyond the original deadline", () => {
		const running = started(30_000, 200_000);
		for (const event of [
			{
				kind: "complete",
				runRevision: 2,
				attempt: 1,
				nowMs: 500_000,
				outcome: { kind: "success" },
			},
			{ kind: "complete", runRevision: 1, attempt: 2, nowMs: 500_000, outcome: { kind: "stop" } },
			{ kind: "uncertain", runRevision: 2, attempt: 1 },
		] as const) {
			expect(advanceGmailPolling(running, event)).toEqual({
				kind: "unchanged",
				reason: "stale",
				snapshot: running,
			});
		}
	});

	it("ignores replayed completion after the first accepted outcome without moving any state field", () => {
		const running = started(30_000, 200_000);
		const next = complete(running, 40_000, { kind: "success" });
		for (const outcome of [
			{ kind: "success" },
			{ kind: "stop" },
			{ kind: "retry", notBeforeMs: 1 },
		] as const) {
			expect(
				advanceGmailPolling(next, {
					kind: "complete",
					runRevision: 1,
					attempt: 1,
					nowMs: 500_000,
					outcome,
				}),
			).toEqual({ kind: "unchanged", reason: "stale", snapshot: next });
		}
		const second = changed(advanceGmailPolling(next, { kind: "tick", nowMs: 70_000 }));
		expect(
			advanceGmailPolling(second, {
				kind: "complete",
				runRevision: 1,
				attempt: 1,
				nowMs: 80_000,
				outcome: { kind: "stop" },
			}),
		).toEqual({ kind: "unchanged", reason: "stale", snapshot: second });
	});

	it("accepts a supplied policy stop without interpreting provider errors", () => {
		expect(complete(started(), 40_000, { kind: "stop" })).toMatchObject({
			phase: "stopped",
			reason: "policy-stop",
			attempt: 1,
		});
	});

	it("never schedules normal cadence or a supplied retry at or after the original deadline", () => {
		for (const deadline of [0, 29_999, 30_000]) {
			expect(createGmailPollingState(0, deadline)).toMatchObject({
				phase: "stopped",
				reason: "deadline",
			});
		}
		for (const outcome of [{ kind: "success" }, { kind: "retry", notBeforeMs: 70_000 }] as const) {
			expect(complete(started(30_000, 70_000), 40_000, outcome)).toMatchObject({
				phase: "stopped",
				reason: "deadline",
				deliverByMs: 70_000,
			});
		}
		expect(complete(started(30_000, 70_001), 40_000, { kind: "success" })).toMatchObject({
			phase: "waiting",
			nextDueMs: 70_000,
			deliverByMs: 70_001,
		});
		expect(complete(started(30_000, 70_000), 70_000, { kind: "success" })).toMatchObject({
			phase: "stopped",
			reason: "deadline",
		});
	});

	it("checks timestamp addition and preserves an exact maximum supplied future bound", () => {
		const max = Number.MAX_SAFE_INTEGER;
		expect(createGmailPollingState(max - 30_000)).toMatchObject({ nextDueMs: max });
		expect(() => createGmailPollingState(max - 29_999)).toThrowError(new TypeError(invalidMessage));
		const waiting = complete(started(), 40_000, { kind: "retry", notBeforeMs: max });
		expect(restoreGmailPollingState(waiting)).toMatchObject({ nextDueMs: max });
		const running = changed(advanceGmailPolling(waiting, { kind: "tick", nowMs: max }));
		const before = JSON.stringify(running);
		if (running.phase !== "running") throw new Error("Expected running state");
		invalid(running, {
			kind: "complete",
			runRevision: running.active.runRevision,
			attempt: running.active.attempt,
			nowMs: max,
			outcome: { kind: "success" },
		});
		expect(JSON.stringify(running)).toBe(before);
	});

	it("checks revision and attempt increments without wrapping or changing the supplied state", () => {
		const initial = createGmailPollingState(0);
		for (const state of [
			{ ...initial, revision: Number.MAX_SAFE_INTEGER },
			{ ...initial, attempt: Number.MAX_SAFE_INTEGER },
		]) {
			const before = JSON.stringify(state);
			invalid(state, { kind: "tick", nowMs: 30_000 });
			expect(JSON.stringify(state)).toBe(before);
		}
		const near = { ...initial, revision: Number.MAX_SAFE_INTEGER - 1 };
		const running = changed(advanceGmailPolling(near, { kind: "tick", nowMs: 30_000 }));
		expect(running.revision).toBe(Number.MAX_SAFE_INTEGER);
		invalid(running, { kind: "uncertain", runRevision: Number.MAX_SAFE_INTEGER, attempt: 1 });
	});

	it("copies and freezes returned snapshots without freezing caller objects or reading fields twice", () => {
		function tracked(values: Record<string, unknown>): {
			value: object;
			reads: Record<string, number>;
		} {
			const value = {};
			const reads: Record<string, number> = {};
			for (const key of Object.keys(values)) {
				Object.defineProperty(value, key, {
					enumerable: true,
					get: () => {
						reads[key] = (reads[key] ?? 0) + 1;
						return values[key];
					},
				});
			}
			return { value, reads };
		}
		const active = tracked({ runRevision: 1, attempt: 1, startedAtMs: 30_000 });
		const source = tracked({
			version: 1,
			revision: 1,
			attempt: 1,
			phase: "running",
			active: active.value,
			deliverByMs: 500_000,
		});
		const suppliedOutcome = tracked({ kind: "retry", notBeforeMs: 250_000 });
		const suppliedEvent = tracked({
			kind: "complete",
			runRevision: 1,
			attempt: 1,
			nowMs: 40_000,
			outcome: suppliedOutcome.value,
		});
		const plan = advanceGmailPolling(
			source.value as GmailPollingSnapshot,
			suppliedEvent.value as GmailPollingEvent,
		);
		const next = changed(plan);
		expect(next).toMatchObject({ phase: "waiting", nextDueMs: 250_000, deliverByMs: 500_000 });
		for (const observed of [active, source, suppliedOutcome, suppliedEvent]) {
			expect(Object.values(observed.reads).every((count) => count === 1)).toBe(true);
			expect(Object.isFrozen(observed.value)).toBe(false);
		}
		expect(Object.isFrozen(plan)).toBe(true);
		expect(Object.isFrozen(next)).toBe(true);
		const mutable = { version: 1, revision: 0, attempt: 0, phase: "waiting", nextDueMs: 130_000 };
		const copy = restoreGmailPollingState(mutable);
		mutable.nextDueMs = 0;
		expect(copy).toMatchObject({ nextDueMs: 130_000 });
		expect(Object.isFrozen(mutable)).toBe(false);
	});

	it("refuses malformed persisted state rather than resetting or accepting inconsistent active work", () => {
		const running = started(30_000, 200_000);
		if (running.phase !== "running") throw new Error("Expected running state");
		for (const value of [
			null,
			[],
			{},
			{ ...running, version: 2 },
			{ ...running, revision: -1 },
			{ ...running, extra: true },
			{ ...running, active: { ...running.active, runRevision: 2 } },
			{ ...running, active: { ...running.active, attempt: 2 } },
			{ ...running, active: { ...running.active, startedAtMs: 200_000 } },
			{ ...running, stopReason: "policy-stop" },
			{
				version: 1,
				revision: 1,
				attempt: 1,
				phase: "running",
				active: running.active,
				stopReason: "deadline",
			},
			{ version: 1, revision: 2, attempt: 1, phase: "stopped", reason: "deadline" },
			{
				version: 1,
				revision: 0,
				attempt: 0,
				phase: "waiting",
				nextDueMs: 30_000,
				deliverByMs: 30_000,
			},
		]) {
			expect(() => restoreGmailPollingState(value)).toThrowError(new TypeError(invalidMessage));
		}
		for (const value of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
			expect(() => createGmailPollingState(value)).toThrowError(new TypeError(invalidMessage));
			invalid(createGmailPollingState(0), { kind: "tick", nowMs: value });
		}
	});

	it("validates complete outcome DATA and sanitizes throwing accessors without preserving a cause", () => {
		const running = started();
		if (running.phase !== "running") throw new Error("Expected running state");
		for (const outcome of [
			null,
			{},
			{ kind: "retry" },
			{ kind: "retry", notBeforeMs: -1 },
			{ kind: "success", extra: true },
		]) {
			invalid(running, {
				kind: "complete",
				runRevision: running.active.runRevision,
				attempt: running.active.attempt,
				nowMs: 40_000,
				outcome,
			});
		}
		const throwing = {
			get phase(): string {
				throw new Error("untrusted-field");
			},
		};
		try {
			restoreGmailPollingState(throwing);
			throw new Error("Expected state refusal");
		} catch (caught) {
			expect(caught).toBeInstanceOf(TypeError);
			expect((caught as TypeError).message).toBe(invalidMessage);
			expect(Object.hasOwn(caught as object, "cause")).toBe(false);
		}
	});
});
