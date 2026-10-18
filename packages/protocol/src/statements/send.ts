import * as z from "zod";
import { type Flag, FlagCode, flagsHash } from "../flags.ts";
import { Sha256Hex, Ulid, UtcMs } from "../scalars.ts";
import { type SendSnapshotV1, sendWindow } from "../snapshot.ts";
import { baseFields, type DeviceStatementBase, withLifetime } from "./common.ts";
export interface SendStatement extends DeviceStatementBase {
	readonly outbox: string;
	readonly contentHash: string;
	readonly flagsHash: string;
	readonly flagsAcked: readonly FlagCode[];
	readonly notBefore: number | null;
	readonly deliverBy: number;
}
export const FlagsAcked: z.ZodType<readonly FlagCode[]> = z
	.array(FlagCode)
	.max(16)
	.refine(
		(codes) => codes.every((code, index) => index === 0 || (codes[index - 1] as string) < code),
		{ message: "sorted unique flag codes" },
	);
export const SendStatement: z.ZodType<SendStatement> = withLifetime(
	z.strictObject({
		...baseFields,
		outbox: Ulid,
		contentHash: Sha256Hex,
		flagsHash: Sha256Hex,
		flagsAcked: FlagsAcked,
		notBefore: UtcMs.nullable(),
		deliverBy: UtcMs,
	}),
);
export function requiredAckCodes(flags: readonly Flag[]): FlagCode[] {
	flagsHash(flags);
	return [
		...new Set(flags.filter((flag) => flag.severity === "ack").map((flag) => flag.code)),
	].sort();
}
export function checkFlagsAcked(statement: SendStatement, flags: readonly Flag[]): boolean {
	try {
		return (
			SendStatement.safeParse(statement).success &&
			statement.flagsHash === flagsHash(flags) &&
			requiredAckCodes(flags).every((code) => statement.flagsAcked.includes(code))
		);
	} catch {
		return false;
	}
}
export function checkSendWindow(statement: SendStatement, snapshot: SendSnapshotV1): boolean {
	try {
		if (!SendStatement.safeParse(statement).success) return false;
		const window = sendWindow(snapshot, statement.iat);
		return (
			statement.notBefore === (window.notBefore ?? null) && statement.deliverBy === window.deliverBy
		);
	} catch {
		return false;
	}
}

export const SendDefinition: {
	readonly typ: "approval.send.v1";
	readonly schema: typeof SendStatement;
} = { typ: "approval.send.v1", schema: SendStatement };
