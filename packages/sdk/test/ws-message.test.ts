import { PassThrough } from "node:stream";
import {
	HOST_FRAME_TAG,
	HOST_MAX_FRAME_BYTES,
	HOST_MAX_WS_DATA_LENGTH,
	HostNotification,
} from "@draftyak/protocol/host-channel";
import { canonicalize } from "@draftyak/protocol/jcs";
import { describe, expect, it } from "vitest";
import { createPluginContext } from "../src/context.ts";
import { memoryHost } from "../src/host.ts";
import { stdioHost } from "../src/stdio.ts";

const text = 'Release notes, line one.\nLine two quotes "draft" text. '.repeat(700);
const section = { type: "rich_text_section", elements: [{ type: "text", text }] };
const envelope = JSON.stringify(
	{
		envelope_id: "00000000-0000-4000-8000-000000000001",
		type: "events_api",
		payload: {
			event: { type: "message", text, blocks: [{ type: "rich_text", elements: [section] }] },
		},
	},
	null,
	2,
);
const message = (data: unknown, params: Record<string, unknown> = { socketId: "s" }) =>
	({ jsonrpc: "2.0", method: "host/ws.message", params: { ...params, data } }) as HostNotification;
const reply = (value: string) => ({ jsonrpc: "2.0", id: "r", result: { value } });
const frameBytes = (value: unknown): number => Buffer.byteLength(canonicalize(value));
// Repeats unit, then pads with ASCII, so the frame is exactly `bytes` long.
const fill = (frame: (data: string) => unknown, unit: string, bytes = HOST_MAX_FRAME_BYTES) => {
	const room = bytes - frameBytes(frame(""));
	const size = frameBytes(unit) - 2;
	return unit.repeat(Math.floor(room / size)) + "x".repeat(room % size);
};
const full = fill(message, "x");
const astral = fill(message, "\u{1f600}");
const delivered: [string, string][] = [
	["a multi-line socket-mode envelope", envelope],
	["every line break", "a\nb\r\nc d e"],
	["data that fills the frame bound exactly", full],
	["four-byte characters that fill the frame bound exactly", astral],
];
const tipped = message(`${full.slice(1)}é`);
const wide = message("é".repeat(HOST_MAX_WS_DATA_LENGTH));
const longReply = reply(fill(reply, "x", HOST_MAX_FRAME_BYTES + 1));
const oversized: [string, unknown][] = [
	["a ws.message one multi-byte character over", tipped],
	["a ws.message at the length bound in multi-byte characters", wide],
	["a reply one byte over", longReply],
];
const invalid: [string, unknown][] = [
	["non-text data", message(1)],
	["an extra member", message("data", { socketId: "s", extra: true })],
	["an invalid socket id", message("data", { socketId: "a b" })],
	["missing data", { jsonrpc: "2.0", method: "host/ws.message", params: { socketId: "s" } }],
];
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const lengths = (values: readonly string[]): number[] => values.map((value) => value.length);

async function stdio() {
	const input = new PassThrough();
	const output = new PassThrough();
	const errors: unknown[] = [];
	const forwarded: unknown[] = [];
	let closes = 0;
	const host = stdioHost({ input, output, onerror: (error) => errors.push(error) });
	host.transport.onmessage = (value) => forwarded.push(value);
	host.transport.onclose = () => closes++;
	await host.transport.start();
	output.on("data", (bytes: Buffer) => {
		for (const line of bytes.toString().split("\n")) {
			if (!line.startsWith(HOST_FRAME_TAG)) continue;
			const request = JSON.parse(line.slice(1));
			if (request.method !== "host/ws.open") continue;
			const opened = { jsonrpc: "2.0", id: request.id, result: { socketId: "s" } };
			input.write(`${HOST_FRAME_TAG}${canonicalize(opened)}\n`);
		}
	});
	const socket = await createPluginContext({ plugin: "fixture" }, host).ws.open(
		"wss://example.invalid/",
	);
	const received: string[] = [];
	socket.subscribe((data) => received.push(data));
	const pending = host.request("host/changed", {}).then(
		() => "resolved",
		(error: { code?: string }) => error.code,
	);
	// Pipe-sized pieces, so a frame also crosses partial reads.
	const send = (line: string): void => {
		const bytes = Buffer.from(line);
		for (let start = 0; start < bytes.length; start += 65_536)
			input.write(bytes.subarray(start, start + 65_536));
	};
	return {
		host,
		received,
		errors,
		forwarded,
		pending,
		closes: () => closes,
		deliver: (value: unknown) => send(`${HOST_FRAME_TAG}${canonicalize(value)}\n`),
		ping: () => send('{"jsonrpc":"2.0","id":9,"method":"ping"}\n'),
	};
}

