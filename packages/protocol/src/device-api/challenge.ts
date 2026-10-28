import * as z from "zod";
import { CONFIRMATION_PRESETS } from "../entities/device.ts";
import type { FlagCode } from "../flags.ts";
import { canonicalize } from "../jcs.ts";
import { Ulid } from "../scalars.ts";
import {
	checkFlagsAcked,
	checkSendWindow,
	FlagsAcked,
	matchesAgentSessionPending,
	type SendStatement,
} from "../statements.ts";
import {
	ChallengeContext,
	decodeDeviceStatement,
	presetFitsRole,
	StatementText,
} from "./common.ts";
import { OperationReview, SendReview } from "./review.ts";

export type ChallengeRequest =
	| {
			readonly kind: "approval.send.v1";
			readonly id: string;
			readonly flagsAcked: readonly FlagCode[];
	  }
	| { readonly kind: "pair-confirm.v1"; readonly id: string }
	| { readonly kind: "agent-session.v1"; readonly id: string };
export const ChallengeRequest: z.ZodType<ChallengeRequest> = z
	.discriminatedUnion("kind", [
		z.strictObject({ kind: z.literal("approval.send.v1"), id: Ulid, flagsAcked: FlagsAcked }),
		z.strictObject({ kind: z.literal("pair-confirm.v1"), id: Ulid }),
		z.strictObject({ kind: z.literal("agent-session.v1"), id: Ulid }),
	])
	.meta({ id: "draftyak.device-api.ChallengeRequest" });
export type Challenge = {
	readonly kind: "approval.send.v1" | "pair-confirm.v1" | "agent-session.v1";
	readonly id: string;
	readonly statement: string;
};
export const Challenge: z.ZodType<Challenge> = z
	.discriminatedUnion("kind", [
		z.strictObject({ kind: z.literal("approval.send.v1"), id: Ulid, statement: StatementText }),
		z.strictObject({ kind: z.literal("pair-confirm.v1"), id: Ulid, statement: StatementText }),
		z.strictObject({ kind: z.literal("agent-session.v1"), id: Ulid, statement: StatementText }),
	])
	.refine((value) => decodeDeviceStatement(value.kind, value.statement) !== undefined, {
		message: "statement must match challenge kind",
	})
	.meta({ id: "draftyak.device-api.Challenge" });

export function checkChallenge(
	challenge: unknown,
	review: unknown,
	request: unknown,
	context: { hub: string; device: string },
): boolean {
	try {
		const c = Challenge.safeParse(challenge),
			r = ChallengeRequest.safeParse(request),
			identity = ChallengeContext.safeParse(context);
		if (
			!c.success ||
			!r.success ||
			!identity.success ||
			c.data.kind !== r.data.kind ||
			c.data.id !== r.data.id
		)
			return false;
		const statement = decodeDeviceStatement(c.data.kind, c.data.statement);
		if (
			statement === undefined ||
			statement.hub !== identity.data.hub ||
			statement.device !== identity.data.device
		)
			return false;
		if (r.data.kind === "approval.send.v1") {
			const parsed = SendReview.safeParse(review);
			if (!parsed.success || parsed.data.id !== r.data.id) return false;
			const item = parsed.data;
			return (
				item.snapshot.hub === statement.hub &&
				item.snapshot.epoch === statement.epoch &&
				item.snapshot.outbox === statement.outbox &&
				statement.outbox === r.data.id &&
				statement.contentHash === item.contentHash &&
				statement.flagsHash === item.flagsHash &&
				canonicalize(statement.flagsAcked) === canonicalize(r.data.flagsAcked) &&
				checkSendWindow(statement as unknown as SendStatement, item.snapshot) &&
				checkFlagsAcked(statement as unknown as SendStatement, item.flags)
			);
		}
		const parsed = OperationReview.safeParse(review);
		if (!parsed.success || parsed.data.id !== r.data.id) return false;
		if (r.data.kind === "agent-session.v1")
			return (
				parsed.data.kind === "agent-session" &&
				matchesAgentSessionPending(statement, {
					session: parsed.data.id,
					subject: parsed.data.subject,
				})
			);
		if (parsed.data.kind !== "pair-confirm") return false;
		const subject = parsed.data.subject;
		return (
			presetFitsRole(subject.preset, String(statement.role)) &&
			statement.candidate === subject.candidate &&
			statement.role === subject.role &&
			statement.transportSpkiSha256 === subject.transportSpkiSha256 &&
			statement.signingKey === subject.signingKey &&
			canonicalize(statement.capabilities) === canonicalize(CONFIRMATION_PRESETS[subject.preset])
		);
	} catch {
		return false;
	}
}
