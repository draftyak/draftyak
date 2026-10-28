import {
	arrayValues,
	type CoverageRequirements,
	type Destination,
	destination,
	MAX_ATTEMPTS,
	RecorderError,
	type RecorderResult,
	readResult,
} from "./schema.ts";

/** Every attempt counts, including policy refusals and DNS/connect failures. */
export function assertDestinations(
	input: string | Uint8Array,
	required: CoverageRequirements,
	allowed: readonly Destination[],
): RecorderResult {
	const result = readResult(input, required);
	const list = arrayValues(allowed, MAX_ATTEMPTS).map(destination);
	if (
		result.attempts.some(
			(attempt) =>
				!list.some(
					(entry) =>
						entry.host === attempt.destination.host &&
						entry.port === attempt.destination.port &&
						entry.transport === attempt.destination.transport,
				),
		)
	)
		throw new RecorderError("COVERAGE_MISMATCH");
	return result;
}
