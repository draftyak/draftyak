import { describe, expect, it } from "vitest";
import {
	createNativeKvMemory,
	NativeKvMemoryError,
} from "../../../../src/plugins/broker/channel/native-kv-memory.ts";

function refuses(code: string, work: () => unknown): void {
	let failure: unknown;
	try {
		work();
	} catch (error) {
		failure = error;
	}
	expect(failure).toBeInstanceOf(NativeKvMemoryError);
	expect(failure).toMatchObject({ code });
}

const INVALID = "CHANNEL_KV_MEMORY_INVALID";
const LIMIT = "CHANNEL_KV_MEMORY_LIMIT";
const CLOSED = "CHANNEL_KV_MEMORY_CLOSED";

// Partition objects below are DATA identity sentinels, never Session or namespace grants.
describe("native KV memory DATA resource", () => {
	it("isolates partition identity and keys while missing values remain null", () => {
		const memory = createNativeKvMemory();
		const first = Object.freeze({});
		const second = Object.freeze({});
		expect(memory.get(first, "cursor")).toBeNull();
		expect(memory.set(first, "cursor", { page: 1 })).toBeUndefined();
		expect(memory.set(first, "other", { page: 2 })).toBeUndefined();
		expect(memory.set(second, "cursor", { page: 3 })).toBeUndefined();
		expect(memory.get(first, "cursor")).toEqual({ page: 1 });
		expect(memory.get(first, "other")).toEqual({ page: 2 });
		expect(memory.get(second, "cursor")).toEqual({ page: 3 });
		expect(memory.get(Object.freeze({}), "cursor")).toBeNull();
		memory.close();
	});

	it("copies input and returns independent deeply frozen JSON snapshots", () => {
		const memory = createNativeKvMemory();
		const partition = {};
		const row = { page: 1 };
		const input = { nested: { cursor: "next" }, rows: [row] };
		memory.set(partition, "state", input);
		input.nested.cursor = "changed";
		row.page = 9;
		input.rows.push({ page: 10 });
		const first = memory.get(partition, "state") as {
			nested: { cursor: string };
			rows: readonly { page: number }[];
		};
		const second = memory.get(partition, "state") as typeof first;
		expect(first).toEqual({ nested: { cursor: "next" }, rows: [{ page: 1 }] });
		expect(second).toEqual(first);
		expect(first).not.toBe(second);
		expect(first.nested).not.toBe(second.nested);
		expect(first.rows).not.toBe(second.rows);
		expect(first.rows[0]).not.toBe(second.rows[0]);
		for (const value of [first, first.nested, first.rows, first.rows[0]])
			expect(Object.isFrozen(value)).toBe(true);
		expect(Reflect.set(first.nested, "cursor", "overwritten")).toBe(false);
		expect(memory.get(partition, "state")).toEqual(second);
		memory.close();
	});

	it.each([null, true, false, 0, 2.5, "text"])("retains scalar JSON %j", (value) => {
		const memory = createNativeKvMemory();
		const partition = {};
		memory.set(partition, "state", value);
		expect(memory.get(partition, "state")).toEqual(value);
		memory.close();
	});

	it("replaces and deletes only the selected partition key", () => {
		const memory = createNativeKvMemory();
		const first = {};
		const second = {};
		memory.set(first, "state", "old");
		memory.set(first, "neighbor", "retained");
		memory.set(second, "state", "other partition");
		memory.set(first, "state", "new");
		expect(memory.get(first, "state")).toBe("new");
		expect(memory.delete(first, "state")).toBeUndefined();
		expect(memory.delete(first, "missing")).toBeUndefined();
		expect(memory.get(first, "state")).toBeNull();
		expect(memory.get(first, "neighbor")).toBe("retained");
		expect(memory.get(second, "state")).toBe("other partition");
		memory.close();
	});

	it("enforces the proposed value byte bound without changing a failed overwrite", () => {
		const memory = createNativeKvMemory();
		const partition = {};
		const boundary = "x".repeat(65_534);
		expect(Buffer.byteLength(JSON.stringify(boundary))).toBe(65_536);
		memory.set(partition, "state", boundary);
		expect(memory.get(partition, "state")).toBe(boundary);
		refuses(LIMIT, () => memory.set(partition, "state", `${boundary}x`));
		expect(memory.get(partition, "state")).toBe(boundary);
		refuses(LIMIT, () => memory.set(partition, "new", `${boundary}x`));
		expect(memory.get(partition, "new")).toBeNull();
		memory.close();
	});

	it("enforces one total key budget across partitions while allowing replacement and delete", () => {
		const memory = createNativeKvMemory();
		const first = {};
		const second = {};
		for (let index = 0; index < 1_023; index++) memory.set(first, `key-${index}`, index);
		memory.set(second, "last", "full");
		memory.set(first, "key-0", "replacement");
		expect(memory.get(first, "key-0")).toBe("replacement");
		refuses(LIMIT, () => memory.set(second, "overflow", "valid DATA"));
		expect(memory.get(second, "overflow")).toBeNull();
		memory.delete({}, "missing");
		refuses(LIMIT, () => memory.set({}, "still-full", null));
		memory.delete(first, "key-1");
		memory.set(second, "overflow", "now fits");
		expect(memory.get(first, "key-1")).toBeNull();
		expect(memory.get(second, "overflow")).toBe("now fits");
		refuses(LIMIT, () => memory.set(first, "another", true));
		memory.close();
	});

	it("leaves the prior value intact when key or JSON capture fails", () => {
		const memory = createNativeKvMemory();
		const partition = {};
		memory.set(partition, "state", { cursor: "retained" });
		const cycle: Record<string, unknown> = {};
		cycle.self = cycle;
		for (const value of [undefined, Number.NaN, 1n, cycle]) {
			refuses(INVALID, () => memory.set(partition, "state", value));
			expect(memory.get(partition, "state")).toEqual({ cursor: "retained" });
		}
		refuses(INVALID, () => memory.set(partition, "", "invalid key"));
		refuses(INVALID, () => memory.set(partition, "x".repeat(129), "invalid key"));
		refuses(INVALID, () => memory.get(partition, { key: "state" }));
		refuses(INVALID, () => memory.delete(partition, "space key"));
		expect(memory.get(partition, "state")).toEqual({ cursor: "retained" });
		memory.close();
	});

	it("refuses hostile values without running hooks or replacing the old value", () => {
		const memory = createNativeKvMemory();
		const partition = {};
		let reads = 0;
		const hook = () => {
			reads++;
			return "next";
		};
		memory.set(partition, "state", { cursor: "retained" });
		const getter = Object.defineProperty({}, "cursor", { enumerable: true, get: hook });
		const proxy = new Proxy(
			{ cursor: "next" },
			{
				get: hook,
				ownKeys: () => {
					reads++;
					return [];
				},
				getOwnPropertyDescriptor: () => {
					reads++;
					return undefined;
				},
				getPrototypeOf: () => {
					reads++;
					return null;
				},
			},
		);
		for (const value of [getter, { nested: proxy }, { toJSON: hook }]) {
			refuses(INVALID, () => memory.set(partition, "state", value));
			expect(memory.get(partition, "state")).toEqual({ cursor: "retained" });
		}
		expect(reads).toBe(0);
		memory.close();
	});

	it.each([
		{ name: "null", partition: null },
		{ name: "undefined", partition: undefined },
		{ name: "string", partition: "namespace" },
		{ name: "number", partition: 1 },
		{ name: "function", partition: () => null },
	])("refuses a $name partition DATA identity", ({ partition }) => {
		const memory = createNativeKvMemory();
		const invalid = partition as object;
		refuses(INVALID, () => memory.get(invalid, "state"));
		refuses(INVALID, () => memory.set(invalid, "state", null));
		refuses(INVALID, () => memory.delete(invalid, "state"));
		const original = {};
		memory.set(original, "state", "valid DATA");
		expect(memory.get(original, "state")).toBe("valid DATA");
		memory.close();
	});

	it("does not inspect partition fields and refuses proxy partition aliases without traps", () => {
		const memory = createNativeKvMemory();
		let reads = 0;
		const trap = (): never => {
			reads++;
			throw new Error("Unexpected partition inspection");
		};
		const partition = Object.defineProperty(Object.create({ inherited: true }), "accountId", {
			enumerable: true,
			get: trap,
		});
		memory.set(partition, "state", "DATA");
		expect(memory.get(partition, "state")).toBe("DATA");
		const alias = new Proxy(partition, {
			get: trap,
			ownKeys: trap,
			getOwnPropertyDescriptor: trap,
			getPrototypeOf: trap,
		});
		refuses(INVALID, () => memory.get(alias, "state"));
		refuses(INVALID, () => memory.set(alias, "state", "changed"));
		refuses(INVALID, () => memory.delete(alias, "state"));
		expect(memory.get(partition, "state")).toBe("DATA");
		expect(reads).toBe(0);
		memory.close();
	});

	it("fences retained method references immediately on close before inspecting later inputs", () => {
		const memory = createNativeKvMemory();
		const partition = {};
		memory.set(partition, "state", { cursor: "next" });
		const { get, set, delete: remove, close } = memory;
		expect(Object.isFrozen(memory)).toBe(true);
		expect(close()).toBeUndefined();
		refuses(CLOSED, () => get(partition, "state"));
		refuses(CLOSED, () => set(partition, "state", "late"));
		refuses(CLOSED, () => remove(partition, "state"));
		let reads = 0;
		const hostile = new Proxy(
			{},
			{
				get: () => {
					reads++;
					throw new Error("Closed resource inspected DATA");
				},
			},
		);
		refuses(CLOSED, () => get(hostile, undefined));
		refuses(CLOSED, () => set(hostile, undefined, hostile));
		refuses(CLOSED, () => remove(hostile, undefined));
		expect(close()).toBeUndefined();
		expect(reads).toBe(0);
	});
});
