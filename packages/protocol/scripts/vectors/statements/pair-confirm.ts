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
	await signed(
		"mobile-capabilities",
		{ ...base, capabilities: ["read", "draft", "organize"] },
		true,
	);
	await signed("cli-capabilities", { ...base, capabilities: ["read", "draft"] }, true);
	await signed("canonical-subset", { ...base, capabilities: ["draft", "approve"] }, true);
	await signed(
		"reordered-desktop-capabilities",
		{ ...base, capabilities: ["draft", "read", "organize", "approve", "admin"] },
		false,
	);
	await signed("reordered-subset", { ...base, capabilities: ["draft", "read"] }, false);
	await signed("preset-excluded", { ...base, preset: "desktop" }, false);
	const order = ["read", "draft", "organize", "approve", "admin"];
	for (let first = 0; first < order.length; first++) {
		for (let second = first + 1; second < order.length; second++) {
			await signed(
				`ordered-${order[first]}-${order[second]}`,
				{ ...base, capabilities: [order[first], order[second]] },
				true,
			);
			await signed(
				`reordered-${order[second]}-${order[first]}`,
				{ ...base, capabilities: [order[second], order[first]] },
				false,
			);
		}
	}
	await signed("host-role-refused", { ...base, role: "host:sms" }, false);
	await signed("host-capability-refused", { ...base, capabilities: ["host:sms"] }, false);
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
