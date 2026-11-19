import { Buffer } from "node:buffer";
import { type ParsedMail, parseMail } from "@draftyak/content";
import { describe, expect, it } from "vitest";
import { NativeProjectionError, projectParsedEmailDisplay } from "../../src/sync/projection.ts";

async function parsed(): Promise<ParsedMail> {
	return parseMail(
		Buffer.from(
			[
				"From: Header value <sender@example.test>",
				"To: recipient@example.test",
				"Subject: Untrusted header",
				"Content-Type: text/plain; charset=utf-8",
				"",
				"Message body",
			].join("\r\n"),
		),
		{ provider: "generic", ownerAddresses: [] },
	);
}

describe("parsed email display projection", () => {
	it("copies parsed fields with taint and preserves the generic authentication result", async () => {
		const input = await parsed();
		const result = projectParsedEmailDisplay(input);
		expect(result).toMatchObject({
			direction: "inbound",
			dmarc: "none",
			from: [
				{
					address: { untrusted: true, text: "sender@example.test" },
					name: { untrusted: true, text: "Header value" },
				},
			],
			subject: { untrusted: true, text: "Untrusted header" },
		});
		expect(Object.isFrozen(result)).toBe(true);
		const mailbox = result.from[0];
		if (mailbox === undefined) throw new Error("Expected projected sender mailbox");
		mailbox.address.text = "changed@example.test";
		expect(input.from[0]?.address).toBe("sender@example.test");
		expect(result).not.toHaveProperty("provenance");
		expect(result).not.toHaveProperty("providerRef");
	});

	it("cuts text at scalar boundaries and keeps exact limits unmarked", async () => {
		const input = await parsed();
		const result = projectParsedEmailDisplay({
			...input,
			subject: "😀".repeat(2001),
			from: [{ address: "sender@example.test", name: "😀".repeat(257) }],
		});
		expect(result.subject).toEqual({
			untrusted: true,
			text: "😀".repeat(2000),
			truncated: true,
		});
		expect(result.from[0]?.name).toEqual({
			untrusted: true,
			text: "😀".repeat(256),
			truncated: true,
		});
		expect(
			projectParsedEmailDisplay({ ...input, subject: "😀".repeat(2000) }).subject,
		).not.toHaveProperty("truncated");
	});

	it("bounds each mailbox list in order and marks only a cut list", async () => {
		const input = await parsed();
		const addresses = Array.from({ length: 101 }, (_, index) => ({
			address: `mailbox${index}@example.test`,
		}));
		const result = projectParsedEmailDisplay({
			...input,
			from: addresses,
			replyTo: addresses,
			to: addresses,
			cc: addresses,
			bcc: addresses.slice(0, 100),
		});
		for (const field of ["from", "replyTo", "to", "cc", "bcc"] as const) {
			expect(result[field]).toHaveLength(100);
			expect(result[field][99]?.address.text).toBe("mailbox99@example.test");
			expect(result[field][0]?.name).toBeNull();
		}
		expect(result.fromTruncated).toBe(true);
		expect(result.replyToTruncated).toBe(true);
		expect(result.toTruncated).toBe(true);
		expect(result.ccTruncated).toBe(true);
		expect(result).not.toHaveProperty("bccTruncated");
	});

	it("retains attachment order, bounded names and declared media-type normalization", async () => {
		const input = await parsed();
		const attachments = Array.from({ length: 101 }, (_, index) => ({
			...(index === 0 ? {} : { filename: "😀".repeat(257) }),
			mimeType: index === 0 ? "TEXT/PLAIN; charset=utf-8" : "unreadable",
			size: index,
			sha256: "a".repeat(64),
		}));
		const result = projectParsedEmailDisplay({ ...input, attachments });
		expect(result.attachments).toHaveLength(100);
		expect(result.attachmentsTruncated).toBe(true);
		expect(result.attachments[0]).toEqual({
			filename: { untrusted: true, text: "" },
			contentType: "text/plain",
			size: 0,
		});
		expect(result.attachments[1]).toEqual({
			filename: { untrusted: true, text: "😀".repeat(256), truncated: true },
			contentType: "application/octet-stream",
			size: 1,
		});
		expect(result.attachments[99]?.size).toBe(99);
	});

	it("applies the parser's refused-From downgrade before projecting display data", async () => {
		const input = await parsed();
		const boundary: ParsedMail = {
			...input,
			direction: "outbound",
			auth: { ...input.auth, dmarc: "pass" },
		};
		expect(projectParsedEmailDisplay(boundary)).toMatchObject({
			direction: "outbound",
			dmarc: "pass",
		});
		const result = projectParsedEmailDisplay({
			...boundary,
			from: [{ address: "unreadable" }, ...input.from],
		});
		expect(result.direction).toBe("inbound");
		expect(result.dmarc).toBe("none");
		expect(result.from).toHaveLength(1);
		expect(result.from[0]?.address.text).toBe("sender@example.test");
	});

	it("refuses invalid scalars and attachment sizes with a fixed error", async () => {
		const input = await parsed();
		for (const changed of [
			{ ...input, subject: "\ud800" },
			{
				...input,
				attachments: [{ mimeType: "text/plain", size: -1, sha256: "a".repeat(64) }],
			},
		]) {
			expect(() => projectParsedEmailDisplay(changed)).toThrow(NativeProjectionError);
			expect(() => projectParsedEmailDisplay(changed)).toThrow("Content projection unavailable");
		}
	});
});
