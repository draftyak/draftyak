import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { type HeaderList, headersSha256, jcsSha256, sha256Hex } from "../src/hash.ts";
import { outcome, utf8, vectorFiles } from "./vectors.ts";

interface HeadersCase {
	readonly id: string;
	readonly headers: [string, string][];
	readonly canonical?: string;
	readonly sha256?: string;
	readonly error?: string;
}

describe("sha256Hex and jcsSha256", () => {
	it("hash bytes, and strings as their UTF-8", () => {
		expect(sha256Hex("abc")).toBe(
			"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
		);
		expect(sha256Hex(new Uint8Array())).toBe(
			"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
		);
		expect(sha256Hex("\u{e9}\u{1f600}")).toBe(sha256Hex(utf8("\u{e9}\u{1f600}")));
		expect(outcome(() => sha256Hex("\u{d800}"))).toBe("JCS_LONE_SURROGATE");
	});

	it("hash the canonical form", () => {
		expect(jcsSha256({ b: [1, "x"], a: null })).toBe(sha256Hex('{"a":null,"b":[1,"x"]}'));
	});
});

describe("headersSha256", () => {
	const [[file, vectors] = ["", { format: "", cases: [] as HeadersCase[] }]] = vectorFiles<{
		format: string;
		cases: HeadersCase[];
	}>("hash");

	it("has the shared vectors", () => {
		expect(file).toBe("headers.json");
		expect(vectors.format).toBe("draftyak.vectors.hash.v1");
	});

	it.each(vectors.cases.map((item) => [item.id, item] as const))("headers.json: %s", (_, item) => {
		if (item.error !== undefined) {
			expect(outcome(() => headersSha256(item.headers))).toBe(item.error);
			return;
		}
		expect(headersSha256(item.headers)).toBe(item.sha256);
		expect(sha256Hex(item.canonical ?? "")).toBe(item.sha256);
	});

	const name = fc.stringMatching(/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,16}$/);
	const value = fc.stringMatching(/^(?:[!-~](?:[\t -~]{0,20}[!-~])?)?$/);
	const headers = fc.array(fc.tuple(name, value), { maxLength: 8 });
	const recase = (text: string, flips: readonly boolean[]): string =>
		[...text].map((c, i) => (flips[i % flips.length] ? c.toUpperCase() : c.toLowerCase())).join("");

	it("ignores the order of headers and the case of names (1,000 runs)", () => {
		fc.assert(
			fc.property(headers, fc.array(fc.boolean(), { minLength: 1 }), (list, flips) => {
				const other: HeaderList = list
					.map(([key, item]) => [recase(key, flips), item] as const)
					.reverse();
				expect(headersSha256(other)).toBe(headersSha256(list));
			}),
			{ numRuns: 1000 },
		);
	});

	it("changes with any byte of any value (1,000 runs)", () => {
		const nonEmpty = headers.filter((list) => list.some(([, item]) => item !== ""));
		fc.assert(
			fc.property(nonEmpty, fc.nat(), fc.nat(), (list, pick, at) => {
				const candidates = list.flatMap(([, item], index) => (item === "" ? [] : [index]));
				const index = candidates[pick % candidates.length] ?? 0;
				const [key, item] = list[index] ?? ["", ""];
				const position = at % item.length;
				const changed = item[position] === "x" ? "y" : "x";
				const other = list.with(index, [
					key,
					`${item.slice(0, position)}${changed}${item.slice(position + 1)}`,
				]);
				expect(headersSha256(other)).not.toBe(headersSha256(list));
			}),
			{ numRuns: 1000 },
		);
	});

	it("refuses what isn't a header name or value", () => {
		const bad = [
			[1, "x"],
			["x", 1],
			["x"],
			["X-A", "b\u{0}"],
			["X-A", "\u{7f}"],
		] as unknown as HeaderList;
		const codes = bad.map((pair) => outcome(() => headersSha256([pair])));
		expect(codes).toEqual([
			"HEADERS_INVALID_NAME",
			"HEADERS_INVALID_VALUE",
			"HEADERS_INVALID_VALUE",
			"HEADERS_INVALID_VALUE",
			"HEADERS_INVALID_VALUE",
		]);
	});
});
