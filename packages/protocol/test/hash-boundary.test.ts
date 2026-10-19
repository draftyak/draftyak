import { describe, expect, it } from "vitest";
import { type HeaderList, HeadersError, headersSha256, jcsSha256 } from "../src/hash.ts";

const hash = (value: unknown): string => headersSha256(value as HeaderList);

describe("header pair shape", () => {
	it("refuses extra tuple members and string rows instead of silently hashing a prefix", () => {
		for (const row of [["x-a", "1", "extra"], "ab"])
			expect(() => hash([row])).toThrow(
				new HeadersError("HEADERS_INVALID_NAME", "a header name is an ASCII token"),
			);
	});
	it("retains name/value refusal codes and content-free diagnostics", () => {
		for (const row of [[], [1, "value"], ["PRIVATE_BAD_NAME\r\n", "value"]])
			expect(() => hash([row])).toThrow(
				new HeadersError("HEADERS_INVALID_NAME", "a header name is an ASCII token"),
			);
		for (const row of [["x-a"], ["x-a", 1], ["x-a", "PRIVATE_BAD_VALUE\r\n"]])
			expect(() => hash([row])).toThrow(
				new HeadersError("HEADERS_INVALID_VALUE", "a header value is visible ASCII"),
			);
	});
	it("retains normative bytes, duplicates and exact values without adding broker caps", () => {
		const list = Array.from(
			{ length: 65 },
			(_, at) => ["X-Large", `${at}:${"x".repeat(256)}`] as const,
		);
		const normalized = list
			.map(([name, value]) => [name.toLowerCase(), value])
			.sort((a, b) => {
				const left = a[1] ?? "",
					right = b[1] ?? "";
				return left < right ? -1 : Number(left > right);
			});
		expect(hash(list)).toBe(jcsSha256(normalized));
		expect(
			hash([
				["X-A", "one"],
				["x-a", "one"],
			]),
		).not.toBe(hash([["x-a", "one"]]));
		expect(hash(Object.freeze([Object.freeze(["X-A", "value"])]))).toBe(hash([["x-a", "value"]]));
	});
	it("continues to accept ordinary caller array subclasses", () => {
		class Headers extends Array<readonly [string, string]> {}
		class Pair extends Array<string> {}
		const row = new Pair("X-A", "value");
		expect(hash(new Headers(row as unknown as readonly [string, string]))).toBe(
			hash([["x-a", "value"]]),
		);
	});
});
