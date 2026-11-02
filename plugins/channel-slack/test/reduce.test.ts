import { ChatMessageChange, MAX_CHANGES } from "@draftyak/protocol/normalized-change";
import { describe, expect, it } from "vitest";
import { reduceMessagesPage } from "../src/reduce.ts";

const CHANNEL = "CDYTEST1";

function message(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		type: "message",
		ts: "1800000000.123456",
		user: "UDYTEST1",
		text: "DYTEST ordinary message",
		...overrides,
	};
}

function page(messages: unknown[] = [message()], cursor = ""): Record<string, unknown> {
	return {
		ok: true,
		messages,
		has_more: cursor !== "",
		response_metadata: { next_cursor: cursor },
	};
}

function refused(input: unknown, channel: unknown = CHANNEL): void {
	let caught: unknown;
	try {
		reduceMessagesPage(channel, input);
	} catch (error) {
		caught = error;
	}
	expect(caught).toBeInstanceOf(Error);
	expect((caught as Error).message).toBe("SLACK_READ_INVALID");
}

describe("Slack message page data reduction", () => {
	// These wire shapes match FakeSlack history/replies; no read invocation or native grant is made.
	it("preserves descending history and root/reply order from ordinary wire pages", () => {
		const root = "1800000000.000000001";
		const reply = "1800000000.000000002";
		const latest = "1800000000.000000003";
		const history = reduceMessagesPage(
			CHANNEL,
			page([
				message({ ts: latest, text: "new root", reply_count: 0 }),
				message({ ts: root, text: "root", reply_count: 1 }),
			]),
		);
		expect(history.changes.map((change) => change.ts)).toEqual([latest, root]);
		expect(history.replyCounts).toEqual([
			{ ts: latest, count: 0 },
			{ ts: root, count: 1 },
		]);
		const replies = reduceMessagesPage(
			CHANNEL,
			page([
				message({ ts: root, text: "root", reply_count: 1 }),
				message({ ts: reply, thread_ts: root, user: "UDYTEST2", text: "reply", reply_count: 0 }),
			]),
		);
		expect(replies.changes).toEqual([
			{
				kind: "chat.message",
				channelId: CHANNEL,
				ts: root,
				sentAt: 1_800_000_000_000,
				author: { kind: "user", id: "UDYTEST1" },
				text: "root",
			},
			{
				kind: "chat.message",
				channelId: CHANNEL,
				ts: reply,
				threadTs: root,
				sentAt: 1_800_000_000_000,
				author: { kind: "user", id: "UDYTEST2" },
				text: "reply",
			},
		]);
		for (const change of [...history.changes, ...replies.changes])
			expect(ChatMessageChange.safeParse(change).success).toBe(true);
	});

	it("keeps timestamp identity below a millisecond and derives dates without floating-point rounding", () => {
		const stamps = ["1800000000.123456", "1800000000.123456789", "1800000000.123999999"];
		const result = reduceMessagesPage(CHANNEL, page(stamps.map((ts) => message({ ts }))));
		expect(result.changes.map((change) => change.ts)).toEqual(stamps);
		expect(result.changes.map((change) => change.sentAt)).toEqual([
			1_800_000_000_123, 1_800_000_000_123, 1_800_000_000_123,
		]);
	});

	it.each([
		["0.000000001", 0],
		["0.1", 100],
		["1.999999999", 1999],
		["999999999999.999999999", 999_999_999_999_999],
		["9007199254740.991", Number.MAX_SAFE_INTEGER],
		["9007199254740.991999999", Number.MAX_SAFE_INTEGER],
	])("maps timestamp %s to integer milliseconds %i", (ts, sentAt) => {
		const result = reduceMessagesPage(CHANNEL, page([message({ ts })]));
		expect(result.changes[0]?.ts).toBe(ts);
		expect(result.changes[0]?.sentAt).toBe(sentAt);
	});

	it("preserves root self-thread identity and distinguishes absent counts from zero", () => {
		const ts = "1800000000.123456";
		const absent = reduceMessagesPage(CHANNEL, page([message({ thread_ts: ts })]));
		expect(absent.changes[0]?.threadTs).toBe(ts);
		expect(absent.replyCounts).toEqual([]);
		const zero = reduceMessagesPage(CHANNEL, page([message({ reply_count: 0 })]));
		expect(zero.replyCounts).toEqual([{ ts, count: 0 }]);
		const maximum = reduceMessagesPage(
			CHANNEL,
			page([message({ reply_count: Number.MAX_SAFE_INTEGER })]),
		);
		expect(maximum.replyCounts).toEqual([{ ts, count: Number.MAX_SAFE_INTEGER }]);
	});

	it("preserves an opaque cursor and reports only this page's declared continuation", () => {
		const cursor = "DYTEST+/cursor==";
		const result = reduceMessagesPage(CHANNEL, page([], cursor));
		expect(result).toEqual({ changes: [], nextCursor: cursor, more: true, replyCounts: [] });
		expect(reduceMessagesPage(CHANNEL, page([]))).toEqual({
			changes: [],
			nextCursor: undefined,
			more: false,
			replyCounts: [],
		});
		const maximum = "x".repeat(4096);
		expect(reduceMessagesPage(CHANNEL, page([], maximum)).nextCursor).toBe(maximum);
	});

	it("retains either continuation signal without inventing a cursor or a completed scan", () => {
		const incomplete = reduceMessagesPage(CHANNEL, { ...page([]), has_more: true });
		expect(incomplete.more).toBe(true);
		expect(incomplete.nextCursor).toBeUndefined();
		const cursorOnly = reduceMessagesPage(CHANNEL, { ...page([], "next-page"), has_more: false });
		expect(cursorOnly.more).toBe(true);
		expect(cursorOnly.nextCursor).toBe("next-page");
		const withoutMetadata = { ok: true, messages: [], has_more: false };
		expect(reduceMessagesPage(CHANNEL, withoutMetadata)).toEqual({
			changes: [],
			nextCursor: undefined,
			more: false,
			replyCounts: [],
		});
		const noCursor = reduceMessagesPage(CHANNEL, { ...withoutMetadata, has_more: true });
		expect(noCursor.more).toBe(true);
		expect(noCursor.nextCursor).toBeUndefined();
		expect(reduceMessagesPage(CHANNEL, { ...withoutMetadata, response_metadata: {} }).more).toBe(
			false,
		);
	});

	it("accepts the shared row and text limits, including valid pages above 256 KiB", () => {
		const messages = Array.from({ length: MAX_CHANGES }, (_, index) =>
			message({ ts: `1800000000.${String(index).padStart(9, "0")}`, text: "x".repeat(600) }),
		);
		expect(Buffer.byteLength(JSON.stringify(page(messages)))).toBeGreaterThan(256 * 1024);
		const result = reduceMessagesPage(CHANNEL, page(messages));
		expect(result.changes).toHaveLength(MAX_CHANGES);
		expect(result.changes.map((change) => change.ts)).toEqual(messages.map((item) => item.ts));
		const body = "\u{1f9ad}".repeat(40_000);
		const large = reduceMessagesPage(CHANNEL, page([message({ text: body })]));
		expect(large.changes[0]?.text).toBe(body);
		expect(ChatMessageChange.safeParse(large.changes[0]).success).toBe(true);
	});

	it("keeps channel and user IDs opaque within the shared provider-ID contract", () => {
		const channel = "opaque:channel/identity";
		const user = "provider:user/identity";
		const result = reduceMessagesPage(channel, page([message({ user })]));
		expect(result.changes[0]?.channelId).toBe(channel);
		expect(result.changes[0]?.author).toEqual({ kind: "user", id: user });
		const maximum = "x".repeat(256);
		const edge = reduceMessagesPage(maximum, page([message({ user: maximum })]));
		expect(edge.changes[0]?.channelId).toBe(maximum);
		expect(edge.changes[0]?.author.id).toBe(maximum);
	});

	it("preserves empty, decomposed and control-containing text as untrusted data", () => {
		const bodies = ["", "Cafe\u0301", "DYTEST\u0000\r\nmessage"];
		const result = reduceMessagesPage(
			CHANNEL,
			page(bodies.map((text, index) => message({ ts: `${index}.0`, text }))),
		);
		expect(result.changes.map((change) => change.text)).toEqual(bodies);
	});

	it("accepts ordinary null-prototype data and leaves caller objects untouched", () => {
		const input = page([Object.assign(Object.create(null), message())]);
		const nullPage = Object.assign(Object.create(null), input);
		nullPage.response_metadata = Object.assign(Object.create(null), { next_cursor: "" });
		const before = structuredClone(nullPage);
		const result = reduceMessagesPage(CHANNEL, nullPage);
		expect(result.changes[0]?.text).toBe("DYTEST ordinary message");
		expect(structuredClone(nullPage)).toEqual(before);
	});

	it("returns detached deeply frozen data that cannot change after input mutation", () => {
		const raw = message({ thread_ts: "1799999999.1", reply_count: 2 });
		const input = page([raw], "DYTEST-cursor");
		const result = reduceMessagesPage(CHANNEL, input);
		const expected = structuredClone(result);
		raw.user = "UDYTEST2";
		raw.text = "changed";
		raw.thread_ts = "1799999998.1";
		raw.reply_count = 9;
		(input.messages as unknown[]).push(message({ ts: "1.0" }));
		(input.response_metadata as Record<string, unknown>).next_cursor = "changed";
		expect(result).toEqual(expected);
		expect(Object.isFrozen(result)).toBe(true);
		expect(Object.isFrozen(result.changes)).toBe(true);
		expect(Object.isFrozen(result.changes[0])).toBe(true);
		expect(Object.isFrozen(result.changes[0]?.author)).toBe(true);
		expect(Object.isFrozen(result.replyCounts)).toBe(true);
		expect(Object.isFrozen(result.replyCounts[0])).toBe(true);
		expect(() => Object.assign(result.changes[0] as object, { text: "changed" })).toThrow(
			TypeError,
		);
		expect(() => Object.assign(result.replyCounts[0] as object, { count: 9 })).toThrow(TypeError);
	});

	it.each([null, [], false, "page", { ok: false, error: "not_authed" }])(
		"refuses a non-successful page without exposing input details",
		(input) => refused(input),
	);

	it.each([
		{ ...page(), ok: 1 },
		{ ...page(), messages: {} },
		{ ...page(), messages: Array(1) },
		{ ...page(), has_more: "false" },
		{ ...page(), response_metadata: null },
		{ ...page(), response_metadata: [] },
		{ ...page(), response_metadata: { next_cursor: 1 } },
	])("refuses malformed page shape atomically", (input) => refused(input));

	it("ignores harmless page, message and metadata extensions while preserving selected data", () => {
		const raw = message({
			team: "TDYTEST1",
			client_msg_id: "DYTEST-client-id",
			blocks: [{ type: "section", text: { type: "plain_text", text: "untrusted presentation" } }],
		});
		const input = {
			...page([raw], "next-page"),
			warning: "DYTEST harmless metadata",
			response_metadata: { next_cursor: "next-page", warnings: ["DYTEST metadata"] },
		};
		expect(reduceMessagesPage(CHANNEL, input)).toEqual(
			reduceMessagesPage(CHANNEL, page([message()], "next-page")),
		);
	});

	it("refuses an explicit page error even alongside ok:true without reading its value", () => {
		refused({ ...page(), error: "not_authed" });
		refused({ ...page(), error: undefined });
		let calls = 0;
		const input = Object.defineProperty(page(), "error", {
			enumerable: true,
			get() {
				calls++;
				throw new Error("Provider error getter");
			},
		});
		refused(input);
		expect(calls).toBe(0);
	});

	it.each([
		{ ...page(), response_metadata: { next_cursor: "cursor\n" }, has_more: true },
		{ ...page(), response_metadata: { next_cursor: "not visible\u0000" }, has_more: true },
		{ ...page(), response_metadata: { next_cursor: "\u754c" }, has_more: true },
		{ ...page(), response_metadata: { next_cursor: "x".repeat(4097) }, has_more: true },
	])("refuses malformed cursor data instead of coercing or discarding it", (input) =>
		refused(input),
	);

	it.each([null, "", 123, "C 123", "C123\n", "\u754c", "C".repeat(257)])(
		"refuses invalid channel identity %s",
		(channel) => refused(page(), channel),
	);

	it.each([
		"1800000000",
		"1800000000.",
		"00.1",
		"-1.0",
		"1e3.1",
		"1.1234567890",
		"9007199254740.992",
		"9007199254741.0",
		"1.0\n",
		1800000000,
		null,
	])("refuses invalid timestamp %s without coercion", (ts) => refused(page([message({ ts })])));

	it.each([
		{ user: "" },
		{ user: "has space" },
		{ user: "x".repeat(257) },
		{ user: 123 },
		{ text: 1 },
		{ text: "\ud800" },
		{ text: "x".repeat(40_001) },
		{ thread_ts: "bad" },
		{ reply_count: -1 },
		{ reply_count: 0.5 },
		{ reply_count: Number.MAX_SAFE_INTEGER + 1 },
		{ reply_count: undefined },
		{ reply_count: "2" },
	])("refuses malformed message data without dropping the row", (change) =>
		refused(page([message({ ts: "1.0" }), message(change)])),
	);

	it.each([
		{ subtype: "message_changed" },
		{ files: [] },
		{ edited: { ts: "1.0" } },
		{ bot_id: "B123" },
		{ attachments: [] },
		{ message: {} },
		{ deleted_ts: "1.0" },
		{ type: "message_deleted", deleted_ts: "1.0" },
	])("refuses unsupported semantic rows instead of advancing over lost content", (change) =>
		refused(page([message({ ts: "1.0" }), message(change)], "next-page")),
	);

	it("refuses each known unsupported semantic field by presence without evaluating accessors", () => {
		let calls = 0;
		for (const key of [
			"subtype",
			"bot_id",
			"files",
			"edited",
			"message",
			"deleted_ts",
			"attachments",
		]) {
			const raw = Object.defineProperty(message(), key, {
				enumerable: true,
				get() {
					calls++;
					throw new Error("Unsupported field getter");
				},
			});
			refused(page([raw]));
		}
		expect(calls).toBe(0);
	});

	it("refuses duplicate message IDs rather than overwriting one revision", () => {
		refused(page([message({ text: "first" }), message({ text: "different" })]));
	});

	it("refuses more rows than the shared normalized page limit", () => {
		refused(
			page(Array.from({ length: MAX_CHANGES + 1 }, (_, index) => message({ ts: `${index}.0` }))),
		);
	});

	it.each(["page", "messages", "message", "metadata"] as const)(
		"rejects a %s proxy without evaluating traps",
		(location) => {
			let calls = 0;
			const trap = (): never => {
				calls++;
				throw new Error("Caller trap");
			};
			const wrap = (value: object) =>
				new Proxy(value, {
					get: trap,
					ownKeys: trap,
					getPrototypeOf: trap,
					getOwnPropertyDescriptor: trap,
				});
			const input = page();
			if (location === "messages") input.messages = wrap([message()]);
			if (location === "message") input.messages = [wrap(message())];
			if (location === "metadata") input.response_metadata = wrap({ next_cursor: "" });
			refused(location === "page" ? wrap(input) : input);
			expect(calls).toBe(0);
		},
	);

	it.each(["page", "message", "metadata"] as const)(
		"rejects a %s accessor without calling it",
		(location) => {
			let calls = 0;
			const get = (): never => {
				calls++;
				throw new Error("Caller getter");
			};
			const input = page();
			if (location === "page") Object.defineProperty(input, "messages", { enumerable: true, get });
			if (location === "message")
				input.messages = [Object.defineProperty(message(), "text", { enumerable: true, get })];
			if (location === "metadata")
				input.response_metadata = Object.defineProperty({}, "next_cursor", {
					enumerable: true,
					get,
				});
			refused(input);
			expect(calls).toBe(0);
		},
	);

	it("does not inspect or copy unknown getters, proxies, cycles, symbols or serialization callbacks", () => {
		let calls = 0;
		const trap = (): never => {
			calls++;
			throw new Error("Unselected field trap");
		};
		const poison = new Proxy(
			{},
			{
				get: trap,
				ownKeys: trap,
				getPrototypeOf: trap,
				getOwnPropertyDescriptor: trap,
			},
		);
		const cycle: Record<string, unknown> = {};
		cycle.self = cycle;
		const raw = message();
		const metadata = { next_cursor: "" };
		const input = { ...page([raw]), response_metadata: metadata };
		for (const target of [input, raw, metadata]) {
			Object.defineProperty(target, "unknownGetter", { enumerable: true, get: trap });
			Object.assign(target, { unknownProxy: poison, unknownCycle: cycle, toJSON: trap });
		}
		const symbol = Symbol("extra");
		Object.defineProperty(input, symbol, { enumerable: true, get: trap });
		expect(reduceMessagesPage(CHANNEL, input)).toEqual(reduceMessagesPage(CHANNEL, page()));
		expect(calls).toBe(0);
	});

	it("refuses inherited required fields rather than reading the prototype", () => {
		refused(Object.create(page()));
	});

	it("does not execute a caller array iterator or indexed accessor", () => {
		let calls = 0;
		const trap = (): never => {
			calls++;
			throw new Error("Caller array hook");
		};
		const iterator = [message()];
		Object.defineProperty(iterator, Symbol.iterator, { value: trap });
		refused(page(iterator));
		const indexed = [message()];
		Object.defineProperty(indexed, "0", { enumerable: true, get: trap });
		refused(page(indexed));
		expect(calls).toBe(0);
	});
});
