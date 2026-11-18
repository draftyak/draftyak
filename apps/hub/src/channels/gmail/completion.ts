import type { PluginErrorResult } from "@draftyak/protocol/errors";
import {
	advanceGmailPolling,
	type GmailPollingOutcome,
	type GmailPollingSnapshot,
	type GmailPollingTransition,
	restoreGmailPollingState,
} from "./polling.ts";
import { type GmailPollRetryOptions, planGmailPollRetry } from "./retry.ts";

export type GmailPollingCompletionOutcome =
	| Readonly<{ kind: "success" }>
	| Readonly<{
			kind: "error";
			error: Pick<PluginErrorResult, "code" | "retryAfterMs">;
	  }>;

export interface GmailPollingCompletion {
	readonly runRevision: number;
	readonly attempt: number;
	readonly nowMs: number;
	readonly outcome: GmailPollingCompletionOutcome;
}

const INVALID = "Invalid Gmail polling completion input";

function fail(): never {
	throw new TypeError(INVALID);
}

function record(value: unknown): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) fail();
	return value as Record<string, unknown>;
}

function integer(value: unknown, minimum: number): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) fail();
	return value;
}

/**
 * Composes reported completion DATA with the retry and cadence policies.
 * Correlation is not terminal evidence, a lease, or permission to execute. The
 * caller still owns durable CAS, actual completion/currentness and budgets.
 */
export function completeGmailPolling(
	snapshot: GmailPollingSnapshot,
	completion: GmailPollingCompletion,
	options?: GmailPollRetryOptions,
): GmailPollingTransition {
	try {
		const current = restoreGmailPollingState(snapshot);
		const reported = record(completion);
		const runRevision = integer(reported.runRevision, 1);
		const attempt = integer(reported.attempt, 1);
		// advance parses complete-event outcomes eagerly. Ignore unrelated reports
		// here, before touching their time, outcome, errors or retry options.
		if (
			(current.phase !== "running" && current.phase !== "uncertain") ||
			current.active.runRevision !== runRevision ||
			current.active.attempt !== attempt
		) {
			return Object.freeze({ kind: "unchanged", reason: "stale", snapshot: current });
		}

		const nowMs = integer(reported.nowMs, 0);
		const event = { kind: "complete", runRevision, attempt, nowMs } as const;
		// Existing latches and an observed deadline win independently of outcome.
		if (
			current.stopReason !== undefined ||
			(current.deliverByMs !== undefined && nowMs >= current.deliverByMs)
		) {
			return advanceGmailPolling(current, { ...event, outcome: { kind: "stop" } });
		}

		const outcome = record(reported.outcome);
		const kind = outcome.kind;
		let plannedOutcome: GmailPollingOutcome;
		if (kind === "success") {
			plannedOutcome = { kind: "success" };
		} else if (kind === "error") {
			const suppliedError = record(outcome.error);
			// The real retry policy validates these two captured normalized fields.
			// Unrelated detail/cause fields are never read or spread.
			const error = Object.freeze({
				code: suppliedError.code,
				retryAfterMs: suppliedError.retryAfterMs,
			}) as Pick<PluginErrorResult, "code" | "retryAfterMs">;
			const policyNowMs = Math.max(current.active.startedAtMs, nowMs);
			const plan = planGmailPollRetry(
				error,
				{
					nowMs: policyNowMs,
					attempt: current.active.attempt,
					cancelled: false,
					...(current.deliverByMs === undefined ? {} : { deliverByMs: current.deliverByMs }),
				},
				options,
			);
			// Policy stops remain cadence policy-stop unless its own deadline or
			// latch wins. Do not fabricate a clock observation to force a reason.
			plannedOutcome =
				plan.kind === "retry" ? { kind: "retry", notBeforeMs: plan.retryAtMs } : { kind: "stop" };
		} else {
			return fail();
		}
		return advanceGmailPolling(current, { ...event, outcome: plannedOutcome });
	} catch {
		return fail();
	}
}
