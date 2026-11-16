import { Flags } from "@draftyak/protocol/flags";
import { describe, expect, it } from "vitest";
import type { HygieneResult } from "../src/hygiene.ts";
import { classifyInstructionSignalFlags } from "../src/instruction-signal-flags.ts";

type Signal = Pick<HygieneResult, "suspectedInstructions">;

const REFUSED = { status: "refused", code: "INVALID_INPUT" } as const;
const WARNING = { code: "SUSPECTED_INSTRUCTIONS", severity: "advisory" } as const;

function classify(value: unknown) {
	return classifyInstructionSignalFlags(value as Signal);
}

function classified(value: unknown, expected: boolean) {
	const result = classify(value);
	expect(result).toStrictEqual({ status: "classified", flags: expected ? [WARNING] : [] });
	if (result.status !== "classified") throw new Error("DYTEST_EXPECTED_CLASSIFIED");
	expect(Flags.safeParse(result.flags).success).toBe(true);
	return result;
}

function record(value: boolean, nullPrototype = false): object {
	return Object.defineProperty(nullPrototype ? Object.create(null) : {}, "suspectedInstructions", {
		value,
		writable: true,
		enumerable: true,
		configurable: true,
	});
}

const VALID: ReadonlyArray<{ name: string; value: boolean; make: () => object }> = [
	{ name: "plain true", value: true, make: () => record(true) },
	{ name: "plain false", value: false, make: () => record(false) },
	{ name: "null-prototype true", value: true, make: () => record(true, true) },
	{ name: "null-prototype false", value: false, make: () => record(false, true) },
	{ name: "frozen true", value: true, make: () => Object.freeze(record(true)) },
	{ name: "frozen false", value: false, make: () => Object.freeze(record(false)) },
	{
		name: "non-enumerable non-writable true",
		value: true,
		make: () => Object.defineProperty({}, "suspectedInstructions", { value: true }),
	},
	{
		name: "non-enumerable non-writable false",
		value: false,
		make: () => Object.defineProperty({}, "suspectedInstructions", { value: false }),
	},
];

const MALFORMED: ReadonlyArray<{ name: string; value: unknown }> = [
	{ name: "undefined", value: undefined },
	{ name: "null", value: null },
	{ name: "zero", value: 0 },
	{ name: "one", value: 1 },
	{ name: "NaN", value: Number.NaN },
	{ name: "true string", value: "true" },
	{ name: "false string", value: "false" },
	{ name: "boxed boolean", value: Object(true) },
	{ name: "array", value: [] },
	{ name: "object", value: {} },
	{ name: "symbol", value: Symbol("DYTEST-signal") },
	{ name: "bigint", value: 1n },
];

const PRIMITIVES: ReadonlyArray<{ name: string; value: unknown }> = [
	{ name: "undefined", value: undefined },
	{ name: "null", value: null },
	{ name: "true", value: true },
	{ name: "false", value: false },
	{ name: "number", value: 1 },
	{ name: "string", value: "DYTEST-signal" },
	{ name: "bigint", value: 1n },
	{ name: "symbol", value: Symbol("DYTEST-signal") },
];

class SignalInstance {
	readonly suspectedInstructions = true;
}

const EXOTICS: ReadonlyArray<{ name: string; make: () => object }> = [
	{ name: "array", make: () => Object.assign([], { suspectedInstructions: true }) },
	{ name: "function", make: () => Object.assign(() => undefined, { suspectedInstructions: true }) },
	{ name: "date", make: () => Object.assign(new Date(0), { suspectedInstructions: true }) },
	{ name: "map", make: () => Object.assign(new Map(), { suspectedInstructions: true }) },
	{ name: "class instance", make: () => new SignalInstance() },
	{
		name: "boxed string",
		make: () => Object.assign(Object("signal"), { suspectedInstructions: true }),
	},
];

