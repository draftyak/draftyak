import { createHook } from "node:async_hooks";
import { describe, expect, it } from "vitest";
import { checkWait, systemClock } from "../../src/kernel/clock.ts";

const refusal = "Clock wait must be whole milliseconds from 0 to 15000";

function expectRefusal(value: unknown): void {
	expect(() => checkWait(value as number)).toThrow(new RangeError(refusal));

	let timers = 0;
	let thrown: unknown;
	let returned: Promise<void> | undefined;
	const controller = new AbortController();
	const hook = createHook({
		init(_id, type) {
			if (type === "Timeout") timers++;
		},
	});
	hook.enable();
	try {
		returned = systemClock.after(value as number, controller.signal);
	} catch (error) {
		thrown = error;
	} finally {
		hook.disable();
		// A broken guard must not leave a distant native timer or rejected promise behind.
		void returned?.catch(() => {});
		controller.abort();
	}
	expect(thrown).toBeInstanceOf(RangeError);
	expect((thrown as Error).message).toBe(refusal);
	expect(returned).toBeUndefined();
	expect(timers).toBe(0);
}

describe("bounded clock admission", () => {
	it.each([0, -0, 1, 14_999, 15_000])("preserves accepted wait %s exactly", (value) => {
		expect(Object.is(checkWait(value), value)).toBe(true);
	});

	it.each([
		["negative neighbor of zero", -Number.MIN_VALUE],
		["negative integer", -1],
		["positive neighbor of zero", Number.MIN_VALUE],
		["fraction below one", 0.5],
		["fraction below maximum", 14_999.5],
		["fraction above maximum", 15_000.5],
		["integer above maximum", 15_001],
		["NaN", NaN],
		["positive infinity", Infinity],
		["negative infinity", -Infinity],
		["largest safe integer", Number.MAX_SAFE_INTEGER],
		["first unsafe integer", Number.MAX_SAFE_INTEGER + 1],
		["smallest safe integer", Number.MIN_SAFE_INTEGER],
		["native overflow boundary minus two", 2 ** 31 - 2],
		["native overflow boundary minus one", 2 ** 31 - 1],
		["native overflow boundary", 2 ** 31],
		["thirty days", 30 * 24 * 60 * 60 * 1_000],
		["undefined", undefined],
		["null", null],
		["false", false],
		["true", true],
		["empty string", ""],
		["zero string", "0"],
		["maximum string", "15000"],
		["bigint", 0n],
		["symbol", Symbol("synthetic wait")],
		["boxed number", new Number(0)],
		["array", [0]],
		["plain object", {}],
		["function", () => 0],
	] as const)("refuses %s synchronously before native timer admission", (_name, value) => {
		expectRefusal(value);
	});

	it("does not coerce objects even when they advertise accepted numeric values", () => {
		let hooks = 0;
		const poison = {
			[Symbol.toPrimitive]() {
				hooks++;
				return 0;
			},
			valueOf() {
				hooks++;
				return 15_000;
			},
			toString() {
				hooks++;
				return "0";
			},
		};
		expectRefusal(poison);
		expect(hooks).toBe(0);
	});

	it("does not inspect coercion accessors or proxy traps", () => {
		let hooks = 0;
		const fail = (): never => {
			hooks++;
			throw new Error("Synthetic coercion hook ran");
		};
		const accessors = Object.defineProperties(
			{},
			{
				[Symbol.toPrimitive]: { get: fail },
				valueOf: { get: fail },
				toString: { get: fail },
			},
		);
		const proxy = new Proxy(
			{},
			{
				get: fail,
				getPrototypeOf: fail,
				ownKeys: fail,
				getOwnPropertyDescriptor: fail,
			},
		);
		const revocable = Proxy.revocable({}, {});
		revocable.revoke();
		for (const value of [accessors, proxy, revocable.proxy]) expectRefusal(value);
		expect(hooks).toBe(0);
	});

	it.each([
		["plain", { aborted: false }],
		["null-prototype", Object.assign(Object.create(null), { aborted: false })],
		[
			"throwing-addEventListener",
			{
				aborted: false,
				addEventListener() {
					throw new Error("Synthetic listener failure");
				},
			},
		],
		["null", null],
	] as const)("refuses a %s signal before creating a native timer", (_name, signal) => {
		let timers = 0;
		let thrown: unknown;
		let returned: Promise<void> | undefined;
		const hook = createHook({
			init(_id, type) {
				if (type === "Timeout") timers++;
			},
		});
		hook.enable();
		try {
			returned = systemClock.after(100, signal as unknown as AbortSignal);
		} catch (error) {
			thrown = error;
		} finally {
			hook.disable();
			void returned?.catch(() => {});
		}
		expect(thrown).toBeInstanceOf(TypeError);
		expect((thrown as Error).message).toBe("Clock wait signal must be an AbortSignal");
		expect(returned).toBeUndefined();
		expect(timers).toBe(0);
	});

	it("observes a real native Timeout for an accepted zero wait", async () => {
		let timers = 0;
		const hook = createHook({
			init(_id, type) {
				if (type === "Timeout") timers++;
			},
		});
		let pending: Promise<void>;
		hook.enable();
		try {
			pending = systemClock.after(0);
		} finally {
			hook.disable();
		}
		await expect(pending).resolves.toBeUndefined();
		expect(timers).toBe(1);
	});
});
