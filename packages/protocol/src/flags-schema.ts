import * as z from "zod";
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