describe("classifyInstructionSignalFlags", () => {
	it.each(VALID)(
		"projects only the supplied boolean from $name without changing input",
		({ value, make }) => {
			const signal = make();
			const before = Object.getOwnPropertyDescriptors(signal);
			const prototype = Object.getPrototypeOf(signal);
			classified(signal, value);
			expect(Object.getOwnPropertyDescriptors(signal)).toStrictEqual(before);
			expect(Object.getPrototypeOf(signal)).toBe(prototype);
		},
	);

	it.each(MALFORMED)(
		"refuses a $name used value without reflecting it in the result",
		({ value }) => {
			expect(classify({ suspectedInstructions: value })).toStrictEqual(REFUSED);
		},
	);

	it.each(PRIMITIVES)("refuses top-level $name rather than coercing it", ({ value }) => {
		expect(classify(value)).toStrictEqual(REFUSED);
	});

	it("refuses a missing own field on a plain record", () => {
		expect(classify({})).toStrictEqual(REFUSED);
	});

	it("refuses a missing own field on a null-prototype record", () => {
		expect(classify(Object.create(null))).toStrictEqual(REFUSED);
	});

	it("refuses an inherited field instead of treating it as an own signal", () => {
		expect(classify(Object.create({ suspectedInstructions: true }))).toStrictEqual(REFUSED);
	});

	it.each(EXOTICS)("refuses a $name even when it carries an own boolean", ({ make }) => {
		expect(classify(make())).toStrictEqual(REFUSED);
	});

	it("refuses an own getter without invoking it", () => {
		let reads = 0;
		const signal = Object.defineProperty({}, "suspectedInstructions", {
			get() {
				reads++;
				throw new Error("DYTEST_GETTER_CALLED");
			},
		});
		expect(classify(signal)).toStrictEqual(REFUSED);
		expect(reads).toBe(0);
	});

	it("refuses an own setter-only descriptor without invoking it", () => {
		let writes = 0;
		const signal = Object.defineProperty({}, "suspectedInstructions", {
			set(_value: unknown) {
				writes++;
				throw new Error("DYTEST_SETTER_CALLED");
			},
		});
		expect(classify(signal)).toStrictEqual(REFUSED);
		expect(writes).toBe(0);
	});

	it("refuses an object used value without any primitive conversion", () => {
		let conversions = 0;
		const convert = () => {
			conversions++;
			throw new Error("DYTEST_COERCION_CALLED");
		};
		const value = { valueOf: convert, toString: convert, [Symbol.toPrimitive]: convert };
		expect(classify({ suspectedInstructions: value })).toStrictEqual(REFUSED);
		expect(conversions).toBe(0);
	});

	it("refuses a proxy record without invoking any observation trap", () => {
		let traps = 0;
		const trap = () => {
			traps++;
			throw new Error("DYTEST_PROXY_TRAP_CALLED");
		};
		const signal = new Proxy(
			{ suspectedInstructions: true },
			{
				get: trap,
				getPrototypeOf: trap,
				getOwnPropertyDescriptor: trap,
				ownKeys: trap,
				has: trap,
				isExtensible: trap,
			},
		);
		expect(classify(signal)).toStrictEqual(REFUSED);
		expect(traps).toBe(0);
	});

	it("refuses a revoked proxy without leaking a reflection error", () => {
		const { proxy, revoke } = Proxy.revocable({ suspectedInstructions: true }, {});
		revoke();
		expect(classify(proxy)).toStrictEqual(REFUSED);
	});

	it.each([true, false])(
		"ignores unused getters and symbol fields for supplied signal %s",
		(value) => {
			let reads = 0;
			const signal = record(value, !value);
			for (const key of [
				"text",
				"links",
				"removals",
				"reason",
				"toJSON",
				"toString",
				"valueOf",
				Symbol.toPrimitive,
			]) {
				Object.defineProperty(signal, key, {
					get() {
						reads++;
						throw new Error("DYTEST_UNUSED_GETTER_CALLED");
					},
				});
			}
			classified(signal, value);
			expect(reads).toBe(0);
		},
	);

	it("returns fresh mutually isolated warning arrays and flag objects", () => {
		const signal = Object.freeze(record(true));
		const first = classified(signal, true);
		const second = classified(signal, true);
		expect(first).not.toBe(second);
		expect(first.flags).not.toBe(second.flags);
		expect(first.flags[0]).not.toBe(second.flags[0]);
		const flag = first.flags[0];
		if (flag === undefined) throw new Error("DYTEST_EXPECTED_WARNING");
		Reflect.set(flag, "detail", "DYTEST-mutated-output");
		Reflect.set(first.flags, "length", 0);
		expect(second).toStrictEqual({ status: "classified", flags: [WARNING] });
		classified(signal, true);
	});

	it("returns a fresh empty array for each false projection", () => {
		const signal = Object.freeze(record(false));
		const first = classified(signal, false);
		const second = classified(signal, false);
		expect(first).not.toBe(second);
		expect(first.flags).not.toBe(second.flags);
		Reflect.set(first.flags, "0", WARNING);
		expect(second).toStrictEqual({ status: "classified", flags: [] });
		classified(signal, false);
	});
});
