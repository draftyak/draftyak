import {
	ackRequired,
	type Flag,
	FlagCode,
	FlagsError,
	type FlagsErrorCode,
	flagSeverity,
	flagsHash,
} from "../../src/flags.ts";
import { sha256Hex } from "../../src/hash.ts";
import { canonicalize } from "../../src/jcs.ts";
import type { VectorFile } from "../vectors.ts";

const format = "draftyak.vectors.flags.v1";
const hex = (text: string): string => Buffer.from(text, "utf8").toString("hex");

const flag = (code: FlagCode, detail?: string): Flag =>
	(detail === undefined
		? { code, severity: flagSeverity(code) }
		: { code, severity: flagSeverity(code), detail }) as Flag;

// `sorted` is written out by hand: the order whose JCS flagsHash must hash.
function hashed(id: string, flags: readonly Flag[], sorted: readonly Flag[]): object {
	const canonical = canonicalize(sorted);
	const digest = flagsHash(flags);
	if (sha256Hex(canonical) !== digest) throw new Error(`flags ${id}: ${canonical} isn't hashed`);
	const ack = ackRequired(flags);
	return { id, flags, sorted, canonicalHex: hex(canonical), flagsHash: digest, ackRequired: ack };
}

const single = (id: string, one: Flag): object => hashed(id, [one], [one]);

function refused(id: string, flags: unknown, error: FlagsErrorCode): object {
	try {
		flagsHash(flags as Flag[]);
	} catch (thrown) {
		if (thrown instanceof FlagsError && thrown.code === error) return { id, flags, error };
		throw thrown;
	}
	throw new Error(`flags ${id}: accepted`);
}

const invalid = (id: string, flags: unknown): object => refused(id, flags, "FLAGS_INVALID");

function cases(): object[] {
	const ana = flag("NEW_RECIPIENT", "ana@example.com");
	const mixed = [
		flag("TOOL_CONTEXT_USED", "calendar.freebusy from calendar.example.com"),
		flag("AGENT_AUTHORED"),
		flag("EXTERNAL_LINK", "example.net"),
		flag("NEW_RECIPIENT", "bo@example.org"),
		flag("DMARC_FAIL"),
	];
	const mixedSorted = [mixed[1], mixed[4], mixed[2], mixed[3], mixed[0]] as Flag[];
	const links = ["b.example", undefined, "a.example", "B.example"].map((host) =>
		flag("EXTERNAL_LINK", host),
	);
	// UTF-16 code units: U+00E9 < U+1F600 (0xD83D) < U+FF61, where UTF-8 bytes put U+FF61 second.
	const units = ["\u{ff61}", "\u{1f600}", "\u{e9}"].map((host) => flag("EXTERNAL_LINK", host));
	const every = FlagCode.options.map((code) => flag(code));
	const escapes = 'quote " backslash \\ tab \t line\nfeed';
	return [
		hashed("empty", [], []),
		single("one-ack", ana),
		single("one-detail-byte-changed", flag("NEW_RECIPIENT", "ana@example.con")),
		single("one-info", mixed[0] as Flag),
		hashed(
			"advisory-only",
			[flag("TOOL_INSTRUCTIONS", "kb.lookup"), flag("SUSPECTED_INSTRUCTIONS")],
			[flag("SUSPECTED_INSTRUCTIONS"), flag("TOOL_INSTRUCTIONS", "kb.lookup")],
		),
		single("code-changed", flag("SUSPECTED_INSTRUCTIONS")),
		single("code-changed-other", flag("TOOL_INSTRUCTIONS")),
		hashed("mixed", mixed, mixedSorted),
		hashed("mixed-other-order", mixed.toReversed(), mixedSorted),
		hashed("same-code-by-detail", links, [links[1], links[3], links[2], links[0]] as Flag[]),
		hashed("detail-by-utf16-code-units", units, [units[2], units[1], units[0]] as Flag[]),
		single("detail-escapes", flag("SECRET_PATTERN", escapes)),
		single("detail-1000-astral-code-points", flag("SECRET_PATTERN", "\u{1f600}".repeat(1000))),
		hashed(
			"every-code",
			every.toReversed(),
			every.toSorted((a, b) => (a.code < b.code ? -1 : 1)),
		),
		invalid("unknown-code", [{ code: "NEW_SENDER", severity: "ack" }]),
		invalid("ack-code-as-info", [{ code: "NEW_RECIPIENT", severity: "info" }]),
		invalid("advisory-code-as-ack", [{ code: "SUSPECTED_INSTRUCTIONS", severity: "ack" }]),
		invalid("unknown-severity", [{ code: "NEW_RECIPIENT", severity: "warn" }]),
		invalid("missing-severity", [{ code: "NEW_RECIPIENT" }]),
		invalid("unknown-member", [{ ...ana, note: "x" }]),
		invalid("empty-detail", [{ ...ana, detail: "" }]),
		invalid("null-detail", [{ ...ana, detail: null }]),
		invalid("detail-not-a-string", [{ ...ana, detail: 7 }]),
		invalid("detail-1001-code-points", [{ ...ana, detail: "a".repeat(1001) }]),
		invalid("not-a-list", ana),
		invalid("flag-not-an-object", ["NEW_RECIPIENT"]),
		invalid("positional-flag", [["NEW_RECIPIENT", "ack"]]),
		invalid("object-form-code", [{ code: { NEW_RECIPIENT: null }, severity: "ack" }]),
		invalid("object-form-severity", [{ code: "NEW_RECIPIENT", severity: { ack: null } }]),
		refused("duplicate", [links[0], links[0]], "FLAGS_DUPLICATE"),
		refused("duplicate-without-detail", [every[3], every[3]], "FLAGS_DUPLICATE"),
	];
}

export function generate(): VectorFile[] {
	const catalogue = {
		format,
		description:
			"The flag catalogue in order: every code with its severity. A flag with a severity other " +
			"than its code's is refused (FLAGS_INVALID).",
		codes: FlagCode.options.map((code) => ({ code, severity: flagSeverity(code) })),
	};
	const description =
		'flagsHash. A case with "flagsHash" gives "flags" as listed and "sorted", the same flags ' +
		"ordered by code, then detail (a flag without one first), comparing UTF-16 code units as JCS " +
		'sorts member names; "canonicalHex" is the UTF-8 of the JCS of "sorted", "flagsHash" its ' +
		'SHA-256, and "ackRequired" whether any flag is ack. A case with "error" is refused with ' +
		"that code: FLAGS_INVALID for anything but a list of catalogue flags with their own " +
		"severity and an optional detail of 1 to 1,000 Unicode scalar values, FLAGS_DUPLICATE for " +
		"two flags with the same code and detail.";
	return [
		{ path: "flags/catalogue.json", content: catalogue },
		{ path: "flags/flags-hash.json", content: { format, description, cases: cases() } },
	];
}
