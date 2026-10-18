import type { VectorContext, VectorFile } from "../../vectors.ts";
import { SNAPSHOT_IDS } from "../snapshot.ts";
import { type SignVector, statementBase, typedVectors } from "./shared.ts";
export function example(): Record<string, unknown> {
	return {
		...statementBase(),
		op: SNAPSHOT_IDS.op,
		kind: "plugin.install",
		digest: "b".repeat(64),
	};
}
async function extra(base: Record<string, unknown>, signed: SignVector): Promise<void> {
	await signed("unknown-admin-kind", { ...base, kind: "unregistered-test-operation" }, false);
	await signed("advertised-addresses", { ...base, kind: "access.advertised-addresses-set" }, true);
}
export const generate = (context: VectorContext): Promise<VectorFile[]> =>
	typedVectors("admin.v1", context, example, extra);
