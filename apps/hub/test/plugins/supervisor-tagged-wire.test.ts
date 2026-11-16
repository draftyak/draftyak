import {
	HOST_FRAME_TAG,
	HOST_MAX_FRAME_BYTES,
	HostMessage,
	PLUGIN_BOOTSTRAP_MAX_BYTES,
	PluginBootstrap,
} from "@draftyak/protocol/host-channel";
import { canonicalize, JCS_MAX_DEPTH, parseStrict } from "@draftyak/protocol/jcs";
import { describe, expect, it } from "vitest";
import {
	createPluginWireDecoder,
	encodePluginBootstrapFrame,
	encodePluginHostFrame,
	PluginWireError,
} from "../../src/plugins/supervisor/tagged-wire.ts";

type Decoder = ReturnType<typeof createPluginWireDecoder>;
type Frame = NonNullable<ReturnType<Decoder["push"]>["frame"]>;

const request = (value: unknown = "DYTEST-Å-🐂") =>
	HostMessage.parse({
		jsonrpc: "2.0",
		id: "DYTEST-call",
		method: "host/kv.set",
		params: { key: "DYTEST-key", value },
	});
const cancel = HostMessage.parse({
	jsonrpc: "2.0",
	method: "host/cancel",
	params: { requestId: "DYTEST-call" },
});
const reply = HostMessage.parse({ jsonrpc: "2.0", id: "DYTEST-call", result: null });
const notification = HostMessage.parse({
	jsonrpc: "2.0",
	method: "host/ws.message",
	params: { socketId: "DYTEST-socket", data: "DYTEST-🐂" },
});
const bootstrap = PluginBootstrap.parse({
	jsonrpc: "2.0",
	method: "host/bootstrap",
	params: { instance: { id: "DYTEST-instance", config: { value: "DYTEST-config" } } },
});

const json = (value: unknown): Buffer => Buffer.from(canonicalize(value), "utf8");
function wire(value: unknown, tagged = true): Buffer {
	return Buffer.concat([
		Buffer.from(tagged ? HOST_FRAME_TAG : "", "utf8"),
		json(value),
		Buffer.from([10]),
	]);
}
function invalid(action: () => unknown): void {
	let caught: unknown;
	try {
		action();
	} catch (error) {
		caught = error;
	}
	expect(caught).toBeInstanceOf(PluginWireError);
	if (!(caught instanceof PluginWireError)) throw new Error("Expected fixed wire error");
	expect(caught.code).toBe("PLUGIN_WIRE_INVALID");
	expect(caught.name).toBe("PluginWireError");
	expect(caught.message).toBe("Invalid plugin process frame");
	expect("cause" in caught).toBe(false);
}
function whole(bytes: Uint8Array): Frame {
	const decoder = createPluginWireDecoder();
	const page = decoder.push(bytes);
	expect(page.consumed).toBe(bytes.byteLength);
	expect(page.frame).toBeDefined();
	decoder.end();
	if (!page.frame) throw new Error("Expected one actual wire frame");
	return page.frame;
}
function pages(decoder: Decoder, bytes: Uint8Array): Frame[] {
	const result: Frame[] = [];
	let offset = 0;
	while (offset < bytes.byteLength) {
		const page = decoder.push(bytes.subarray(offset));
		expect(Number.isSafeInteger(page.consumed)).toBe(true);
		expect(page.consumed).toBeGreaterThan(0);
		expect(page.consumed).toBeLessThanOrEqual(bytes.byteLength - offset);
		offset += page.consumed;
		if (page.frame) result.push(page.frame);
	}
	return result;
}
function refused(bytes: Uint8Array): void {
	const decoder = createPluginWireDecoder();
	invalid(() => decoder.push(bytes));
	invalid(() => decoder.push(wire(request())));
	invalid(() => decoder.end());
}
function sized(lane: "host" | "untagged", size: number) {
	const make = lane === "host" ? (text: string) => request(text) : (text: string) => text;
	const overhead = json(make("")).length;
	const value = make("x".repeat(size - overhead));
	expect(json(value).length).toBe(size);
	return { value, bytes: wire(value, lane === "host") };
}

