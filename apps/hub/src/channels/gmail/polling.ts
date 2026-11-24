interface PollingBase {
	readonly version: 1;
	readonly revision: number;
	readonly attempt: number;
	readonly deliverByMs?: number;
}

export interface GmailPollingRun {
	readonly runRevision: number;
	readonly attempt: number;
	readonly startedAtMs: number;
}

export type GmailPollingStopReason = "cancelled" | "deadline" | "policy-stop";

export type GmailPollingSnapshot = Readonly<
	PollingBase &
		(
			| { readonly phase: "waiting"; readonly nextDueMs: number }
			| {
					readonly phase: "running" | "uncertain";
					readonly active: GmailPollingRun;
					readonly stopReason?: "cancelled" | "deadline";
			  }
			| { readonly phase: "stopped"; readonly reason: GmailPollingStopReason }
		)
>;

export type GmailPollingOutcome =
	| Readonly<{ kind: "success" }>
	| Readonly<{ kind: "retry"; notBeforeMs: number }>
	| Readonly<{ kind: "stop" }>;

export type GmailPollingEvent =
	| Readonly<{ kind: "tick"; nowMs: number }>
	| Readonly<{ kind: "cancel" }>
	| Readonly<{ kind: "uncertain"; runRevision: number; attempt: number }>
	| Readonly<{
			kind: "complete";
			runRevision: number;
			attempt: number;
			nowMs: number;
			outcome: GmailPollingOutcome;
	  }>;

export type GmailPollingTransition =
	| Readonly<{
			kind: "update";
			expectedRevision: number;
			nextSnapshot: GmailPollingSnapshot;
	  }>
	| Readonly<{
			kind: "unchanged";
			reason: "not-due" | "active" | "stopped" | "stale";
			snapshot: GmailPollingSnapshot;
	  }>;

const INTERVAL_MS = 30_000;
const INVALID = "Invalid Gmail polling state input";

function fail(): never {
	throw new TypeError(INVALID);
}

function integer(value: unknown, minimum = 0): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) fail();
	return value;
}

function increment(value: number): number {
	if (value === Number.MAX_SAFE_INTEGER) fail();
	return value + 1;
}

function intervalAfter(value: number): number {
	if (value > Number.MAX_SAFE_INTEGER - INTERVAL_MS) fail();
	return value + INTERVAL_MS;
}

function record(value: unknown): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) fail();
	return value as Record<string, unknown>;
}

function keys(value: object, required: readonly string[], optional: readonly string[] = []): void {
	for (const key of Reflect.ownKeys(value)) {
		if (typeof key !== "string" || (!required.includes(key) && !optional.includes(key))) fail();
	}
	for (const key of required) if (!Object.hasOwn(value, key)) fail();
}

function stopReason(value: unknown): GmailPollingStopReason {
	if (value !== "cancelled" && value !== "deadline" && value !== "policy-stop") fail();
	return value;
}

function base(state: PollingBase, revision: number, attempt = state.attempt): PollingBase {
	return {
		version: 1,
		revision,
		attempt,
		...(state.deliverByMs === undefined ? {} : { deliverByMs: state.deliverByMs }),
	};
}

function stopped(
	state: PollingBase,
	revision: number,
	reason: GmailPollingStopReason,
	attempt = state.attempt,
): GmailPollingSnapshot {
	return Object.freeze({ ...base(state, revision, attempt), phase: "stopped", reason });
}

