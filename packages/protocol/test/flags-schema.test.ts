import * as legacy from "@draftyak/protocol/flags";
import * as schema from "@draftyak/protocol/flags-schema";
import { Flag, FlagCode, FlagSeverity, Flags, flagSeverity } from "@draftyak/protocol/flags-schema";
import { describe, expect, it } from "vitest";

const catalogue = [
	["NEW_RECIPIENT", "ack"],
	["RECIPIENT_ADDED_BY_AGENT", "ack"],
	["REPLY_TO_REDIRECT", "ack"],
	["AGENT_AUTHORED", "ack"],
	["DMARC_FAIL", "ack"],
	["EXTERNAL_LINK", "ack"],
	["AGENT_INSERTED_CONTACT", "ack"],
	["ATTACHMENT_ADDED_BY_AGENT", "ack"],
	["INVISIBLE_CHARS", "ack"],
	["MASS_MENTION", "ack"],
	["CROSS_THREAD_DATA", "ack"],
	["SECRET_PATTERN", "ack"],
	["SUSPECTED_INSTRUCTIONS", "advisory"],
	["TOOL_DATA_IN_BODY", "ack"],
	["TOOL_CONTEXT_USED", "info"],
	["TOOL_INSTRUCTIONS", "advisory"],
] as const;
const severities = ["ack", "info", "advisory"] as const;

describe("the public flags-schema entry", () => {
	it("shares the original schema objects and severity function with the flags entry", () => {
		expect(FlagCode).toBe(legacy.FlagCode);
		expect(FlagSeverity).toBe(legacy.FlagSeverity);
		expect(Flag).toBe(legacy.Flag);
		expect(Flags).toBe(legacy.Flags);
		expect(flagSeverity).toBe(legacy.flagSeverity);
	});

	it("exports the schema surface without the hashing or acknowledgement functions", () => {
		expect(Object.keys(schema).sort()).toEqual(
			["Flag", "FlagCode", "FlagSeverity", "Flags", "flagSeverity"].sort(),
		);
	});

	it("retains the public flag types in both import directions", () => {
		const current: Flag = Flag.parse({ code: "DMARC_FAIL", severity: "ack" });
		const old: legacy.Flag = current;
		const returned: Flag = legacy.Flag.parse(old);
		const oldCode: legacy.FlagCode = FlagCode.parse("DMARC_FAIL");
		const currentCode: FlagCode = legacy.FlagCode.parse(oldCode);
		const oldSeverity: legacy.FlagSeverity = FlagSeverity.parse("ack");
		const currentSeverity: FlagSeverity = legacy.FlagSeverity.parse(oldSeverity);
		expect(returned).toEqual(current);
		expect(currentCode).toBe("DMARC_FAIL");
		expect(currentSeverity).toBe("ack");
	});

	it("retains the canonical catalogue order, schema identities and set metadata", () => {
		expect(FlagCode.options).toEqual(catalogue.map(([code]) => code));
		expect(FlagSeverity.options).toEqual(severities);
		expect(FlagCode.meta()?.id).toBe("draftyak.flags.FlagCode");
		expect(FlagSeverity.meta()?.id).toBe("draftyak.flags.FlagSeverity");
		expect(Flag.meta()?.id).toBe("draftyak.flags.Flag");
		expect(Flags.meta()?.uniqueItems).toBe(true);
	});

	it.each(catalogue)("accepts %s only at its canonical %s severity", (code, severity) => {
		const flag = { code, severity };
		expect(FlagCode.safeParse(code).success).toBe(true);
		expect(flagSeverity(code)).toBe(severity);
		expect(Flag.parse(flag)).toEqual(flag);
		expect(Flags.parse([flag])).toEqual([flag]);
		for (const wrong of severities.filter((value) => value !== severity)) {
			expect(Flag.safeParse({ code, severity: wrong }).success).toBe(false);
			expect(Flags.safeParse([{ code, severity: wrong }]).success).toBe(false);
		}
	});
});

