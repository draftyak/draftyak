import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { MAX_MAIL_BYTES } from "../src/limits.ts";
import { parseMailInWorker } from "../src/worker.ts";

const evidence = { provider: "generic" as const, ownerAddresses: ["owner@example.test"] };

it.each([3, 25])(
	"parses a %s MiB attachment in the bounded mail heap and returns metadata only",
	async (mebibytes) => {
		const attachment = Buffer.alloc(mebibytes * 1048576, 65);
		const encoded =
			attachment
				.toString("base64")
				.match(/.{1,76}/g)
				?.join("\r\n") ?? "";
		const raw = Buffer.from(
			[
				"From: sender@example.test",
				"Subject: Attachment-bearing note",
				'Content-Type: multipart/mixed; boundary="outer"',
				"",
				"--outer",
				"Content-Type: text/plain",
				"",
				"Keep this note.",
				"--outer",
				"Content-Type: application/pdf",
				'Content-Disposition: attachment; filename="fixture.pdf"',
				"Content-Transfer-Encoding: base64",
				"",
				encoded,
				"--outer--",
				"",
			].join("\r\n"),
		);
		expect(raw.length).toBeGreaterThan(2 * 1048576);
		expect(raw.length).toBeLessThanOrEqual(MAX_MAIL_BYTES);
		const mail = await parseMailInWorker(raw, evidence);
		expect(mail.body.text).toBe("Keep this note.");
		expect(mail.bodyRefusal).toBeUndefined();
		expect(mail.subject).toBe("Attachment-bearing note");
		expect(mail.attachments).toEqual([
			{
				filename: "fixture.pdf",
				mimeType: "application/pdf",
				size: attachment.length,
				sha256: createHash("sha256").update(attachment).digest("hex"),
			},
		]);
		expect(Object.keys(mail.attachments[0] ?? {}).sort()).toEqual([
			"filename",
			"mimeType",
			"sha256",
			"size",
		]);
		expect(JSON.stringify(mail).length).toBeLessThan(2000);
	},
);

it("handles a long malformed From within the ready worker processing budget", async () => {
	const raw = Buffer.from(`From: a${" ".repeat(60000)}a\r\nSubject: Still parsed\r\n\r\nvisible`);
	const mail = await parseMailInWorker(raw, evidence, { timeoutMs: 2000 });
	expect(mail.auth.dmarc).toBe("none");
	expect(mail.direction).toBe("inbound");
	expect(mail.body.text).toBe("visible");
});
