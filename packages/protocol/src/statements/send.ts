import * as z from "zod";
import { Flag, FlagCode, FlagsError, flagsHash } from "../flags.ts";
import { Sha256Hex, Ulid, UtcMs } from "../scalars.ts";
import { CurrentSendSnapshotV1, type SendSnapshotV1, sendWindow } from "../snapshot.ts";
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
const flagList = z.array(Flag);
function checkedFlags(flags: readonly Flag[]): Flag[] {
	const parsed = flagList.safeParse(flags);
	if (!parsed.success) {
		// Preserve flag diagnostics without letting a diagnostic reread admit a failed projection.
		flagsHash(flags);
		throw new FlagsError("FLAGS_INVALID", "invalid flag set");
	}
	flagsHash(parsed.data);
	return parsed.data;
}
function ackCodes(flags: readonly Flag[]): FlagCode[] {
	return [
		...new Set(flags.filter((flag) => flag.severity === "ack").map((flag) => flag.code)),
	].sort();
}
export function requiredAckCodes(flags: readonly Flag[]): FlagCode[] {
	return ackCodes(checkedFlags(flags));
}
export function checkFlagsAcked(statement: SendStatement, flags: readonly Flag[]): boolean {
	try {
		const parsed = SendStatement.safeParse(statement);
		if (!parsed.success) return false;
		const projectedFlags = checkedFlags(flags);
		return (
			parsed.data.flagsHash === flagsHash(projectedFlags) &&
			ackCodes(projectedFlags).every((code) => parsed.data.flagsAcked.includes(code))
		);
	} catch {
		return false;
	}
}
export function checkSendWindow(statement: SendStatement, snapshot: SendSnapshotV1): boolean {
	try {
		const parsed = SendStatement.safeParse(statement);
		const current = CurrentSendSnapshotV1.safeParse(snapshot);
		if (!parsed.success || !current.success) return false;
		const window = sendWindow(current.data, parsed.data.iat);
		return (
			parsed.data.notBefore === (window.notBefore ?? null) &&
			parsed.data.deliverBy === window.deliverBy
		);
	} catch {
		return false;
	}
}

export const SendDefinition: {
	readonly typ: "approval.send.v1";
	readonly schema: typeof SendStatement;
} = { typ: "approval.send.v1", schema: SendStatement };
