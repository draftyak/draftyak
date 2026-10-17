import { appError } from "./elicit.ts";

// §6 Completion: only owner-chosen account aliases and these fixed values, never provider data.
export const WINDOWS = ["24h", "72h", "7d"] as const;
export const TONES = ["brief", "neutral", "warm"] as const;
export const MAX_VALUES = 20;
export const COMPLETION_LIMIT = 60;
export const COMPLETION_WINDOW_MS = 60_000;

// Every match: McpServer sets total and hasMore from what a completer returns.
export function complete<T extends string>(values: readonly T[], prefix: string): T[] {
	return values.filter((value) => value.startsWith(prefix));
}

interface Completion {
	readonly values: readonly string[];
	readonly total?: number;
}

// At most 20 values, while total and hasMore still count every match.
export function capCompletion(result: unknown): unknown {
	const { completion } = result as { completion?: Completion };
	if (completion === undefined) return result;
	const total = completion.total ?? completion.values.length;
	const values = completion.values.slice(0, MAX_VALUES);
	return { ...(result as object), completion: { values, total, hasMore: total > values.length } };
}

// A bucket of its own, 60 completion requests a minute per principal, so typing can't starve tool
// calls; over it, app error 1003 with retryAfterMs.
export class CompletionBucket {
	readonly #taken = new Map<string, number[]>();

	take(principal: string, now: number = Date.now()): void {
		const recent = (this.#taken.get(principal) ?? []).filter(
			(at) => at > now - COMPLETION_WINDOW_MS,
		);
		if (recent.length >= COMPLETION_LIMIT) {
			const retryAfterMs = (recent[0] ?? now) + COMPLETION_WINDOW_MS - now;
			this.#taken.set(principal, recent);
			throw appError("RATE_LIMITED", "Too many completion requests; retry later.", {
				retryAfterMs,
			});
		}
		this.#taken.set(principal, [...recent, now]);
	}
}
