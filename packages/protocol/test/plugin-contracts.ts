import { readFileSync } from "node:fs";
import path from "node:path";
import { type Schema, Validator } from "@cfworker/json-schema";
import { expect } from "vitest";
import type * as z from "zod";
import { ENGINE_DEPENDENT, patterns } from "./vectors.ts";

const specDir = path.resolve(import.meta.dirname, "..", "..", "..", "spec");

// A JSON Schema as committed under spec/.
export const committed = (file: string): Schema =>
	JSON.parse(readFileSync(path.join(specDir, file), "utf8")) as Schema;

// zod and the committed JSON Schema (draft 2020-12) must agree on every sample.
export function agree(
	schema: z.ZodType,
	json: Schema,
	accepted: unknown[],
	refused: unknown[],
): void {
	for (const pattern of patterns(json)) expect(pattern).not.toMatch(ENGINE_DEPENDENT);
	const validator = new Validator(json, "2020-12", false);
	for (const sample of [...accepted, ...refused]) {
		const expected = accepted.includes(sample);
		const shown = JSON.stringify(sample)?.slice(0, 200);
		expect(schema.safeParse(sample).success, `zod: ${shown}`).toBe(expected);
		expect(validator.validate(sample).valid, `schema: ${shown}`).toBe(expected);
	}
}

// `value` with `member` set, for samples that add or change one member.
export const withMember = (value: object, member: string, to: unknown): object => ({
	...value,
	[member]: to,
});

// Shaped as §3 describes them: Gmail-like mail, Slack-like and channel-hello chat.
export const changes = {
	email: {
		kind: "email.message",
		providerId: "18c2f0a1b2c3d4e5",
		threadId: "18c2f0a1b2c3d4e0",
		internalDate: 1_792_000_000_000,
		labelIds: ["INBOX", "UNREAD", "CATEGORY_PERSONAL"],
		sizeBytes: 5_120,
		// A four-line RFC 5322 message: From, Subject, a blank line and "DYTEST hello".
		raw: { base64: "RnJvbTogc2FtQGV4YW1wbGUuY29tDQpTdWJqZWN0OiBEWVRFU1QNCg0KRFlURVNUIGhlbGxvDQo" },
	},
	emailMetadataOnly: {
		kind: "email.message",
		providerId: "18c2f0a1b2c3d4e6",
		threadId: "18c2f0a1b2c3d4e0",
		internalDate: 1_792_000_001_000,
		labelIds: [],
	},
	emailInBlob: {
		kind: "email.message",
		providerId: "18c2f0a1b2c3d4e7",
		threadId: "18c2f0a1b2c3d4e7",
		internalDate: 1_792_000_002_000,
		labelIds: ["SENT"],
		raw: { ref: "01JAZ3W3B6Q8M2V0G5T9K4X7RC" },
	},
	emailDeleted: { kind: "email.deleted", providerId: "18c2f0a1b2c3d4e5" },
	emailLabels: {
		kind: "email.labels",
		providerId: "18c2f0a1b2c3d4e5",
		threadId: "18c2f0a1b2c3d4e0",
		labelIds: ["INBOX"],
	},
	chat: {
		kind: "chat.message",
		channelId: "C0123ABCD",
		ts: "1792000000.000100",
		threadTs: "1791999000.000200",
		sentAt: 1_792_000_000_000,
		author: { kind: "user", id: "U0123ABCD" },
		text: "DYTEST hello <@U0456EFGH> \u{1f44b}",
		files: [{ id: "F0123ABCD", name: "agenda.pdf", contentType: "application/pdf", size: 1_024 }],
	},
	chatEditedByBot: {
		kind: "chat.message",
		channelId: "D0123ABCD",
		ts: "1792000005.000300",
		sentAt: 1_792_000_005_000,
		author: { kind: "bot", id: "B0123ABCD" },
		subtype: "bot_message",
		text: "DYTEST build passed",
		editedAt: 1_792_000_009_000,
	},
	chatHello: {
		kind: "chat.message",
		channelId: "conv-1",
		ts: "msg_000001",
		sentAt: 1_792_000_000_000,
		author: { kind: "user", id: "user-1" },
		text: "DYTEST hello",
	},
	chatDeleted: { kind: "chat.deleted", channelId: "C0123ABCD", ts: "1792000000.000100" },
	conversation: {
		kind: "chat.conversation",
		channelId: "C0123ABCD",
		name: "dytest-general",
		type: "public",
		external: false,
		shared: false,
		memberCount: 42,
		archived: false,
		member: true,
	},
	dm: {
		kind: "chat.conversation",
		channelId: "D0123ABCD",
		type: "dm",
		external: true,
		shared: true,
		memberCount: 2,
		archived: false,
		member: true,
	},
} as const;
