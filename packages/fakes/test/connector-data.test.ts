import { expect, it } from "vitest";
import { copyChunk, jsonObject } from "../src/connector-client/data.ts";

it.each([2048, 2049])("bounds otherwise valid JSON at %i nodes", (nodes) => {
	// The root object and its array each count as one node.
	const source = JSON.stringify({ values: Array.from({ length: nodes - 2 }, () => 0) });
	expect(() => JSON.parse(source)).not.toThrow();
	if (nodes === 2048) expect(jsonObject(source)).toEqual({ values: Array(2046).fill(0) });
	else expect(() => jsonObject(source)).toThrow(/^Connector fixture refused$/);
});

it("refuses a shared byte view containing otherwise valid JSON", () => {
	const ordinary = new Uint8Array([0x7b, 0x7d]);
	expect(copyChunk(ordinary, 2)).toEqual(ordinary);
	const shared = new Uint8Array(new SharedArrayBuffer(2));
	shared.set(ordinary);
	expect(new TextDecoder().decode(shared)).toBe("{}");
	expect(() => copyChunk(shared, 2)).toThrow(/^Connector fixture refused$/);
});
