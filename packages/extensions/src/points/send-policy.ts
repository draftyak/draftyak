import type { Flag } from "@draftyak/protocol/flags";
import type { Ulid } from "@draftyak/protocol/scalars";
import type { SendSnapshotV1 } from "@draftyak/protocol/snapshot";
import type { DeepReadonly } from "../common.ts";

declare const approvalCountBrand: unique symbol;
export type ApprovalCount = number & { readonly [approvalCountBrand]: true };

export function approvalCount(value: number): ApprovalCount {
	if (!Number.isSafeInteger(value) || value < 1) throw new Error("Approval count refused");
	return value as ApprovalCount;
}

export interface SendPolicyInput {
	readonly phase: "propose" | "claim" | "retry";
	readonly snapshot: DeepReadonly<SendSnapshotV1>;
	readonly flags: readonly DeepReadonly<Flag>[];
	readonly userId: Ulid;
	readonly accountId: Ulid;
}

/** A policy cannot grant authority. Require(1) adds no restriction to the core owner/PIN floor. */
export type SendPolicyResult =
	| { readonly kind: "deny"; readonly reason: string }
	| {
			readonly kind: "require";
			readonly approvals: ApprovalCount;
			readonly roles?: readonly string[];
	  };

export interface SendPolicy {
	readonly id: string;
	evaluate(input: SendPolicyInput): Promise<SendPolicyResult>;
}
