import * as z from "zod";
import {
	CONFIRMATION_PRESETS,
	ConfirmationPreset,
	DeviceCapabilities,
	type DeviceCapability,
} from "../entities/device.ts";
import { uniqueItems } from "../entities/fields.ts";
import { OutboxState, StateReason } from "../entities/outbox.ts";
import { type Flag, Flags, flagsHash } from "../flags.ts";
import { jcsSha256 } from "../hash.ts";
import { DisplayName, PairingRole, PairingSas } from "../pairing.ts";
import { Sha256Hex, Ulid, UtcMs } from "../scalars.ts";
import { contentHash, SendSnapshotV1 } from "../snapshot.ts";
import { AdminKind, AgentSessionReviewSubject, SigningKey } from "../statements.ts";
import {
	ADMIN_REVIEW_KINDS,
	AdminAccountSubject,
	AdminDataBackupSubject,
	AdminDeviceCapabilitiesSubject,
	type AdminOperationReview,
	type AdminReviewKind,
} from "./admin.ts";
import { presetFitsRole } from "./common.ts";

export type OperationRequest =
	| { readonly kind: AdminKind; readonly ids: readonly string[] }
	| {
			readonly kind: "pair-confirm";
			readonly ids: readonly [string];
			readonly preset: ConfirmationPreset;
	  };
export const OperationRequest: z.ZodType<OperationRequest> = z
	.discriminatedUnion("kind", [
		z.strictObject({
			kind: AdminKind.exclude(ADMIN_REVIEW_KINDS),
			ids: uniqueItems(z.array(Ulid).max(100)),
		}),
		// A reviewed kind names the account or device its subject describes, or nothing to back up.
		z.strictObject({
			kind: AdminKind.extract([
				"account.disconnect",
				"account.mode-full",
				"security.device-capabilities",
			]),
			ids: z.tuple([Ulid]),
		}),
		z.strictObject({ kind: z.literal("data.backup"), ids: z.array(Ulid).max(0) }),
		z.strictObject({
			kind: z.literal("pair-confirm"),
			ids: z.tuple([Ulid]),
			preset: ConfirmationPreset,
		}),
	])
	.meta({ id: "draftyak.device-api.OperationRequest" });
export interface SendReview {
	readonly id: string;
	readonly snapshot: SendSnapshotV1;
	readonly contentHash: string;
	readonly flags: readonly Flag[];
	readonly flagsHash: string;
	readonly state: OutboxState;
	readonly stateReason: StateReason | null;
	readonly requiredUsers: readonly string[];
	readonly expiresAt: number;
}
export const SendReview: z.ZodType<SendReview> = z
	.strictObject({
		id: Ulid,
		snapshot: SendSnapshotV1,
		contentHash: Sha256Hex,
		flags: Flags,
		flagsHash: Sha256Hex,
		state: OutboxState,
		stateReason: StateReason.nullable(),
		requiredUsers: uniqueItems(z.array(Ulid).min(1)),
		expiresAt: UtcMs,
	})
	.refine(
		(value) => {
			try {
				return (
					value.contentHash === contentHash(value.snapshot) &&
					value.flagsHash === flagsHash(value.flags)
				);
			} catch {
				return false;
			}
		},
		{ message: "review hashes must match its snapshot and flags" },
	)
	.meta({ id: "draftyak.device-api.SendReview" });
export interface PairConfirmSubject {
	readonly candidate: string;
	readonly name: string;
	readonly role: PairingRole;
	readonly transportSpkiSha256: string;
	readonly signingKey: string;
	readonly preset: ConfirmationPreset;
	readonly capabilities: readonly DeviceCapability[];
	readonly sas: string;
}
export const PairConfirmSubject: z.ZodType<PairConfirmSubject> = z
	.strictObject({
		candidate: Ulid,
		name: DisplayName,
		role: PairingRole,
		transportSpkiSha256: Sha256Hex,
		signingKey: SigningKey,
		preset: ConfirmationPreset,
		capabilities: DeviceCapabilities,
		sas: PairingSas,
	})
	.refine(
		(value) =>
			presetFitsRole(value.preset, value.role) &&
			JSON.stringify(value.capabilities) === JSON.stringify(CONFIRMATION_PRESETS[value.preset]),
		{ message: "preset must fit candidate role and exact capabilities" },
	)
	.meta({ id: "draftyak.device-api.PairConfirmSubject" });
export interface PairConfirmationReview {
	readonly id: string;
	readonly kind: "pair-confirm";
	readonly digest: string;
	readonly subject: PairConfirmSubject;
	readonly expiresAt: number;
	readonly remainingMs: number;
}
export interface AgentSessionReview {
	readonly id: string;
	readonly kind: "agent-session";
	readonly digest: string;
	readonly subject: AgentSessionReviewSubject;
	readonly expiresAt: number;
	readonly remainingMs: number;
}
export type OperationReview = PairConfirmationReview | AgentSessionReview | AdminOperationReview;
const pairReview = z.strictObject({
	id: Ulid,
	kind: z.literal("pair-confirm"),
	digest: Sha256Hex,
	subject: PairConfirmSubject,
	expiresAt: UtcMs,
	remainingMs: z.int().min(0).max(120_000),
});
const agentSessionReview = z.strictObject({
	id: Ulid,
	kind: z.literal("agent-session"),
	digest: Sha256Hex,
	subject: AgentSessionReviewSubject,
	expiresAt: UtcMs,
	remainingMs: z.int().min(0).max(120_000),
});
const adminReview = <K extends AdminReviewKind, S extends z.ZodType>(kind: K, subject: S) =>
	z.strictObject({
		id: Ulid,
		kind: z.literal(kind),
		digest: Sha256Hex,
		subject,
		expiresAt: UtcMs,
		remainingMs: z.int().min(0).max(120_000),
	});
export const OperationReview: z.ZodType<OperationReview> = z
	.discriminatedUnion("kind", [
		pairReview,
		agentSessionReview,
		adminReview("account.disconnect", AdminAccountSubject),
		adminReview("account.mode-full", AdminAccountSubject),
		adminReview("security.device-capabilities", AdminDeviceCapabilitiesSubject),
		adminReview("data.backup", AdminDataBackupSubject),
	])
	.refine(
		(value) => {
			try {
				return value.digest === jcsSha256(value.subject);
			} catch {
				return false;
			}
		},
		{ message: "operation digest must match its subject" },
	)
	.meta({ id: "draftyak.device-api.OperationReview" });
