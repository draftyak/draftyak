import type { ChatDraftContent } from "@draftyak/protocol/entities/draft/chat";
import { Flags } from "@draftyak/protocol/flags";
import { describe, expect, it } from "vitest";
import { classifySlackMassMentionTokenFlags } from "../src/mass-mention-flags.ts";

const invalid = { status: "refused", code: "INVALID_INPUT" };
const limit = { status: "refused", code: "STRUCTURE_LIMIT" };
const classify = (draft: unknown) =>
	classifySlackMassMentionTokenFlags(draft as Pick<ChatDraftContent, "channel" | "body">);

function expectTokens(body: string, mentions: readonly string[]): void {
	const result = classify({ channel: "chat", body });
	expect(result).toEqual({
		status: "classified",
		flags: mentions.map((detail) => ({ code: "MASS_MENTION", severity: "ack", detail })),
	});
	if (result.status !== "classified") throw new Error("DYTEST expected token DATA");
	expect(Flags.safeParse(result.flags).success).toBe(true);
}

describe("explicit Slack mass-mention token DATA", () => {
	it.each([
		["<!channel>", "@channel"],
		["<!everyone>", "@everyone"],
		["<!here>", "@here"],
	])("maps %s to its fixed canonical detail", (token, detail) => {
		expectTokens(`DYTEST before ${token} after`, [detail]);
	});

	it("deduplicates repeated tokens in fixed channel, everyone, here order", () => {
		expectTokens("<!here><!everyone><!here><!channel><!everyone><!channel>", [
			"@channel",
			"@everyone",
			"@here",
		]);
	});

	it.each([
		"DYTEST x<!here>y",
		"> DYTEST <!here>",
		"`<!here>`",
		"```\nDYTEST <!here>\n```",
		"\\<!here>",
	])("conservatively warns on a literal token in supplied text %#", (body) => {
		expectTokens(body, ["@here"]);
	});

	it.each([
		"",
		"DYTEST ordinary message",
		"@channel @everyone @here",
		"&lt;!channel&gt; &lt;!everyone&gt; &lt;!here&gt;",
		"<!CHANNEL> <!Everyone> <!Here>",
		"<! channel> <!everyone > <!here|DYTEST-label>",
	])("leaves unsupported forms outside this token subset %#", (body) => {
		expectTokens(body, []);
	});

	it("does not infer a mention from thread broadcast DATA", () => {
		expect(
			classify({ channel: "chat", body: "DYTEST reply", broadcast: true, threadTs: "1" }),
		).toEqual({ status: "classified", flags: [] });
	});

	it("does not read thread, broadcast, enumeration or coercion extras", () => {
		let reads = 0;
		const unused = () => {
			reads++;
			throw new Error("DYTEST unused draft field");
		};
		const draft = { channel: "chat", body: "<!channel>" };
		for (const key of ["threadTs", "broadcast", "other", "toJSON", Symbol.toPrimitive])
			Object.defineProperty(draft, key, { get: unused });
		expect(classify(draft)).toEqual({
			status: "classified",
			flags: [{ code: "MASS_MENTION", severity: "ack", detail: "@channel" }],
		});
		expect(reads).toBe(0);
	});

	it("accepts nonenumerable own DATA on a null-prototype record", () => {
		const draft = Object.create(null);
		Object.defineProperty(draft, "channel", { value: "chat" });
		Object.defineProperty(draft, "body", { value: "<!everyone>" });
		expect(classify(draft)).toEqual({
			status: "classified",
			flags: [{ code: "MASS_MENTION", severity: "ack", detail: "@everyone" }],
		});
	});

	it("leaves frozen input unchanged and isolates later result objects", () => {
		const draft = Object.freeze({ channel: "chat", body: "DYTEST <!here>" });
		const first = classify(draft);
		if (first.status !== "classified") throw new Error("DYTEST expected first token DATA");
		const flag = first.flags[0];
		if (!flag) throw new Error("DYTEST expected a mention flag");
		Reflect.set(flag, "detail", "DYTEST changed");
		Reflect.set(first.flags, "length", 0);
		expectTokens(draft.body, ["@here"]);
		expectTokens("DYTEST without a token", []);
		expect(draft).toEqual({ channel: "chat", body: "DYTEST <!here>" });
	});
});

