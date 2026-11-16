import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import MailComposer from "nodemailer/lib/mail-composer";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as mime from "../src/index.ts";
import { type ClaimStamp, MimeError, type MimeInput, renderMime } from "../src/index.ts";

const stamp: ClaimStamp = {
	messageId: "<golden-1.4f2a9c1e@example.com>",
	dateMs: Date.parse("2026-10-17T12:00:00Z"),
	mimeBoundary: "0123456789abcdef01234567",
	uploadBoundary: "draftyak_upload_0123456789abcdef",
};
const input: MimeInput = {
	from: { name: "Owner Example", address: "owner@example.com" },
	to: [{ name: "Alice Example", address: "alice@example.org" }],
	cc: [{ address: "carol@example.net" }],
	subject: "Re: Lunch on Thursday",
	text: "Hi Alice,\n\nThursday at noon works for me.\n\nOwner\n",
	inReplyTo: "<thread-2@example.org>",
	references: ["<thread-1@example.org>", "<thread-2@example.org>"],
};
afterEach(() => vi.restoreAllMocks());

describe("shared native MIME bytes", () => {
	it("matches the existing independent golden fixture directly", async () => {
		const golden = readFileSync(new URL("./fixtures/reply-ascii.eml", import.meta.url));
		const rendered = await renderMime(input, stamp);
		expect(rendered.raw).toEqual(golden);
		expect(rendered.to).toEqual(["alice@example.org"]);
		expect(rendered.cc).toEqual(["carol@example.net"]);
		expect(rendered.subject).toBe(input.subject);
		expect(rendered.textSha256).toBe(
			createHash("sha256").update(input.text.replace(/\n+$/, "")).digest("hex"),
		);
		expect(mime).not.toHaveProperty("renderSendRequest");
	});
	it("keeps caller-stamped Unicode and content-only attachments deterministic", async () => {
		const value: MimeInput = {
			...input,
			subject: "Café ☕",
			to: [{ name: "Zoë", address: "Local@BÜCHER.example" }],
			attachments: [
				{
					filename: "Übersicht.txt",
					contentType: "text/plain",
					content: Buffer.from("Synthetic attachment"),
				},
			],
		};
		const one = await renderMime(value, stamp),
			two = await renderMime(value, stamp);
		expect(two).toEqual(one);
		expect(one.to).toEqual(["Local@xn--bcher-kva.example"]);
		expect(one.raw.toString()).not.toContain("Bcc:");
		expect(one.raw.toString()).toContain(`Message-ID: ${stamp.messageId}\r\n`);
		expect(one.raw.toString()).toContain("Date: Sat, 17 Oct 2026 12:00:00 +0000\r\n");
		expect(one.raw.toString()).toContain(`--_NmP-${stamp.mimeBoundary}-Part_1`);
		expect(one.raw.toString("latin1").replace(/\r\n/g, "")).not.toMatch(/[^\x20-\x7e]/);
	});
	it("copies attachment and mailbox inputs before the asynchronous composer completes", async () => {
		const content = Buffer.from("ATTACHMENT_ORIGINAL"),
			to = [{ address: "before@example.test" }];
		const value = {
			...input,
			to,
			attachments: [{ filename: "synthetic.txt", contentType: "text/plain", content }],
		};
		const pending = renderMime(value, stamp);
		to[0] = { address: "AFTER_CANARY@example.test" };
		content.fill(0);
		const rendered = await pending;
		expect(rendered.to).toEqual(["before@example.test"]);
		expect(rendered.raw.toString()).toContain("To: before@example.test\r\n");
		expect(rendered.raw.toString()).toContain(
			Buffer.from("ATTACHMENT_ORIGINAL").toString("base64"),
		);
		expect(rendered.raw.toString()).not.toContain("AFTER_CANARY");
	});
	it.each([
		{ ...stamp, uploadBoundary: "short" },
		{ ...stamp, dateMs: stamp.dateMs + 1 },
		{ ...stamp, mimeBoundary: "PRIVATE_BOUNDARY_CANARY\n" },
	])("retains the complete four-field compatibility stamp guard", async (value) => {
		await expect(renderMime(input, value)).rejects.toEqual(new MimeError("BAD_STAMP"));
	});
	it("retains fixed legacy diagnostics and refuses a missing upload stamp field", async () => {
		const { uploadBoundary: _unused, ...incomplete } = stamp;
		await expect(renderMime(input, incomplete as ClaimStamp)).rejects.toEqual(
			new MimeError("BAD_STAMP"),
		);
		await expect(
			renderMime({ ...input, subject: "PRIVATE_HEADER_CANARY\r\nX: injected" }, stamp),
		).rejects.toEqual(new MimeError("HEADER_CRLF"));
		expect(new MimeError("HEADER_CRLF").message).toBe("gmail: HEADER_CRLF");
	});
	it.each([
		{ filename: "synthetic.txt", contentType: "text/plain", path: "PRIVATE_PATH_CANARY" },
		{
			filename: "synthetic.txt",
			contentType: "text/plain",
			href: "https://example.test/PRIVATE_URL_CANARY",
		},
		{
			filename: "synthetic.txt",
			contentType: "text/plain; charset=utf-8",
			content: Buffer.from("x"),
		},
	])("refuses non-content attachment sources before composing", async (attachment) => {
		const compile = vi.spyOn(MailComposer.prototype, "compile");
		await expect(
			renderMime({ ...input, attachments: [attachment] } as unknown as MimeInput, stamp),
		).rejects.toEqual(new MimeError("BAD_ATTACHMENT"));
		expect(compile).not.toHaveBeenCalled();
	});
	it("passes no file/URL access and redacts a composer failure", async () => {
		let access: unknown;
		const compile = vi.spyOn(MailComposer.prototype, "compile").mockImplementation(function (
			this: MailComposer,
		) {
			access = { file: this.mail.disableFileAccess, url: this.mail.disableUrlAccess };
			throw new Error("PRIVATE_COMPOSER_CANARY");
		});
		await expect(renderMime(input, stamp)).rejects.toEqual(new MimeError("COMPOSE_FAILED"));
		expect(compile).toHaveBeenCalledOnce();
		expect(access).toEqual({ file: true, url: true });
	});
});

describe("shared comparison rules", () => {
	it("preserves local-part case, deduplicates canonical domains and refuses alternate mailbox forms", () => {
		expect(
			mime.normalizeAddresses([
				"Local@BÜCHER.example",
				"Local@xn--bcher-kva.example",
				"local@BÜCHER.example",
			]),
		).toEqual(["Local@xn--bcher-kva.example", "local@xn--bcher-kva.example"]);
		for (const value of [
			'"quoted local"@example.test',
			"name@example.test/path",
			"name@@example.test",
			"名@example.test",
		])
			expect(() => mime.canonicalAddress(value)).toThrow(MimeError);
	});
	it("preserves existing subject whitespace and decoded-body comparison behavior", () => {
		expect(mime.normalizeSubject(" Re:  Café\t\r\n update ")).toBe("Re: Café update");
		expect(mime.textSha256("A\r\nB\r\n\r\n")).toBe(
			createHash("sha256").update("A\nB").digest("hex"),
		);
		expect(mime.textSha256("A\nB ")).not.toBe(mime.textSha256("A\nB"));
	});
});
