import { createHmac } from "node:crypto";
import { canonicalize } from "@draftyak/protocol/jcs";

/** Internal domain-separated authentication of the durable audit position. */
export function auditHeadTag(key: Uint8Array, seq: number, mac: string): string {
	return createHmac("sha256", key)
		.update("draftyak/audit-head/v1\n")
		.update(canonicalize({ seq, mac }))
		.digest("hex");
}
