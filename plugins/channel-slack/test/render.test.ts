import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
	MAX_REQUEST_BYTES,
	MAX_TEXT_CHARACTERS,
	renderSlackPostMessage,
	renderSlackRequest,
	SlackCoreError,
} from "../src/index.ts";

const base = { channelId: "C0CHAN001", text: "Synthetic message", origin: "machine" };
const fixtures = JSON.parse(
	readFileSync(new URL("./fixtures/postmessage.json", import.meta.url), "utf8"),
) as { name: string; input: unknown; body: string }[];
const code = (action: () => unknown, expected = "INVALID_INPUT"): void => {
	try {
		action();
		throw new Error("expected rejection");
	} catch (error) {
		expect(error).toBeInstanceOf(SlackCoreError);
		expect((error as SlackCoreError).code).toBe(expected);
		expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain(
			"PRIVATE_CANARY",
		);
	}
};

describe("slack-postmessage", () => {
	it.each(fixtures)("golden: $name", ({ input, body }) => {
		const request = renderSlackRequest(input);
		expect(request.body).toBe(body);
		expect(request).toMatchObject({
			method: "POST",
			url: "https://slack.com/api/chat.postMessage",
			contentType: "application/json",
		});
		expect(request.headers).toEqual([["content-type", "application/json"]]);
		expect(request.bodySha256).toBe(
			createHash("sha256").update(Buffer.from(body, "utf8")).digest("hex"),
		);
		expect(request.headersSha256).toBe(
			createHash("sha256").update('[["content-type","application/json"]]').digest("hex"),
		);
		expect(Object.isFrozen(request)).toBe(true);
		expect(Object.isFrozen(request.headers[0])).toBe(true);
		expect(Object.isFrozen(renderSlackPostMessage(input))).toBe(true);
	});
	it("omits top-level thread_ts and rejects direct provider options", () => {
		expect(renderSlackPostMessage(base)).toEqual({
			channel: "C0CHAN001",
			text: "Synthetic message",
			unfurl_links: false,
			unfurl_media: false,
			reply_broadcast: false,
		});
		for (const key of [
			"blocks",
			"attachments",
			"username",
			"icon_url",
			"icon_emoji",
			"parse",
			"metadata",
			"reply_broadcast",
			"unfurl_links",
			"channelName",
			"source",
		]) {
			code(() => renderSlackPostMessage({ ...base, [key]: "PRIVATE_CANARY" }));
		}
	});
	it.each([undefined, false])(
		"defaults broadcast %j to an explicit false wire field",
		(broadcast) => {
			const request = renderSlackRequest({ ...base, broadcast });
			expect(request.body).toBe(renderSlackRequest(base).body);
			expect(JSON.parse(request.body).reply_broadcast).toBe(false);
		},
	);
	it.each([false, true])("binds threaded broadcast %j into exact bytes and hashes", (broadcast) => {
		const input = { ...base, threadTs: "1.0", broadcast };
		const expected = `{"channel":"C0CHAN001","thread_ts":"1.0","text":"Synthetic message","unfurl_links":false,"unfurl_media":false,"reply_broadcast":${broadcast}}`;
		const request = renderSlackRequest(input);
		expect(request.body).toBe(expected);
		expect(request.bodySha256).toBe(createHash("sha256").update(expected).digest("hex"));
		expect(request.headersSha256).toBe(
			createHash("sha256").update('[["content-type","application/json"]]').digest("hex"),
		);
		expect(renderSlackPostMessage(input).reply_broadcast).toBe(broadcast);
	});
	it.each([null, 0, 1, "false", "true", {}, [], Object(true)].map((broadcast) => ({ broadcast })))(
		"refuses a nonprimitive-boolean broadcast %j",
		({ broadcast }) => code(() => renderSlackRequest({ ...base, threadTs: "1.0", broadcast })),
	);
	it.each(["owner", "machine", "mcp"])(
		"refuses an orphan broadcast for %s provenance",
		(origin) => {
			for (const threadTs of [undefined, null])
				code(() => renderSlackRequest({ ...base, origin, threadTs, broadcast: true }));
		},
	);
	it("refuses a broadcast accessor without evaluating it", () => {
		let calls = 0;
		const input = Object.defineProperty({ ...base, threadTs: "1.0" }, "broadcast", {
			enumerable: true,
			get() {
				calls++;
				throw new Error("PRIVATE_CANARY");
			},
		});
		code(() => renderSlackRequest(input));
		expect(calls).toBe(0);
	});
	it("counts a true broadcast and thread in the exact UTF-8 byte ceiling", () => {
		const input = { ...base, threadTs: "1.0", broadcast: true };
		const overhead = Buffer.byteLength(renderSlackRequest({ ...input, text: "x" }).body) - 1;
		const remaining = MAX_REQUEST_BYTES - overhead;
		const text = "😀".repeat(Math.floor(remaining / 4)) + "x".repeat(remaining % 4);
		const request = renderSlackRequest({ ...input, text });
		expect(Buffer.byteLength(request.body)).toBe(MAX_REQUEST_BYTES);
		expect(request.bodySha256).toBe(createHash("sha256").update(request.body).digest("hex"));
		code(() => renderSlackRequest({ ...input, text: `${text}x` }), "REQUEST_TOO_LARGE");
	});
	it.each([
		null,
		[],
		42,
		"PRIVATE_CANARY",
		undefined,
		new Date(),
		{ ...base, origin: "unknown" },
		{ ...base, origin: undefined },
		{ ...base, threadTs: 1760000000 },
	])("rejects untrusted input shapes", (value) => code(() => renderSlackPostMessage(value)));
	it.each([
		"#general",
		"U0OTHER01",
		"C",
		"C01/other",
		"c0chan001",
		"C0CHAN001\r\n",
		"C0CHAN001\n",
		"C0CHAN001\u2028",
		`C${"X".repeat(32)}`,
	])("rejects ambiguous channel destination %s", (channelId) =>
		code(() => renderSlackPostMessage({ ...base, channelId })),
	);
	it.each([
		"1760000000",
		"01.000001",
		"1.1234567890",
		"-1.000001",
		"1.0\n",
		"1.0\r\n",
		"1.0\u2028",
		"1e9.000001",
	])("rejects noncanonical thread timestamp %s", (threadTs) =>
		code(() => renderSlackPostMessage({ ...base, threadTs })),
	);
	it.each(["", "   ", "PRIVATE_CANARY\u0000", "a\rb", "cafe\u0301", "\ud800", "\udfff"])(
		"rejects empty, noncanonical or invalid Unicode text",
		(text) => code(() => renderSlackPostMessage({ ...base, text })),
	);
	it("does not evaluate accessors or expose their values", () => {
		let called = false;
		const input = Object.defineProperty({ ...base }, "text", {
			get() {
				called = true;
				throw new Error("PRIVATE_CANARY");
			},
		});
		code(() => renderSlackPostMessage(input));
		expect(called).toBe(false);
		code(() =>
			renderSlackPostMessage(
				new Proxy(
					{},
					{
						getPrototypeOf() {
							throw new Error("PRIVATE_CANARY");
						},
					},
				),
			),
		);
	});
	it("enforces the text limit after escaping and never truncates", () => {
		expect(
			renderSlackPostMessage({ ...base, text: "x".repeat(MAX_TEXT_CHARACTERS) }).text.length,
		).toBe(MAX_TEXT_CHARACTERS);
		code(
			() => renderSlackPostMessage({ ...base, text: "x".repeat(MAX_TEXT_CHARACTERS + 1) }),
			"TEXT_TOO_LONG",
		);
		expect(renderSlackPostMessage({ ...base, text: "&".repeat(8000) }).text.length).toBe(40_000);
		code(() => renderSlackPostMessage({ ...base, text: "&".repeat(8001) }), "TEXT_TOO_LONG");
	});
	it("enforces UTF-8 JSON bytes independently of Unicode character count", () => {
		const overhead = Buffer.byteLength(renderSlackRequest({ ...base, text: "x" }).body) - 1;
		const remaining = MAX_REQUEST_BYTES - overhead;
		const exact = "😀".repeat(Math.floor(remaining / 4)) + "x".repeat(remaining % 4);
		expect(Buffer.byteLength(renderSlackRequest({ ...base, text: exact }).body)).toBe(
			MAX_REQUEST_BYTES,
		);
		code(() => renderSlackRequest({ ...base, text: `${exact}x` }), "REQUEST_TOO_LARGE");
	});
	it("escapes every machine/MCP control token without adding provider keys (150 runs)", () => {
		fc.assert(
			fc.property(
				fc.stringMatching(/^[A-Za-z0-9 &<>]{1,100}$/),
				fc.constantFrom("machine", "mcp"),
				(text, origin) => {
					if (!text.trim()) return;
					const payload = renderSlackPostMessage({ ...base, text, origin });
					expect(payload.text.replace(/&(amp|lt|gt);/g, "")).not.toMatch(/[&<>]/);
					expect(Object.keys(payload).sort()).toEqual([
						"channel",
						"reply_broadcast",
						"text",
						"unfurl_links",
						"unfurl_media",
					]);
				},
			),
			{ numRuns: 150, seed: 6101 },
		);
	});
});
