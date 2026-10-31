import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyMailAuth } from "../src/auth-results.ts";
import { ContentError, MAX_MAIL_BYTES } from "../src/limits.ts";
import { type MailEvidence, parseMail } from "../src/mail.ts";

const evidence: MailEvidence = { provider: "gmail", ownerAddresses: ["Owner@example.com"] };
const sha256 = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
const raw = (extra: readonly string[] = [], body = "Hello from a synthetic sender.") =>
	Buffer.from(
		[
			"From: Synthetic Sender <Sender@example.com>",
			"To: Owner <Owner@example.com>",
			"Subject: Synthetic subject",
			"Message-ID: <fixture@example.com>",
			...extra,
			"",
			body,
		].join("\r\n"),
	);

describe("provider authentication", () => {
	it("uses the topmost provider result, including folded fields", async () => {
		const mail = await parseMail(
			raw([
				"Authentication-Results: mx.google.com;",
				"\tdkim=pass header.d=example.com;",
				"\tdmarc=pass (p=NONE sp=NONE dis=NONE) header.from=example.com",
			]),
			evidence,
		);
		expect(mail.auth).toEqual({
			dmarc: "pass",
			verifiedSender: "Sender@example.com",
			reason: "verified",
		});
		expect(mail.direction).toBe("inbound");
		expect(mail.messageId).toBe("<fixture@example.com>");
	});

	it.each([
		["mx.google.com; dmarc=fail header.from=example.com", "dmarc-fail"],
		[
			"mx.google.com; spf=pass smtp.mailfrom=example.com; dkim=pass header.d=example.com",
			"invalid-results",
		],
		["mx.google.com; dmarc=pass header.from=other.example.com", "unaligned-from"],
		["mx.google.com; dmarc=pass header.from=example.com.attacker.test", "unaligned-from"],
		[
			"mx.google.com; dmarc=pass header.from=example.com; dmarc=fail header.from=example.com",
			"invalid-results",
		],
		['mx.google.com; dmarc=pass reason="quoted header.from=example.com "', "invalid-results"],
		["mx.google.com (unterminated; dmarc=pass header.from=example.com", "invalid-results"],
		["mx.google.com; dmarc=pass (header.from=example.com)", "invalid-results"],
	])("does not upgrade %s from a lower forged pass", async (top, reason) => {
		const mail = await parseMail(
			raw([
				`Authentication-Results: ${top}`,
				"Authentication-Results: mx.google.com; dmarc=pass header.from=example.com",
			]),
			evidence,
		);
		expect(mail.auth.verifiedSender).toBeUndefined();
		expect(mail.auth.reason).toBe(reason);
	});

	it.each([["From: Other <Other@example.com>"], ["fRoM: Sender@example.com"]])(
		"a duplicate From loses trust",
		async (duplicate) => {
			const mail = await parseMail(
				raw([
					duplicate,
					"Authentication-Results: mx.google.com; dmarc=pass header.from=example.com",
				]),
				evidence,
			);
			expect(mail.auth.reason).toBe("ambiguous-from");
			expect(mail.direction).toBe("inbound");
		},
	);

	it.each([
		"Sender@example.com, Other@example.com",
		"group: Sender@example.com;",
		"Sender@example.com trailing-junk",
		"<Sender@example.com> trailing-junk",
		"Sender\u200b@example.com",
	])("does not verify an ambiguous or malformed From: %s", async (from) => {
		const bytes = Buffer.from(
			`From: ${from}\r\nAuthentication-Results: mx.google.com; dmarc=pass header.from=example.com\r\n\r\nHello`,
		);
		const mail = await parseMail(bytes, evidence);
		expect(mail.auth.verifiedSender).toBeUndefined();
		expect(mail.direction).toBe("inbound");
	});

	it("does not trust generic-provider auth or Reply-To", async () => {
		const mail = await parseMail(
			raw([
				"Reply-To: Replacement <Redirect@elsewhere.test>",
				"Authentication-Results: mx.google.com; dmarc=pass header.from=example.com",
			]),
			{ ...evidence, provider: "generic" },
		);
		expect(mail.auth.reason).toBe("unsupported-provider");
		expect(mail.replyTo).toEqual([{ address: "Redirect@elsewhere.test", name: "Replacement" }]);
	});

	it("normalizes an IDN domain while preserving the local part", async () => {
		const bytes = Buffer.from(
			"From: User@BÜCHER.example\r\nAuthentication-Results: mx.google.com; dmarc=pass header.from=xn--bcher-kva.example\r\n\r\nHello",
		);
		const mail = await parseMail(bytes, evidence);
		expect(mail.from[0]?.address).toBe("User@xn--bcher-kva.example");
		expect(mail.auth.verifiedSender).toBe("User@xn--bcher-kva.example");
	});

	it("does not interpret markers inside comments or quoted reason values as auth methods", () => {
		for (const value of [
			"mx.google.com; spf=pass (dmarc=pass header.from=example.com)",
			'mx.google.com; reason="dmarc=pass; header.from=example.com"',
		]) {
			expect(
				verifyMailAuth([{ key: "authentication-results", value }], "gmail", "Sender@example.com")
					.verifiedSender,
			).toBeUndefined();
		}
	});
});

