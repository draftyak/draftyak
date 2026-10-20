import { describe, expect, it } from "vitest";
import { canonicalize } from "../../src/jcs.ts";
import {
	checkToolResult,
	parseToolFrame,
	TOOL_ERROR_META_KEY,
	TOOL_FRAME_MAX_BYTES,
} from "../../src/tool-v1.ts";

const t0 = Date.UTC(2026, 9, 19);
const busy = (count: number) =>
	Array.from({ length: count }, (_, i) => ({
		start: t0 + i * 120_000,
		end: t0 + i * 120_000 + 60_000,
		status: i % 2 === 0 ? "busy" : "tentative",
	}));
const notes = { notes: [{ label: "Account", text: "DYTEST prefers mornings." }] };
// A tools/call result as the plugin sends it.
const complete = (structuredContent: unknown, rest: object = {}) => ({
	resultType: "complete",
	content: [],
	structuredContent,
	...rest,
});
const failed = (error: unknown, rest: object = {}) => ({
	resultType: "complete",
	content: [{ type: "text", text: "AUTH_REVOKED" }],
	isError: true,
	_meta: { [TOOL_ERROR_META_KEY]: error, "io.modelcontextprotocol/serverInfo": {} },
	...rest,
});
const refused = (refusal: string) => ({ status: "refused", refusal });

describe("parseToolFrame", () => {
	// A JSON string padded to exactly `bytes` UTF-8 bytes.
	const frame = (bytes: number): string => JSON.stringify("x".repeat(bytes - 2));

	it("parses a frame of up to 64 KiB strictly, its line terminator not counted", () => {
		expect(TOOL_FRAME_MAX_BYTES).toBe(65_536);
		for (const line of [frame(65_536), `${frame(65_536)}\n`, `${frame(65_536)}\r\n`]) {
			expect(parseToolFrame(line).status).toBe("ok");
			expect(parseToolFrame(new TextEncoder().encode(line)).status).toBe("ok");
		}
		const encoded = new TextEncoder().encode('{"jsonrpc":"2.0","id":1,"result":{}}\n');
		expect(parseToolFrame(encoded)).toEqual({
			status: "ok",
			message: { jsonrpc: "2.0", id: 1, result: {} },
		});
	});

	it("drops a larger frame unparsed, and a frame that isn't strict JSON", () => {
		for (const line of [frame(65_537), `${frame(65_537)}\n`, `${frame(65_536)} \n`]) {
			expect(parseToolFrame(line)).toEqual({ status: "dropped", reason: "TOOL_FRAME_TOO_LARGE" });
		}
		// Only one terminator is left out of the count.
		expect(parseToolFrame(`${frame(65_535)}\n\n\n`).status).toBe("dropped");
		// Invalid JSON over the limit is dropped for its size: it is never parsed.
		expect(parseToolFrame(`{${"x".repeat(65_536)}`)).toHaveProperty(
			"reason",
			"TOOL_FRAME_TOO_LARGE",
		);
		// Multi-byte characters count as their UTF-8 bytes.
		expect(parseToolFrame(JSON.stringify("\u{e9}".repeat(32_767))).status).toBe("ok");
		expect(parseToolFrame(JSON.stringify("\u{e9}".repeat(32_768))).status).toBe("dropped");
		for (const invalid of ['{"a":1,"a":2}', '{"a":"\\ud800"}', "{", "", new Uint8Array([0xff])]) {
			expect(parseToolFrame(invalid)).toEqual({ status: "dropped", reason: "TOOL_FRAME_INVALID" });
		}
	});
});

