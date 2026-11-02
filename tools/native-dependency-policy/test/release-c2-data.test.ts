import { describe, expect, it } from "vitest";
import { C2_CRATES, C2Error, copyData, version } from "../src/release-c2-data.ts";

describe("closed C2 data snapshot", () => {
	it("prevents runtime overrides of the fixed source name and path tuples", () => {
		for (const tuple of C2_CRATES) {
			const original = tuple[1];
			try {
				expect(Reflect.set(tuple, 1, "../not-selected")).toBe(false);
				expect(tuple[1]).toBe(original);
			} finally {
				Reflect.set(tuple, 1, original);
			}
		}
	});
	it("detaches and freezes own data, including shared ordinary subtrees", () => {
		const child = { x: [1, "value"] },
			input = { a: child, b: child };
		const result = copyData(input) as typeof input;
		child.x.push(2);
		expect(result.a.x).toEqual([1, "value"]);
		expect(Object.isFrozen(result.a.x)).toBe(true);
		expect(result.a).not.toBe(result.b);
	});
	it("refuses traps and accessors without invoking them", () => {
		let calls = 0;
		for (const value of [
			new Proxy(
				{},
				{
					ownKeys: () => {
						calls++;
						return [];
					},
				},
			),
			Object.defineProperty({}, "x", {
				enumerable: true,
				get: () => {
					calls++;
					return 1;
				},
			}),
		])
			expect(() => copyData(value)).toThrow(C2Error);
		expect(calls).toBe(0);
	});
	it.each([
		() => {
			const x: unknown[] = [];
			x.push(x);
			return x;
		},
		() => new Array(2),
		() => Object.assign([], { extra: 1 }),
		() => ({ x: undefined }),
		() => ({ x: "\ud800" }),
		() => ({ x: 1.5 }),
		() => ({ [Symbol()]: 1 }),
		() => new Date(0),
	])("refuses unsupported data", (make) => expect(() => copyData(make())).toThrow(C2Error));
	it("enforces scalar bytes and container depth", () => {
		expect(copyData("x".repeat(65536))).toHaveLength(65536);
		expect(() => copyData("x".repeat(65537))).toThrow(C2Error);
		let value: unknown = null;
		for (let i = 0; i < 65; i++) value = [value];
		expect(() => copyData(value)).toThrow(C2Error);
	});
	it.each(["1.0.0", "1.0.0-alpha.1", "1.0.0+build.01"])("accepts strict path-safe SemVer %s", (s) =>
		expect(version(s)).toBe(s),
	);
	it.each(["01.0.0", "1.0.0-01", "1.0.0/next", "1.0.0-", "1.0.0%2fnext", "1.0.0\n"])(
		"refuses unsupported SemVer %j",
		(s) => expect(() => version(s)).toThrow(C2Error),
	);
});
