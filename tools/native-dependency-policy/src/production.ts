import { BasisError, UnavailableCurrentBasisProducer } from "./current-basis.ts";
import { createEvidenceDirectory } from "./evidence.ts";
import { createNativePolicyProducer, type NativePolicyProducer } from "./runner.ts";

/**
 * No independently current security-event delivery route is established yet.
 * Refuse active records before starting native work; cached data is not current evidence.
 * Construction has no I/O, so authority preflight still precedes every producer action.
 */
export function createProductionProducer(options: {
	readonly repositoryRoot: string;
	readonly evidenceDirectory?: string;
}): NativePolicyProducer {
	const { repositoryRoot, evidenceDirectory } = options;
	return createNativePolicyProducer({
		async collect() {
			const evidence = await createEvidenceDirectory({
				checkoutRoot: repositoryRoot,
				...(evidenceDirectory === undefined ? {} : { directory: evidenceDirectory }),
			});
			try {
				await new UnavailableCurrentBasisProducer().database();
			} catch (error) {
				if (!(error instanceof BasisError) || error.code !== "BASIS_UNAVAILABLE") throw error;
				return {
					runId: evidence.runId,
					reportDigest: null,
					binding: null,
					audit: null,
					rawExits: { full: null, advisory: null },
					evidenceObservedAt: null,
					sourceRevisions: null,
					failure: "BASIS_UNAVAILABLE",
				};
			}
			throw new BasisError("BASIS_UNAVAILABLE");
		},
		async revalidate() {
			return { reportDigest: null, binding: null, sourceRevisions: null };
		},
	});
}
