import { Ulid } from "@draftyak/protocol/scalars";
import { expect, it } from "vitest";
import { newId } from "../../src/kernel/ids.ts";

it("encodes the full 48-bit time and independently validates generated ULIDs", () => {
	const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
	for (const time of [0, 1, 1_800_000_000_000, 0xffffffffffff]) {
		const id = newId(time);
		expect(Ulid.parse(id)).toBe(id);
		const decoded = [...id.slice(0, 10)].reduce((n, c) => n * 32 + alphabet.indexOf(c), 0);
		expect(decoded).toBe(time);
	}
	expect(new Set(Array.from({ length: 100 }, () => newId(1))).size).toBe(100);
});
it("refuses invalid times without coercion", () => {
	let hooks = 0;
	for (const time of [
		-1,
		1.1,
		NaN,
		Infinity,
		0x1000000000000,
		"1",
		{
			valueOf() {
				hooks++;
				return 1;
			},
		},
	])
		expect(() => newId(time as number)).toThrow("Invalid identifier time");
	expect(hooks).toBe(0);
});
