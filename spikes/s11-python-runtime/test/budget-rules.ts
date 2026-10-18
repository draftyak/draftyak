// S11's budgets (plan §15 S11 (g)) and how a measurement is judged. A budget missed by more than 2×
// on a native, unloaded run is an S11 FAIL (No-go); a smaller miss is ladder step 3 (snapshots or
// fewer C-extension wheels), so Go with fallback (ADR 0013's decision rule).
export const BUDGETS = {
	coldStartP50Ms: 1_500,
	coldStartP95Ms: 3_000,
	idleRssMiB: 200,
	roundTripP50Ms: 50,
} as const;
export type BudgetRow = keyof typeof BUDGETS;

// Load only makes a timing slower. A resident-memory reading can come out smaller under memory
// pressure (a trimmed working set, compressed pages), so a PASS there needs an unloaded leg too.
export type RowKind = "timing" | "memory";
export const ROW_KIND: Readonly<Record<BudgetRow, RowKind>> = {
	coldStartP50Ms: "timing",
	coldStartP95Ms: "timing",
	idleRssMiB: "memory",
	roundTripP50Ms: "timing",
};

export const COLD_START_RUNS = 20;
export const ROUND_TRIP_RUNS = 20;
export const ROUND_TRIP_BYTES = 1_048_576;
// Plan §4 Health: the watchdog kills a python plugin above 1 GiB; §4 Flags: a 512 MiB wasm heap.
export const PYTHON_RSS_LIMIT_MIB = 1_024;
export const WASM_FLAG = "--wasm-max-mem-pages";
export const WASM_PAGES = 8_192;

export type Verdict = "PASS" | "MISS" | "FAIL";

export function verdict(value: number, limit: number): Verdict {
	if (!Number.isFinite(value) || value < 0) return "FAIL";
	if (value <= limit) return "PASS";
	return value <= 2 * limit ? "MISS" : "FAIL";
}

// Nearest rank: the smallest value with at least p percent of the values at or below it.
export function percentile(values: readonly number[], p: number): number {
	if (values.length === 0 || p <= 0 || p > 100)
		throw new Error("percentile needs values and 0 < p <= 100");
	const sorted = values.toSorted((a, b) => a - b);
	return sorted[Math.ceil((p / 100) * sorted.length) - 1] as number;
}

// held: the kit's lock and its idle check passed before the run; machine-busy: that idle check
// failed; failed: the lock couldn't be taken.
export type LockStatus = "held" | "machine-busy" | "failed";
export type RowVerdict =
	| Verdict
	| "not measured"
	| "not counted: machine-busy"
	| "not run: machine-busy"
	| "not run: bench lock failed";

// A leg is unloaded when every CPU sample taken between its plugins stayed under the threshold.
export function unloaded(samples: readonly number[], thresholdPercent: number): boolean {
	return samples.length > 0 && samples.every((sample) => sample < thresholdPercent);
}

// A held run's row counts when its leg was unloaded; a timing PASS counts anyway, because load only
// slows a plugin. A row without a number is a harness problem, not a verdict. Numbers that don't
// count keep what they would give.
export function judge(
	value: number | null,
	limit: number,
	kind: RowKind,
	status: LockStatus,
	legUnloaded: boolean,
): { readonly verdict: RowVerdict; readonly provisional: Verdict | null } {
	const measured = value !== null && Number.isFinite(value) && value >= 0;
	const would = measured ? verdict(value, limit) : null;
	if (status === "failed") return { verdict: "not run: bench lock failed", provisional: would };
	if (status === "machine-busy") return { verdict: "not run: machine-busy", provisional: would };
	if (would === null) return { verdict: "not measured", provisional: null };
	if (legUnloaded || (kind === "timing" && would === "PASS")) {
		return { verdict: would, provisional: null };
	}
	return { verdict: "not counted: machine-busy", provisional: would };
}

// DRAFTYAK_STRICT_BUDGETS=1, which M2c's nightly sets, makes a counted MISS fail the budget test as
// well as a FAIL. Any other value than 1, 0 or empty is refused.
export function strictBudgets(env: NodeJS.ProcessEnv = process.env): boolean {
	const value = env.DRAFTYAK_STRICT_BUDGETS ?? "";
	if (value === "1" || value === "" || value === "0") return value === "1";
	throw new Error(`DRAFTYAK_STRICT_BUDGETS is 1 (strict) or 0, not "${value}"`);
}
