import { describe, expect, it } from "vitest";
import { manifestJson, surfaceJson } from "../src/manifest/json.ts";

// Contract boundaries stay independent of the implementation's exported limits.
const MANIFEST_BYTES = 262_144;
const SURFACE_BYTES = 1_048_576;
const SURFACE_NODES = 65_536;
const representations = ["value", "text", "bytes"] as const;

function inputAs(value: unknown, representation: (typeof representations)[number]): unknown {
	if (representation === "value") return value;
	const text = JSON.stringify(value);
	return representation === "text" ? text : new TextEncoder().encode(text);
}

function manifestAtBytes(bytes: number): string[] {
	const value = Array<string>(8).fill("x".repeat(32_768));
	// Eight quoted strings, seven commas and the two array brackets use 25 bytes.
	value[7] = "x".repeat(bytes - 7 * 32_768 - 25);
	expect(Buffer.byteLength(JSON.stringify(value))).toBe(bytes);
	return value;
}

function surfaceAtBytes(bytes: number): { payload: string } {
	const value = { payload: "x".repeat(bytes - 14) };
	expect(Buffer.byteLength(JSON.stringify(value))).toBe(bytes);
	return value;
}

function surfaceAtNodes(nodes: number): Record<string, null> {
	const value: Record<string, null> = {};
	for (let index = 0; index < nodes - 1; index++) value[`k${index}`] = null;
	expect(Object.keys(value).length + 1).toBe(nodes);
	expect(Buffer.byteLength(JSON.stringify(value))).toBeLessThan(SURFACE_BYTES);
	return value;
}

describe("manifest JSON contract boundaries", () => {
	it.each(representations)("manifest-byte-cap/%s", (representation) => {
		for (const bytes of [MANIFEST_BYTES - 1, MANIFEST_BYTES]) {
			const value = manifestAtBytes(bytes);
			expect(manifestJson(inputAs(value, representation))).toEqual(value);
		}
		expect(() =>
			manifestJson(inputAs(manifestAtBytes(MANIFEST_BYTES + 1), representation)),
		).toThrow("Manifest JSON refused");
	});

	it.each(representations)("surface-byte-cap/%s", (representation) => {
		for (const bytes of [SURFACE_BYTES - 1, SURFACE_BYTES]) {
			const value = surfaceAtBytes(bytes);
			expect(surfaceJson(inputAs(value, representation))).toEqual(value);
		}
		expect(() => surfaceJson(inputAs(surfaceAtBytes(SURFACE_BYTES + 1), representation))).toThrow(
			"Surface JSON refused",
		);
	});

	it.each([
		["object", false],
		["object", true],
		["array", false],
		["array", true],
		["nested-object", false],
		["nested-object", true],
		["nested-array", false],
		["nested-array", true],
	] as const)("symbol-key-refusal/%s/enumerable=%s", (shape, enumerable) => {
		const container = shape.endsWith("array") ? [null] : { value: null };
		const value = shape.startsWith("nested") ? { child: container } : container;
		for (const parse of [manifestJson, surfaceJson]) expect(parse(value)).toEqual(value);
		Object.defineProperty(container, Symbol("extra"), { value: null, enumerable });
		for (const parse of [manifestJson, surfaceJson])
			expect(() => parse(value)).toThrow(/JSON refused/);
	});

	it("surface-node-cap", () => {
		for (const nodes of [SURFACE_NODES - 1, SURFACE_NODES]) {
			const value = surfaceAtNodes(nodes);
			expect(surfaceJson(value)).toEqual(value);
		}
		expect(() => surfaceJson(surfaceAtNodes(SURFACE_NODES + 1))).toThrow("Surface JSON refused");
	});
});
