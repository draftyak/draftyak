import { type Schema, Validator } from "@cfworker/json-schema";
import { describe, expect, it } from "vitest";
import { jsonSchemaOf } from "../scripts/export-spec.ts";
import { schema, path as schemaPath } from "../scripts/spec/draft-read.ts";
import { CurrentDraft } from "../src/draft-read.ts";
import { Draft, DraftRevision } from "../src/entities/draft.ts";

const draftId = "01JAZ3W3B6Q8M2V0G5T9K4X7RC";
const otherId = "01JAZ3W3B6Q8M2V0G5T9K4X7RD";

function sample(channel: "email" | "chat" = "email"): CurrentDraft {
	return {
		draft: {
			id: draftId,
			accountId: otherId,
			conversationId: channel === "email" ? null : otherId,
			rev: 3,
			state: "open",
			createdAt: 1,
			updatedAt: 2,
		},
		revision: {
			draftId,
			rev: 3,
			author: { kind: "owner", id: otherId },
			content:
				channel === "email"
					? {
							channel,
							to: ["recipient@example.test"],
							cc: [],
							bcc: [],
							subject: "Meeting",
							body: "Tuesday works.",
							attachments: [],
						}
					: { channel, threadTs: null, broadcast: false, body: "Tuesday works." },
			contentSha256: "a".repeat(64),
			flags: [{ code: "TOOL_CONTEXT_USED", severity: "info" }],
			createdAt: 2,
		},
	};
}

describe("CurrentDraft", () => {
	it.each([
		["email", "open"],
		["email", "sent"],
		["email", "discarded"],
		["chat", "open"],
		["chat", "sent"],
		["chat", "discarded"],
	] as const)("preserves an existing %s draft in state %s", (channel, state) => {
		const value = sample(channel);
		value.draft.state = state;
		expect(CurrentDraft.parse(value)).toEqual(value);
	});

	it("parses frozen input into detached data without changing its header, content or flags", () => {
		const value = sample("chat");
		Object.freeze(value.draft);
		Object.freeze(value.revision.author);
		Object.freeze(value.revision.content);
		Object.freeze(value.revision.flags[0]);
		Object.freeze(value.revision.flags);
		Object.freeze(value.revision);
		Object.freeze(value);
		const parsed = CurrentDraft.parse(value);
		expect(parsed).toEqual(value);
		expect(parsed).not.toBe(value);
		expect(parsed.draft).not.toBe(value.draft);
		expect(parsed.revision).not.toBe(value.revision);
		expect(parsed.revision.content).not.toBe(value.revision.content);
		expect(parsed.revision.flags).not.toBe(value.revision.flags);
		parsed.revision.content.body = "Changed after parsing.";
		expect(value.revision.content.body).toBe("Tuesday works.");
	});

	it.each([
		{ name: "draft id", change: { draftId: otherId }, path: ["revision", "draftId"] },
		{ name: "revision number", change: { rev: 2 }, path: ["revision", "rev"] },
	])("refuses a mismatched $name even when both nested models are valid", ({ change, path }) => {
		const value = sample();
		const revision = { ...value.revision, ...change };
		expect(Draft.safeParse(value.draft).success).toBe(true);
		expect(DraftRevision.safeParse(revision).success).toBe(true);
		const result = CurrentDraft.safeParse({ ...value, revision });
		expect(result.success).toBe(false);
		if (!result.success) expect(result.error.issues.map((issue) => issue.path)).toEqual([path]);
	});

	it("reports both join mismatches without rewriting either nested model", () => {
		const value = sample();
		const revision = { ...value.revision, draftId: otherId, rev: 2 };
		const result = CurrentDraft.safeParse({ ...value, revision });
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.error.issues.map((issue) => issue.path)).toEqual([
				["revision", "draftId"],
				["revision", "rev"],
			]);
		}
		expect(value.draft).toMatchObject({ id: draftId, rev: 3 });
		expect(revision).toMatchObject({ draftId: otherId, rev: 2 });
	});

	it.each([
		["a missing header", { revision: sample().revision }],
		["a missing revision", { draft: sample().draft }],
		["an unknown outer field", { ...sample(), approved: true }],
	])("refuses %s", (_name, value) => {
		expect(CurrentDraft.safeParse(value).success).toBe(false);
	});

	it.each([
		["header", { ...sample(), draft: { ...sample().draft, ownerId: otherId } }],
		["revision", { ...sample(), revision: { ...sample().revision, approved: true } }],
	])("keeps the existing %s model strict", (_name, value) => {
		expect(CurrentDraft.safeParse(value).success).toBe(false);
	});

	it.each([
		[
			"a noncanonical header id",
			{ ...sample(), draft: { ...sample().draft, id: draftId.toLowerCase() } },
		],
		["a zero header revision", { ...sample(), draft: { ...sample().draft, rev: 0 } }],
		["a fractional revision", { ...sample(), revision: { ...sample().revision, rev: 1.5 } }],
		["a string revision", { ...sample(), revision: { ...sample().revision, rev: "3" } }],
		[
			"a malformed content hash",
			{ ...sample(), revision: { ...sample().revision, contentSha256: "a" } },
		],
		[
			"a flag with another severity",
			{
				...sample(),
				revision: {
					...sample().revision,
					flags: [{ code: "TOOL_CONTEXT_USED", severity: "ack" }],
				},
			},
		],
		[
			"a broadcast without a thread",
			{
				...sample("chat"),
				revision: {
					...sample("chat").revision,
					content: { channel: "chat", threadTs: null, broadcast: true, body: "Text" },
				},
			},
		],
		["an unknown draft state", { ...sample(), draft: { ...sample().draft, state: "approved" } }],
	])("retains the nested refusal for %s", (_name, value) => {
		expect(CurrentDraft.safeParse(value).success).toBe(false);
	});

	it.each([null, [], "draft", 3])("refuses a non-object envelope: %j", (value) => {
		expect(CurrentDraft.safeParse(value).success).toBe(false);
	});

	it("registers the shared shape without claiming JSON Schema enforces the cross-field join", () => {
		expect(schemaPath).toBe("schemas/draft-read-v1.schema.json");
		expect(schema).toBe(CurrentDraft);
		const json = jsonSchemaOf(schema) as Schema;
		const validator = new Validator(json, "2020-12", false);
		expect(validator.validate(sample()).valid).toBe(true);
		expect(validator.validate(sample("chat")).valid).toBe(true);
		expect(validator.validate({ ...sample(), approved: true }).valid).toBe(false);
		expect(validator.validate({ draft: sample().draft }).valid).toBe(false);
	});
});