describe("canonical bounded chat body intake", () => {
	it("finds a token at the last accepted scalar position", () => {
		const token = "<!channel>";
		expectTokens("x".repeat(40_000 - token.length) + token, ["@channel"]);
	});

	it("counts astral scalars rather than UTF-16 units", () => {
		const token = "<!here>";
		expectTokens("\u{1f642}".repeat(40_000 - token.length) + token, ["@here"]);
		expectTokens("\u{1f642}".repeat(40_000), []);
	});

	it.each([
		`<!here>${"x".repeat(40_000 - "<!here>".length + 1)}`,
		"\u{1f642}".repeat(40_001),
		"x".repeat(80_001),
	])("refuses oversized body DATA without returning an earlier token %#", (body) => {
		expect(classify({ channel: "chat", body })).toEqual(limit);
	});

	it.each(["<!here>\r\nDYTEST", "<!here>e\u0301", "<!here>\ud800", "<!here>\udfff"])(
		"validates the whole body before classifying an earlier token %#",
		(body) => {
			expect(classify({ channel: "chat", body })).toEqual(invalid);
		},
	);

	it("accepts NFC and LF without normalizing input", () => {
		expectTokens("DYTEST \u00e9\n<!everyone>", ["@everyone"]);
	});

	it.each([
		undefined,
		null,
		false,
		0,
		"<!here>",
		{},
		{ channel: "chat" },
		{ body: "<!here>" },
		Object.create({ channel: "chat", body: "<!here>" }),
		Object.assign([], { channel: "chat", body: "<!here>" }),
		Object.assign(new Date(0), { channel: "chat", body: "<!here>" }),
	])("refuses primitive, incomplete, inherited or exotic draft input %#", (draft) => {
		expect(classify(draft)).toEqual(invalid);
	});

	it.each(["email", "CHAT", null, {}, Object("chat")])(
		"requires canonical chat channel %#",
		(channel) => {
			expect(classify({ channel, body: "<!here>" })).toEqual(invalid);
		},
	);

	it.each([undefined, null, 1, {}, Object("<!here>")])(
		"requires primitive body text %#",
		(body) => {
			expect(classify({ channel: "chat", body })).toEqual(invalid);
		},
	);

	it.each(["channel", "body"] as const)("refuses an accessor for %s without invoking it", (key) => {
		let reads = 0;
		const draft = { channel: "chat", body: "<!here>" };
		Object.defineProperty(draft, key, {
			get: () => {
				reads++;
				return key === "channel" ? "chat" : "<!here>";
			},
		});
		expect(classify(draft)).toEqual(invalid);
		expect(reads).toBe(0);
	});

	it("refuses proxy drafts and proxy used fields without invoking traps or coercion", () => {
		let calls = 0;
		const trap = () => {
			calls++;
			throw new Error("DYTEST proxy or coercion callback");
		};
		const handler = {
			get: trap,
			getPrototypeOf: trap,
			getOwnPropertyDescriptor: trap,
			ownKeys: trap,
		};
		const draft = { channel: "chat", body: "<!here>" };
		expect(classify(new Proxy(draft, handler))).toEqual(invalid);
		const revoked = Proxy.revocable(draft, handler);
		revoked.revoke();
		expect(classify(revoked.proxy)).toEqual(invalid);
		for (const key of ["channel", "body"] as const) {
			expect(classify({ ...draft, [key]: new Proxy({}, handler) })).toEqual(invalid);
			expect(classify({ ...draft, [key]: { [Symbol.toPrimitive]: trap, toString: trap } })).toEqual(
				invalid,
			);
		}
		expect(calls).toBe(0);
	});
});
