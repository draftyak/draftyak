import { Validator } from "@cfworker/json-schema";
import { describe, expect, it } from "vitest";
import { channelV1 } from "../src/channel-v1.ts";
import { checkToolResult } from "../src/extension.ts";
import {
	CHAT_CHANNEL_TYPES,
	MAX_INLINE_BYTES,
	MessageBody,
	NormalizedChange,
	PluginChange,
} from "../src/normalized-change.ts";
import { agree, changes, committed, withMember } from "./plugin-contracts.ts";

const accepted = Object.values(changes);
const schema = committed("schemas/normalized-change-v1.schema.json");
const loneSurrogate = "DYTEST \ud83d";

describe("NormalizedChange", () => {
	it("accepts the email and chat changes of §3 in zod and the exported schema", () => {
		const types = CHAT_CHANNEL_TYPES.map((type) => withMember(changes.conversation, "type", type));
		agree(NormalizedChange, schema, [...accepted, ...types], []);
		expect(CHAT_CHANNEL_TYPES).toEqual(["dm", "group_dm", "public", "private"]);
	});

	it("refuses an unknown member in every kind, parsed email fields included", () => {
		const refused = [
			...accepted.map((change) => withMember(change, "extra", 1)),
			withMember(changes.email, "subject", "DYTEST"),
			withMember(changes.email, "from", "sam@example.com"),
			withMember(changes.emailMetadataOnly, "direction", "inbound"),
			withMember(changes.chat, "channelName", "general"),
		];
		agree(NormalizedChange, schema, [], refused);
	});

	it("refuses unknown kinds and malformed ids, times and bytes", () => {
		const astral = "\u{1f600}";
		const { author: _, ...anonymous } = changes.chat;
		agree(
			NormalizedChange,
			schema,
			[
				withMember(changes.chat, "text", astral.repeat(40_000)),
				withMember(changes.email, "raw", {
					base64: "A".repeat(Math.ceil((MAX_INLINE_BYTES * 4) / 3)),
				}),
				withMember(changes.email, "providerId", "x".repeat(256)),
			],
			[
				withMember(changes.email, "kind", "sms.message"),
				withMember(changes.email, "kind", "email.parsed"),
				withMember(changes.email, "providerId", "a b"),
				withMember(changes.email, "providerId", ""),
				withMember(changes.email, "providerId", "x".repeat(257)),
				withMember(changes.email, "providerId", "caf\u{e9}"),
				withMember(changes.email, "internalDate", 1.5),
				withMember(changes.email, "internalDate", -1),
				withMember(
					changes.email,
					"labelIds",
					Array.from({ length: 257 }, (_, i) => `L${i}`),
				),
				withMember(changes.email, "raw", {
					base64: "A".repeat(Math.ceil((MAX_INLINE_BYTES * 4) / 3) + 2),
				}),
				withMember(changes.email, "raw", { base64: "AB" }),
				withMember(changes.email, "raw", { base64: "AAAA", ref: "01JAZ3W3B6Q8M2V0G5T9K4X7RC" }),
				withMember(changes.email, "raw", { ref: "blob-1" }),
				withMember(changes.chat, "text", `${astral.repeat(40_000)}x`),
				withMember(changes.chat, "subtype", "Bot_Message"),
				withMember(changes.chat, "author", { kind: "app", id: "A0123" }),
				anonymous,
				withMember(
					changes.chat,
					"files",
					Array.from({ length: 21 }, () => changes.chat.files[0]),
				),
				withMember(changes.chat, "files", [{ ...changes.chat.files[0], contentType: "pdf" }]),
				withMember(changes.chat, "files", [
					{ ...changes.chat.files[0], contentType: "Application/PDF" },
				]),
				withMember(changes.conversation, "type", "group"),
				withMember(changes.conversation, "type", "group-dm"),
				withMember(changes.conversation, "memberCount", -1),
				withMember(changes.conversation, "archived", "no"),
				{ kind: "chat.conversation", channelId: "C0123ABCD" },
			],
		);
	});

	// Python's re lets `$` match before a final line feed; patterns match the whole string.
	it("refuses ids, subtypes and media types with a trailing line feed", () => {
		agree(
			NormalizedChange,
			schema,
			[],
			[
				withMember(changes.email, "providerId", "18c2f0a1b2c3d4e5\n"),
				withMember(changes.email, "labelIds", ["INBOX\n"]),
				withMember(changes.chat, "channelId", "C0123ABCD\n"),
				withMember(changes.chat, "subtype", "bot_message\n"),
				withMember(changes.chat, "files", [
					{ ...changes.chat.files[0], contentType: "application/pdf\n" },
				]),
			],
		);
	});

	// JSON Schema can't state well-formedness: the schema accepts what the validators refuse.
	it("refuses text holding a lone surrogate, which no hash or canonical form takes", () => {
		const document = new Validator(schema, "2020-12", false);
		const refused = [
			withMember(changes.chat, "text", loneSurrogate),
			withMember(changes.chat, "files", [{ ...changes.chat.files[0], name: loneSurrogate }]),
			withMember(changes.conversation, "name", loneSurrogate),
		];
		for (const change of refused) {
			expect(NormalizedChange.safeParse(change).success).toBe(false);
			expect(document.validate(change).valid).toBe(true);
			const page = { changes: [change], cursor: "cur_000002", more: false };
			const result = checkToolResult(channelV1, "channel_sync", { structuredContent: page });
			expect(result.ok).toBe(false);
			expect(JSON.stringify(result)).toContain("lone surrogate");
		}
	});

	it("is what channel plugins may report, and a message body always carries the body", () => {
		for (const change of accepted) expect(PluginChange.safeParse(change).success).toBe(true);
		const { raw: _raw, ...withoutRaw } = changes.email;
		const bodies = [changes.email, changes.emailInBlob, changes.chat, changes.chatHello];
		for (const body of bodies) expect(MessageBody.safeParse(body).success).toBe(true);
		for (const other of [withoutRaw, changes.emailDeleted, changes.conversation]) {
			expect(MessageBody.safeParse(other).success).toBe(false);
		}
	});
});
