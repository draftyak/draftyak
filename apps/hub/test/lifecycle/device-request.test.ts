import { checkRouteRequestBytes } from "@draftyak/protocol/device-api";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type DeviceRequestFrame,
	decodeDeviceRequest,
} from "../../src/lifecycle/device-request.ts";

const encoder = new TextEncoder();
const windowPath = "/device/v1/pairing/windows";
const syntheticPin = "000000";
const windowText = JSON.stringify({ role: "device", pin: syntheticPin });
const opaqueRoutes = [
	{ name: "claim", path: "/pair/v1/claim", route: "pairing-claim", cap: 4096 },
	{ name: "reveal", path: "/pair/v1/reveal", route: "pairing-reveal", cap: 1024 },
] as const;

// Comparisons report booleans only, including when a deliberate omission fails.
function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
	if (left.byteLength !== right.byteLength) return false;
	for (let index = 0; index < left.byteLength; index++)
		if (left[index] !== right[index]) return false;
	return true;
}

function accepted(
	path: string,
	body: Uint8Array,
	route: DeviceRequestFrame["route"],
): DeviceRequestFrame {
	const result = decodeDeviceRequest("POST", path, body);
	try {
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("Expected pairing request DATA");
		expect(Object.isFrozen(result)).toBe(true);
		expect(Object.isFrozen(result.frame)).toBe(true);
		expect(result.frame.route).toBe(route);
		return result.frame;
	} catch (error) {
		if (result.ok) result.frame.received.fill(0);
		throw error;
	}
}

function refused(
	method: string,
	path: string,
	received: Uint8Array,
	reason: "unsupported" | "too-large" | "invalid",
): void {
	const result = decodeDeviceRequest(method, path, received);
	try {
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("Expected fixed pairing DATA refusal");
		expect(result.reason).toBe(reason);
		expect(Object.isFrozen(result)).toBe(true);
	} finally {
		if (result.ok) result.frame.received.fill(0);
	}
}

afterEach(() => vi.restoreAllMocks());

