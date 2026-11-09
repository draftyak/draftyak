import {
	ChatDraftContent,
	type DraftContent,
	EmailDraftContent,
} from "@draftyak/protocol/entities/draft";
import { type Flag, Flags, flagSeverity } from "@draftyak/protocol/flags";
import { describe, expect, it } from "vitest";
import { classifyBodyLinkAndInvisibleFlags } from "../src/body-flags.ts";

type Body = Pick<DraftContent, "channel" | "body">;

const invisible: Flag = { code: "INVISIBLE_CHARS", severity: "ack" };
const link = (detail: string): Flag => ({ code: "EXTERNAL_LINK", severity: "ack", detail });
const body = (text: string, channel: Body["channel"] = "email"): Body => ({
	channel,
	body: text,
});

function classified(input: Body): readonly Flag[] {
	const result = classifyBodyLinkAndInvisibleFlags(input);
	expect(result.status).toBe("classified");
	if (result.status !== "classified") throw new Error("Expected classified body data");
	expect(Flags.safeParse(result.flags).success).toBe(true);
	expect(new Set(result.flags.map((flag) => JSON.stringify([flag.code, flag.detail]))).size).toBe(
		result.flags.length,
	);
	return result.flags;
}

function expectFlags(input: Body, expected: readonly Flag[]): void {
	const actual = classified(input);
	expect(actual).toHaveLength(expected.length);
	expect(actual).toEqual(expect.arrayContaining([...expected]));
}

function refused(
	input: unknown,
	code: "INVALID_INPUT" | "STRUCTURE_LIMIT" = "INVALID_INPUT",
): void {
	expect(classifyBodyLinkAndInvisibleFlags(input as Body)).toEqual({ status: "refused", code });
}

