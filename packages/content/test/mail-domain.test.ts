import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { type MailEvidence, parseMail } from "../src/mail.ts";

const evidence: MailEvidence = { provider: "gmail", ownerAddresses: ["Owner@example.test"] };
const malformedDomains = [
	"example.test/attacker",
	"example.test?attacker",
	"example.test#attacker",
	"example.test\\attacker",
	"example%2etest",
	"0x7f.1",
	"127.1",
	"0127.0.0.1",
	"2130706433",
	"127.0.0.1",
];
const raw = (from: string, extra: readonly string[] = []) =>
	Buffer.from(
		[
			`From: ${from}`,
			"Authentication-Results: mx.google.com; dmarc=pass header.from=example.test",
			...extra,
			"",
			"Synthetic message.",
		].join("\r\n"),
	);
const sentEvidence = (bytes: Uint8Array) => ({
	kind: "provider-sent" as const,
	messageSha256: createHash("sha256").update(bytes).digest("hex"),
});

describe("mailbox domain parsing", () => {
	it("recognizes the valid owner control with evidence for the exact message", async () => {
		const bytes = raw("Owner@example.test");
		const mail = await parseMail(bytes, { ...evidence, sentEvidence: sentEvidence(bytes) });
		expect(mail.from).toEqual([{ address: "Owner@example.test" }]);
		expect(mail.auth.verifiedSender).toBe("Owner@example.test");
		expect(mail.direction).toBe("outbound");
	});

	it.each(malformedDomains)("does not shorten a malformed From domain: %s", async (domain) => {
		const bytes = raw(`Owner@${domain}`);
		const mail = await parseMail(bytes, { ...evidence, sentEvidence: sentEvidence(bytes) });
		expect(mail.from).toEqual([]);
		expect(mail.auth.verifiedSender).toBeUndefined();
		expect(mail.direction).toBe("inbound");
	});

	it.each(malformedDomains)(
		"does not shorten recipient or Reply-To domains: %s",
		async (domain) => {
			const mail = await parseMail(
				raw("Sender@example.test", [
					`To: Recipient@${domain}, Valid@example.test`,
					`Cc: Recipient@${domain}`,
					`Bcc: Recipient@${domain}`,
					`Reply-To: Recipient@${domain}`,
				]),
				evidence,
			);
			expect(mail.to).toEqual([{ address: "Valid@example.test" }]);
			expect(mail.cc).toEqual([]);
			expect(mail.bcc).toEqual([]);
			expect(mail.replyTo).toEqual([]);
		},
	);

	it.each(malformedDomains)("refuses a malformed owner evidence domain: %s", async (domain) => {
		await expect(
			parseMail(raw("Owner@example.test"), {
				...evidence,
				ownerAddresses: [`Owner@${domain}`],
			}),
		).rejects.toMatchObject({ code: "INVALID_INPUT", message: "Content is invalid." });
	});

	it.each(["Üser@BÜCHER.test", "Owner/label?value@BÜCHER.test"])(
		"preserves incoming local parts and IDNA normalization: %s",
		async (address) => {
			const canonical = `${address.slice(0, address.lastIndexOf("@"))}@xn--bcher-kva.test`;
			const mail = await parseMail(raw(`"Synthetic Sender" <${address}>`), {
				...evidence,
				ownerAddresses: [canonical],
			});
			expect(mail.from).toEqual([{ address: canonical, name: "Synthetic Sender" }]);
		},
	);

	it.each(["\u{10400}ser", "Owner\u034f", "Owner\u115f"])(
		"omits local parts outside the shared visible BMP contract: %s",
		async (local) => {
			const address = `${local}@example.test`;
			const mail = await parseMail(
				raw(address, [`To: ${address}`, `Reply-To: ${address}`]),
				evidence,
			);
			expect(mail.from).toEqual([]);
			expect(mail.to).toEqual([]);
			expect(mail.replyTo).toEqual([]);
			expect(mail.auth.verifiedSender).toBeUndefined();
			await expect(
				parseMail(raw("Owner@example.test"), { ...evidence, ownerAddresses: [address] }),
			).rejects.toMatchObject({ code: "INVALID_INPUT", message: "Content is invalid." });
		},
	);
});
