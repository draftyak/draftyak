import type { VectorContext, VectorFile } from "../../vectors.ts";
import { SNAPSHOT_IDS } from "../snapshot.ts";
import { type SignVector, statementBase, typedVectors } from "./shared.ts";
export function example(_signer: string, other: string): Record<string, unknown> {
	return {
		...statementBase(),
		candidate: SNAPSHOT_IDS.candidate,
		role: "device",
		transportSpkiSha256: "b".repeat(64),
		signingKey: other,
		capabilities: ["read", "draft", "organize", "approve", "admin"],
	};
}
async function extra(base: Record<string, unknown>, signed: SignVector): Promise<void> {
	await signed("unknown-role", { ...base, role: "unregistered-test-role" }, false);
	await signed("duplicate-capability", { ...base, capabilities: ["read", "read"] }, false);
	await signed(
		"unknown-capability",
		{ ...base, capabilities: ["unregistered-test-capability"] },
		false,
	);
	await signed("user-id-excluded", { ...base, userId: SNAPSHOT_IDS.author }, false);
	await signed("empty-capabilities", { ...base, capabilities: [] }, false);
	await signed("self-confirmation", { ...base, candidate: base.device }, false);
}
export const generate = (context: VectorContext): Promise<VectorFile[]> =>
	typedVectors("pair-confirm.v1", context, example, extra);
