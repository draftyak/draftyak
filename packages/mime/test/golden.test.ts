import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MimeError, renderMime } from "../src/index.ts";
import { GOLDEN_NODEMAILER, goldenCases, goldenDir } from "./golden.ts";
import { decodeHeader, getHeader, parseMessage } from "./mime-parse.ts";

describe("kept MIME golden files", () => {
	it("pins the composer version used by all four fixtures", () => {
		const manifest = createRequire(import.meta.url).resolve("nodemailer/package.json");
		expect(JSON.parse(readFileSync(manifest, "utf8")).version).toBe(GOLDEN_NODEMAILER);
	});
	for (const [name, { input, stamp }] of Object.entries(goldenCases)) {
		if (input.bcc?.length) {
			it(`${name}.eml remains gated by the Bcc transport decision`, async () => {
				const golden = parseMessage(readFileSync(path.join(goldenDir, `${name}.eml`)));
				expect(getHeader(golden, "Bcc")).toBe("archive@example.com");
				expect(golden.parts[1]?.filename).toBe(input.attachments?.[0]?.filename);
				await expect(renderMime(input, stamp)).rejects.toEqual(new MimeError("BCC_UNAVAILABLE"));
			});
			continue;
		}
		it(`${name}.eml matches byte for byte and parses back independently`, async () => {
			const golden = readFileSync(path.join(goldenDir, `${name}.eml`));
			const rendered = await renderMime(input, stamp);
			expect(rendered.raw).toEqual(golden);
			const wire = rendered.raw.toString("latin1");
			expect(wire.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
			const headers = wire.slice(0, wire.indexOf("\r\n\r\n"));
			for (const line of headers.split("\r\n")) expect(line).toMatch(/^[\x20-\x7e]{1,998}$/);
			const message = parseMessage(rendered.raw);
			expect(decodeHeader(getHeader(message, "Subject") ?? "")).toBe(input.subject);
			expect(getHeader(message, "Message-ID")).toBe(stamp.messageId);
			expect(Date.parse(getHeader(message, "Date") ?? "")).toBe(stamp.dateMs);
			for (const recipient of input.to)
				expect(decodeHeader(getHeader(message, "To") ?? "")).toContain(recipient.address);
			const text = message.parts.length === 0 ? message : message.parts[0];
			expect(text?.body.toString("utf8").replace(/\r\n/g, "\n")).toBe(input.text);
			if (input.attachments) {
				for (const [index, attachment] of input.attachments.entries()) {
					expect(message.parts[index + 1]?.filename).toBe(attachment.filename);
					expect(message.parts[index + 1]?.body).toEqual(Buffer.from(attachment.content));
				}
			}
			for (const [key, value] of Object.entries(input.list ?? {}))
				expect(getHeader(message, `List-${key}`)).toBe(value);
			expect(getHeader(message, "Bcc")).toBeUndefined();
		});
	}
	it("parses a current non-Bcc Unicode attachment with exact binary bytes and content type", async () => {
		const fixture = goldenCases["new-with-attachment"];
		if (!fixture) throw new Error("Attachment fixture missing");
		const filename = "Résumé 日程 📎.bin",
			contentType = "application/x-synthetic-binary",
			content = Buffer.from(Array.from({ length: 256 }, (_, value) => value));
		const rendered = await renderMime(
			{
				...fixture.input,
				bcc: [],
				attachments: [{ filename, contentType, content }],
			},
			fixture.stamp,
		);
		const message = parseMessage(rendered.raw),
			attachment = message.parts[1];
		expect(message.mimeType).toBe("multipart/mixed");
		expect(message.parts).toHaveLength(2);
		expect(getHeader(message, "Bcc")).toBeUndefined();
		expect(getHeader(message, "Message-ID")).toBe(fixture.stamp.messageId);
		expect(attachment?.filename).toBe(filename);
		expect(attachment?.mimeType).toBe(contentType);
		expect(attachment?.body).toEqual(content);
	});
});
