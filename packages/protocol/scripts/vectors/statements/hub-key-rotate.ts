import { sha256Hex } from "../../../src/hash.ts";
import type { VectorContext, VectorFile } from "../../vectors.ts";
import { SNAPSHOT_IAT } from "../snapshot.ts";
import { type SignVector, typedVectors } from "./shared.ts";
export function example(signer: string, other: string): Record<string, unknown> {
	return {
		v: 1,
		hub: sha256Hex(Buffer.from(signer, "base64url")),
		epoch: 1,
		keyUse: "identity",
		newKey: other,
		iat: SNAPSHOT_IAT,
	};
}
async function extra(base: Record<string, unknown>, signed: SignVector): Promise<void> {
	await signed("unknown-key-use", { ...base, keyUse: "unregistered-test-key-use" }, false);
}
export const generate = (context: VectorContext): Promise<VectorFile[]> =>
	typedVectors("hub-key-rotate.v1", context, example, extra);