describe("device request DATA proposal", () => {
	it("uses the actual received-window catalogue validator", () => {
		const received = encoder.encode(windowText);
		expect(checkRouteRequestBytes("pairing-window", received)).toBe(true);
		const result = accepted(windowPath, received, "pairing-window");
		try {
			expect(result.route === "pairing-window" && result.body.role === "device").toBe(true);
			expect(result.route === "pairing-window" && result.body.pin === syntheticPin).toBe(true);
			expect(sameBytes(result.received, received)).toBe(true);
			expect(result.received.buffer === received.buffer).toBe(false);
			expect(Object.keys(result).sort().join(",")).toBe("body,received,route");
		} finally {
			result.received.fill(0);
			received.fill(0);
		}
	});

	it.each(["GET", "post", "PUT", "HEAD", "POST "])(
		"refuses the unsupported method %s",
		(method) => {
			const body = encoder.encode(windowText);
			try {
				refused(method, windowPath, body, "unsupported");
			} finally {
				body.fill(0);
			}
		},
	);

	it.each([
		{ name: "query", path: "/pair/v1/claim?x=1" },
		{ name: "trailing slash", path: "/pair/v1/reveal/" },
		{ name: "case alias", path: "/Device/v1/pairing/windows" },
		{ name: "encoded alias", path: "/pair/v1/%63laim" },
		{ name: "dot segment", path: "/pair/v1/./claim" },
		{ name: "fragment", path: "/pair/v1/reveal#part" },
		{ name: "extra endpoint", path: "/pair/v1/abort" },
	])("refuses a $name without URL normalization", ({ path }) => {
		refused("POST", path, new Uint8Array(), "unsupported");
	});

	it.each([
		{ name: "missing PIN", bytes: encoder.encode(JSON.stringify({ role: "device" })) },
		{
			name: "wrong role",
			bytes: encoder.encode(JSON.stringify({ role: "host", pin: syntheticPin })),
		},
		{
			name: "short synthetic PIN",
			bytes: encoder.encode(JSON.stringify({ role: "device", pin: "0".repeat(5) })),
		},
		{
			name: "long synthetic PIN",
			bytes: encoder.encode(JSON.stringify({ role: "device", pin: "0".repeat(65) })),
		},
		{
			name: "extra field",
			bytes: encoder.encode(JSON.stringify({ role: "device", pin: syntheticPin, extra: true })),
		},
		{
			name: "duplicate field",
			bytes: encoder.encode('{"role":"device","pin":"000000","pin":"111111"}'),
		},
		{ name: "invalid UTF-8", bytes: Uint8Array.of(0xff) },
	])("refuses malformed Open DATA through the actual validator: $name", ({ bytes }) => {
		const before = new Uint8Array(bytes);
		try {
			expect(checkRouteRequestBytes("pairing-window", bytes)).toBe(false);
			refused("POST", windowPath, bytes, "invalid");
			expect(sameBytes(bytes, before)).toBe(true);
		} finally {
			bytes.fill(0);
			before.fill(0);
		}
	});

	it("clears its private parsing copy after a decoder failure", () => {
		const received = encoder.encode(windowText);
		const before = new Uint8Array(received);
		let catalogueView: Uint8Array | undefined;
		let ownedView: Uint8Array | undefined;
		let unexpectedSuccess: Uint8Array | undefined;
		let decodes = 0;
		let catalogueDecoded = false;
		let ownedDecoded = false;
		let ownedWasNonzero = false;
		let distinctCaller = false;
		let distinctCatalogue = false;
		try {
			expect(checkRouteRequestBytes("pairing-window", received)).toBe(true);
			const original = TextDecoder.prototype.decode;
			const spy = vi.spyOn(TextDecoder.prototype, "decode").mockImplementation(function (
				this: TextDecoder,
				...args: Parameters<TextDecoder["decode"]>
			) {
				decodes++;
				const view = args[0] instanceof Uint8Array ? args[0] : undefined;
				if (decodes === 1) {
					catalogueView = view;
					const text = Reflect.apply(original, this, args);
					catalogueDecoded = true;
					return text;
				}
				if (decodes === 2) {
					ownedView = view;
					ownedWasNonzero = view?.some((byte) => byte !== 0) === true;
					distinctCaller = view !== undefined && view.buffer !== received.buffer;
					distinctCatalogue =
						view !== undefined &&
						catalogueView !== undefined &&
						view.buffer !== catalogueView.buffer;
					Reflect.apply(original, this, args);
					ownedDecoded = true;
					throw new Error("Synthetic decoder refusal");
				}
				return Reflect.apply(original, this, args);
			});
			try {
				const result = decodeDeviceRequest("POST", windowPath, received);
				if (result.ok) unexpectedSuccess = result.frame.received;
				expect(!result.ok && result.reason === "invalid").toBe(true);
				expect(decodes).toBe(2);
				expect(catalogueDecoded && ownedDecoded).toBe(true);
				expect(distinctCaller && distinctCatalogue).toBe(true);
				expect(ownedWasNonzero).toBe(true);
				expect(ownedView?.byteLength).toBe(received.byteLength);
				expect(ownedView?.every((byte) => byte === 0) === true).toBe(true);
				expect(sameBytes(received, before)).toBe(true);
			} finally {
				spy.mockRestore();
			}
		} finally {
			unexpectedSuccess?.fill(0);
			ownedView?.fill(0);
			catalogueView?.fill(0);
			received.fill(0);
			before.fill(0);
		}
	});

	it("applies the window byte cap before decoding and admits the exact boundary", () => {
		let decodes = 0;
		const original = TextDecoder.prototype.decode;
		vi.spyOn(TextDecoder.prototype, "decode").mockImplementation(function (
			this: TextDecoder,
			...args: Parameters<TextDecoder["decode"]>
		) {
			decodes++;
			return Reflect.apply(original, this, args);
		});
		const exact = encoder.encode(
			windowText + " ".repeat(1024 - encoder.encode(windowText).byteLength),
		);
		const oversized = new Uint8Array(1025).fill(0xff);
		try {
			refused("POST", windowPath, oversized, "too-large");
			expect(decodes).toBe(0);
			const result = accepted(windowPath, exact, "pairing-window");
			try {
				expect(result.received.byteLength).toBe(1024);
				expect(decodes > 0).toBe(true);
			} finally {
				result.received.fill(0);
			}
		} finally {
			exact.fill(0);
			oversized.fill(0);
		}
	});

	it.each(opaqueRoutes)(
		"caps opaque $name bytes without decoding or parsing",
		({ path, route, cap }) => {
			let decodes = 0;
			const original = TextDecoder.prototype.decode;
			vi.spyOn(TextDecoder.prototype, "decode").mockImplementation(function (
				this: TextDecoder,
				...args: Parameters<TextDecoder["decode"]>
			) {
				decodes++;
				return Reflect.apply(original, this, args);
			});
			const exact = new Uint8Array(cap).fill(0xff);
			const oversized = new Uint8Array(cap + 1).fill(0xff);
			const result = accepted(path, exact, route);
			const empty = accepted(path, new Uint8Array(), route);
			try {
				expect(result.received.byteLength).toBe(cap);
				expect(sameBytes(result.received, exact)).toBe(true);
				expect(empty.received.byteLength).toBe(0);
				refused("POST", path, oversized, "too-large");
				expect(decodes).toBe(0);
				expect(Object.keys(result).sort().join(",")).toBe("received,route");
			} finally {
				result.received.fill(0);
				empty.received.fill(0);
				exact.fill(0);
				oversized.fill(0);
			}
		},
	);

	it.each(opaqueRoutes)(
		"preserves the exact $name subview and transfers an independent wipeable copy",
		({ path, route }) => {
			const expected = Uint8Array.of(0xff, 0, 0x20, 0x7b, 0x20, 0x7d, 0x0a);
			const backing =
				route === "pairing-claim"
					? Buffer.alloc(expected.byteLength + 8, 0x7f)
					: new Uint8Array(expected.byteLength + 8).fill(0x7f);
			backing.set(expected, 3);
			const received = backing.subarray(3, 3 + expected.byteLength);
			const result = accepted(path, received, route);
			try {
				expect(sameBytes(result.received, expected)).toBe(true);
				expect(result.received.buffer === backing.buffer).toBe(false);
				result.received.fill(0);
				expect(sameBytes(received, expected)).toBe(true);
				result.received.set(expected);
				backing.fill(0);
				expect(sameBytes(result.received, expected)).toBe(true);
				result.received.fill(0);
				expect(result.received.every((byte) => byte === 0)).toBe(true);
				expect(expected.some((byte) => byte !== 0)).toBe(true);
			} finally {
				result.received.fill(0);
				backing.fill(0);
				expected.fill(0);
			}
		},
	);

	it("uses intrinsic extent and copy operations without supplied view hooks", () => {
		let hooks = 0;
		const hook = (): never => {
			hooks++;
			throw new Error("Unexpected received-view hook");
		};
		const expected = Uint8Array.of(0xff, 0x20, 0);
		const received = new Uint8Array(expected);
		for (const name of [
			"buffer",
			"byteOffset",
			"byteLength",
			"length",
			"slice",
			"set",
			"constructor",
		])
			Object.defineProperty(received, name, { get: hook });
		Object.defineProperty(received, Symbol.iterator, { get: hook });
		Object.defineProperty(received, Symbol.toStringTag, { get: hook });
		const result = accepted("/pair/v1/claim", received, "pairing-claim");
		try {
			expect(sameBytes(result.received, expected)).toBe(true);
			expect(hooks).toBe(0);
		} finally {
			result.received.fill(0);
			Uint8Array.prototype.fill.call(received, 0);
			expected.fill(0);
		}
	});

	it("refuses unknown received inputs and proxies without invoking their hooks", () => {
		let hooks = 0;
		const hook = (): never => {
			hooks++;
			throw new Error("Unexpected request hook");
		};
		const proxy = new Proxy(new Uint8Array(1), {
			get: hook,
			ownKeys: hook,
			getOwnPropertyDescriptor: hook,
			getPrototypeOf: hook,
		});
		const fake = Object.defineProperty({}, "byteLength", { get: hook });
		for (const received of [
			null,
			undefined,
			[],
			fake,
			proxy,
			new DataView(new ArrayBuffer(1)),
			new Uint16Array(1),
		])
			refused("POST", "/pair/v1/claim", received as Uint8Array, "invalid");
		const coerced = { toString: hook } as unknown as string;
		refused(coerced, windowPath, new Uint8Array(), "unsupported");
		refused("POST", coerced, new Uint8Array(), "unsupported");
		expect(hooks).toBe(0);
	});
});
