import type { OutboxState, StateReason } from "@draftyak/protocol/entities/outbox";
import type { Flag, FlagCode } from "@draftyak/protocol/flags";
import type { CurrentSendSnapshotV1 } from "@draftyak/protocol/snapshot";
import type { WorkScope } from "../jobs/database.ts";
import type { SqlReader, SqlTransaction } from "../store/store.ts";

/** Native outbox data interface. A target record never grants approval or caller rights. */
export interface SendTargetRecord {
	readonly id: string;
	readonly userId: string;
	readonly accountId: string;
	readonly draftId: string;
	readonly dataClass: string;
	readonly snapshot: CurrentSendSnapshotV1;
	readonly contentHash: string;
	readonly flags: readonly Flag[];
	readonly flagsHash: string;
	readonly requiredApprovals: number;
	readonly requiredUsers: readonly string[];
	readonly undoWindowMs: number;
	readonly expiresAt: number;
	readonly state: OutboxState;
	readonly stateReason: StateReason | null;
	readonly targetVersion: number;
}
export type SendTargetScope = WorkScope;
export type SendApplyResult = "pending" | "approved" | "scheduled";
export interface StoredSendApproval {
	readonly approvalId: string;
	readonly userId: string;
	readonly deviceId: string;
	readonly iat: number;
	readonly notBefore: number | null;
	readonly deliverBy: number;
	readonly approvedAt: number;
}
export interface VerifiedSendApprovalFacts extends StoredSendApproval {
	readonly outboxId: string;
	readonly challengeId: string;
	readonly hub: string;
	readonly epoch: number;
	readonly contentHash: string;
	readonly flagsHash: string;
	readonly flagsAcked: readonly FlagCode[];
	readonly targetVersion: number;
}
declare const verifiedSendApprovalBrand: unique symbol;
/** Minted only after genuine native device, challenge, signature and PIN checks in the write. */
export interface VerifiedSendApproval {
	readonly [verifiedSendApprovalBrand]: true;
}
export interface ConsumedSendApproval {
	readonly approval: VerifiedSendApprovalFacts;
	readonly stored: readonly StoredSendApproval[];
}
export interface SendApprovalTarget {
	write<T>(work: (tx: SqlTransaction, scope: SendTargetScope) => T): T;
	item(db: SqlReader, outboxId: string): SendTargetRecord | undefined;
	draftLocked(db: SqlReader, draftId: string): boolean;
	scheduledCount(db: SqlReader, accountId: string, excludeOutboxId: string): number;
	/** Only consumeVerifiedSendApproval's real table projection may determine the tally. */
	apply(scope: SendTargetScope, proof: VerifiedSendApproval): SendApplyResult;
}
export interface SendApprovalPolicyInput {
	readonly phase: "propose";
	readonly snapshot: CurrentSendSnapshotV1;
	readonly flags: readonly Flag[];
	readonly userId: string;
	readonly accountId: string;
}
export type SendApprovalPolicyResult =
	| { readonly kind: "deny"; readonly reason?: string }
	| {
			readonly kind: "require";
			readonly approvals: number;
			readonly users?: readonly string[];
			readonly roles?: readonly string[];
	  };
export interface SendApprovalPolicy {
	readonly id: string;
	evaluate(input: SendApprovalPolicyInput): Promise<SendApprovalPolicyResult>;
}