async function memory() {
	const host = memoryHost((method) => (method === "host/ws.open" ? { socketId: "s" } : null));
	const socket = await createPluginContext({ plugin: "fixture" }, host).ws.open(
		"wss://example.invalid/",
	);
	const received: string[] = [];
	socket.subscribe((data) => received.push(data));
	return { host, received };
}

describe("host/ws.message fixtures", () => {
	it("cover a large multi-line envelope and the exact data bound", () => {
		expect(envelope.length).toBeGreaterThan(40_000);
		expect(envelope).toContain("\n");
		expect(full.length).toBe(HOST_MAX_WS_DATA_LENGTH);
		expect([full, astral].map((data) => frameBytes(message(data)))).toEqual([
			HOST_MAX_FRAME_BYTES,
			HOST_MAX_FRAME_BYTES,
		]);
	});
	it("keep the over-budget ws.messages schema-valid, so only the frame bound refuses them", () => {
		expect([tipped, wide].map((value) => HostNotification.safeParse(value).success)).toEqual([
			true,
			true,
		]);
		expect([tipped, wide, longReply].map(frameBytes)).toEqual([
			HOST_MAX_FRAME_BYTES + 1,
			2 * HOST_MAX_WS_DATA_LENGTH + 80,
			HOST_MAX_FRAME_BYTES + 1,
		]);
	});
});

describe("stdio host/ws.message bound", () => {
	it.each(delivered)("delivers %s and keeps the channel open", async (_name, data) => {
		const channel = await stdio();
		channel.deliver(message(data));
		channel.ping();
		await flush();
		expect(lengths(channel.received)).toEqual([data.length]);
		expect(channel.received[0] === data).toBe(true);
		expect(channel.forwarded).toEqual([{ jsonrpc: "2.0", id: 9, method: "ping" }]);
		expect([channel.closes(), channel.errors.length]).toEqual([0, 0]);
		channel.host.close();
		expect(await channel.pending).toBe("DENIED");
	});
	it.each(oversized)("refuses %s before delivery like any overlong frame", async (_name, value) => {
		const channel = await stdio();
		channel.deliver(value);
		channel.ping();
		await flush();
		expect(lengths(channel.received)).toEqual([]);
		expect(channel.forwarded).toEqual([]);
		expect(channel.closes()).toBe(1);
		expect(channel.errors).toMatchObject([{ code: "BAD_REQUEST" }]);
		expect(await channel.pending).toBe("DENIED");
		await expect(channel.host.request("host/kv.get", { key: "key" })).rejects.toMatchObject({
			code: "DENIED",
		});
	});
	it.each(invalid)("closes the channel, MCP included, on %s", async (_name, value) => {
		const channel = await stdio();
		channel.deliver(value);
		channel.ping();
		await flush();
		expect(channel.received).toEqual([]);
		expect(channel.forwarded).toEqual([]);
		expect(channel.closes()).toBe(1);
		expect(channel.errors).toMatchObject([{ code: "BAD_REQUEST" }]);
		expect(await channel.pending).toBe("DENIED");
	});
});

describe("memory host/ws.message bound", () => {
	it("delivers every case that fits the frame bound", async () => {
		const channel = await memory();
		for (const [, data] of delivered) channel.host.notify(message(data));
		expect(lengths(channel.received)).toEqual(lengths(delivered.map(([, data]) => data)));
		expect(channel.received.every((data, index) => data === delivered[index]?.[1])).toBe(true);
		channel.host.close();
	});
	it("refuses oversized and invalid notifications before delivery", async () => {
		const channel = await memory();
		for (const [, value] of oversized)
			expect(() => channel.host.notify(value as HostNotification)).toThrow("Host value too large");
		for (const [, value] of invalid)
			expect(() => channel.host.notify(value as HostNotification)).toThrow();
		channel.host.notify(message("after"));
		expect(channel.received).toEqual(["after"]);
		channel.host.close();
	});
});
