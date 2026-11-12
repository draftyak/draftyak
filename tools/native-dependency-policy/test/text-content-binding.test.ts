import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	MAX_TEXT_CONTENT_BYTES,
	projectOwnTextField,
	TextContentBindingError,
	type TextField,
} from "../src/text-content-binding.ts";

const bindingForBytes = (hex: string) => {
	const bytes = Buffer.from(hex, "hex");
	return {
		state: "string",
		bytes: bytes.length,
		sha256: createHash("sha256").update(bytes).digest("hex"),
	};
};

describe("own text content binding", () => {
	it("distinguishes missing, null and empty string without returning content", () => {
		const missing = projectOwnTextField({}, "body");
		const absent = projectOwnTextField({ other: "ignored" }, "body");
		const nullable = projectOwnTextField({ body: null }, "body");
		const empty = projectOwnTextField({ body: "" }, "body");
		expect(missing).toEqual({ state: "missing" });
		expect(absent).toEqual(missing);
		expect(nullable).toEqual({ state: "null" });
		expect(empty).toEqual({
			state: "string",
			bytes: 0,
			sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
		});
		for (const binding of [missing, nullable, empty]) {
			expect(Object.isFrozen(binding)).toBe(true);
			expect(() => Object.assign(binding, { state: "changed" })).toThrow(TypeError);
			expect(Reflect.ownKeys(binding).sort()).toEqual(
				binding.state === "string" ? ["bytes", "sha256", "state"] : ["state"],
			);
		}
	});

	it.each<TextField>(["name", "title", "body", "description"])(
		"projects only the selected own %s field",
		(field) => {
			const record = { [field]: "A" };
			expect(projectOwnTextField(record, field)).toEqual(bindingForBytes("41"));
			const nullPrototype = Object.create(null);
			Object.defineProperty(nullPrototype, field, { value: "A", enumerable: false });
			expect(projectOwnTextField(nullPrototype, field)).toEqual(bindingForBytes("41"));
		},
	);

	it.each([
		["NFC", "\u00e9", "c3a9"],
		["NFD", "e\u0301", "65cc81"],
		["CRLF", "line\r\n", "6c696e650d0a"],
		["LF", "line\n", "6c696e650a"],
		["BOM", "\ufeffvalue", "efbbbf76616c7565"],
		["NUL", "a\0b", "610062"],
		["astral", "\ud83d\ude42", "f09f9982"],
	])("preserves exact decoded UTF-8 bytes for %s", (_, text, expectedHex) => {
		expect(projectOwnTextField({ title: text }, "title")).toEqual(bindingForBytes(expectedHex));
	});

	it("keeps canonically equivalent strings and line endings distinct", () => {
		expect(projectOwnTextField({ body: "\u00e9" }, "body")).not.toEqual(
			projectOwnTextField({ body: "e\u0301" }, "body"),
		);
		expect(projectOwnTextField({ body: "line\r\n" }, "body")).not.toEqual(
			projectOwnTextField({ body: "line\n" }, "body"),
		);
	});

	it.each(["\ud800", "\udfff", "a\ud800b", "\ud800\ud800", "\udc00\ud800"])(
		"refuses unpaired surrogates rather than hashing replacement bytes: %j",
		(text) => {
			expect(() => projectOwnTextField({ body: text }, "body")).toThrow(TextContentBindingError);
		},
	);

	it("admits the exact UTF-8 byte limit for ASCII and multibyte text", () => {
		for (const text of ["x".repeat(MAX_TEXT_CONTENT_BYTES), "\u00e9".repeat(524_288)]) {
			expect(projectOwnTextField({ description: text }, "description")).toEqual({
				state: "string",
				bytes: 1_048_576,
				sha256: createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex"),
			});
		}
	});

	it("refuses a multibyte value above the UTF-8 byte limit without truncation", () => {
		const text = "\u00e9".repeat(524_289);
		expect(text.length).toBeLessThan(MAX_TEXT_CONTENT_BYTES);
		expect(() => projectOwnTextField({ body: text }, "body")).toThrow(TextContentBindingError);
	});

	it("refuses ASCII above the limit", () => {
		expect(() => projectOwnTextField({ name: "x".repeat(1_048_577) }, "name")).toThrow(
			TextContentBindingError,
		);
	});

	it("refuses selected accessors without invoking getter or setter", () => {
		let calls = 0;
		for (const descriptor of [
			{
				get: () => {
					calls++;
					return "text";
				},
			},
			{
				set: (_value: unknown) => {
					calls++;
				},
			},
		]) {
			const record = Object.defineProperty({}, "body", descriptor);
			expect(() => projectOwnTextField(record, "body")).toThrow(TextContentBindingError);
		}
		expect(calls).toBe(0);
	});

	it("does not enumerate or evaluate unrelated fields", () => {
		let calls = 0;
		const record = Object.defineProperty({ body: "A" }, "other", {
			get() {
				calls++;
				throw new Error("unselected getter executed");
			},
		});
		expect(projectOwnTextField(record, "body")).toEqual(bindingForBytes("41"));
		expect(calls).toBe(0);
	});

	it("refuses proxies before invoking any reflection traps", () => {
		let traps = 0;
		const target = { body: "A" };
		const proxy = new Proxy(target, {
			getPrototypeOf(value) {
				traps++;
				return Reflect.getPrototypeOf(value);
			},
			getOwnPropertyDescriptor(value, field) {
				traps++;
				return Reflect.getOwnPropertyDescriptor(value, field);
			},
			get(value, field, receiver) {
				traps++;
				return Reflect.get(value, field, receiver);
			},
			ownKeys(value) {
				traps++;
				return Reflect.ownKeys(value);
			},
		});
		let failure: unknown;
		try {
			projectOwnTextField(proxy, "body");
		} catch (error) {
			failure = error;
		}
		expect(traps).toBe(0);
		expect(failure).toBeInstanceOf(TextContentBindingError);
	});

	it("refuses revoked proxies with the fixed content-free error", () => {
		const { proxy, revoke } = Proxy.revocable({ body: "A" }, {});
		revoke();
		expect(() => projectOwnTextField(proxy, "body")).toThrow(TextContentBindingError);
	});

	it.each([
		["undefined", undefined],
		["boolean", false],
		["number", 0],
		["bigint", 1n],
		["symbol", Symbol("text")],
		["object", {}],
		["array", []],
		["boxed string", new String("text")],
		["function", () => "text"],
	])("refuses present nonprimitive-string data without coercion: %s", (_, value) => {
		expect(() => projectOwnTextField({ body: value }, "body")).toThrow(TextContentBindingError);
	});

	it("does not coerce values or field names", () => {
		let calls = 0;
		const coercible = {
			[Symbol.toPrimitive]() {
				calls++;
				return "body";
			},
		};
		expect(() => projectOwnTextField({ body: coercible }, "body")).toThrow(TextContentBindingError);
		expect(() => projectOwnTextField({ body: "A" }, coercible as unknown as TextField)).toThrow(
			TextContentBindingError,
		);
		expect(calls).toBe(0);
	});

	it.each(["", "Body", "NAME", "__proto__", "constructor", "body\0", " body"])(
		"refuses unsupported field selection: %j",
		(field) => {
			expect(() => projectOwnTextField({ body: "A" }, field as TextField)).toThrow(
				TextContentBindingError,
			);
		},
	);

	it.each([undefined, null, "text", 1, true, [], new Date(0), new Map(), new String("A")])(
		"refuses non-record inputs: %j",
		(record) => {
			expect(() => projectOwnTextField(record, "body")).toThrow(TextContentBindingError);
		},
	);

	it("refuses custom prototypes without reading inherited fields", () => {
		let calls = 0;
		const record = Object.create({
			get body() {
				calls++;
				return "A";
			},
		});
		expect(() => projectOwnTextField(record, "body")).toThrow(TextContentBindingError);
		expect(calls).toBe(0);
	});
});