describe("plugin tagged wire byte decoder", () => {
	it("routes only tagged requests and cancellation onto the host lane", () => {
		expect(whole(wire(request()))).toEqual({ kind: "host", message: request() });
		expect(whole(wire(cancel))).toEqual({ kind: "host", message: cancel });
		// Untagged strict JSON is DATA for the later MCP consumer, never host dispatch.
		expect(whole(wire(request(), false))).toEqual({ kind: "untagged", value: request() });
		const rpcData = { jsonrpc: "2.0", id: 7, method: "tools/list", params: {} };
		expect(whole(wire(rpcData, false))).toEqual({ kind: "untagged", value: rpcData });
	});

	it("retains tag, split UTF8, and LF across one-byte pages", () => {
		const bytes = wire(request());
		const decoder = createPluginWireDecoder();
		for (let index = 0; index < bytes.length; index++) {
			const page = decoder.push(bytes.subarray(index, index + 1));
			expect(page.consumed).toBe(1);
			if (index + 1 < bytes.length) expect(page.frame).toBeUndefined();
			else expect(page.frame).toEqual({ kind: "host", message: request() });
		}
		decoder.end();
	});

	it("returns one consumed prefix per frame from coalesced host and untagged DATA", () => {
		const first = wire(request());
		const second = wire(cancel);
		const third = wire({ result: "DYTEST" }, false);
		const all = Buffer.concat([first, second, third]);
		const decoder = createPluginWireDecoder();
		const page = decoder.push(all);
		expect(page.consumed).toBe(first.length);
		expect(page.frame).toEqual({ kind: "host", message: request() });
		expect(pages(decoder, all.subarray(page.consumed))).toEqual([
			{ kind: "host", message: cancel },
			{ kind: "untagged", value: { result: "DYTEST" } },
		]);
		decoder.end();
	});

	it("snapshots consumed partial caller bytes before later mutation", () => {
		const bytes = wire(request());
		const split = Math.floor(bytes.length / 2);
		const caller = Uint8Array.from(bytes.subarray(0, split));
		const decoder = createPluginWireDecoder();
		expect(decoder.push(caller)).toEqual({ consumed: caller.length });
		caller.fill(0);
		expect(decoder.push(bytes.subarray(split)).frame).toEqual({ kind: "host", message: request() });
		decoder.end();
	});

	it("returns the first valid frame before refusing its coalesced overlong tail", () => {
		const first = wire(request());
		const tail = sized("untagged", HOST_MAX_FRAME_BYTES + 1).bytes;
		const joined = Buffer.concat([first, tail]);
		const decoder = createPluginWireDecoder();
		const page = decoder.push(joined);
		expect(page.consumed).toBe(first.length);
		expect(page.frame).toEqual({ kind: "host", message: request() });
		invalid(() => decoder.push(joined.subarray(page.consumed)));
		invalid(() => decoder.end());
	});

	for (const lane of ["host", "untagged"] as const) {
		it("accepts exactly one MiB of " + lane + " JSON excluding its tag and LF", () => {
			const boundary = sized(lane, HOST_MAX_FRAME_BYTES);
			expect(boundary.bytes.length).toBe(HOST_MAX_FRAME_BYTES + (lane === "host" ? 2 : 1));
			expect(whole(boundary.bytes)).toEqual(
				lane === "host"
					? { kind: "host", message: boundary.value }
					: { kind: "untagged", value: boundary.value },
			);
		});
		it("refuses one byte over the " + lane + " JSON payload cap and latches failure", () => {
			refused(sized(lane, HOST_MAX_FRAME_BYTES + 1).bytes);
		});
	}

	it("pages a chunk larger than one MiB when each contained frame is within its own cap", () => {
		const boundary = sized("untagged", HOST_MAX_FRAME_BYTES);
		const decoder = createPluginWireDecoder();
		const result = pages(decoder, Buffer.concat([boundary.bytes, boundary.bytes]));
		expect(result).toEqual([
			{ kind: "untagged", value: boundary.value },
			{ kind: "untagged", value: boundary.value },
		]);
		decoder.end();
	});

	it("accepts CRLF as strict JSON whitespace while counting CR toward payload length", () => {
		const below = sized("host", HOST_MAX_FRAME_BYTES - 1);
		const crlf = Buffer.concat([below.bytes.subarray(0, -1), Buffer.from([13, 10])]);
		expect(whole(crlf)).toEqual({ kind: "host", message: below.value });
		const exact = sized("host", HOST_MAX_FRAME_BYTES);
		refused(Buffer.concat([exact.bytes.subarray(0, -1), Buffer.from([13, 10])]));
	});

	for (const [name, bytes] of [
		["invalid UTF8", Buffer.from([34, 0xff, 34, 10])],
		["truncated UTF8", Buffer.from([34, 0xc3, 34, 10])],
		["UTF8 BOM", Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), wire(null, false)])],
		["duplicate root key", Buffer.from('{"x":1,"x":2}\n')],
		["escaped duplicate key", Buffer.from('{"x":1,"\\u0078":2}\n')],
		["nested duplicate key", Buffer.from('{"value":{"x":1,"x":2}}\n')],
		["lone surrogate", Buffer.from('"\\ud800"\n')],
		["empty line", Buffer.from([10])],
		["double tag", Buffer.concat([Buffer.from(HOST_FRAME_TAG), wire(request())])],
		["tag after whitespace", Buffer.concat([Buffer.from(" "), wire(request())])],
	] as const) {
		it("refuses " + name + " with a sticky fixed error", () => refused(bytes));
	}

	it("accepts the actual JCS depth boundary and refuses its immediate neighbor", () => {
		const accepted = Buffer.from(
			"[".repeat(JCS_MAX_DEPTH) + "0" + "]".repeat(JCS_MAX_DEPTH) + "\n",
		);
		expect(whole(accepted)).toEqual({ kind: "untagged", value: parseStrict(accepted) });
		refused(
			Buffer.from("[".repeat(JCS_MAX_DEPTH + 1) + "0" + "]".repeat(JCS_MAX_DEPTH + 1) + "\n"),
		);
	});

	it("refuses root internal NODE commands while preserving ordinary and nested application DATA", () => {
		refused(wire({ cmd: "NODE_HANDLE", value: null }, false));
		refused(wire({ cmd: "NODE_CHANNEL_FD", value: null }));
		expect(whole(wire({ cmd: "DYTEST_APP", value: null }, false))).toEqual({
			kind: "untagged",
			value: { cmd: "DYTEST_APP", value: null },
		});
		const nested = { nested: { cmd: "NODE_HANDLE" } };
		expect(whole(wire(nested, false))).toEqual({ kind: "untagged", value: nested });
		expect(whole(wire(request(nested)))).toEqual({ kind: "host", message: request(nested) });
	});

	for (const [name, value] of [
		["reply", reply],
		["notification", notification],
		["bootstrap", bootstrap],
	] as const) {
		it("refuses a child-to-parent tagged " + name, () => refused(wire(value)));
	}

	it("allows empty pushes and clean repeated end, then refuses later input", () => {
		const decoder = createPluginWireDecoder();
		expect(decoder.push(new Uint8Array())).toEqual({ consumed: 0 });
		expect(decoder.push(wire(request())).frame).toEqual({ kind: "host", message: request() });
		decoder.end();
		decoder.end();
		invalid(() => decoder.push(new Uint8Array()));
	});

	it("refuses end with a truncated tag or JSON line and retains failure", () => {
		for (const prefix of [Buffer.from(HOST_FRAME_TAG), wire(request()).subarray(0, -1)]) {
			const decoder = createPluginWireDecoder();
			expect(decoder.push(prefix).frame).toBeUndefined();
			invalid(() => decoder.end());
			invalid(() => decoder.end());
			invalid(() => decoder.push(wire(request())));
		}
	});
});

