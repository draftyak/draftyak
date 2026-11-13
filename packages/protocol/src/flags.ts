import * as z from "zod";
import { Flag, FlagCode, FlagSeverity, flagSeverity } from "./flags-schema.ts";
import { sha256Hex } from "./hash.ts";
import { canonicalize } from "./jcs.ts";

export { Flag, FlagCode, FlagSeverity, Flags, flagSeverity } from "./flags-schema.ts";

export type FlagsErrorCode = "FLAGS_INVALID" | "FLAGS_DUPLICATE";

export class FlagsError extends Error {
	override name = "FlagsError";
	readonly code: FlagsErrorCode;

	constructor(code: FlagsErrorCode, message: string) {
		super(`${code}: ${message}`);
		this.code = code;
	}
}

const flagList = z.array(Flag);
// UTF-16 code units, as JCS sorts member names.
const compare = (a: string, b: string): number => (a < b ? -1 : Number(a > b));
const byCodeThenDetail = (a: Flag, b: Flag): number =>
	compare(a.code, b.code) || compare(a.detail ?? "", b.detail ?? "");

// Why a list isn't a list of flags, naming a severity that isn't its code's as such. Unknown
// members are counted, never named, so no text the input chose reaches the message.
function reason(flags: unknown, issue: z.core.$ZodIssue | undefined): string {
	const at = issue?.path[0];
	const flag: unknown = Array.isArray(flags) && typeof at === "number" ? flags[at] : undefined;
	const { code, severity } = (typeof flag === "object" && flag !== null ? flag : {}) as Flag;
	const own = FlagCode.safeParse(code).success ? flagSeverity(code) : undefined;
	if (own !== undefined && FlagSeverity.safeParse(severity).success && severity !== own) {
		return `${String(at)}.severity: ${code} is ${own}`;
	}
	const path = issue?.path.map(String).join(".");
	const what =
		issue?.code === "unrecognized_keys" ? `${issue.keys.length} unknown member(s)` : issue?.message;
	return path ? `${path}: ${what}` : `${what}`;
}

// The flags as a checked set, sorted by code, then detail (none first), each with only its own
// members, so every language hashes the same bytes.
function sortedFlags(flags: unknown): Flag[] {
	const parsed = flagList.safeParse(flags);
	if (!parsed.success) throw new FlagsError("FLAGS_INVALID", reason(flags, parsed.error.issues[0]));
	const sorted = parsed.data
		.map(
			({ code, severity, detail }) =>
				(detail === undefined ? { code, severity } : { code, severity, detail }) as Flag,
		)
		.toSorted(byCodeThenDetail);
	sorted.forEach((flag, at) => {
		const before = sorted[at - 1];
		if (before !== undefined && byCodeThenDetail(before, flag) === 0) {
			throw new FlagsError("FLAGS_DUPLICATE", `${flag.code} repeats with the same detail`);
		}
	});
	return sorted;
}

// The SHA-256 of the JCS of the flags sorted by code, then detail, which the approval binds.
export function flagsHash(flags: readonly Flag[]): string {
	return sha256Hex(canonicalize(sortedFlags(flags)));
}

// Whether the owner must acknowledge the flags before the PIN: any ack flag.
export function ackRequired(flags: readonly Flag[]): boolean {
	return sortedFlags(flags).some((flag) => flag.severity === "ack");
}
