import { readFileSync } from "node:fs";
import { type Schema, Validator } from "@cfworker/json-schema";
import { describe, expect, it } from "vitest";
import * as z from "zod";
import {
	HOST_MAX_FRAME_BYTES,
	HOST_MAX_WS_DATA_LENGTH,
	HostMessage,
	HostNotification,
	jsonCopy,
} from "../src/host-channel.ts";
import { canonicalize } from "../src/jcs.ts";

const validator = new Validator(
	z.toJSONSchema(HostMessage, { target: "draft-2020-12", io: "input" }) as Schema,
	"2020-12",
);
const exported = new Validator(
	JSON.parse(
		readFileSync(
			new URL("../../../spec/schemas/host-channel-v1.schema.json", import.meta.url),
			"utf8",
		),
	) as Schema,
	"2020-12",
);
const message = (data: unknown, params: Record<string, unknown> = { socketId: "s" }) => ({
	jsonrpc: "2.0",
	method: "host/ws.message",
	params: { ...params, data },
});
const frameBytes = (value: unknown): number => Buffer.byteLength(canonicalize(value));
// Repeats unit, then pads with ASCII, so the frame for socket "s" is exactly at the frame bound.
const fill = (unit: string): string => {
	const room = HOST_MAX_FRAME_BYTES - frameBytes(message(""));
	const size = frameBytes(unit) - 2;
	return unit.repeat(Math.floor(room / size)) + "x".repeat(room % size);
};
const accepted = (value: unknown): boolean[] => [
	HostNotification.safeParse(value).success,
	HostMessage.safeParse(value).success,
	validator.validate(value).valid,
	exported.validate(value).valid,
];
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
const max = HOST_MAX_WS_DATA_LENGTH;

describe("host/ws.message data bound", () => {
	it.each([
		["one over the generic text bound", "x".repeat(8193), true],
		["a multi-line socket-mode envelope", envelope, true],
		["every line break", "a\nb\r\nc d e", true],
		["data at the bound", "x".repeat(max), true],
		["data over the bound", "x".repeat(max + 1), false],
		["four-byte data at the bound in code points", "\u{1f600}".repeat(max), true],
		["four-byte data over the bound in code points", "\u{1f600}".repeat(max + 1), false],
		["non-text data", 1, false],
	])("%s agrees across runtime and generated schemas", (_name, data, valid) => {
		expect(accepted(message(data))).toEqual([valid, valid, valid, valid]);
	});
	it("keeps the socket id and member restrictions", () => {
		for (const params of [{ socketId: "s", extra: true }, { socketId: "a b" }, {}]) {
			const value = message("data", params);
			expect(HostMessage.safeParse(value).success).toBe(false);
			expect(exported.validate(value).valid).toBe(false);
		}
	});
	it("bounds data by the frame bound less the smallest ws.message frame", () => {
		expect([max, HOST_MAX_FRAME_BYTES]).toEqual([1_048_496, 1_048_576]);
		expect(frameBytes(message(""))).toBe(HOST_MAX_FRAME_BYTES - max);
		expect(frameBytes(message("x".repeat(max)))).toBe(HOST_MAX_FRAME_BYTES);
	});
	it.each([
		["ASCII", "x"],
		["two-byte", "é"],
		["three-byte", "€"],
		["four-byte", "\u{1f600}"],
		["line separator", " "],
		["escaped line feed", "\n"],
		["escaped quote", '"'],
		["escaped control", "\u0001"],
	])("fits %s data up to the frame bound and refuses one byte more", (_name, unit) => {
		const data = fill(unit);
		const fits = message(data);
		expect(frameBytes(fits)).toBe(HOST_MAX_FRAME_BYTES);
		expect(HostNotification.parse(jsonCopy(fits))).toEqual(fits);
		const over = message(`${data}x`);
		expect(frameBytes(over)).toBe(HOST_MAX_FRAME_BYTES + 1);
		expect(() => jsonCopy(over)).toThrow("Host value too large");
	});
	it("refuses schema-valid data that cannot fit, multi-byte data at the length bound included", () => {
		for (const over of [
			message("x".repeat(max), { socketId: "s2" }),
			message(`${"x".repeat(max - 1)}é`),
			...["é", "€", "\u{1f600}", "\n", "\u0001"].map((unit) => message(unit.repeat(max))),
		]) {
			expect(accepted(over)).toEqual([true, true, true, true]);
			expect(frameBytes(over)).toBeGreaterThan(HOST_MAX_FRAME_BYTES);
			expect(() => jsonCopy(over)).toThrow("Host value too large");
		}
	});
});