describe("plugin parent frame encoders", () => {
	for (const [name, value] of [
		["reply", reply],
		["notification", notification],
	] as const) {
		it("encodes a real " + name + " as detached canonical tagged bytes", () => {
			const input = json(value);
			const result = encodePluginHostFrame(input);
			expect(Buffer.isBuffer(result)).toBe(true);
			expect(result).toEqual(wire(value));
			input.fill(0);
			expect(result).toEqual(wire(value));
		});
	}

	it("normalizes noncanonical valid JSON without accepting an object payload", () => {
		const input = Buffer.from(' { "result" : null, "id" : "DYTEST-call", "jsonrpc" : "2.0" } \r\n');
		expect(encodePluginHostFrame(input)).toEqual(wire(reply));
		invalid(() => encodePluginHostFrame(reply as unknown as Uint8Array));
	});

	it("encodes the complete real bootstrap with a detached input snapshot", () => {
		const input = json(bootstrap);
		const result = encodePluginBootstrapFrame(input);
		expect(result).toEqual(wire(bootstrap));
		input.fill(0);
		expect(result).toEqual(wire(bootstrap));
	});

	it("caps the bootstrap instance rather than its larger full frame", () => {
		const empty = { id: "DYTEST-instance", config: { value: "" } };
		const padding = PLUGIN_BOOTSTRAP_MAX_BYTES - json(empty).length;
		const instance = { ...empty, config: { value: "x".repeat(padding) } };
		expect(json(instance).length).toBe(PLUGIN_BOOTSTRAP_MAX_BYTES);
		const value = PluginBootstrap.parse({
			jsonrpc: "2.0",
			method: "host/bootstrap",
			params: { instance },
		});
		expect(json(value).length).toBeGreaterThan(PLUGIN_BOOTSTRAP_MAX_BYTES);
		expect(encodePluginBootstrapFrame(json(value))).toEqual(wire(value));
		const tooLarge = {
			...value,
			params: { instance: { ...instance, config: { value: "x".repeat(padding + 1) } } },
		};
		invalid(() => encodePluginBootstrapFrame(json(tooLarge)));
	});

	it("accepts exactly one MiB of reply JSON and refuses one more byte", () => {
		const make = (text: string) =>
			HostMessage.parse({ jsonrpc: "2.0", id: "DYTEST-call", result: text });
		const padding = HOST_MAX_FRAME_BYTES - json(make("")).length;
		const value = make("x".repeat(padding));
		expect(json(value).length).toBe(HOST_MAX_FRAME_BYTES);
		expect(encodePluginHostFrame(json(value))).toEqual(wire(value));
		invalid(() => encodePluginHostFrame(json(make("x".repeat(padding + 1)))));
	});

	it("refuses oversized noncanonical input whose canonical frame would fit", () => {
		for (const [value, encode] of [
			[reply, encodePluginHostFrame],
			[bootstrap, encodePluginBootstrapFrame],
		] as const) {
			const canonical = json(value);
			const exact = Buffer.concat([
				Buffer.alloc(HOST_MAX_FRAME_BYTES - canonical.length, 0x20),
				canonical,
			]);
			const tooLong = Buffer.concat([Buffer.from(" "), exact]);
			expect(exact.length).toBe(HOST_MAX_FRAME_BYTES);
			expect(tooLong.length).toBe(HOST_MAX_FRAME_BYTES + 1);
			expect(canonical.length).toBeLessThan(HOST_MAX_FRAME_BYTES);
			expect(parseStrict(tooLong)).toEqual(value);
			expect(encode(exact)).toEqual(wire(value));
			invalid(() => encode(tooLong));
		}
	});

	it("refuses canonical output expansion above one MiB despite a smaller valid input", () => {
		const rawLexeme = "1e-6";
		const itemBytes = Buffer.byteLength(canonicalize(1e-6), "utf8");
		expect(itemBytes).toBeGreaterThan(Buffer.byteLength(rawLexeme, "utf8"));
		const empty = HostMessage.parse({ jsonrpc: "2.0", id: "DYTEST-call", result: [] });
		const emptyBytes = json(empty).length;
		// Nonempty array size adds one comma per item except the first.
		const fitCount = Math.floor((HOST_MAX_FRAME_BYTES - emptyBytes + 1) / (itemBytes + 1));
		const raw = (count: number) =>
			Buffer.from(
				'{"jsonrpc":"2.0","id":"DYTEST-call","result":[' +
					Array(count).fill(rawLexeme).join(",") +
					"]}",
				"utf8",
			);
		const within = raw(fitCount);
		const over = raw(fitCount + 1);
		const withinValue = HostMessage.parse(parseStrict(within));
		const overValue = HostMessage.parse(parseStrict(over));
		const withinCanonical = json(withinValue);
		const overCanonical = json(overValue);
		expect(within.length).toBeLessThan(HOST_MAX_FRAME_BYTES);
		expect(over.length).toBeLessThan(HOST_MAX_FRAME_BYTES);
		expect(withinCanonical.length).toBeLessThanOrEqual(HOST_MAX_FRAME_BYTES);
		expect(overCanonical.length).toBeGreaterThan(HOST_MAX_FRAME_BYTES);
		expect(overCanonical.length - HOST_MAX_FRAME_BYTES).toBeLessThanOrEqual(itemBytes + 1);
		expect(overCanonical.length).toBeGreaterThan(over.length);
		expect(encodePluginHostFrame(within)).toEqual(wire(withinValue));
		invalid(() => encodePluginHostFrame(over));
	});

	for (const [name, value] of [
		["request", request()],
		["cancel", cancel],
		["bootstrap", bootstrap],
	] as const) {
		it("refuses " + name + " in the parent host encoder", () =>
			invalid(() => encodePluginHostFrame(json(value))),
		);
	}
	for (const [name, value] of [
		["reply", reply],
		["notification", notification],
		["request", request()],
	] as const) {
		it("refuses " + name + " in the bootstrap encoder", () =>
			invalid(() => encodePluginBootstrapFrame(json(value))),
		);
	}

	it("retains strict UTF8 duplicate-key and depth validation on outbound bytes", () => {
		const marker = "DYTEST-utf8-x";
		const replacement = "DYTEST-utf8-" + String.fromCodePoint(0xfffd);
		const replyValue = HostMessage.parse({ jsonrpc: "2.0", id: "DYTEST-call", result: marker });
		const bootstrapValue = PluginBootstrap.parse({
			jsonrpc: "2.0",
			method: "host/bootstrap",
			params: { instance: { id: "DYTEST-instance", config: { value: marker } } },
		});
		const fixtures = [
			{
				value: replyValue,
				lossy: HostMessage.parse({ jsonrpc: "2.0", id: "DYTEST-call", result: replacement }),
				validate: (value: unknown) => HostMessage.parse(value),
				encode: encodePluginHostFrame,
			},
			{
				value: bootstrapValue,
				lossy: PluginBootstrap.parse({
					jsonrpc: "2.0",
					method: "host/bootstrap",
					params: { instance: { id: "DYTEST-instance", config: { value: replacement } } },
				}),
				validate: (value: unknown) => PluginBootstrap.parse(value),
				encode: encodePluginBootstrapFrame,
			},
		];
		for (const fixture of fixtures) {
			const valid = json(fixture.value);
			const needle = Buffer.from(marker);
			const offset = valid.indexOf(needle);
			expect(offset).toBeGreaterThanOrEqual(0);
			expect(valid.lastIndexOf(needle)).toBe(offset);
			const corrupted = Buffer.from(valid);
			const payloadByte = offset + needle.length - 1;
			expect(corrupted[payloadByte]).toBe(0x78);
			corrupted[payloadByte] = 0xff;
			// Omitting fatal UTF8 would still leave this SAME full envelope schema-valid.
			expect(fixture.validate(parseStrict(corrupted.toString("utf8")))).toEqual(fixture.lossy);
			expect(fixture.encode(valid)).toEqual(wire(fixture.value));
			invalid(() => fixture.encode(corrupted));
		}
		invalid(() =>
			encodePluginHostFrame(
				Buffer.from('{"jsonrpc":"2.0","id":"DYTEST-call","result":null,"result":null}'),
			),
		);
		let nested: unknown = 0;
		for (let depth = 1; depth < JCS_MAX_DEPTH; depth++) nested = [nested];
		const atDepth = HostMessage.parse({ jsonrpc: "2.0", id: "DYTEST-call", result: nested });
		expect(encodePluginHostFrame(json(atDepth))).toEqual(wire(atDepth));
		const tooDeep = HostMessage.parse({ jsonrpc: "2.0", id: "DYTEST-call", result: [nested] });
		// JSON.stringify deliberately builds the invalid-depth bytes; canonicalize would reject first.
		const tooDeepBytes = Buffer.from(JSON.stringify(tooDeep), "utf8");
		expect(tooDeepBytes.length).toBeLessThan(HOST_MAX_FRAME_BYTES);
		invalid(() => encodePluginHostFrame(tooDeepBytes));
	});
});

