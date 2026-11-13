import { describe, expect, it } from "vitest";
import { checkedParsedMail, type MailEvidence, parseMail } from "../src/mail.ts";
import { parseMailCore } from "../src/mail-parser.ts";

const evidence: MailEvidence = { provider: "generic", ownerAddresses: ["Owner@example.test"] };
const raw = (headers: readonly string[], newline: string) =>
	Buffer.from(
		[
			"From: Sender <Sender@example.test>",
			"To: Owner <Owner@example.test>",
			"Subject: Reply header metadata",
			...headers,
			"",
			"Synthetic body.",
			"Reply-To: BodyOnly@example.test",
		].join(newline),
	);

const cases = [
	{ name: "absent Reply-To", headers: [], count: 0 },
	{ name: "present Reply-To", headers: ["Reply-To: Target <Target@example.test>"], count: 1 },
	{ name: "empty Reply-To", headers: ["Reply-To:"], count: 1 },
	{ name: "unreadable Reply-To", headers: ["Reply-To: MAILER-DAEMON"], count: 1 },
	{
		name: "duplicate empty and nonempty Reply-To",
		headers: ["Reply-To:", "reply-to: Target <Target@example.test>"],
		count: 2,
	},
	{
		name: "mixed-case folded Reply-To",
		headers: ["rEpLy-To: Folded", "\t<Target@example.test>"],
		count: 1,
	},
] as const;

describe("original Reply-To header metadata", () => {
	for (const ending of [
		{ name: "CRLF", value: "\r\n" },
		{ name: "LF", value: "\n" },
	]) {
		for (const sample of cases) {
			it(`counts ${sample.name} with ${ending.name} line endings`, async () => {
				const parsed = await parseMail(raw(sample.headers, ending.value), evidence);
				expect(parsed).toHaveProperty("replyToHeaderCount", sample.count);
			});
		}
	}

	it("preserves the field count when the public checked boundary drops an address", async () => {
		const bytes = raw(["Reply-To: Local <Reply@localhost>"], "\r\n"),
			core = await parseMailCore(bytes, evidence);
		expect(core.replyTo).toEqual([{ address: "Reply@localhost", name: "Local" }]);
		expect(core.replyToHeaderCount).toBe(1);
		const checked = checkedParsedMail(core);
		expect(checked.replyTo).toEqual([]);
		expect(checked.replyToHeaderCount).toBe(1);
		const parsed = await parseMail(bytes, evidence);
		expect(parsed.replyTo).toEqual([]);
		expect(parsed.replyToHeaderCount).toBe(1);
	});
});
