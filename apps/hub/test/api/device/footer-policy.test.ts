import { describe, expect, it } from "vitest";
import {
	captureNativeOutboxFooterPolicy,
	type NativeOutboxFooterPolicy,
} from "../../../src/api/device/outbox-context.ts";
import { AuthzError } from "../../../src/authz/errors.ts";

function refuses(input: unknown): void {
	expect(() => captureNativeOutboxFooterPolicy(input as NativeOutboxFooterPolicy)).toThrow(
		AuthzError,
	);
}

describe("native footer policy DATA capture", () => {
	it("preserves an explicit empty footer without supplying a default", () => {
		const captured = captureNativeOutboxFooterPolicy({ footer: "" });
		expect(captured).toEqual({ footer: "" });
		expect(Object.isFrozen(captured)).toBe(true);
	});

	it("detaches and freezes the explicit native choice without changing its bytes", () => {
		const input = { footer: "Disclosure\nCaf\u00e9 \ud83d\ude00" };
		const captured = captureNativeOutboxFooterPolicy(input);
		expect(captured).not.toBe(input);
		expect(captured.footer).toBe(input.footer);
		expect(Reflect.ownKeys(captured)).toEqual(["footer"]);
		expect(Object.isFrozen(captured)).toBe(true);
		input.footer = "Changed after capture";
		expect(captured.footer).toBe("Disclosure\nCaf\u00e9 \ud83d\ude00");
	});

	it("accepts a closed inert null-prototype record", () => {
		const input = Object.assign(Object.create(null), { footer: "Explicit choice" });
		expect(captureNativeOutboxFooterPolicy(input)).toEqual({ footer: "Explicit choice" });
	});

	it("accepts 10,000 Unicode code points even when they use 20,000 code units", () => {
		const footer = "\ud83d\ude00".repeat(10_000);
		expect(footer.length).toBe(20_000);
		expect(captureNativeOutboxFooterPolicy({ footer }).footer).toBe(footer);
	});

	it.each([
		["BMP", "x".repeat(10_001)],
		["astral", "\ud83d\ude00".repeat(10_001)],
	])("refuses 10,001 %s code points", (_kind, footer) => {
		refuses({ footer });
	});

	it.each([
		["non-NFC", "e\u0301"],
		["CRLF", "a\r\nb"],
		["CR", "a\rb"],
		["lone high surrogate", "\ud800"],
		["lone low surrogate", "\udc00"],
	])("refuses %s instead of normalizing or repairing it", (_kind, footer) => {
		refuses({ footer });
	});

	it.each([null, undefined, "footer", 7, true, [], {}, { footer: 7 }])(
		"refuses a missing or non-record/string input (%#)",
		(input) => {
			refuses(input);
		},
	);

	it("refuses extra string, symbol and nonenumerable members", () => {
		refuses({ footer: "Explicit choice", enabled: true });
		refuses({ footer: "Explicit choice", [Symbol("extra")]: true });
		refuses(Object.defineProperty({ footer: "Explicit choice" }, "extra", { value: true }));
	});

	it("does not invoke a footer getter", () => {
		let calls = 0;
		const input = Object.defineProperty({}, "footer", {
			enumerable: true,
			get() {
				calls++;
				throw new Error("Getter must not run");
			},
		});
		refuses(input);
		expect(calls).toBe(0);
	});

	it("refuses inherited and nonenumerable footer properties", () => {
		refuses(Object.create({ footer: "Inherited" }));
		refuses(Object.defineProperty({}, "footer", { value: "Hidden" }));
	});

	it("refuses a Proxy without invoking its traps", () => {
		let calls = 0;
		const input = new Proxy(
			{ footer: "Explicit choice" },
			{
				getPrototypeOf() {
					calls++;
					throw new Error("Proxy trap must not run");
				},
				ownKeys() {
					calls++;
					throw new Error("Proxy trap must not run");
				},
			},
		);
		refuses(input);
		expect(calls).toBe(0);
	});
});
