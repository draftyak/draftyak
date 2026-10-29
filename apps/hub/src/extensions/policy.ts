import type { SendPolicyInput } from "@draftyak/extensions";
import type { TimerClock } from "../kernel/clock.ts";
import { denseArray, frozenCopy, isIdentifier, ownData } from "./values.ts";

/** A throw, rejection or a policy still running after two seconds denies. */
export const POLICY_TIMEOUT_MS = 2_000;
export const MAX_ROLES = 16;

export type SendPolicyDecision =
	| { readonly kind: "deny"; readonly policies: readonly string[] }
	| { readonly kind: "require"; readonly approvals: number; readonly roles: readonly string[] };

export interface RegisteredSendPolicy {
	readonly module: string;
	readonly id: string;
	evaluate(input: SendPolicyInput): unknown;
}
export interface RegisteredWorkspaceAccess {
	canAccess(userId: string, accountId: string): unknown;
}

/** The host's own timer and monotonic clock, captured at start; module code never supplies either. */
export type DeadlineClock = Pick<TimerClock, "after" | "monotonicMs">;

/**
 * The settled value, or undefined after a throw, a rejection or the bound. The timer only ends the
 * wait: a value counts only if the monotonic clock shows it settled before the bound, so a busy
 * event loop that delays the timer never lets a late value through.
 */
export async function settleWithin(
	operation: () => unknown,
	ms: number,
	clock: DeadlineClock,
): Promise<{ readonly value: unknown } | undefined> {
	const controller = new AbortController();
	let start: number, timer: Promise<undefined>;
	try {
		start = clock.monotonicMs();
		if (!Number.isFinite(start)) return undefined;
		timer = clock.after(ms, controller.signal).then(
			() => undefined,
			() => undefined,
		);
	} catch {
		return undefined;
	}
	try {
		const work = Promise.resolve()
			.then(operation)
			.then(
				(value) => ({ value }),
				() => undefined,
			);
		const settled = await Promise.race([work, timer]);
		return settled !== undefined && inTime(clock, start, ms) ? settled : undefined;
	} finally {
		controller.abort();
	}
}

/** Elapsed time that is late, negative, non-finite or unreadable counts as the timeout. */
function inTime(clock: DeadlineClock, start: number, ms: number): boolean {
	let now: unknown;
	try {
		now = clock.monotonicMs();
	} catch {
		return false;
	}
	const elapsed = typeof now === "number" ? now - start : Number.NaN;
	return elapsed >= 0 && elapsed < ms;
}

const PHASES = new Set(["propose", "claim", "retry"]);

/** Only an exact deny or require shape counts; anything else, including allow-like values, denies. */
function requirement(value: unknown): { approvals: number; roles: readonly string[] } | undefined {
	try {
		const fields = new Map(ownData(value, 3, "module"));
		if (fields.get("kind") !== "require") return undefined;
		for (const key of fields.keys())
			if (key !== "kind" && key !== "approvals" && key !== "roles") return undefined;
		const approvals = fields.get("approvals");
		if (typeof approvals !== "number" || !Number.isSafeInteger(approvals) || approvals < 1)
			return undefined;
		const roles = fields.has("roles") ? denseArray(fields.get("roles"), MAX_ROLES, "module") : [];
		if (!roles.every(isIdentifier) || new Set(roles).size !== roles.length) return undefined;
		return { approvals, roles };
	} catch {
		return undefined;
	}
}

/** Every registered policy is AND-ed: one deny denies, require only adds approvals or roles. */
export async function evaluateSendPolicies(
	policies: readonly RegisteredSendPolicy[],
	input: SendPolicyInput,
	clock: DeadlineClock,
): Promise<SendPolicyDecision> {
	if (!PHASES.has(input.phase)) throw new TypeError("Unknown send policy phase");
	const outcomes = await Promise.all(
		policies.map(async (policy) => {
			const settled = await settleWithin(
				() => policy.evaluate(frozenCopy(input)),
				POLICY_TIMEOUT_MS,
				clock,
			);
			return settled === undefined ? undefined : requirement(settled.value);
		}),
	);
	const denied = policies
		.filter((_, index) => outcomes[index] === undefined)
		.map((policy) => `${policy.module}/${policy.id}`);
	if (denied.length > 0)
		return Object.freeze({ kind: "deny", policies: Object.freeze(denied.sort()) });
	let approvals = 1;
	const roles = new Set<string>();
	for (const outcome of outcomes) {
		approvals = Math.max(approvals, outcome?.approvals ?? 1);
		for (const role of outcome?.roles ?? []) roles.add(role);
	}
	return Object.freeze({ kind: "require", approvals, roles: Object.freeze([...roles].sort()) });
}

/** AND-ed with core ownership and routing: only an exact true from every provider in time grants. */
export async function canAccessAll(
	providers: readonly RegisteredWorkspaceAccess[],
	userId: string,
	accountId: string,
	clock: DeadlineClock,
): Promise<boolean> {
	const settled = await Promise.all(
		providers.map((provider) =>
			settleWithin(() => provider.canAccess(userId, accountId), POLICY_TIMEOUT_MS, clock),
		),
	);
	return settled.every((result) => result?.value === true);
}