function snapshot(value: unknown): GmailPollingSnapshot {
	const input = record(value);
	const phase = input.phase;
	const common = ["version", "revision", "attempt", "phase"];
	if (phase === "waiting") keys(input, [...common, "nextDueMs"], ["deliverByMs"]);
	else if (phase === "running" || phase === "uncertain") {
		keys(input, [...common, "active"], ["deliverByMs", "stopReason"]);
	} else if (phase === "stopped") keys(input, [...common, "reason"], ["deliverByMs"]);
	else fail();
	const version = input.version;
	const revision = integer(input.revision);
	const attempt = integer(input.attempt);
	if (attempt > revision) fail();
	const deliverByMs = Object.hasOwn(input, "deliverByMs") ? integer(input.deliverByMs) : undefined;
	if (version !== 1) fail();
	const parsed: PollingBase = {
		version: 1,
		revision,
		attempt,
		...(deliverByMs === undefined ? {} : { deliverByMs }),
	};
	if (phase === "waiting") {
		const nextDueMs = integer(input.nextDueMs);
		if (deliverByMs !== undefined && nextDueMs >= deliverByMs) fail();
		return Object.freeze({ ...parsed, phase, nextDueMs });
	}
	if (phase === "stopped") {
		const reason = stopReason(input.reason);
		if (reason === "deadline" && deliverByMs === undefined) fail();
		return stopped(parsed, revision, reason);
	}
	const suppliedRun = record(input.active);
	keys(suppliedRun, ["runRevision", "attempt", "startedAtMs"]);
	const runRevision = integer(suppliedRun.runRevision, 1);
	const runAttempt = integer(suppliedRun.attempt, 1);
	const startedAtMs = integer(suppliedRun.startedAtMs);
	const suppliedStop = Object.hasOwn(input, "stopReason")
		? stopReason(input.stopReason)
		: undefined;
	if (
		runRevision > revision ||
		runAttempt !== attempt ||
		runAttempt > runRevision ||
		(deliverByMs !== undefined && startedAtMs >= deliverByMs) ||
		(suppliedStop === "deadline" && deliverByMs === undefined) ||
		suppliedStop === "policy-stop"
	) {
		fail();
	}
	return Object.freeze({
		...parsed,
		phase,
		active: Object.freeze({ runRevision, attempt: runAttempt, startedAtMs }),
		...(suppliedStop === undefined ? {} : { stopReason: suppliedStop }),
	});
}

function outcome(value: unknown): GmailPollingOutcome {
	const input = record(value);
	const kind = input.kind;
	if (kind === "retry") {
		keys(input, ["kind", "notBeforeMs"]);
		return Object.freeze({ kind, notBeforeMs: integer(input.notBeforeMs) });
	}
	if (kind !== "success" && kind !== "stop") fail();
	keys(input, ["kind"]);
	return Object.freeze({ kind });
}

function event(value: unknown): GmailPollingEvent {
	const input = record(value);
	const kind = input.kind;
	if (kind === "tick") {
		keys(input, ["kind", "nowMs"]);
		return Object.freeze({ kind, nowMs: integer(input.nowMs) });
	}
	if (kind === "cancel") {
		keys(input, ["kind"]);
		return Object.freeze({ kind });
	}
	if (kind !== "complete" && kind !== "uncertain") fail();
	keys(
		input,
		kind === "complete"
			? ["kind", "runRevision", "attempt", "nowMs", "outcome"]
			: ["kind", "runRevision", "attempt"],
	);
	const runRevision = integer(input.runRevision, 1);
	const attempt = integer(input.attempt, 1);
	if (kind === "uncertain") return Object.freeze({ kind, runRevision, attempt });
	return Object.freeze({
		kind,
		runRevision,
		attempt,
		nowMs: integer(input.nowMs),
		outcome: outcome(input.outcome),
	});
}

function unchanged(
	state: GmailPollingSnapshot,
	reason: Extract<GmailPollingTransition, { kind: "unchanged" }>["reason"],
): GmailPollingTransition {
	return Object.freeze({ kind: "unchanged", reason, snapshot: state });
}

function update(state: GmailPollingSnapshot, next: GmailPollingSnapshot): GmailPollingTransition {
	return Object.freeze({ kind: "update", expectedRevision: state.revision, nextSnapshot: next });
}

/** Creates journal DATA. The first poll is due 30 seconds after creation. */
export function createGmailPollingState(nowMs: number, deliverByMs?: number): GmailPollingSnapshot {
	try {
		const now = integer(nowMs);
		const deadline = deliverByMs === undefined ? undefined : integer(deliverByMs);
		const initial: PollingBase = {
			version: 1,
			revision: 0,
			attempt: 0,
			...(deadline === undefined ? {} : { deliverByMs: deadline }),
		};
		if (deadline !== undefined && now >= deadline) return stopped(initial, 0, "deadline");
		const nextDueMs = intervalAfter(now);
		if (deadline !== undefined && nextDueMs >= deadline) return stopped(initial, 0, "deadline");
		return Object.freeze({ ...initial, phase: "waiting", nextDueMs });
	} catch {
		return fail();
	}
}

