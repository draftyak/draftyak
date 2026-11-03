import { createHash } from "node:crypto";
import {
	type C2Basis,
	type C2Scope,
	c2Scope,
	canonicalC2,
	normalizeC2ReleaseBasis,
} from "./release-c2.ts";
import { C2Error, copyData, integer, refuse } from "./release-c2-data.ts";

/** Source-aware DATA only; neither digest establishes source authenticity or approval. */
export interface C2ReleaseProjection {
	readonly schemaVersion: 2;
	readonly kind: "source-aware-c2-release-projection";
	readonly authority: false;
	readonly reusableNativeSourceBasis: false;
	readonly basis: C2Basis;
	readonly semanticDigest: string;
	readonly observationDigest: string;
	readonly observedAtMs: number;
	/** Validation time only. It never replaces the original source observation or age window. */
	readonly checkedAtMs: number;
}

/**
 * Consume the complete schema2 basis without mapping it to the older release schema.
 * Callers using a C2Collector retain its original receipt separately for revalidate(receipt).
 * This projection accepts DATA, never issues or replaces that collector's genuine receipt.
 */
export function projectC2ReleaseBasis(
	input: unknown,
	expectedScope: C2Scope,
	checkedAtMs: number,
): C2ReleaseProjection {
	try {
		const scope = c2Scope(copyData(expectedScope)),
			validationTime = integer(checkedAtMs),
			{ basis, semanticDigest } = normalizeC2ReleaseBasis(input);
		if (canonicalC2(scope) !== canonicalC2(basis.scopeBinding)) refuse();
		let observedAtMs = basis.completedAtMs;
		for (const observation of basis.observations) {
			observedAtMs = Math.min(
				observedAtMs,
				observation.initial.observedAtMs,
				observation.recheck.observedAtMs,
			);
		}
		if (validationTime < basis.completedAtMs || validationTime - observedAtMs >= basis.maxAgeMs)
			refuse("C2_EXPIRED");
		// Semantic identity already binds the scope and every API/index-specific technical fact.
		// Observation identity additionally binds all original timing and complete source receipts.
		const observationDigest = createHash("sha256")
			.update("draftyak/native-dependency-policy/releases/observation/v2\0")
			.update(
				canonicalC2({
					schemaVersion: 2,
					semanticDigest,
					scopeBinding: basis.scopeBinding,
					startedAtMs: basis.startedAtMs,
					completedAtMs: basis.completedAtMs,
					maxAgeMs: basis.maxAgeMs,
					observations: basis.observations,
				}),
			)
			.digest("hex");
		return Object.freeze({
			schemaVersion: 2,
			kind: "source-aware-c2-release-projection",
			authority: false,
			reusableNativeSourceBasis: false,
			basis,
			semanticDigest,
			observationDigest,
			observedAtMs,
			checkedAtMs: validationTime,
		});
	} catch (error) {
		if (error instanceof C2Error) throw error;
		return refuse();
	}
}
