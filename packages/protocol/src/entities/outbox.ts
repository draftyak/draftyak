import * as z from "zod";
import { Sha256Hex, Ulid, UtcMs } from "../scalars.ts";

// §3's states, in the order an item can reach them.
const outboxStates = [
	"PENDING_APPROVAL",
	"APPROVED",
	"SCHEDULED",
	"SENDING",
	"RETRY_WAIT",
	"UNKNOWN",
	"SENT",
	"FAILED",
	"NEEDS_REAPPROVAL",
	"CANCELLED",
	"REJECTED",
	"SUPERSEDED",
	"EXPIRED",
] as const;
export type OutboxState = (typeof outboxStates)[number];
export const OutboxState: z.ZodEnum<z.core.util.ToEnum<OutboxState>> = z.enum(outboxStates).meta({
	id: "draftyak.entities.OutboxState",
	description:
		"An outbox item's state. APPROVED, SCHEDULED, SENDING, RETRY_WAIT and UNKNOWN are live: " +
		"while a draft has a live item, it is locked.",
});

// §3's void reasons, in its order.
const stateReasons = [
	"missed",
	"new_reply",
	"channel_changed",
	"approver_revoked",
	"credential_lost",
	"plugin_quarantined",
	"policy",
	"restored",
	"not_found",
] as const;
export type StateReason = (typeof stateReasons)[number];
export const StateReason: z.ZodEnum<z.core.util.ToEnum<StateReason>> = z.enum(stateReasons).meta({
	id: "draftyak.entities.StateReason",
	description: "Why an item needs approval again; the UI labels it from this, as Missed.",
});

const proposerKinds = ["owner", "agent"] as const;

export const ProposedBy: z.ZodObject<
	{ kind: z.ZodEnum<z.core.util.ToEnum<(typeof proposerKinds)[number]>>; id: typeof Ulid },
	z.core.$strict
> = z.strictObject({ kind: z.enum(proposerKinds), id: Ulid }).meta({
	id: "draftyak.entities.ProposedBy",
	description:
		"The owner (a user id) or an agent (a grant or agent token id); an agent can cancel only " +
		"what it proposed.",
});
export type ProposedBy = z.infer<typeof ProposedBy>;

const outboxFields: {
	id: typeof Ulid;
	accountId: typeof Ulid;
	draftId: typeof Ulid;
	rev: z.ZodInt;
	proposedBy: typeof ProposedBy;
	contentHash: typeof Sha256Hex;
	flagsHash: typeof Sha256Hex;
	notBefore: z.ZodNullable<typeof UtcMs>;
	deliverBy: z.ZodNullable<typeof UtcMs>;
	requiredApprovals: z.ZodInt;
	createdAt: typeof UtcMs;
	updatedAt: typeof UtcMs;
} = {
	id: Ulid,
	accountId: Ulid,
	draftId: Ulid,
	rev: z.int().min(1),
	proposedBy: ProposedBy,
	contentHash: Sha256Hex,
	flagsHash: Sha256Hex,
	notBefore: UtcMs.nullable(),
	deliverBy: UtcMs.nullable(),
	requiredApprovals: z.int().min(1),
	createdAt: UtcMs,
	updatedAt: UtcMs,
};

type Unvoided = Exclude<OutboxState, "NEEDS_REAPPROVAL">;
type OutboxItemOf<State extends z.ZodType, Reason extends z.ZodType> = z.ZodObject<
	typeof outboxFields & { state: State; stateReason: Reason },
	z.core.$strict
>;

// NEEDS_REAPPROVAL always carries its reason, and no other state carries one.
export const OutboxItem: z.ZodDiscriminatedUnion<
	[
		OutboxItemOf<z.ZodEnum<z.core.util.ToEnum<Unvoided>>, z.ZodNull>,
		OutboxItemOf<z.ZodLiteral<"NEEDS_REAPPROVAL">, typeof StateReason>,
	],
	"state"
> = z
	.discriminatedUnion("state", [
		z.strictObject({
			...outboxFields,
			state: z.enum(outboxStates.filter((state) => state !== "NEEDS_REAPPROVAL") as Unvoided[]),
			stateReason: z.null(),
		}),
		z.strictObject({
			...outboxFields,
			state: z.literal("NEEDS_REAPPROVAL"),
			stateReason: StateReason,
		}),
	])
	.meta({
		id: "draftyak.entities.OutboxItem",
		description:
			"A frozen send proposal of a draft revision. contentHash and flagsHash cover its " +
			"snapshot and the flags the owner saw; notBefore and deliverBy bound when it may send, " +
			"and requiredApprovals counts the approvals it needs.",
	});
export type OutboxItem = z.infer<typeof OutboxItem>;