interface ByteConsumer {
	readonly name: string;
	readonly bytes: Buffer;
	run(input: Uint8Array): unknown;
}
const consumers: readonly ByteConsumer[] = [
	{
		name: "decoder",
		bytes: wire(request()),
		run: (input) => {
			const decoder = createPluginWireDecoder();
			const page = decoder.push(input);
			decoder.end();
			return page.frame;
		},
	},
	{ name: "host encoder", bytes: json(reply), run: encodePluginHostFrame },
	{ name: "bootstrap encoder", bytes: json(bootstrap), run: encodePluginBootstrapFrame },
];

describe("plugin wire byte input ownership", () => {
	it("ignores own typed-array accessors and iteration hooks while retaining valid bytes", () => {
		for (const consumer of consumers) {
			const input = Uint8Array.from(consumer.bytes);
			const backing = input.buffer;
			let hooks = 0;
			const hook = () => {
				hooks++;
				throw new Error("Caller byte hook invoked");
			};
			for (const key of ["buffer", "byteOffset", "byteLength", "length", "constructor"])
				Object.defineProperty(input, key, { get: hook });
			Object.defineProperty(input, "subarray", { value: hook });
			Object.defineProperty(input, Symbol.iterator, { get: hook });
			Object.defineProperty(backing, "constructor", { get: hook });
			const result = consumer.run(input);
			expect(hooks).toBe(0);
			expect(result).toEqual(consumer.run(Uint8Array.from(consumer.bytes)));
		}
	});

	for (const shape of [
		"proxy",
		"DataView",
		"Int8Array",
		"shared",
		"resizable",
		"detached",
	] as const) {
		it("refuses " + shape + " byte backing at every byte entrypoint without caller hooks", () => {
			for (const consumer of consumers) {
				const plain = Uint8Array.from(consumer.bytes);
				let hooks = 0;
				let invalidInput: unknown;
				if (shape === "proxy") {
					const hook = () => {
						hooks++;
						throw new Error("Caller proxy hook invoked");
					};
					invalidInput = new Proxy(plain, { get: hook, getPrototypeOf: hook, ownKeys: hook });
				} else if (shape === "DataView") {
					invalidInput = new DataView(plain.buffer);
				} else if (shape === "Int8Array") {
					invalidInput = new Int8Array(plain.buffer);
				} else if (shape === "shared") {
					const shared = new Uint8Array(new SharedArrayBuffer(plain.length));
					shared.set(plain);
					invalidInput = shared;
				} else if (shape === "resizable") {
					const resizable = new Uint8Array(
						new ArrayBuffer(plain.length, { maxByteLength: plain.length + 1 }),
					);
					resizable.set(plain);
					invalidInput = resizable;
				} else {
					invalidInput = plain;
					plain.buffer.transfer();
				}
				invalid(() => consumer.run(invalidInput as Uint8Array));
				expect(hooks).toBe(0);
				expect(consumer.run(Uint8Array.from(consumer.bytes))).toBeDefined();
			}
		});
	}
});
