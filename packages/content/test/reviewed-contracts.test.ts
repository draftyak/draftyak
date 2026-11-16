import { createHash } from "node:crypto";
import { MessageDirection } from "@draftyak/protocol/entities/common";
import { DraftContent } from "@draftyak/protocol/entities/draft";
import { describe, expect, it } from "vitest";
import { cleanHtml, cleanText, parseMail } from "../src/index.ts";
import { buildDraftRequest, type DraftPromptInput } from "../src/prompt.ts";

const ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const NEXT = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
const evidence = { provider: "gmail" as const, ownerAddresses: ["Owner@example.test"] };
const raw = (from: string | undefined, body = "Synthetic message.") =>
	Buffer.from(
		`${from === undefined ? "" : `From: ${from}\r\n`}To: Owner@example.test\r\nSubject: Synthetic\r\n\r\n${body}`,
	);
const email = (body: string) => ({
	channel: "email",
	to: ["recipient@example.test"],
	cc: [],
	bcc: [],
	subject: "Synthetic",
	body,
	attachments: [],
});
const chat = (body: string) => ({ channel: "chat", threadTs: null, broadcast: false, body });

describe("reviewed direction handoff", () => {
	it.each([
		undefined,
		"MAILER-DAEMON",
		"Sender@example.test, Other@example.test",
		"group: Sender@example.test;",
		"Sender@example.test trailing-junk",
		"Owner@example.test",
	])("keeps parseable mail without exact native outbound evidence inbound: %s", async (from) => {
		const parsed = await parseMail(raw(from), evidence);
		expect(MessageDirection.parse(parsed.direction)).toBe("inbound");
	});
	it("requires both an exact owner and byte-bound send evidence, even with message-supplied claims", async () => {
		const bytes = raw("Owner@example.test", "X-DraftYak-Direction: outbound\r\nSynthetic"),
			hash = createHash("sha256").update(bytes).digest("hex");
		expect((await parseMail(bytes, evidence)).direction).toBe("inbound");
		for (const kind of ["verified-send", "provider-sent"] as const) {
			const sent = { ...evidence, sentEvidence: { kind, messageSha256: hash } };
			expect(MessageDirection.parse((await parseMail(bytes, sent)).direction)).toBe("outbound");
			expect(
				(await parseMail(Buffer.concat([bytes, Buffer.from(" altered")]), sent)).direction,
			).toBe("inbound");
			const noFrom = raw(undefined);
			expect(
				(
					await parseMail(noFrom, {
						...sent,
						sentEvidence: {
							kind,
							messageSha256: createHash("sha256").update(noFrom).digest("hex"),
						},
					})
				).direction,
			).toBe("inbound");
		}
	});
	it("passes actual parsed fallback direction into a prompt while refusing the removed direction value", async () => {
		const parsed = await parseMail(raw("Owner@example.test"), evidence);
		const input: DraftPromptInput = {
			model: "synthetic-model",
			conversationId: ID,
			messages: [
				{
					id: NEXT,
					conversationId: ID,
					body: parsed.body,
					direction: parsed.direction,
					dmarc: parsed.auth.dmarc,
				},
			],
		};
		expect(buildDraftRequest(input).request.prompt).toContain(
			'"direction":"inbound","dmarc":"none"',
		);
		const row = input.messages[0];
		if (!row) throw new Error("Missing synthetic message");
		expect(() =>
			buildDraftRequest({
				...input,
				messages: [{ ...row, direction: "unknown" }],
			} as unknown as DraftPromptInput),
		).toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }));
		expect(() =>
			buildDraftRequest({
				...input,
				messages: [{ ...row, dmarc: "unknown" }],
			} as unknown as DraftPromptInput),
		).toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }));
	});
});

describe("content to reviewed draft boundary", () => {
	it.each(["email", "chat"] as const)(
		"cleans decomposed and mixed-line-ending body text for the shared %s form",
		(channel) => {
			const source = "Cafe\u0301\r\nSecond line\rThird line";
			const draft = channel === "email" ? email : chat;
			expect(DraftContent.safeParse(draft(source)).success).toBe(false);
			const clean = cleanText(source);
			expect(clean.text).toBe("Café\nSecond line\nThird line");
			expect(DraftContent.parse(draft(clean.text)).body).toBe(clean.text);
		},
	);
	it("preserves the MIME/HTML hygiene path and returns NFC/LF body text the actual draft validator accepts", async () => {
		const plain = await parseMail(raw("Sender@example.test", "Cafe\u0301\r\nLine\rEnd"), evidence);
		expect(plain.body.text).toBe("Café\nLine\nEnd");
		expect(DraftContent.parse(email(plain.body.text)).body).toBe(plain.body.text);
		const html = cleanHtml("<p>Cafe\u0301</p><p>Second\r\nline</p>");
		expect(html.text.normalize("NFC")).toBe(html.text);
		expect(html.text).not.toContain("\r");
		expect(DraftContent.parse(chat(html.text)).body).toBe(html.text);
	});
	it("does not pretend body hygiene supplies the native one-line subject/file-name policy", () => {
		const cleaned = cleanText("Synthetic\r\nheader").text;
		expect(cleaned).toContain("\n");
		expect(DraftContent.safeParse({ ...email("Body"), subject: cleaned }).success).toBe(false);
		expect(
			DraftContent.safeParse({
				...email("Body"),
				attachments: [
					{
						blobId: ID,
						filename: cleaned,
						contentType: "text/plain",
						size: 1,
						sha256: "ab".repeat(32),
					},
				],
			}).success,
		).toBe(false);
	});
});
