import { afterEach, expect, it, vi } from "vitest";
import {
	ClientMetadataFetcher,
	type ClientMetadataOptions,
} from "../../src/mcp/client-metadata/index.ts";
import { configData, MetadataDestinations } from "../../src/mcp/client-metadata/policy.ts";

const ENVELOPE = 9 * 1024 * 1024;
afterEach(() => vi.restoreAllMocks());
const refusal = /^Client metadata refused$/;

it.each(["string", "key", "array", "record"] as const)(
	"refuses oversized %s configuration before native semantic validation",
	(kind) => {
		const input =
			kind === "string"
				? "x".repeat(ENVELOPE + 1)
				: kind === "key"
					? { ["x".repeat(ENVELOPE + 1)]: null }
					: kind === "array"
						? Array(257).fill(null)
						: Object.fromEntries(Array.from({ length: 257 }, (_, at) => [`key${at}`, null]));
		expect(() => configData(input)).toThrow(refusal);
	},
);
it("refuses a large constructor array before bulk descriptor materialization or element reads", () => {
	const destinations = Array(257).fill({
		kind: "cimd",
		host: "client.example",
		paths: [{ exact: "/client.json" }],
	});
	const descriptors = vi.spyOn(Object, "getOwnPropertyDescriptors");
	const itemDescriptor = vi.spyOn(Object, "getOwnPropertyDescriptor");
	let numericReads = 0;
	itemDescriptor.mockImplementation(((value: unknown, key: PropertyKey) => {
		if (value === destinations && key !== "length") numericReads++;
		return Reflect.getOwnPropertyDescriptor(value as object, key);
	}) as typeof Object.getOwnPropertyDescriptor);
	expect(() => new MetadataDestinations(destinations)).toThrow(refusal);
	expect(descriptors.mock.calls.some(([value]) => value === destinations)).toBe(false);
	expect(numericReads).toBe(0);
});
it("does not serialize or scan unbounded strings/keys before the envelope refusal", () => {
	const oversized = "x".repeat(ENVELOPE + 1),
		stringify = vi.spyOn(JSON, "stringify"),
		normalize = vi.spyOn(String.prototype, "isWellFormed");
	for (const input of [oversized, { [oversized]: null }])
		expect(() => configData(input)).toThrow(refusal);
	expect(stringify.mock.calls.some(([value]) => value === oversized)).toBe(false);
	expect(normalize).not.toHaveBeenCalled();
});
it("admits the complete maximum documented native configuration within the smallest whole-MiB envelope", () => {
	const host = [63, 63, 63, 61].map((length) => "a".repeat(length)).join("."),
		prefix = `/${"a".repeat(2046)}/`;
	const input: ClientMetadataOptions = {
		destinations: Array.from({ length: 128 }, () => ({
			kind: "cimd",
			host,
			paths: Array.from({ length: 32 }, () => ({ prefix })),
		})),
		deniedAddresses: Array(256).fill("ffff:ffff:ffff:ffff:ffff:ffff:255.255.255.255"),
		maxBytes: 1_048_576,
		timeoutMs: 10_000,
	};
	const bytes = Buffer.byteLength(JSON.stringify(input));
	expect(bytes).toBe(8_495_307);
	expect(bytes).toBeGreaterThan(8 * 1024 * 1024);
	expect(bytes).toBeLessThan(ENVELOPE);
	const fetcher = new ClientMetadataFetcher(input);
	fetcher.close();
	expect(() => new MetadataDestinations(input.destinations)).not.toThrow();
});
it("counts actual UTF-8/JSON escapes across fields and admits the exact encoded boundary", () => {
	for (const [unit, bytes] of [
		["x", 1],
		["\0", 6],
		["🦬", 4],
	] as const) {
		const text =
			unit.repeat(Math.floor((ENVELOPE - 2) / bytes)) + "x".repeat((ENVELOPE - 2) % bytes);
		expect(configData(text)).toBe(text);
		expect(() => configData(text + unit)).toThrow(refusal);
	}
	const half = "x".repeat(ENVELOPE / 2);
	expect(() => configData({ first: half, second: half })).toThrow(refusal);
});
it("freezes detached snapshots and refuses nested hooks, malformed text and non-JSON values without contentful errors", () => {
	const input = { destinations: [{ kind: "cimd", paths: [{ exact: "/client.json" }] }] },
		copied = configData(input) as typeof input;
	input.destinations[0]?.paths.push({ exact: "/changed.json" });
	expect(copied.destinations[0]?.paths).toHaveLength(1);
	expect(Object.isFrozen(copied)).toBe(true);
	expect(Object.isFrozen(copied.destinations[0]?.paths)).toBe(true);
	let calls = 0;
	const get = () => {
		calls++;
		throw new Error("PRIVATE_CONFIG_CANARY");
	};
	const accessor = Object.defineProperty({}, "path", { enumerable: true, get });
	for (const value of [
		new Proxy({}, { ownKeys: get, getPrototypeOf: get }),
		{ nested: accessor },
		Object.assign([], { [Symbol()]: true }),
		[undefined],
		{ text: "\ud800" },
		{ number: Number.NaN },
	]) {
		expect(() => configData(value)).toThrow(refusal);
	}
	expect(calls).toBe(0);
});
