import * as z from "zod";
import { sha256Hex } from "./hash.ts";
import { canonicalize } from "./jcs.ts";
import { boundedText } from "./scalars.ts";

// The catalogue, in spec/flags-v1.md's order. It is closed: a new code is a new major (flags-v2).
const flagCodes = [
	"NEW_RECIPIENT",
	"RECIPIENT_ADDED_BY_AGENT",
	"REPLY_TO_REDIRECT",
	"AGENT_AUTHORED",
	"DMARC_FAIL",
	"EXTERNAL_LINK",
	"AGENT_INSERTED_CONTACT",
	"ATTACHMENT_ADDED_BY_AGENT",
	"INVISIBLE_CHARS",
	"MASS_MENTION",
	"CROSS_THREAD_DATA",
	"SECRET_PATTERN",
	"SUSPECTED_INSTRUCTIONS",
	"TOOL_DATA_IN_BODY",
	"TOOL_CONTEXT_USED",
	"TOOL_INSTRUCTIONS",
] as const;
export type FlagCode = (typeof flagCodes)[number];
export const FlagCode: z.ZodEnum<z.core.util.ToEnum<FlagCode>> = z.enum(flagCodes).meta({
	id: "draftyak.flags.FlagCode",
	description: "A flag in the catalogue of spec/flags-v1.md.",
});

const flagSeverities = ["ack", "info", "advisory"] as const;
export type FlagSeverity = (typeof flagSeverities)[number];
export const FlagSeverity: z.ZodEnum<z.core.util.ToEnum<FlagSeverity>> = z
	.enum(flagSeverities)
	.meta({
		id: "draftyak.flags.FlagSeverity",
		description:
			"ack needs the owner's explicit acknowledgement before the PIN; info and advisory are " +
			"shown without one.",
	});

// Every flag is ack unless listed here.
type InfoCode = "TOOL_CONTEXT_USED";
type AdvisoryCode = "SUSPECTED_INSTRUCTIONS" | "TOOL_INSTRUCTIONS";
type AckCode = Exclude<FlagCode, InfoCode | AdvisoryCode>;
const lighter: Readonly<Record<InfoCode | AdvisoryCode, FlagSeverity>> = {
	TOOL_CONTEXT_USED: "info",
	SUSPECTED_INSTRUCTIONS: "advisory",
	TOOL_INSTRUCTIONS: "advisory",
};

export function flagSeverity(code: FlagCode): FlagSeverity {
	return Object.hasOwn(lighter, code) ? lighter[code as keyof typeof lighter] : "ack";
}

// Unicode scalar values, as Rust's strings hold: boundedText refuses a lone surrogate.
const FlagDetail = boundedText(1000).min(1);

type FlagOf<C extends FlagCode, S extends FlagSeverity> = z.ZodObject<
	{
		code: z.ZodEnum<z.core.util.ToEnum<C>>;
		severity: z.ZodLiteral<S>;
		detail: z.ZodOptional<z.ZodString>;
	},
	z.core.$strict
>;

// One object per severity, each taking exactly the codes of that severity, so a flag can't carry
// another severity than its code's in any language.
const flagOf = <C extends FlagCode, S extends FlagSeverity>(severity: S): FlagOf<C, S> =>
	z.strictObject({
		code: z.enum(flagCodes.filter((code) => flagSeverity(code) === severity) as [C, ...C[]]),
		severity: z.literal(severity),
		detail: FlagDetail.optional(),
	});

export const Flag: z.ZodDiscriminatedUnion<
	[FlagOf<AckCode, "ack">, FlagOf<InfoCode, "info">, FlagOf<AdvisoryCode, "advisory">],
	"severity"
> = z
	.discriminatedUnion("severity", [
		flagOf<AckCode, "ack">("ack"),
		flagOf<InfoCode, "info">("info"),
		flagOf<AdvisoryCode, "advisory">("advisory"),
	])
	.meta({
		id: "draftyak.flags.Flag",
		description:
			"A flag on a draft revision: its code, the code's severity, and an optional detail " +
			"(1 to 1,000 Unicode scalar values) that the composer and the approval window show " +
			"as data.",
	});
export type Flag = z.infer<typeof Flag>;

const flagKey = (flag: Flag): string => JSON.stringify([flag.code, flag.detail ?? null]);

// A set: no two flags share their code and detail, which with one severity per code is JSON
// Schema's uniqueItems.
export const Flags: z.ZodArray<typeof Flag> = z
	.array(Flag)
	.refine((flags) => new Set(flags.map(flagKey)).size === flags.length, {
		message: "two flags share a code and detail",
	})
	.meta({
		uniqueItems: true,
		description: "A revision's flags, in any order; flagsHash sorts them.",
	});

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
