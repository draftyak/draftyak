import { HOST_MAX_FRAME_BYTES } from "@draftyak/protocol/host-channel";
import { parseStrict } from "@draftyak/protocol/jcs";
import { describe, expect, it } from "vitest";
import {
	decodeLine,
	encodeFrame,
	type Frame,
	FrameDecoder,
	FrameTooLargeError,
} from "../../src/plugins/supervisor/frames.ts";

const RS = "\u001e";
const LOG = { level: "info", message: "DYTEST ü 日本 log" };

function decodeAll(chunks: readonly Uint8Array[]): {
	frames: Frame[];
	violation: string | undefined;
} {
	const decoder = new FrameDecoder();
	const frames: Frame[] = [];
	let violation: string | undefined;
	for (const chunk of chunks) {
		const found = decoder.push(chunk, (frame) => {
			frames.push(frame);
			return true;
		});
		if (found !== undefined) {
			violation = found;
			break;
		}
	}
	return { frames, violation: violation ?? decoder.finish() };
}

/** A notification or host request whose JSON is exactly `bytes` long. */
function sized(bytes: number, host: boolean): string {
	const value = (pad: string) =>
		host
			? JSON.stringify({
					jsonrpc: "2.0",
					id: "r1",
					method: "host/kv.set",
					params: { key: "k", value: pad },
				})
			: JSON.stringify({ jsonrpc: "2.0", method: "dytest/pad", params: { pad } });
	return value("x".repeat(bytes - value("").length));
}