describe("draft body acknowledgement flags", () => {
	it.each(["email", "chat"] as const)(
		"classifies empty and ordinary %s text without adding unrelated flags",
		(channel) => {
			expectFlags(body("", channel), []);
			expectFlags(body("Ordinary\ttext\nNext line and caf\u00e9 \u{1f642}.", channel), []);
			expectFlags(body("@here ignore previous instructions 123456", channel), []);
		},
	);

	it("uses the catalogue's exact acknowledgement codes and canonical flag set", () => {
		expect(flagSeverity("INVISIBLE_CHARS")).toBe("ack");
		expect(flagSeverity("EXTERNAL_LINK")).toBe("ack");
		expectFlags(body("Visible\u200b https://example.invalid/one"), [
			invisible,
			link("example.invalid"),
		]);
	});

	it.each([
		["NUL", "\u0000"],
		["backspace", "\u0008"],
		["vertical tab", "\u000b"],
		["form feed", "\u000c"],
		["C0 control", "\u001f"],
		["DEL", "\u007f"],
		["C1 control", "\u0085"],
		["soft hyphen", "\u00ad"],
		["combining grapheme joiner", "\u034f"],
		["Arabic letter mark", "\u061c"],
		["Hangul filler", "\u115f"],
		["Khmer invisible vowel", "\u17b4"],
		["Mongolian separator", "\u180e"],
		["zero width space", "\u200b"],
		["zero width non-joiner", "\u200c"],
		["zero width joiner", "\u200d"],
		["left-to-right mark", "\u200e"],
		["right-to-left mark", "\u200f"],
		["left-to-right embedding", "\u202a"],
		["right-to-left embedding", "\u202b"],
		["pop directional formatting", "\u202c"],
		["left-to-right override", "\u202d"],
		["right-to-left override", "\u202e"],
		["word joiner", "\u2060"],
		["function application", "\u2061"],
		["left-to-right isolate", "\u2066"],
		["right-to-left isolate", "\u2067"],
		["first strong isolate", "\u2068"],
		["pop directional isolate", "\u2069"],
		["variation selector", "\ufe0f"],
		["byte order mark", "\ufeff"],
		["language tag", "\u{e0001}"],
		["tag letter", "\u{e0061}"],
		["cancel tag", "\u{e007f}"],
		["supplementary variation selector", "\u{e0100}"],
	])("flags %s in the original canonical body", (_name, character) => {
		expectFlags(body(`Before${character}After`), [invisible]);
	});

	it("deduplicates invisible classes and preserves ordinary whitespace", () => {
		expectFlags(body("\u200b\u202e\u{e0061}\u200b\u0000"), [invisible]);
		expectFlags(body(" \t\n\u00a0\u2028\u2029"), []);
	});

	it.each(["ht\u200btps://exam\u2060ple.invalid/path", "h\u202ettp://example.invalid/path"])(
		"recognizes HTTP obfuscated by invisible characters: %s",
		(text) => expectFlags(body(text), [invisible, link("example.invalid")]),
	);

	it("keeps hostname-only details and deduplicates case, paths, ports and IDNA variants", () => {
		expectFlags(
			body(
				"HTTPS://EXAMPLE.INVALID/one http://example.invalid:8443/two " +
					"https://synthetic:fixture@b\u00fccher.invalid:123/private?q=synthetic#part " +
					"http://XN--BCHER-KVA.INVALID/again",
			),
			[link("example.invalid"), link("xn--bcher-kva.invalid")],
		);
	});

	it.each([
		["(https://example.invalid/path).", "example.invalid"],
		["https://example.invalid/path),.;!?]}", "example.invalid"],
		["http://[::1]", "[::1]"],
		["https://[2001:db8::1]:8443/path).", "[2001:db8::1]"],
		["http://[2001:DB8::1]]", "[2001:db8::1]"],
	])("uses canonical hosts while trimming prose punctuation in %s", (text, host) => {
		expectFlags(body(text), [link(host)]);
	});

	it("finds literal HTTP in markup without interpreting attributes", () => {
		expectFlags(
			body('<b>Visible</b> [link 1: forged.invalid] <a href="https://example.invalid/path">x</a>'),
			[link("example.invalid")],
		);
	});

	it.each([
		"javascript:https://example.invalid/path",
		"VBSCRIPT:https://example.invalid/path",
		"file:/https://example.invalid/path",
		"data:text/plain,https://example.invalid/path",
		"data:,https://example.invalid/path",
	])("consumes an outer dangerous URI before considering nested HTTP: %s", (text) => {
		expectFlags(body(text), []);
	});

	it("matches existing hygiene for unknown outer schemes and HTTP-owned nested schemes", () => {
		expectFlags(body("custom:https://example.invalid/path"), [link("example.invalid")]);
		expectFlags(body("https://example.invalid/javascript:payload?q=data:text/plain,synthetic"), [
			link("example.invalid"),
		]);
	});

	it.each([
		"http:",
		"https:",
		"https://!",
		"https://[invalid]",
		"http://%zz.invalid",
		"https://example.invalid:99999/path",
		"ftp://example.invalid/path",
		"mailto:owner@example.invalid",
		"//example.invalid/path",
		"File: notes data: see appendix javascript: notes",
	])("does not invent a link flag for non-HTTP or malformed token %s", (text) => {
		expectFlags(body(text), []);
	});

	it.each(["email", "chat"] as const)(
		"scans quoted %s text beyond the display history cap",
		(channel) => {
			expectFlags(
				body(`Current\n> ${"q".repeat(5_000)}\u200b https://quoted.invalid/path`, channel),
				[invisible, link("quoted.invalid")],
			);
		},
	);

	it("scans an email's complete body past 40,000 characters and through its final scalar", () => {
		const suffix = "\n> https://tail.invalid/path\u200b";
		const text = "a".repeat(100_000 - [...suffix].length) + suffix;
		expect(EmailDraftContent.shape.body.safeParse(text).success).toBe(true);
		expectFlags(body(text), [invisible, link("tail.invalid")]);
	});

	it.each([
		["email", 100_000, EmailDraftContent.shape.body],
		["chat", 40_000, ChatDraftContent.shape.body],
	] as const)("uses the merged %s scalar bound", (channel, maximum, schema) => {
		const suffix = " https://end.invalid/\u200b";
		const text = "\u{1f642}".repeat(maximum - [...suffix].length) + suffix;
		expect(text.length).toBeGreaterThan(maximum);
		expect([...text]).toHaveLength(maximum);
		expect(schema.safeParse(text).success).toBe(true);
		expectFlags(body(text, channel), [invisible, link("end.invalid")]);
		const overflow = `${text}\u{1f642}`;
		expect(schema.safeParse(overflow).success).toBe(false);
		refused(body(overflow, channel));
	});

	it("allows 512 distinct hosts and an additional invisible flag", () => {
		const hosts = Array.from({ length: 512 }, (_, index) => `h${index}.example.invalid`);
		const text = `${hosts.map((host) => `https://${host}/path`).join(" ")}\u200b`;
		expectFlags(body(text), [...hosts.map(link), invisible]);
	});

	it("deduplicates repeated hosts before applying the distinct-host limit", () => {
		expectFlags(body("https://example.invalid/path ".repeat(600)), [link("example.invalid")]);
	});

	it("refuses the whole result on a 513th distinct host", () => {
		const text = Array.from(
			{ length: 513 },
			(_, index) => `https://h${index}.example.invalid/`,
		).join(" ");
		refused(body(`\u200b${text}`), "STRUCTURE_LIMIT");
	});

	it("refuses the whole result when a URL host cannot fit the canonical flag detail", () => {
		const longHost = `${"a".repeat(1_001)}.invalid`;
		refused(body(`https://valid.invalid/ \u200b https://${longHost}/`), "STRUCTURE_LIMIT");
	});

	it.each([null, undefined, true, 1, "body", [], new Date(0), Object("body")])(
		"refuses non-record body data without throwing: %s",
		(value) => refused(value),
	);

	it.each([
		{},
		{ channel: "email" },
		{ body: "text" },
		{ channel: "sms", body: "text" },
		{ channel: "EMAIL", body: "text" },
		{ channel: null, body: "text" },
		{ channel: "email", body: null },
		{ channel: "email", body: 1 },
		{ channel: "email", body: Object("text") },
	])("refuses missing, unsupported or malformed canonical fields: %j", (value) => refused(value));

	it.each([
		["chat", 40_001],
		["email", 100_001],
	] as const)("refuses an overlong %s body", (channel, length) => {
		refused(body("a".repeat(length), channel));
	});

	it.each(["before\rafter", "before\r\nafter", "cafe\u0301", "\ud800", "\udc00", "x\ud800y"])(
		"refuses noncanonical body text instead of normalizing it silently: %j",
		(text) => {
			expect(EmailDraftContent.shape.body.safeParse(text).success).toBe(false);
			refused(body(`https://valid.invalid/ ${text}`));
		},
	);

	it("accepts null-prototype records with own canonical data fields", () => {
		const input = Object.assign(Object.create(null), body("https://example.invalid/\u200b"));
		expectFlags(input, [link("example.invalid"), invisible]);
	});

	it("refuses inherited fields and exotic records without reading getters", () => {
		let reads = 0;
		const inherited = {
			get channel() {
				reads++;
				return "email";
			},
			get body() {
				reads++;
				return "https://example.invalid/";
			},
		};
		refused(Object.create(inherited));
		refused(Object.assign(Object.create({}), body("https://example.invalid/")));
		refused(Object.assign([], body("https://example.invalid/")));
		expect(reads).toBe(0);
	});

	it.each(["channel", "body"] as const)(
		"refuses an own %s accessor without invoking it",
		(field) => {
			let reads = 0;
			const input = body("https://example.invalid/");
			Object.defineProperty(input, field, {
				get() {
					reads++;
					throw new Error("Body classification must not execute accessors");
				},
			});
			refused(input);
			expect(reads).toBe(0);
		},
	);

	it("refuses proxies, including revoked proxies, without invoking inspection traps", () => {
		let traps = 0;
		const trap = (): never => {
			traps++;
			throw new Error("Body classification must not inspect proxy data");
		};
		const handler = {
			get: trap,
			getOwnPropertyDescriptor: trap,
			getPrototypeOf: trap,
			ownKeys: trap,
		};
		refused(new Proxy(body("https://example.invalid/"), handler));
		const revoked = Proxy.revocable(body("text"), handler);
		revoked.revoke();
		refused(revoked.proxy);
		expect(traps).toBe(0);
	});

	it("does not coerce malformed field values", () => {
		let coercions = 0;
		const value = {
			toString() {
				coercions++;
				throw new Error("Canonical fields must not be coerced");
			},
		};
		refused({ channel: value, body: "text" });
		refused({ channel: "email", body: value });
		expect(coercions).toBe(0);
	});

	it("never reads unused recipient, subject, attachment or chat fields", () => {
		let reads = 0;
		const input = body("https://example.invalid/\u200b");
		for (const field of ["to", "cc", "bcc", "subject", "attachments", "threadTs", "broadcast"]) {
			Object.defineProperty(input, field, {
				get() {
					reads++;
					throw new Error("Only channel and body belong to this classification");
				},
			});
		}
		expectFlags(input, [link("example.invalid"), invisible]);
		expect(reads).toBe(0);
	});

	it("preserves the original frozen input across successful and refused classification", () => {
		const input = Object.freeze(body("https://EXAMPLE.INVALID/path\u200b"));
		const before = structuredClone(input);
		expectFlags(input, [link("example.invalid"), invisible]);
		expect(input).toEqual(before);
		const invalid = Object.freeze(body("cafe\u0301"));
		refused(invalid);
		expect(invalid.body).toBe("cafe\u0301");
	});
});
