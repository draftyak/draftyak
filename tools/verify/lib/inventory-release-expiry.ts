const refusal = "Inventory release expiry refused";

/** Absent bounds establish no freshness guarantee. */
export function assertUnexpiredReleaseBounds(bounds: readonly (number | null)[]): void {
	try {
		const now = Date.now();
		if (!Array.isArray(bounds) || !Number.isFinite(now)) throw new Error(refusal);
		for (let index = 0; index < bounds.length; index++) {
			const bound = bounds[index];
			if (
				bound !== null &&
				(typeof bound !== "number" || !Number.isFinite(bound) || bound <= now)
			) {
				throw new Error(refusal);
			}
		}
	} catch {
		throw new Error(refusal);
	}
}