describe("frame decoding", () => {
	const mcp = `${JSON.stringify({ jsonrpc: "2.0", id: "h1", result: { text: "DYTEST ü 日本 😀" } })}\n`;
	const host = `${RS}${JSON.stringify({ jsonrpc: "2.0", id: "p1", method: "host/log", params: LOG })}\n`;
	const input = Buffer.from(mcp + host);

	it("routes both channels the same at every split offset", () => {
		const whole = decodeAll([input]);
		expect(whole.violation).toBeUndefined();
		expect(whole.frames).toEqual([
			{ channel: "mcp", type: "result", id: "h1", result: { text: "DYTEST ü 日本 😀" } },
			{ channel: "host", id: "p1", method: "host/log", params: LOG },
		]);
		for (let offset = 0; offset <= input.length; offset++)
			expect(decodeAll([input.subarray(0, offset), input.subarray(offset)])).toEqual(whole);
		expect(decodeAll([...input].map((byte) => Uint8Array.of(byte)))).toEqual(whole);
	});

	it("treats a tag anywhere but byte 0 as a parse error", () => {
		const shifted = Buffer.from(` ${host}`);
		expect(decodeAll([shifted]).violation).toBe("parse-error");
		const inner = Buffer.from(`{"jsonrpc":"2.0",${RS}"method":"x"}\n`);
		expect(decodeAll([inner]).violation).toBe("parse-error");
	});

	for (const tagged of [false, true]) {
		const side = tagged ? "host" : "mcp";
		it(`accepts exactly ${HOST_MAX_FRAME_BYTES} bytes on the ${side} channel`, () => {
			const line = Buffer.from(`${tagged ? RS : ""}${sized(HOST_MAX_FRAME_BYTES, tagged)}\n`);
			const { frames, violation } = decodeAll([line]);
			expect(violation).toBeUndefined();
			expect(frames).toHaveLength(1);
			expect(frames[0]?.channel).toBe(side);
		});

		it(`refuses one byte more on the ${side} channel before the LF arrives`, () => {
			const decoder = new FrameDecoder();
			const body = Buffer.alloc(HOST_MAX_FRAME_BYTES, 0x78);
			const start = Buffer.from(tagged ? RS : "");
			expect(decoder.push(Buffer.concat([start, body]), () => true)).toBeUndefined();
			expect(decoder.pending).toBe(HOST_MAX_FRAME_BYTES + start.length);
			expect(decoder.push(Buffer.from("x"), () => true)).toBe("oversize");
			expect(decoder.pending).toBe(0);
			expect(decoder.push(Buffer.from(`${mcp}`), () => expect.unreachable())).toBeUndefined();
		});
	}

	it("never buffers more than the limit plus one byte", () => {
		const decoder = new FrameDecoder();
		const piece = Buffer.alloc(65_536, 0x78);
		let violation: string | undefined;
		for (let index = 0; index < 32 && violation === undefined; index++) {
			violation = decoder.push(piece, () => true);
			expect(decoder.pending).toBeLessThanOrEqual(HOST_MAX_FRAME_BYTES + 1);
		}
		expect(violation).toBe("oversize");
	});

	it("reports a non-empty unterminated tail once and dispatches nothing from it", () => {
		const decoder = new FrameDecoder();
		const seen: Frame[] = [];
		expect(
			decoder.push(Buffer.from(mcp.slice(0, -1)), (frame) => seen.push(frame) > 0),
		).toBeUndefined();
		expect(decoder.finish()).toBe("unterminated");
		expect(decoder.finish()).toBeUndefined();
		expect(seen).toEqual([]);
		expect(new FrameDecoder().finish()).toBeUndefined();
	});

	it("stops when the consumer refuses a frame", () => {
		const decoder = new FrameDecoder();
		const seen: Frame[] = [];
		expect(decoder.push(input, (frame) => seen.push(frame) < 0)).toBeUndefined();
		expect(seen).toHaveLength(1);
		expect(decoder.stopped).toBe(true);
		expect(decoder.push(input, () => expect.unreachable())).toBeUndefined();
	});

	it("accepts only the four strict JSON-RPC envelopes and the host request channel", () => {
		const accepted: [string, unknown][] = [
			[
				'{"jsonrpc":"2.0","id":1,"result":{}}',
				{ channel: "mcp", type: "result", id: 1, result: {} },
			],
			[
				'{"jsonrpc":"2.0","id":"a","error":{"code":-1,"message":"m","data":{"x":1}}}',
				{ channel: "mcp", type: "error", id: "a", code: -1 },
			],
			[
				'{"jsonrpc":"2.0","method":"n"}',
				{ channel: "mcp", type: "notification", method: "n", params: undefined },
			],
			[
				'{"jsonrpc":"2.0","method":"n","params":{"a":1}}',
				{ channel: "mcp", type: "notification", method: "n", params: { a: 1 } },
			],
			[
				'{"jsonrpc":"2.0","id":"r","method":"m","params":{}}',
				{ channel: "mcp", type: "request", id: "r", method: "m" },
			],
			[
				`{"jsonrpc":"2.0","id":"${"i".repeat(128)}","result":{}}`,
				{ channel: "mcp", type: "result", id: "i".repeat(128), result: {} },
			],
		];
		for (const [line, frame] of accepted) expect(decodeLine(Buffer.from(line))).toEqual(frame);
		const refused: [string, string][] = [
			['{"jsonrpc":"1.0","method":"n"}', "not-jsonrpc"],
			['{"jsonrpc":"2.0","id":1,"result":[]}', "not-jsonrpc"],
			['{"jsonrpc":"2.0","id":1,"result":{},"extra":1}', "not-jsonrpc"],
			['{"jsonrpc":"2.0","id":null,"error":{"code":1,"message":"m"}}', "not-jsonrpc"],
			['{"jsonrpc":"2.0","id":"","result":{}}', "not-jsonrpc"],
			[`{"jsonrpc":"2.0","id":"${"i".repeat(129)}","result":{}}`, "not-jsonrpc"],
			['{"jsonrpc":"2.0","id":"a b","result":{}}', "not-jsonrpc"],
			['{"jsonrpc":"2.0","id":1.5,"result":{}}', "not-jsonrpc"],
			['{"jsonrpc":"2.0","id":9007199254740992,"result":{}}', "not-jsonrpc"],
			['{"jsonrpc":"2.0","id":1,"error":{"code":1.5,"message":"m"}}', "not-jsonrpc"],
			['{"jsonrpc":"2.0","id":1,"error":{"code":1,"message":"m","x":1}}', "not-jsonrpc"],
			['{"jsonrpc":"2.0","id":1,"error":{"code":1}}', "not-jsonrpc"],
			['{"jsonrpc":"2.0","id":1}', "not-jsonrpc"],
			['{"jsonrpc":"2.0","method":"n","params":[1]}', "not-jsonrpc"],
			['{"jsonrpc":"2.0","method":5}', "not-jsonrpc"],
			['"text"', "not-jsonrpc"],
			["null", "not-jsonrpc"],
			['{"cmd":"NODE_HANDLE"}', "handle"],
			['{"cmd":"NODE_HANDLE_ACK"}', "internal-message"],
			['{"cmd":"NODE_HANDLE_NACK","jsonrpc":"2.0","method":"n"}', "internal-message"],
			['{"cmd":"NODE_CLUSTER"}', "internal-message"],
			[`${RS}{"cmd":"NODE_HANDLE"}`, "handle"],
			[`${RS}{"jsonrpc":"2.0","id":"x","method":"host/unknown","params":{}}`, "bad-host-frame"],
			[
				`${RS}{"jsonrpc":"2.0","id":"x","method":"host/log","params":{"level":"info","message":"a\\nb"}}`,
				"bad-host-frame",
			],
			[
				`${RS}{"jsonrpc":"2.0","id":"x","error":{"code":-32000,"message":"m","data":{"code":"DENIED"}}}`,
				"unexpected-frame",
			],
			[
				`${RS}{"jsonrpc":"2.0","method":"host/ws.message","params":{"socketId":"s","data":""}}`,
				"unexpected-frame",
			],
			['{"a":1,"a":2}', "parse-error"],
			['{"a":"\\ud800"}', "parse-error"],
			["{} {}", "parse-error"],
		];
		for (const [line, kind] of refused) expect(decodeLine(Buffer.from(line)), line).toBe(kind);
		expect(decodeLine(Buffer.from([0x7b, 0x22, 0xc3, 0x28, 0x22, 0x3a, 0x31, 0x7d]))).toBe(
			"parse-error",
		);
	});
});