describe("the extracted canonical detail boundary", () => {
	it.each([
		["one scalar", "x"],
		["one thousand ASCII scalars", "x".repeat(1000)],
		["one thousand astral scalars", "\u{1f600}".repeat(1000)],
		["one thousand mixed scalars", "\u{1f600}".repeat(999) + "x"],
	])("preserves %s without a UTF-16-length substitute", (_name, detail) => {
		const flag = { code: "SECRET_PATTERN", severity: "ack", detail };
		expect(Flag.parse(flag)).toEqual(flag);
		expect(Flags.parse([flag])).toEqual([flag]);
	});

	const refusals: ReadonlyArray<readonly [string, unknown]> = [
		["empty detail", ""],
		["one thousand and one ASCII scalars", "x".repeat(1001)],
		["one thousand and one astral scalars", "\u{1f600}".repeat(1001)],
		["one thousand and one mixed scalars", "\u{1f600}".repeat(1000) + "x"],
		["lone high surrogate", "x\ud800"],
		["lone low surrogate", "\udc00y"],
		["reversed surrogate pair", "a\udc00\ud800b"],
		["null", null],
		["a number", 1],
		["a boolean", true],
		["an object", {}],
		["an array", []],
	];
	it.each(refusals)("refuses %s through both canonical schemas", (_name, detail) => {
		const flag = { code: "SECRET_PATTERN", severity: "ack", detail };
		expect(Flag.safeParse(flag).success).toBe(false);
		expect(Flags.safeParse([flag]).success).toBe(false);
	});
});

describe("strict flag records and sets through the new entry", () => {
	const malformed: ReadonlyArray<readonly [string, unknown]> = [
		["an unknown code", { code: "NEW_SENDER", severity: "ack" }],
		["a missing code", { severity: "ack" }],
		["a missing severity", { code: "NEW_RECIPIENT" }],
		["an extra member", { code: "NEW_RECIPIENT", severity: "ack", extra: true }],
		["a scalar", "NEW_RECIPIENT"],
		["null", null],
		["an array", []],
		["a coerced severity", { code: "DMARC_FAIL", severity: Object("ack") }],
	];
	it.each(malformed)("refuses %s rather than projecting a partial flag", (_name, value) => {
		expect(Flag.safeParse(value).success).toBe(false);
		expect(Flags.safeParse([value]).success).toBe(false);
	});

	it("accepts the empty set and the complete valid catalogue", () => {
		expect(Flags.parse([])).toEqual([]);
		const all = catalogue.map(([code, severity]) => ({ code, severity }));
		expect(Flags.parse(all)).toEqual(all);
	});

	it.each([
		[
			"identical references",
			() => {
				const flag = { code: "DMARC_FAIL", severity: "ack" };
				return [flag, flag];
			},
		],
		[
			"equal fresh records",
			() => [
				{ code: "EXTERNAL_LINK", severity: "ack", detail: "same.example" },
				{ code: "EXTERNAL_LINK", severity: "ack", detail: "same.example" },
			],
		],
		[
			"duplicates separated by another flag",
			() => [
				{ code: "EXTERNAL_LINK", severity: "ack", detail: "same.example" },
				{ code: "DMARC_FAIL", severity: "ack" },
				{ code: "EXTERNAL_LINK", severity: "ack", detail: "same.example" },
			],
		],
	] as const)("refuses %s as a repeated code-and-detail pair", (_name, makeFlags) => {
		expect(Flags.safeParse(makeFlags()).success).toBe(false);
	});

	it("treats an absent detail and explicit undefined as the same set member", () => {
		expect(
			Flags.safeParse([
				{ code: "DMARC_FAIL", severity: "ack" },
				{ code: "DMARC_FAIL", severity: "ack", detail: undefined },
			]).success,
		).toBe(false);
	});

	it("keeps genuinely different details for the same code", () => {
		const flags = [
			{ code: "EXTERNAL_LINK", severity: "ack" },
			{ code: "EXTERNAL_LINK", severity: "ack", detail: "a.example" },
			{ code: "EXTERNAL_LINK", severity: "ack", detail: "b.example" },
		];
		expect(Flags.parse(flags)).toEqual(flags);
	});

	it("keeps equal detail text when the codes are different", () => {
		const flags = [
			{ code: "EXTERNAL_LINK", severity: "ack", detail: "same" },
			{ code: "NEW_RECIPIENT", severity: "ack", detail: "same" },
		];
		expect(Flags.parse(flags)).toEqual(flags);
	});

	it("does not normalize distinct scalar sequences into a duplicate", () => {
		const flags = [
			{ code: "EXTERNAL_LINK", severity: "ack", detail: "\u00e9" },
			{ code: "EXTERNAL_LINK", severity: "ack", detail: "e\u0301" },
		];
		expect(Flags.parse(flags)).toEqual(flags);
	});

	it("preserves supplied order and data without sorting or mutating frozen inputs", () => {
		const flags = Object.freeze([
			Object.freeze({ code: "TOOL_CONTEXT_USED", severity: "info", detail: "second" }),
			Object.freeze({ code: "AGENT_AUTHORED", severity: "ack", detail: "first" }),
		]);
		const before = JSON.stringify(flags);
		expect(Flags.parse(flags)).toEqual(flags);
		expect(JSON.stringify(flags)).toBe(before);
	});
});
