import { describe, expect, it } from "vitest";
import {
	captureNativeKvRequest,
	NativeKvRequestError,
} from "../../../../src/plugins/broker/channel/native-kv-request.ts";

function refuses(method: unknown, raw: unknown): void {
	let failure: unknown;
	try {
		captureNativeKvRequest(method, raw);
	} catch (error) {
		failure = error;
	}
	expect(failure).toBeInstanceOf(NativeKvRequestError);
	expect(failure).toMatchObject({ code: "CHANNEL_KV_REQUEST_INVALID" });
}

describe("native KV request DATA capture", () => {
	it.each(["host/kv.get", "host/kv.delete"] as const)(
		"copies and freezes a %s request",
		(method) => {
			const raw = { key: "cursor" };
			const captured = captureNativeKvRequest(method, raw);
			raw.key = "changed";
			expect(captured).toEqual({ method, params: { key: "cursor" } });
			expect(Object.isFrozen(captured)).toBe(true);
			expect(Object.isFrozen(captured.params)).toBe(true);
		},
	);

	it("copies finite JSON values into a deeply frozen set snapshot", () => {
		const raw = {
			key: "cursor",
			value: {
				cursor: { token: "next", at: 2.5 },
				rows: [null, true, false, "text", { n: 3 }],
			},
		};
		const captured = captureNativeKvRequest("host/kv.set", raw);
		expect(captured.method).toBe("host/kv.set");
		if (captured.method !== "host/kv.set") throw new Error("Expected set DATA");
		expect(captured.params.value).toEqual(raw.value);
		expect(captured.params.value).not.toBe(raw.value);
		for (const value of [
			captured,
			captured.params,
			captured.params.value,
			(captured.params.value as Record<string, unknown>).cursor,
			(captured.params.value as Record<string, unknown>).rows,
			((captured.params.value as Record<string, unknown>).rows as unknown[])[4],
		])
			expect(Object.isFrozen(value)).toBe(true);
		raw.key = "changed";
		raw.value.cursor.token = "overwritten";
		raw.value.rows.push("later");
		expect(captured.params).toEqual({
			key: "cursor",
			value: {
				cursor: { token: "next", at: 2.5 },
				rows: [null, true, false, "text", { n: 3 }],
			},
		});
	});

	it("accepts null and null-prototype JSON records", () => {
		expect(captureNativeKvRequest("host/kv.set", { key: "state", value: null })).toEqual({
			method: "host/kv.set",
			params: { key: "state", value: null },
		});
		const value = Object.assign(Object.create(null), { cursor: "next", page: 0 });
		const raw = Object.assign(Object.create(null), { key: "state", value });
		expect(captureNativeKvRequest("host/kv.set", raw)).toEqual({
			method: "host/kv.set",
			params: { key: "state", value: { cursor: "next", page: 0 } },
		});
	});

	it("canonicalizes negative zero in a set snapshot", () => {
		const captured = captureNativeKvRequest("host/kv.set", { key: "state", value: -0 });
		if (captured.method !== "host/kv.set") throw new Error("Expected set DATA");
		expect(Object.is(captured.params.value, 0)).toBe(true);
		expect(Object.is(captured.params.value, -0)).toBe(false);
	});

	it("copies nested selector-named fields as ordinary JSON DATA", () => {
		const value = { namespace: "note", accountId: "label", pluginId: "text" };
		expect(captureNativeKvRequest("host/kv.set", { key: "state", value })).toEqual({
			method: "host/kv.set",
			params: { key: "state", value },
		});
	});

	it("preserves an own __proto__ JSON key without changing prototypes", () => {
		const prototypeBefore = Object.getOwnPropertyDescriptor(Object.prototype, "kvDataMarker");
		const value = Object.defineProperty(Object.create(null), "__proto__", {
			enumerable: true,
			value: { kvDataMarker: "DATA" },
		});
		const captured = captureNativeKvRequest("host/kv.set", { key: "state", value });
		if (captured.method !== "host/kv.set") throw new Error("Expected set DATA");
		expect(Object.hasOwn(captured.params.value as object, "__proto__")).toBe(true);
		const descriptor = Object.getOwnPropertyDescriptor(captured.params.value, "__proto__");
		expect(descriptor?.value).toEqual({ kvDataMarker: "DATA" });
		expect(Object.getPrototypeOf(captured.params.value)).not.toBe(descriptor?.value);
		expect(Object.isFrozen(descriptor?.value)).toBe(true);
		expect(Object.getOwnPropertyDescriptor(Object.prototype, "kvDataMarker")).toEqual(
			prototypeBefore,
		);
	});

	it("copies repeated shared JSON without retaining aliases", () => {
		const shared = { cursor: ["next"] };
		const captured = captureNativeKvRequest("host/kv.set", {
			key: "state",
			value: { left: shared, right: shared },
		});
		if (captured.method !== "host/kv.set") throw new Error("Expected set DATA");
		const value = captured.params.value as Record<string, { cursor: readonly string[] }>;
		expect(value).toEqual({ left: shared, right: shared });
		expect(value.left).not.toBe(shared);
		expect(value.right).not.toBe(shared);
		expect(value.left).not.toBe(value.right);
		expect(value.left?.cursor).not.toBe(value.right?.cursor);
		shared.cursor.push("later");
		expect(value).toEqual({ left: { cursor: ["next"] }, right: { cursor: ["next"] } });
	});

	it.each(["!", "~", "x".repeat(128)])("accepts the visible-ASCII key boundary %j", (key) => {
		expect(captureNativeKvRequest("host/kv.get", { key })).toEqual({
			method: "host/kv.get",
			params: { key },
		});
	});

	it.each(["", "x".repeat(129), "space key", "line\n", "\u001f", "\u007f", "é"])(
		"refuses an out-of-contract key %j",
		(key) => refuses("host/kv.get", { key }),
	);

	it.each([undefined, null, "", "host/kv.list", "host/fetch", "HOST/KV.GET", "host/kv.get\n"])(
		"refuses an unsupported method %j",
		(method) => refuses(method, { key: "state" }),
	);

	it.each([
		{ method: "host/kv.get", raw: null },
		{ method: "host/kv.get", raw: [] },
		{ method: "host/kv.get", raw: {} },
		{ method: "host/kv.get", raw: { key: "state", value: null } },
		{ method: "host/kv.delete", raw: { key: "state", value: null } },
		{ method: "host/kv.set", raw: { key: "state" } },
	])("refuses a malformed $method shape", ({ method, raw }) => refuses(method, raw));

	it.each(["namespace", "pluginId", "accountId", "session", "scope"])(
		"refuses a caller %s selector without inspecting it",
		(field) => {
			let reads = 0;
			const raw = Object.defineProperty({ key: "state", value: null }, field, {
				enumerable: true,
				get() {
					reads++;
					return "caller selector";
				},
			});
			refuses("host/kv.set", raw);
			expect(reads).toBe(0);
		},
	);

	it("does not coerce a method object or evaluate request accessors", () => {
		let reads = 0;
		const hook = () => {
			reads++;
			return "state";
		};
		refuses({ toString: hook }, { key: "state" });
		refuses("host/kv.get", Object.defineProperty({}, "key", { enumerable: true, get: hook }));
		refuses(
			"host/kv.set",
			Object.defineProperty({ key: "state" }, "value", { enumerable: true, get: hook }),
		);
		expect(reads).toBe(0);
	});

	it("refuses nested value accessors without evaluating them", () => {
		let reads = 0;
		const value = Object.defineProperty({}, "cursor", {
			enumerable: true,
			get() {
				reads++;
				return "next";
			},
		});
		refuses("host/kv.set", { key: "state", value });
		expect(reads).toBe(0);
		expect(
			captureNativeKvRequest("host/kv.set", { key: "state", value: { cursor: "next" } }),
		).toEqual({ method: "host/kv.set", params: { key: "state", value: { cursor: "next" } } });
	});

	it("refuses raw, nested-object and nested-array proxies without running traps", () => {
		let reads = 0;
		const trap = (): never => {
			reads++;
			throw new Error("Unexpected proxy trap");
		};
		const traps: ProxyHandler<object> = {
			get: trap,
			ownKeys: trap,
			getOwnPropertyDescriptor: trap,
			getPrototypeOf: trap,
		};
		refuses("host/kv.get", new Proxy({ key: "state" }, traps));
		refuses("host/kv.set", { key: "state", value: { nested: new Proxy({ page: 1 }, traps) } });
		refuses("host/kv.set", { key: "state", value: new Proxy([1], traps) });
		expect(reads).toBe(0);
	});

	it("refuses toJSON and custom prototypes without invoking their hooks", () => {
		let reads = 0;
		const toJSON = () => {
			reads++;
			return { page: 1 };
		};
		refuses("host/kv.set", { key: "state", value: { toJSON } });
		refuses("host/kv.set", { key: "state", value: Object.create({ toJSON }) });
		refuses("host/kv.get", Object.assign(Object.create({ toJSON }), { key: "state" }));
		expect(reads).toBe(0);
	});

	it("refuses sparse and decorated arrays without reading index or iterator hooks", () => {
		let reads = 0;
		const hook = () => {
			reads++;
			return 1;
		};
		const getter = Object.defineProperty([], "0", { enumerable: true, get: hook });
		const decorated = Object.assign([1], { extra: true });
		const iterator = Object.defineProperty([1], Symbol.iterator, { get: hook });
		const hidden = Object.defineProperty([1], "extra", { value: true });
		for (const value of [Array(1), [undefined], getter, decorated, iterator, hidden])
			refuses("host/kv.set", { key: "state", value });
		expect(reads).toBe(0);
		expect(captureNativeKvRequest("host/kv.set", { key: "state", value: [1, null] })).toEqual({
			method: "host/kv.set",
			params: { key: "state", value: [1, null] },
		});
	});

	it("refuses symbol keys and hidden fields at every captured level", () => {
		const symbol = Symbol("extra");
		refuses("host/kv.get", { key: "state", [symbol]: true });
		refuses("host/kv.get", Object.defineProperty({ key: "state" }, "extra", { value: true }));
		refuses("host/kv.get", Object.defineProperty({}, "key", { value: "state" }));
		refuses("host/kv.set", { key: "state", value: { [symbol]: true } });
		refuses("host/kv.set", {
			key: "state",
			value: Object.defineProperty({ page: 1 }, "extra", { value: true }),
		});
	});

	it.each([
		{ name: "undefined", value: undefined },
		{ name: "NaN", value: Number.NaN },
		{ name: "positive infinity", value: Number.POSITIVE_INFINITY },
		{ name: "negative infinity", value: Number.NEGATIVE_INFINITY },
		{ name: "bigint", value: 1n },
		{ name: "symbol", value: Symbol("value") },
		{ name: "function", value: () => null },
	])("refuses non-JSON set DATA $name", ({ value }) =>
		refuses("host/kv.set", { key: "state", value }),
	);

	it("refuses cyclic objects and arrays", () => {
		const object: Record<string, unknown> = {};
		object.self = object;
		const array: unknown[] = [];
		array.push(array);
		refuses("host/kv.set", { key: "state", value: object });
		refuses("host/kv.set", { key: "state", value: array });
	});

	it("includes the params wrapper in the depth-64 boundary", () => {
		const nested = (count: number): unknown => {
			let value: unknown = 0;
			for (let depth = 0; depth < count; depth++) value = [value];
			return value;
		};
		const boundary = nested(63);
		expect(captureNativeKvRequest("host/kv.set", { key: "state", value: boundary })).toEqual({
			method: "host/kv.set",
			params: { key: "state", value: boundary },
		});
		refuses("host/kv.set", { key: "state", value: nested(64) });
	});

	it("accepts an exact one-MiB params frame and refuses the next byte", () => {
		const overhead = Buffer.byteLength(JSON.stringify({ key: "state", value: "" }));
		const value = "x".repeat(1_048_576 - overhead);
		expect(captureNativeKvRequest("host/kv.set", { key: "state", value })).toEqual({
			method: "host/kv.set",
			params: { key: "state", value },
		});
		refuses("host/kv.set", { key: "state", value: `${value}x` });
	});
});
