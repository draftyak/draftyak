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
} from "../../src/channels/slack/index.ts";

const base = {
	channelId: "C0CHAN001",
	text: "Synthetic message",
	footer: "",
	authors: ["ai"],
	broadcast: false,
};
const fixtures = JSON.parse(
	readFileSync(new URL("./fixtures/postmessage.json", import.meta.url), "utf8"),
) as { name: string; input: unknown; body: string; bodySha256: string }[];
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
	it.each(fixtures)("golden: $name", ({ input, body, bodySha256 }) => {
		const request = renderSlackRequest(input);
		expect(request.body).toBe(body);
		expect(request).toMatchObject({
			method: "POST",
			url: "https://slack.com/api/chat.postMessage",
			contentType: "application/json",
		});
		expect(request.headers).toEqual([["content-type", "application/json"]]);
		expect(request.bodySha256).toBe(bodySha256);
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
	it("requires the frozen broadcast input instead of silently choosing false", () => {
		const input = { ...base };
		Reflect.deleteProperty(input, "broadcast");
		code(() => renderSlackRequest(input));
	});
	it.each([undefined, null, 0, "false"])("refuses invalid frozen broadcast %j", (broadcast) => {
		code(() => renderSlackRequest({ ...base, broadcast }));
	});
	it("omits top-level thread_ts and rejects direct provider options", () => {
		expect(renderSlackPostMessage(base)).toEqual({
			channel: "C0CHAN001",
			text: "Synthetic message",
			unfurl_links: false,
			unfurl_media: false,
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
			"origin",
		]) {
			code(() => renderSlackPostMessage({ ...base, [key]: "PRIVATE_CANARY" }));
		}
	});
	it.each(["ai", "agent", "plugin"])(
		"escapes %s authors alone and mixed with owner authors",
		(author) => {
			for (const authors of [
				[author],
				["owner", author],
				[author, "owner"],
				["owner", author, "owner"],
			]) {
				const payload = renderSlackPostMessage({
					...base,
					authors,
					text: "<!channel> <@U0OTHER01> & <https://example.invalid|safe>",
					footer: "<!here> & <https://example.invalid|footer>",
				});
				expect(payload.text).toBe(
					"&lt;!channel&gt; &lt;@U0OTHER01&gt; &amp; &lt;https://example.invalid|safe&gt;\n&lt;!here&gt; &amp; &lt;https://example.invalid|footer&gt;",
				);
			}
		},
	);
	it("preserves literal markup only when every author is the owner", () => {
		const text = "<!here> <@U0OTHER01> & <https://example.invalid|safe>";
		const footer = "<!channel> & <https://example.invalid|footer>";
		for (const authors of [["owner"], ["owner", "owner"], Object.freeze(["owner"])])
			expect(renderSlackPostMessage({ ...base, authors, text, footer }).text).toBe(
				`${text}\n&lt;!channel&gt; &amp; &lt;https://example.invalid|footer&gt;`,
			);
	});
	it("joins a nonempty frozen footer with exactly one line feed and preserves layout", () => {
		expect(renderSlackPostMessage({ ...base, text: "Ready", footer: "Footer" }).text).toBe(
			"Ready\nFooter",
		);
		expect(renderSlackPostMessage({ ...base, text: "Ready\n", footer: "\tFooter\n" }).text).toBe(
			"Ready\n\n\tFooter\n",
		);
		expect(renderSlackPostMessage({ ...base, footer: "" }).text).toBe(base.text);
	});
	it("always escapes the footer exactly once regardless of body provenance", () => {
		const footer = "<!here> & <https://example.invalid|footer> &amp;";
		const expected = "&lt;!here&gt; &amp; &lt;https://example.invalid|footer&gt; &amp;amp;";
		for (const authors of [["owner"], ["ai"], ["agent"], ["plugin"], ["owner", "plugin"]])
			expect(renderSlackPostMessage({ ...base, authors, footer }).text).toBe(
				`${base.text}\n${expected}`,
			);
	});
	it("keeps bytes and hashes bound to the frozen strings when footer settings change", () => {
		const settings = { footer: "Frozen footer & ready" };
		const input = Object.freeze({ ...base, footer: settings.footer });
		const before = renderSlackRequest(input);
		settings.footer = "Changed footer <new>";
		expect(renderSlackRequest(input)).toEqual(before);
		expect(JSON.parse(before.body).text).toBe("Synthetic message\nFrozen footer &amp; ready");
		const changed = renderSlackRequest({ ...input, footer: settings.footer });
		expect(changed.body).not.toBe(before.body);
		expect(changed.bodySha256).not.toBe(before.bodySha256);
	});
	it("accepts the snapshot maximum of 100 author kinds and refuses 101", () => {
		const authors = Array.from({ length: 100 }, () => "owner");
		expect(renderSlackPostMessage({ ...base, authors, text: "<!here> & ready" }).text).toBe(
			"<!here> & ready",
		);
		authors[99] = "plugin";
		expect(renderSlackPostMessage({ ...base, authors, text: "<!here> & ready" }).text).toBe(
			"&lt;!here&gt; &amp; ready",
		);
		code(() => renderSlackPostMessage({ ...base, authors: [...authors, "owner"] }));
	});
	it.each(
		[
			undefined,
			null,
			false,
			0,
			"owner",
			{},
			{ 0: "owner", length: 1 },
			new Set(["owner"]),
			[],
			[undefined],
			[null],
			[false],
			[0],
			[{}],
			[["owner"]],
			[{ kind: "owner", id: "01JTEST00000000000000000000" }],
			[""],
			["OWNER"],
			["machine"],
			["mcp"],
			["unknown"],
			["owner", "unknown"],
			["ai", "unknown"],
			new Array(1),
			Object.assign(new Array(2), { 0: "owner" }),
			Object.assign(["owner"], { extra: true }),
			Object.assign(["owner"], { [Symbol("extra")]: true }),
			Object.defineProperty(["owner"], "0", { enumerable: false }),
			Object.setPrototypeOf(["owner"], null),
		].map((authors, index) => ({ authors, index })),
	)("rejects malformed author kinds case $index", ({ authors }) =>
		code(() => renderSlackPostMessage({ ...base, authors })),
	);
	it("rejects author accessors and array hooks without evaluating them", () => {
		let calls = 0;
		const hook = (): never => {
			calls++;
			throw new Error("PRIVATE_CANARY");
		};
		const input = Object.defineProperty({ ...base }, "authors", { get: hook });
		code(() => renderSlackPostMessage(input));
		const indexed = Object.defineProperty(["owner"], "0", { get: hook, enumerable: true });
		const iterator = Object.defineProperty(["owner"], Symbol.iterator, { get: hook });
		const serializer = Object.defineProperty(["owner"], "toJSON", { get: hook });
		const prototype = Object.setPrototypeOf(["owner"], {
			get [Symbol.iterator]() {
				return hook();
			},
		});
		const coercion = { toString: hook, valueOf: hook, [Symbol.toPrimitive]: hook };
		for (const authors of [indexed, iterator, serializer, prototype, [coercion]])
			code(() => renderSlackPostMessage({ ...base, authors }));
		expect(calls).toBe(0);
	});
	it("rejects author proxies and revoked proxies without executing traps", () => {
		let calls = 0;
		const hook = (): never => {
			calls++;
			throw new Error("PRIVATE_CANARY");
		};
		const traps = {
			get: hook,
			getPrototypeOf: hook,
			ownKeys: hook,
			getOwnPropertyDescriptor: hook,
		};
		const array = new Proxy(["owner"], traps);
		const entry = new Proxy({}, traps);
		const revoked = Proxy.revocable(["owner"], traps);
		revoked.revoke();
		for (const authors of [array, [entry], revoked.proxy])
			code(() => renderSlackPostMessage({ ...base, authors }));
		expect(calls).toBe(0);
	});
	it.each([undefined, null, "1.0"])(
		"omits the broadcast wire field for a frozen false value with thread %j",
		(threadTs) => {
			const input = { ...base, threadTs, broadcast: false };
			expect(renderSlackPostMessage(input)).not.toHaveProperty("reply_broadcast");
			expect(JSON.parse(renderSlackRequest(input).body)).not.toHaveProperty("reply_broadcast");
		},
	);
	it.each([false, true])("binds threaded broadcast %j into exact bytes and hashes", (broadcast) => {
		const input = { ...base, threadTs: "1.0", broadcast };
		const expected = `{"channel":"C0CHAN001","thread_ts":"1.0","text":"Synthetic message","unfurl_links":false,"unfurl_media":false${broadcast ? ',"reply_broadcast":true' : ""}}`;
		const request = renderSlackRequest(input);
		expect(request.body).toBe(expected);
		expect(request.bodySha256).toBe(createHash("sha256").update(expected).digest("hex"));
		expect(request.headersSha256).toBe(
			createHash("sha256").update('[["content-type","application/json"]]').digest("hex"),
		);
		if (broadcast) expect(renderSlackPostMessage(input).reply_broadcast).toBe(true);
		else expect(renderSlackPostMessage(input)).not.toHaveProperty("reply_broadcast");
	});
	it.each([null, 0, 1, "false", "true", {}, [], Object(true)].map((broadcast) => ({ broadcast })))(
		"refuses a nonprimitive-boolean broadcast %j",
		({ broadcast }) => code(() => renderSlackRequest({ ...base, threadTs: "1.0", broadcast })),
	);
	it.each(["owner", "ai", "agent", "plugin"])(
		"refuses an orphan broadcast for %s provenance",
		(author) => {
			for (const threadTs of [undefined, null])
				code(() => renderSlackRequest({ ...base, authors: [author], threadTs, broadcast: true }));
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
	it("requires a frozen footer field instead of reading a current setting", () => {
		const { footer: _footer, ...missing } = base;
		code(() => renderSlackPostMessage(missing));
		code(() => renderSlackRequest(missing));
		code(() => renderSlackRequest({ ...base, footer: undefined }));
	});
	it.each(
		[
			null,
			false,
			0,
			[],
			{},
			Object("footer"),
			"PRIVATE_CANARY\u0000",
			"footer\rnext",
			"footer\u007f",
			"footer\u000b",
			"cafe\u0301",
			"\ud800",
			"\udfff",
			"x".repeat(MAX_TEXT_CHARACTERS * 2 + 1),
		].map((footer, index) => ({ footer, index })),
	)("rejects malformed or noncanonical frozen footer case $index", ({ footer }) =>
		code(() => renderSlackRequest({ ...base, footer })),
	);
	it("rejects footer accessors, coercion hooks and proxies without evaluating them", () => {
		let calls = 0;
		const hook = (): never => {
			calls++;
			throw new Error("PRIVATE_CANARY");
		};
		const accessor = Object.defineProperty({ ...base }, "footer", { get: hook });
		const coercion = { toString: hook, valueOf: hook, [Symbol.toPrimitive]: hook };
		const proxy = new Proxy({}, { get: hook, getPrototypeOf: hook, ownKeys: hook });
		const revoked = Proxy.revocable({}, {});
		revoked.revoke();
		code(() => renderSlackRequest(accessor));
		for (const footer of [coercion, proxy, revoked.proxy])
			code(() => renderSlackRequest({ ...base, footer }));
		expect(calls).toBe(0);
	});
	it.each(["", " ", "\n\t"])("does not let a footer replace an empty body", (text) =>
		code(() => renderSlackRequest({ ...base, text, footer: "Frozen footer" })),
	);
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
		{ ...base, authors: ["unknown"] },
		{ ...base, authors: undefined },
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
	it("counts the separator and escaped footer toward the unchanged text ceiling", () => {
		const input = { ...base, text: "x" };
		const footer = "x".repeat(MAX_TEXT_CHARACTERS - 2);
		expect(renderSlackPostMessage({ ...input, footer }).text.length).toBe(MAX_TEXT_CHARACTERS);
		code(() => renderSlackPostMessage({ ...input, footer: `${footer}x` }), "TEXT_TOO_LONG");
		const escapedFooter = `${"&".repeat(7999)}xxx`;
		expect(renderSlackPostMessage({ ...input, footer: escapedFooter }).text.length).toBe(
			MAX_TEXT_CHARACTERS,
		);
		code(() => renderSlackPostMessage({ ...input, footer: `${escapedFooter}x` }), "TEXT_TOO_LONG");
		code(
			() => renderSlackPostMessage({ ...base, text: "x".repeat(MAX_TEXT_CHARACTERS), footer: "x" }),
			"TEXT_TOO_LONG",
		);
	});
	it("counts the escaped footer and separator in the unchanged UTF-8 byte ceiling", () => {
		const input = { ...base, text: "x", footer: "x" };
		const overhead = Buffer.byteLength(renderSlackRequest(input).body) - 1;
		const remaining = MAX_REQUEST_BYTES - overhead;
		const footer = "😀".repeat(Math.floor(remaining / 4)) + "x".repeat(remaining % 4);
		expect(Buffer.byteLength(renderSlackRequest({ ...input, footer }).body)).toBe(
			MAX_REQUEST_BYTES,
		);
		code(() => renderSlackRequest({ ...input, footer: `${footer}x` }), "REQUEST_TOO_LARGE");
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
	it("escapes non-owner control tokens without adding provider keys (150 runs)", () => {
		fc.assert(
			fc.property(
				fc.stringMatching(/^[A-Za-z0-9 &<>]{1,100}$/),
				fc.constantFrom("ai", "agent", "plugin"),
				(text, author) => {
					if (!text.trim()) return;
					const payload = renderSlackPostMessage({ ...base, text, authors: [author] });
					expect(payload.text.replace(/&(amp|lt|gt);/g, "")).not.toMatch(/[&<>]/);
					expect(Object.keys(payload).sort()).toEqual([
						"channel",
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
