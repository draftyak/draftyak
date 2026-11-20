import { expect, it } from "vitest";
import { CompatibleError, createCompatibleCore, MAX_RESPONSE_BYTES } from "../src/index.ts";
import { completion, core, MODEL, REQUEST } from "./helpers.ts";

it("refuses proxy and executable control records before invoking their hooks", () => {
	const provider = core(),
		request = provider.build(REQUEST);
	let invoked = 0;
	const proxy = (value: object) =>
		new Proxy(value, {
			getPrototypeOf() {
				invoked++;
				throw new Error("PRIVATE_PROXY_CANARY");
			},
			ownKeys() {
				invoked++;
				throw new Error("PRIVATE_PROXY_CANARY");
			},
		});
	expect(() => provider.build(proxy(REQUEST))).toThrow(CompatibleError);
	expect(provider.verifier(REQUEST)(proxy(request))).toBe(false);
	expect(() =>
		createCompatibleCore(
			proxy({
				endpoint: "http://127.0.0.1:11434/v1/chat/completions",
				model: MODEL,
				format: "json_schema",
			}),
			{ hostname: "127.0.0.1", destination: "local" },
		),
	).toThrow(CompatibleError);
	expect(invoked).toBe(0);
	for (const value of [
		Object.defineProperty({ ...REQUEST }, "prompt", { enumerable: false }),
		{ ...REQUEST, [Symbol("hidden")]: "PRIVATE_SYMBOL_CANARY" },
		Object.assign(Object.create({ inherited: true }), REQUEST),
	])
		expect(() => provider.build(value)).toThrow(CompatibleError);
});

it("refuses executable context arrays and unexpected repair metadata without hooks", () => {
	let invoked = 0;
	const accessor = Object.defineProperty([], "0", {
		enumerable: true,
		get() {
			invoked++;
			return "c1";
		},
	});
	const proxy = new Proxy(["c1"], {
		get() {
			invoked++;
			return "c1";
		},
		getPrototypeOf() {
			invoked++;
			return Array.prototype;
		},
	});
	class Subclass extends Array<string> {}
	for (const contextIds of [accessor, proxy, Array(1), new Subclass("c1")])
		expect(() => core().build({ ...REQUEST, contextIds })).toThrow(CompatibleError);
	const repair = new Proxy(["output.body: too_big"], {
		getPrototypeOf() {
			invoked++;
			return Array.prototype;
		},
	});
	expect(() => core().build({ ...REQUEST, repairProblems: repair })).toThrow(CompatibleError);
	expect(invoked).toBe(0);
});

it("bounds actual response bytes even when a typed-array getter lies about its length", () => {
	const provider = core(),
		valid = completion(provider),
		body = new TextEncoder().encode(
			JSON.stringify({
				...JSON.parse(new TextDecoder().decode(valid.body)),
				padding: "x".repeat(MAX_RESPONSE_BYTES),
			}),
		);
	let invoked = 0;
	Object.defineProperty(body, "byteLength", {
		get() {
			invoked++;
			return 1;
		},
	});
	const result = provider.parse(REQUEST, { ...valid, body });
	expect(result).toMatchObject({ kind: "unexpected", stopReason: "invalid_response" });
	expect(invoked).toBe(0);
});

it("copies real byte storage without getters and refuses shared or subclassed response buffers", () => {
	const provider = core(),
		valid = completion(provider),
		body = new Uint8Array(valid.body);
	let invoked = 0;
	Object.defineProperty(body, "byteLength", {
		get() {
			invoked++;
			throw new Error("PRIVATE_BYTE_CANARY");
		},
	});
	expect(provider.parse(REQUEST, { ...valid, body }).kind).toBe("draft");
	expect(invoked).toBe(0);
	class Subclass extends Uint8Array {}
	const shared = new Uint8Array(new SharedArrayBuffer(valid.body.byteLength));
	shared.set(valid.body);
	for (const body of [shared, new Subclass(valid.body)])
		expect(provider.parse(REQUEST, { ...valid, body })).toMatchObject({
			kind: "unexpected",
			stopReason: "invalid_response",
		});
	expect(provider.parse(REQUEST, { ...valid, body: Buffer.from(valid.body) }).kind).toBe("draft");
});
