import { describe, expect, it, vi } from "vitest";
import { ContentError, MAX_TEXT_BYTES } from "../src/limits.ts";
import { extractLiteralHttpUrlTokens } from "../src/url-tokens.ts";

function refused(input: unknown, code: ContentError["code"]): void {
	let error: unknown;
	try {
		extractLiteralHttpUrlTokens(input);
	} catch (caught) {
		error = caught;
	}
	expect(error).toBeInstanceOf(ContentError);
	expect(error).toHaveProperty("code", code);
}

describe("literal HTTP URL tokens", () => {
	it("preserves complete literal identity instead of URL serialization", () => {
		const urls = [
			"https://example.invalid",
			"HTTPS://EXAMPLE.invalid:443/caf\u00e9?x=%2F#One",
			"https://example.invalid/cafe\u0301?x=%2f#One",
			"https://example.invalid/caf\u00e9?x=/#One",
			"http://example.invalid:80/a",
			"https://m\u00fcnich.invalid/a",
			"https://user:pass@example.invalid/a",
		];
		expect(extractLiteralHttpUrlTokens(urls.join(" "))).toEqual(urls);
	});

	it("keeps the same host's different paths, queries, fragments and empty suffixes distinct", () => {
		const urls = [
			"https://example.invalid/a",
			"https://example.invalid/b",
			"https://example.invalid/a?q=1",
			"https://example.invalid/a?q=2",
			"https://example.invalid/a?q=1#one",
			"https://example.invalid/a?q=1#two",
			"https://example.invalid/a?",
			"https://example.invalid/a#",
		];
		expect(extractLiteralHttpUrlTokens(urls.join("\n"))).toEqual(urls);
	});

	it("deduplicates only exact strings, preserves first occurrence and freezes the array", () => {
		const first = "https://example.invalid/A",
			second = "https://example.invalid/a";
		const result = extractLiteralHttpUrlTokens(`${first} ${second} ${first}`);
		expect(result).toEqual([first, second]);
		expect(Object.isFrozen(result)).toBe(true);
	});

	it("uses whitespace, quotes, angle brackets and backticks as span boundaries", () => {
		const url = "https://example.invalid/a";
		expect(extractLiteralHttpUrlTokens(`'${url}'\t"${url}"\n<${url}>\u00a0\`${url}\``)).toEqual([
			url,
		]);
	});

	it("retains URL-valid ambiguous terminal punctuation rather than guessing prose", () => {
		const urls = ["?", "!", ".", ",", ")", "]", "}"].map(
			(tail) => `https://example.invalid/path${tail}`,
		);
		expect(extractLiteralHttpUrlTokens(urls.join(" "))).toEqual(urls);
		expect(extractLiteralHttpUrlTokens("(https://example.invalid/path)")).toEqual([
			"https://example.invalid/path)",
		]);
		expect(extractLiteralHttpUrlTokens("[https://example.invalid/path]")).toEqual([
			"https://example.invalid/path]",
		]);
	});

	it("preserves bare IPv6 authorities and explicit path brackets", () => {
		const urls = ["https://[::1]", "http://[2001:db8::1]:8080/a?b=c#d", "https://[::1]/a]"];
		expect(extractLiteralHttpUrlTokens(urls.join(" "))).toEqual(urls);
	});

	it("does not recover an HTTP URL nested in any other outer URI", () => {
		const nested = "https://inner.invalid/a?x=1#f";
		const values = [
			`javascript:${nested}`,
			`vbscript:${nested}`,
			`data:text/plain,${nested}`,
			`file:///${nested}`,
			`urn:example:${nested}`,
			`mailto:person@example.invalid?body=${nested}`,
			`blob:${nested}`,
			`custom+scheme.v1:${nested}`,
			`xhttps://${nested}`,
		];
		expect(extractLiteralHttpUrlTokens(values.join(" "))).toEqual([]);
		const outer = `https://outer.invalid/a?next=${nested}`;
		expect(extractLiteralHttpUrlTokens(outer)).toEqual([outer]);
	});

	it.each([
		"https:///example.invalid/a",
		"https:////example.invalid/a",
		"https:/example.invalid/a",
		"https:example.invalid/a",
		"https://?query",
		"https://#fragment",
		"https://",
		"http://[not-an-ip]/a",
		"http://example.invalid:99999/a",
		"1https://example.invalid/a?next=https://inner.invalid/",
		"_https://example.invalid/a?next=https://inner.invalid/",
		"\u00e9https://example.invalid/a?next=https://inner.invalid/",
		"%68ttps://example.invalid/a",
		"https%3A//example.invalid/a",
		"\uff48\uff54\uff54\uff50\uff53://example.invalid/a",
	])("rejects repaired or nonliteral schemes/authorities: %s", (value) => {
		expect(extractLiteralHttpUrlTokens(value)).toEqual([]);
	});

	it.each(["\\", "\u0000", "\u001f", "\u007f", "\u0085", "\u200b", "\u202e", "\uFEFF"])(
		"rejects the entire unsafe span without deleting or recovering a suffix: %j",
		(character) => {
			const unsafe = `https://outer.invalid/a${character}https://inner.invalid/b`;
			expect(extractLiteralHttpUrlTokens(unsafe)).toEqual([]);
			expect(extractLiteralHttpUrlTokens(`prefix${character}https://inner.invalid/b`)).toEqual([]);
			expect(extractLiteralHttpUrlTokens(`javascript:${character}https://inner.invalid/b`)).toEqual(
				[],
			);
		},
	);

	it("does not decode entities, escapes or invisible characters into a URL", () => {
		expect(
			extractLiteralHttpUrlTokens(
				"https&#58;//example.invalid/a https%3a//example.invalid/a ht\u200btps://example.invalid/a",
			),
		).toEqual([]);
	});

	it("accepts the 512-distinct-token boundary and refuses an additional distinct token", () => {
		const urls = Array.from({ length: 512 }, (_, index) => `https://example.invalid/${index}`);
		expect(extractLiteralHttpUrlTokens(urls.join(" "))).toEqual(urls);
		refused(`${urls.join(" ")} https://example.invalid/extra`, "STRUCTURE_LIMIT");
		expect(extractLiteralHttpUrlTokens(Array(600).fill(urls[0]).join(" "))).toEqual([urls[0]]);
	});

	it("accepts the exact UTF-8 input ceiling and refuses one additional byte", () => {
		const prefix = "https://example.invalid/a ";
		const remaining = MAX_TEXT_BYTES - Buffer.byteLength(prefix);
		const value = prefix + "\u00e9".repeat(Math.floor(remaining / 2)) + "a".repeat(remaining % 2);
		expect(Buffer.byteLength(value)).toBe(MAX_TEXT_BYTES);
		expect(extractLiteralHttpUrlTokens(value)).toEqual([prefix.trimEnd()]);
		refused(`${value}a`, "INPUT_LIMIT");
		refused("a".repeat(MAX_TEXT_BYTES + 1), "INPUT_LIMIT");
	});

	it("handles a maximum-size near-scheme span without retrying overlapping suffixes", () => {
		const value = "a.".repeat(MAX_TEXT_BYTES / 2);
		expect(extractLiteralHttpUrlTokens(value)).toEqual([]);
	});

	it.each([undefined, null, false, 1, {}, [], Object("https://example.invalid/")])(
		"refuses nonprimitive strings without coercion: %j",
		(value) => refused(value, "INVALID_INPUT"),
	);

	it("does not reflect on proxy inputs and rejects malformed UTF-16", () => {
		const trap = vi.fn(() => {
			throw new Error("Unexpected reflection");
		});
		const value = new Proxy({}, { get: trap, getPrototypeOf: trap, ownKeys: trap });
		refused(value, "INVALID_INPUT");
		expect(trap).not.toHaveBeenCalled();
		refused("\ud800", "INVALID_INPUT");
		refused("\udc00", "INVALID_INPUT");
	});
});
