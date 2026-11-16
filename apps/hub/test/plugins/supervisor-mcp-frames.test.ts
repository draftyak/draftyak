import { Buffer } from "node:buffer";
import { HOST_FRAME_TAG, HOST_MAX_FRAME_BYTES } from "@draftyak/protocol/host-channel";
import { parseJSONRPCMessage } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";
import {
	createPluginWireDecoder,
	encodePluginMcpFrame,
	PluginWireError,
} from "../../src/plugins/supervisor/tagged-wire.ts";

const bytes = (text: string): Buffer => Buffer.from(text, "utf8");

function invalid(raw: Uint8Array): void {
	let caught: unknown;
	try {
		encodePluginMcpFrame(raw);
	} catch (error) {
		caught = error;
	}
	expect(caught).toBeInstanceOf(PluginWireError);
	expect(caught).toMatchObject({
		name: "PluginWireError",
		code: "PLUGIN_WIRE_INVALID",
		message: "Invalid plugin process frame",
	});
	if (!(caught instanceof PluginWireError)) throw new Error("DYTEST expected fixed failure");
	expect(Object.hasOwn(caught, "cause")).toBe(false);
}

describe("plugin MCP input frames", () => {
	it("encodes a canonical untagged request with exactly one trailing LF", () => {
		const frame = encodePluginMcpFrame(
			bytes(' { "params": { "value": 1e20 }, "method": "tools/call", "id": 0, "jsonrpc": "2.0" } '),
		);
		expect(frame.toString("utf8")).toBe(
			'{"id":0,"jsonrpc":"2.0","method":"tools/call","params":{"value":100000000000000000000}}\n',
		);
		expect(frame[0]).not.toBe(HOST_FRAME_TAG.charCodeAt(0));
		expect(frame.at(-1)).toBe(10);
		expect(frame.subarray(0, -1).includes(10)).toBe(false);
	});

	it("preserves numeric and string request IDs and all envelope directions", () => {
		const messages: readonly (readonly [string, string])[] = [
			['{"jsonrpc":"2.0","id":0,"method":"ping"}', '{"id":0,"jsonrpc":"2.0","method":"ping"}\n'],
			[
				'{"jsonrpc":"2.0","id":"0","method":"ping"}',
				'{"id":"0","jsonrpc":"2.0","method":"ping"}\n',
			],
			[
				'{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":0}}',
				'{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":0}}\n',
			],
			[
				'{"jsonrpc":"2.0","id":0,"result":{"resultType":"complete"}}',
				'{"id":0,"jsonrpc":"2.0","result":{"resultType":"complete"}}\n',
			],
			[
				'{"jsonrpc":"2.0","id":"0","error":{"code":-32603,"message":"DYTEST failure"}}',
				'{"error":{"code":-32603,"message":"DYTEST failure"},"id":"0","jsonrpc":"2.0"}\n',
			],
			[
				'{"jsonrpc":"2.0","error":{"code":-32700,"message":"DYTEST parse"}}',
				'{"error":{"code":-32700,"message":"DYTEST parse"},"jsonrpc":"2.0"}\n',
			],
			[
				'{"jsonrpc":"2.0","id":1,"result":{"resultType":"complete","_meta":{"DYTEST":"kept"}}}',
				'{"id":1,"jsonrpc":"2.0","result":{"_meta":{"DYTEST":"kept"},"resultType":"complete"}}\n',
			],
		];
		for (const [index, [input, expected]] of messages.entries()) {
			expect(() => {
				expect(encodePluginMcpFrame(bytes(input)).toString("utf8")).toBe(expected);
			}, `DYTEST envelope ${index}`).not.toThrow();
		}
	});

	it("uses the actual MCP envelope parser instead of accepting arbitrary JSON", () => {
		for (const text of [
			"null",
			"[]",
			"{}",
			"true",
			'"data"',
			'{"jsonrpc":"1.0","id":0,"method":"ping"}',
			'{"jsonrpc":"2.0","id":null,"method":"ping"}',
			'{"jsonrpc":"2.0","id":true,"method":"ping"}',
			'{"jsonrpc":"2.0","method":3}',
			'{"jsonrpc":"2.0","id":0,"error":{"code":"-32603","message":"DYTEST"}}',
		])
			invalid(bytes(text));
	});

	it("refuses ambiguous or invalid UTF-8 JSON without retaining the diagnostic", () => {
		const malformed = bytes('{"jsonrpc":"2.0","method":"ping","params":{"text":"x"}}');
		const textAt = malformed.indexOf(bytes('"x"')) + 1;
		expect(textAt).toBeGreaterThan(0);
		malformed[textAt] = 0xff;
		const lossyNeighbor = bytes(malformed.toString("utf8"));
		expect(encodePluginMcpFrame(lossyNeighbor).toString("utf8")).toBe(
			'{"jsonrpc":"2.0","method":"ping","params":{"text":"\ufffd"}}\n',
		);
		for (const raw of [
			bytes('{"jsonrpc":"2.0","id":0,"id":1,"method":"ping"}'),
			bytes('{"jsonrpc":"2.0","method":"ping"}\n{"jsonrpc":"2.0","method":"ping"}'),
			bytes(`${HOST_FRAME_TAG}{"jsonrpc":"2.0","method":"ping"}`),
			bytes('{"jsonrpc":"2.0","method":"ping","params":{"value":1e999}}'),
			malformed,
		])
			invalid(raw);
	});

	it("refuses root IPC commands while preserving nested DATA", () => {
		const command = bytes('{"jsonrpc":"2.0","method":"ping","cmd":"NODE_CHANNEL_FD"}');
		expect(() => parseJSONRPCMessage(JSON.parse(command.toString("utf8")))).toThrow();
		invalid(command);
		const raw = bytes('{"jsonrpc":"2.0","method":"ping","params":{"cmd":"NODE_CHANNEL_FD"}}');
		expect(encodePluginMcpFrame(raw).toString("utf8")).toBe(
			'{"jsonrpc":"2.0","method":"ping","params":{"cmd":"NODE_CHANNEL_FD"}}\n',
		);
	});

	it("handles escaped control characters as DATA without making extra frames", () => {
		const raw = bytes('{"jsonrpc":"2.0","method":"ping","params":{"text":"a\\n\\u001eb\\r"}}');
		const frame = encodePluginMcpFrame(raw);
		expect(frame.toString("utf8")).toBe(
			'{"jsonrpc":"2.0","method":"ping","params":{"text":"a\\n\\u001eb\\r"}}\n',
		);
		const decoder = createPluginWireDecoder();
		const result = decoder.push(frame);
		expect(result.consumed).toBe(frame.byteLength);
		expect(result.frame).toMatchObject({
			kind: "untagged",
			value: { params: { text: "a\n\u001eb\r" } },
		});
		decoder.end();
	});

	it("accepts exactly the payload byte limit and refuses its next byte", () => {
		const prefix = '{"jsonrpc":"2.0","method":"ping","params":{"text":"';
		const suffix = '"}}';
		const room = HOST_MAX_FRAME_BYTES - Buffer.byteLength(prefix + suffix);
		const exact = bytes(prefix + "x".repeat(room) + suffix);
		const frame = encodePluginMcpFrame(exact);
		expect(exact.byteLength).toBe(HOST_MAX_FRAME_BYTES);
		expect(frame.byteLength).toBe(HOST_MAX_FRAME_BYTES + 1);
		invalid(bytes(prefix + "x".repeat(room + 1) + suffix));
		const tiny = '{"jsonrpc":"2.0","method":"ping"}';
		const padding = HOST_MAX_FRAME_BYTES - Buffer.byteLength(tiny);
		const padded = bytes(" ".repeat(padding) + tiny);
		expect(padded.byteLength).toBe(HOST_MAX_FRAME_BYTES);
		expect(encodePluginMcpFrame(padded).toString("utf8")).toBe(`${tiny}\n`);
		invalid(bytes(" ".repeat(padding + 1) + tiny));
	});

	it("bounds canonical output independently when compact numbers expand", () => {
		const prefix = '{"jsonrpc":"2.0","method":"ping","params":{"values":[';
		const suffix = "]}}";
		const room = HOST_MAX_FRAME_BYTES - Buffer.byteLength(prefix + suffix);
		// Each canonical number takes 21 bytes; every following number adds one comma.
		const count = Math.floor((room + 1) / 22);
		const near = bytes(prefix + Array<string>(count).fill("1e20").join(",") + suffix);
		const frame = encodePluginMcpFrame(near);
		expect(frame.byteLength).toBe(Buffer.byteLength(prefix + suffix) + count * 22);
		expect(frame.byteLength).toBeLessThanOrEqual(HOST_MAX_FRAME_BYTES + 1);
		const tooLarge = bytes(
			prefix +
				Array<string>(count + 1)
					.fill("1e20")
					.join(",") +
				suffix,
		);
		expect(tooLarge.byteLength).toBeLessThan(HOST_MAX_FRAME_BYTES);
		invalid(tooLarge);
	});

	it("copies only the native view without reading shadowed properties or iterators", () => {
		const valid = bytes('{"jsonrpc":"2.0","method":"ping"}');
		const storage = Buffer.concat([bytes("not JSON"), valid, bytes("not JSON")]);
		const raw = new Uint8Array(storage.buffer, storage.byteOffset + 8, valid.byteLength);
		let hooks = 0;
		for (const key of [
			"buffer",
			"byteOffset",
			"byteLength",
			"length",
			"constructor",
			Symbol.iterator,
		]) {
			Object.defineProperty(raw, key, {
				get() {
					hooks++;
					throw new Error("DYTEST hook");
				},
			});
		}
		const frame = encodePluginMcpFrame(raw);
		storage.fill(0);
		expect(frame.toString("utf8")).toBe('{"jsonrpc":"2.0","method":"ping"}\n');
		expect(hooks).toBe(0);
	});

	it("refuses proxy, shared, resizable and detached byte inputs without hooks", () => {
		const valid = bytes('{"jsonrpc":"2.0","method":"ping"}');
		let hooks = 0;
		const proxy = new Proxy(valid, {
			get() {
				hooks++;
				throw new Error("DYTEST hook");
			},
		});
		invalid(proxy);
		expect(hooks).toBe(0);
		const shared = new Uint8Array(new SharedArrayBuffer(valid.byteLength));
		shared.set(valid);
		invalid(shared);
		const resizable = new ArrayBuffer(valid.byteLength, { maxByteLength: valid.byteLength + 1 });
		new Uint8Array(resizable).set(valid);
		invalid(new Uint8Array(resizable));
		const detached = new Uint8Array(valid);
		structuredClone(detached.buffer, { transfer: [detached.buffer] });
		invalid(detached);
		expect(encodePluginMcpFrame(valid).toString("utf8")).toBe(
			'{"jsonrpc":"2.0","method":"ping"}\n',
		);
	});
});