describe("sent evidence", () => {
	const outgoing = Buffer.from(
		"From: Owner@example.com\r\nTo: Sender@example.com\r\nX-DraftYak-Direction: outbound\r\nX-DraftYak-Verified-Send: true\r\n\r\nOwner's synthetic message",
	);

	it("does not trust a From address or message-supplied marker as proof of sending", async () => {
		expect((await parseMail(outgoing, evidence)).direction).toBe("inbound");
	});

	it.each(["verified-send", "provider-sent"] as const)(
		"binds trusted %s evidence to exact raw bytes",
		async (kind) => {
			const sentEvidence = { kind, messageSha256: sha256(outgoing) };
			expect((await parseMail(outgoing, { ...evidence, sentEvidence })).direction).toBe("outbound");
			const altered = Buffer.concat([outgoing, Buffer.from(" changed")]);
			expect((await parseMail(altered, { ...evidence, sentEvidence })).direction).toBe("inbound");
			expect(
				(
					await parseMail(raw(), {
						...evidence,
						sentEvidence: { kind, messageSha256: sha256(raw()) },
					})
				).direction,
			).toBe("inbound");
		},
	);

	it("does not silently lowercase an owner's local part", async () => {
		const bytes = Buffer.from("From: owner@example.com\r\n\r\nDifferent local part");
		expect((await parseMail(bytes, evidence)).direction).toBe("inbound");
	});
});

describe("MIME and bounded output", () => {
	it("prefers the HTML alternative and returns attachment metadata without bytes", async () => {
		const canary = "ATTACHMENT_CONTENT_CANARY_934782";
		const encoded = Buffer.from(canary).toString("base64");
		const bytes = raw(
			["MIME-Version: 1.0", 'Content-Type: multipart/mixed; boundary="outer"'],
			[
				"--outer",
				'Content-Type: multipart/alternative; boundary="inner"',
				"",
				"--inner",
				"Content-Type: text/plain; charset=utf-8",
				"",
				"Unfiltered plain alternative",
				"--inner",
				"Content-Type: text/html; charset=utf-8",
				"",
				'<p>Visible html</p><p style="display:none">HIDDEN_CANARY</p>',
				"--inner--",
				"--outer",
				"Content-Type: application/octet-stream",
				'Content-Disposition: attachment; filename="fixture.bin"',
				"Content-Transfer-Encoding: base64",
				"",
				encoded,
				"--outer--",
			].join("\r\n"),
		);
		const mail = await parseMail(bytes, evidence);
		expect(mail.body.text).toContain("Visible html");
		expect(mail.body.text).not.toContain("HIDDEN_CANARY");
		expect(mail.body.text).not.toContain("Unfiltered plain alternative");
		expect(mail.attachments).toEqual([
			{
				filename: "fixture.bin",
				mimeType: "application/octet-stream",
				size: Buffer.byteLength(canary),
				sha256: sha256(Buffer.from(canary)),
			},
		]);
		expect(JSON.stringify(mail)).not.toContain(canary);
		expect(mail.rawSha256).toBe(sha256(bytes));
	});

	it("keeps nested RFC822 messages out of thread text", async () => {
		const mail = await parseMail(
			raw(
				["MIME-Version: 1.0", 'Content-Type: multipart/mixed; boundary="outer"'],
				[
					"--outer",
					"Content-Type: text/plain",
					"",
					"Visible body",
					"--outer",
					"Content-Type: message/rfc822",
					"",
					"From: Nested@example.com",
					"",
					"NESTED_CANARY",
					"--outer--",
				].join("\r\n"),
			),
			evidence,
		);
		expect(mail.body.text).toContain("Visible body");
		expect(mail.body.text).not.toContain("NESTED_CANARY");
		expect(mail.attachments).toHaveLength(1);
	});

	it.each([
		() => new Uint8Array(),
		() => Buffer.from("Malformed header SECRET_ERROR_CANARY\r\n\r\nbody"),
		() => raw(Array.from({ length: 201 }, () => "X-Test: header")),
		() => new Uint8Array(MAX_MAIL_BYTES + 1),
	])("reports content-free errors for invalid or excessive input", async (make) => {
		const error = await parseMail(make(), evidence).catch((failure: unknown) => failure);
		expect(error).toBeInstanceOf(ContentError);
		expect((error as Error).message).not.toContain("SECRET_ERROR_CANARY");
		expect((error as Error).message.length).toBeLessThan(80);
	});

	it("rejects deeply nested MIME without leaking parser details", async () => {
		let nested = "Content-Type: text/plain\r\n\r\nDEPTH_CANARY";
		for (let i = 0; i < 15; i++) {
			nested = `Content-Type: multipart/mixed; boundary="b${i}"\r\n\r\n--b${i}\r\n${nested}\r\n--b${i}--`;
		}
		await expect(parseMail(Buffer.from(nested), evidence)).rejects.toMatchObject({
			code: "INVALID_INPUT",
			message: "Content is invalid.",
		});
	});
});