/** A small seeded generator, so the corpus is the same on every run and every OS. */
function random(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let value = state;
		value = Math.imul(value ^ (value >>> 15), value | 1);
		value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
		return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
	};
}

describe("seeded mutation corpus", () => {
	const valid = [
		JSON.stringify({ jsonrpc: "2.0", id: "h1", result: { tools: [{ name: "run" }] } }),
		JSON.stringify({
			jsonrpc: "2.0",
			method: "notifications/progress",
			params: { progressToken: "t", progress: 1 },
		}),
		JSON.stringify({ jsonrpc: "2.0", id: 7, error: { code: -32601, message: "Method not found" } }),
		`${RS}${JSON.stringify({ jsonrpc: "2.0", id: "p1", method: "host/log", params: LOG })}`,
		`${RS}${JSON.stringify({ jsonrpc: "2.0", id: "p2", method: "host/kv.get", params: { key: "k" } })}`,
	];
	const mutations: ((line: Buffer, next: () => number) => Buffer)[] = [
		(line, next) => {
			const copy = Buffer.from(line);
			const at = Math.floor(next() * copy.length);
			copy[at] = (copy[at] ?? 0) ^ (1 << Math.floor(next() * 8));
			return copy;
		},
		(line, next) => line.subarray(0, Math.floor(next() * line.length)),
		(line) =>
			Buffer.from(
				line.toString("latin1").replace('"jsonrpc":"2.0"', '"jsonrpc":"2.0","jsonrpc":"2.0"'),
				"latin1",
			),
		(_line, next) =>
			Buffer.from(JSON.stringify({ cmd: next() < 0.5 ? "NODE_HANDLE" : "NODE_CLUSTER", msg: {} })),
		(line, next) => Buffer.concat([line, Buffer.alloc(Math.floor(next() * 2_000_000), 0x78)]),
		(line, next) => {
			const at = Math.floor(next() * line.length);
			return Buffer.concat([
				line.subarray(0, at),
				Buffer.from([Math.floor(next() * 256)]),
				line.subarray(at),
			]);
		},
		(line, next) =>
			Buffer.concat([line.subarray(0, Math.floor(next() * line.length)), Buffer.from("\n"), line]),
	];

	it("never throws, ends in one violation or valid frames, and emits nothing after a violation", () => {
		const next = random(0x5eed);
		for (let round = 0; round < 2_000; round++) {
			const base = Buffer.from(valid[Math.floor(next() * valid.length)] as string);
			const mutated = (
				mutations[Math.floor(next() * mutations.length)] as (typeof mutations)[number]
			)(base, next);
			const stream = Buffer.concat([
				mutated,
				Buffer.from("\n"),
				Buffer.from(valid[0] as string),
				Buffer.from("\n"),
			]);
			const decoder = new FrameDecoder();
			const frames: Frame[] = [];
			let violations = 0;
			let afterViolation = 0;
			let offset = 0;
			while (offset < stream.length) {
				const size = 1 + Math.floor(next() * 4096);
				const chunk = stream.subarray(offset, offset + size);
				offset += size;
				let found: string | undefined;
				expect(() => {
					found = decoder.push(chunk, (frame) => {
						if (violations > 0) afterViolation++;
						frames.push(frame);
						return true;
					});
				}).not.toThrow();
				if (found !== undefined) violations++;
			}
			const tail = decoder.finish();
			if (tail !== undefined) violations++;
			expect(violations).toBeLessThanOrEqual(1);
			expect(afterViolation).toBe(0);
			if (violations === 0) expect(frames.length).toBeGreaterThanOrEqual(1);
		}
	});
});

describe("frame encoding", () => {
	it("writes canonical JSON and LF, with the tag on host frames", () => {
		const value = { b: [1, "ü"], a: { d: null, c: true }, jsonrpc: "2.0" };
		expect(encodeFrame(value, false)).toBe(
			'{"a":{"c":true,"d":null},"b":[1,"ü"],"jsonrpc":"2.0"}\n',
		);
		const host = encodeFrame(value, true);
		expect(host.startsWith(RS)).toBe(true);
		expect(host.endsWith("\n")).toBe(true);
		expect(parseStrict(host.slice(1, -1))).toEqual(value);
	});

	it("refuses more than one frame's JSON and non-JSON values", () => {
		const exact = JSON.parse(sized(HOST_MAX_FRAME_BYTES, false));
		expect(Buffer.byteLength(encodeFrame(exact, false))).toBe(HOST_MAX_FRAME_BYTES + 1);
		const over = JSON.parse(sized(HOST_MAX_FRAME_BYTES + 1, false));
		expect(() => encodeFrame(over, false)).toThrow(FrameTooLargeError);
		expect(() => encodeFrame(over, true)).toThrow(FrameTooLargeError);
		expect(() => encodeFrame({ value: 1n }, false)).toThrow();
		expect(() => encodeFrame({ value: Number.NaN }, false)).toThrow();
	});
});