/** Copies recorded DATA without resetting due times or unresolved operations. */
export function restoreGmailPollingState(value: unknown): GmailPollingSnapshot {
	try {
		return snapshot(value);
	} catch {
		return fail();
	}
}

/**
 * Plans journal transitions only. Run/revision tags are correlation DATA, not
 * native leases or accepted generations. The caller must persist its actual CAS
 * before execution and retain cancellation, current-account, budget and lifetime
 * checks. A matching completion requires the caller's real terminal evidence.
 */
export function advanceGmailPolling(
	state: GmailPollingSnapshot,
	suppliedEvent: GmailPollingEvent,
): GmailPollingTransition {
	try {
		const current = snapshot(state);
		const observed = event(suppliedEvent);
		if (observed.kind === "complete" || observed.kind === "uncertain") {
			if (
				(current.phase !== "running" && current.phase !== "uncertain") ||
				current.active.runRevision !== observed.runRevision ||
				current.active.attempt !== observed.attempt
			) {
				return unchanged(current, "stale");
			}
			if (observed.kind === "uncertain") {
				if (current.phase === "uncertain") return unchanged(current, "active");
				return update(
					current,
					Object.freeze({ ...current, revision: increment(current.revision), phase: "uncertain" }),
				);
			}
			const revision = increment(current.revision);
			if (current.stopReason !== undefined) {
				return update(current, stopped(current, revision, current.stopReason));
			}
			if (current.deliverByMs !== undefined && observed.nowMs >= current.deliverByMs) {
				return update(current, stopped(current, revision, "deadline"));
			}
			if (observed.outcome.kind === "stop") {
				return update(current, stopped(current, revision, "policy-stop"));
			}
			const floor = intervalAfter(Math.max(current.active.startedAtMs, observed.nowMs));
			const nextDueMs =
				observed.outcome.kind === "retry" ? Math.max(floor, observed.outcome.notBeforeMs) : floor;
			const attempt = observed.outcome.kind === "success" ? 0 : current.attempt;
			if (current.deliverByMs !== undefined && nextDueMs >= current.deliverByMs) {
				return update(current, stopped(current, revision, "deadline", attempt));
			}
			return update(
				current,
				Object.freeze({ ...base(current, revision, attempt), phase: "waiting", nextDueMs }),
			);
		}
		if (current.phase === "stopped") return unchanged(current, "stopped");
		if (observed.kind === "cancel") {
			if (current.phase === "waiting") {
				return update(current, stopped(current, increment(current.revision), "cancelled"));
			}
			if (current.stopReason !== undefined) return unchanged(current, "active");
			return update(
				current,
				Object.freeze({
					...current,
					revision: increment(current.revision),
					stopReason: "cancelled",
				}),
			);
		}
		if (current.deliverByMs !== undefined && observed.nowMs >= current.deliverByMs) {
			if (current.phase === "waiting") {
				return update(current, stopped(current, increment(current.revision), "deadline"));
			}
			if (current.stopReason !== undefined) return unchanged(current, "active");
			return update(
				current,
				Object.freeze({
					...current,
					revision: increment(current.revision),
					stopReason: "deadline",
				}),
			);
		}
		if (current.phase !== "waiting") return unchanged(current, "active");
		if (observed.nowMs < current.nextDueMs) return unchanged(current, "not-due");
		const revision = increment(current.revision);
		const attempt = increment(current.attempt);
		return update(
			current,
			Object.freeze({
				...base(current, revision, attempt),
				phase: "running",
				active: Object.freeze({ runRevision: revision, attempt, startedAtMs: observed.nowMs }),
			}),
		);
	} catch {
		return fail();
	}
}