describe("checkToolResult", () => {
	it("uses only structuredContent and reports its canonical size", () => {
		const result = complete(notes, { content: [{ type: "text", text: "ignored" }] });
		expect(checkToolResult("contact.notes", result)).toEqual({
			status: "ok",
			value: notes,
			bytes: canonicalize(notes).length,
		});
		for (const raw of [
			complete(notes, { _meta: { "io.modelcontextprotocol/serverInfo": {} } }),
			complete(notes, { isError: false }),
		]) {
			expect(checkToolResult("contact.notes", raw).status).toBe("ok");
		}
	});

	it("needs resultType complete and content, unless an MCP client already decoded the result", () => {
		const { resultType: _, ...noType } = complete(notes);
		const { content: __, ...noContent } = complete(notes);
		for (const result of [noType, noContent, { structuredContent: notes }]) {
			expect(checkToolResult("contact.notes", result)).toEqual(refused("TOOL_RESULT_INVALID"));
			expect(checkToolResult("contact.notes", result, { decoded: true }).status).toBe("ok");
		}
		const inputRequired = { resultType: "input_required", inputRequests: { a: {} } };
		for (const decoded of [false, true]) {
			expect(checkToolResult("kb.lookup", inputRequired, { decoded })).toEqual(
				refused("TOOL_RESULT_INPUT_REQUIRED"),
			);
			expect(
				checkToolResult("kb.lookup", complete(notes, { resultType: "task" }), { decoded }),
			).toEqual(refused("TOOL_RESULT_INVALID"));
		}
	});

	it("refuses links, embedded resources, images, audio and unknown blocks, errors included", () => {
		const blocks = [
			{ type: "resource_link", uri: "https://draftyak.example/x", name: "draft-x" },
			{ type: "resource", resource: { uri: "file:///x", text: "DYTEST" } },
			{ type: "image", data: "AAAA", mimeType: "image/png" },
			{ type: "audio", data: "AAAA", mimeType: "audio/wav" },
			{ type: "tool_use", name: "x", id: "1", input: {} },
			{ type: "text" },
			"text",
		];
		for (const block of blocks) {
			const content = [{ type: "text", text: "{}" }, block];
			expect(checkToolResult("contact.notes", complete(notes, { content }))).toEqual(
				refused("TOOL_RESULT_CONTENT"),
			);
			expect(checkToolResult("kb.lookup", failed({ code: "NOT_FOUND" }, { content }))).toEqual(
				refused("TOOL_RESULT_CONTENT"),
			);
		}
	});

	it("refuses malformed results", () => {
		for (const result of [
			null,
			[],
			"x",
			complete(notes, { content: "text" }),
			complete(notes, { isError: "yes" }),
		]) {
			expect(checkToolResult("contact.notes", result)).toEqual(refused("TOOL_RESULT_INVALID"));
		}
	});

	it("refuses a missing, off-schema or non-JSON structuredContent", () => {
		const surrogate = JSON.parse('{"notes":[{"label":"\\ud800","text":"x"}]}');
		for (const structuredContent of [
			undefined,
			[],
			"notes",
			{ notes: [{ label: "Account", text: "x", url: "https://draftyak.example" }] },
			{ entries: [] },
			{ notes: [], extra: 1 },
			surrogate,
			{ notes: [], size: Number.POSITIVE_INFINITY },
			{ notes: [{ label: "Account", text: Number.NaN }] },
		]) {
			expect(checkToolResult("contact.notes", complete(structuredContent))).toEqual(
				refused("TOOL_RESULT_OFF_SCHEMA"),
			);
		}
	});

	it("passes a plugin's error on from _meta, and refuses an error without a PluginErrorResult", () => {
		const error = { code: "AUTH_REVOKED", detail: "404 from the calendar host" };
		expect(checkToolResult("calendar.freebusy", failed(error))).toEqual({ status: "error", error });
		expect(
			checkToolResult(
				"calendar.freebusy",
				{ isError: true, _meta: { [TOOL_ERROR_META_KEY]: error } },
				{
					decoded: true,
				},
			),
		).toEqual({ status: "error", error });
		for (const result of [
			failed(undefined),
			failed({ code: "OOPS" }),
			failed({ ...error, extra: 1 }),
			// An error never carries structuredContent, so whatever a plugin sends there matches the
			// tool's outputSchema.
			failed(error, { structuredContent: error }),
			failed(error, { structuredContent: { busy: [] } }),
			complete(error, { isError: true }),
			{ ...failed(error), _meta: undefined },
		]) {
			expect(checkToolResult("calendar.freebusy", result)).toEqual(
				refused("TOOL_RESULT_OFF_SCHEMA"),
			);
		}
	});

	it("fails a calendar.freebusy result of 201 intervals or over 20,480 bytes, never truncating", () => {
		const ok = checkToolResult("calendar.freebusy", complete({ busy: busy(200) }));
		expect(ok.status).toBe("ok");
		expect(ok.status === "ok" && ok.bytes).toBeLessThanOrEqual(20_480);
		expect(checkToolResult("calendar.freebusy", complete({ busy: busy(201) }))).toEqual(
			refused("TOOL_RESULT_OFF_SCHEMA"),
		);
		const large = { busy: busy(400) };
		expect(Buffer.byteLength(canonicalize(large))).toBeGreaterThan(20_480);
		expect(checkToolResult("calendar.freebusy", complete(large))).toEqual(
			refused("TOOL_RESULT_TOO_LARGE"),
		);
		// Sorted, merged intervals only: overlapping ones are refused, never merged here.
		const overlapping = { busy: [busy(1)[0], { ...busy(1)[0], start: t0 + 30_000 }] };
		expect(checkToolResult("calendar.freebusy", complete(overlapping))).toEqual(
			refused("TOOL_RESULT_OFF_SCHEMA"),
		);
	});

	it("holds every result to the smaller of the ceiling and the manifest's maxBytes", () => {
		const text = "\u{e9}".repeat(1000);
		const four = { notes: Array(4).fill({ label: "x".repeat(64), text }) };
		expect(Buffer.byteLength(canonicalize(four))).toBeGreaterThan(4096);
		expect(checkToolResult("contact.notes", complete(four))).toEqual(
			refused("TOOL_RESULT_TOO_LARGE"),
		);
		const one = complete({ notes: four.notes.slice(0, 1) });
		const oneSize = Buffer.byteLength(canonicalize(one.structuredContent));
		expect(checkToolResult("contact.notes", one)).toMatchObject({ status: "ok", bytes: oneSize });
		expect(checkToolResult("contact.notes", one, { maxBytes: oneSize - 1 })).toEqual(
			refused("TOOL_RESULT_TOO_LARGE"),
		);
		expect(checkToolResult("contact.notes", one, { maxBytes: 1_000_000 }).status).toBe("ok");
		for (const maxBytes of [Number.NaN, -1, 1.5, Number.POSITIVE_INFINITY]) {
			expect(() => checkToolResult("contact.notes", one, { maxBytes })).toThrow(RangeError);
		}
	});

	it("checks tool_describe and tool_probe results too, and refuses an unknown tool", () => {
		const describe = complete({ kinds: ["kb.lookup"] });
		expect(checkToolResult("tool_describe", describe).status).toBe("ok");
		const probe = { status: "degraded", bytes: 48_213, items: 37 };
		expect(checkToolResult("tool_probe", complete(probe)).status).toBe("ok");
		expect(checkToolResult("tool_probe", complete({ ...probe, sample: "DYTEST" }))).toEqual(
			refused("TOOL_RESULT_OFF_SCHEMA"),
		);
		expect(() => checkToolResult("constructor" as "kb.lookup", describe)).toThrow(TypeError);
	});
});
