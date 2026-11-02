import { createHash } from "node:crypto";
import PostalMime, { type PostalMimeOptions } from "postal-mime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_TEXT_BYTES } from "../src/limits.ts";
import { type MailEvidence, parseMail } from "../src/mail.ts";

const evidence: MailEvidence = { provider: "gmail", ownerAddresses: ["owner@example.test"] };
const headers = [
	"From: Sender <sender@example.test>",
	"To: owner@example.test",
	"Subject: Kept metadata",
	"Authentication-Results: mx.google.com; dmarc=pass header.from=example.test",
];
const raw = (extra: string[], body?: string): Buffer =>
	Buffer.from([...headers, ...extra].join("\r\n") + (body === undefined ? "" : `\r\n\r\n${body}`));
const hash = (value: Uint8Array): string => createHash("sha256").update(value).digest("hex");
const multipart = (parts: string[]): Buffer =>
	raw(
		['Content-Type: multipart/mixed; boundary="outer"'],
		`${parts.map((part) => `--outer\r\n${part}`).join("\r\n")}\r\n--outer--\r\n`,
	);
afterEach(() => vi.restoreAllMocks());

describe("mail review boundaries", () => {
	it.each([false, true])("accepts header-only mail, trailing CRLF=%s", async (trailing) => {
		const bytes = Buffer.concat([raw([]), Buffer.from(trailing ? "\r\n" : "")]);
		const mail = await parseMail(bytes, evidence);
		expect(mail.subject).toBe("Kept metadata");
		expect(mail.from).toEqual([{ address: "sender@example.test", name: "Sender" }]);
		expect(mail.auth).toMatchObject({ dmarc: "pass", verifiedSender: "sender@example.test" });
		expect(mail.body.text).toBe("");
		expect(mail.bodyRefusal).toBeUndefined();
	});

	it("keeps plain dashed lines that are not declared multipart delimiters", async () => {
		const body = Array.from({ length: 110 }, (_, i) => `-- SQL comment ${i}`).join("\r\n");
		const mail = await parseMail(raw(["Content-Type: text/plain"], body), evidence);
		expect(mail.body.text).toBe(body.replaceAll("\r\n", "\n"));
		expect(mail.bodyRefusal).toBeUndefined();
	});

	it("retains auth, headers and attachment metadata when HTML exceeds the stylesheet budget", async () => {
		const bytes = Buffer.from("SYNTHETIC_ATTACHMENT");
		const alternative = [
			'Content-Type: multipart/alternative; boundary="inner"',
			"",
			"--inner",
			"Content-Type: text/plain",
			"",
			"UNSEEN_PLAIN_ALTERNATIVE",
			"--inner",
			"Content-Type: text/html",
			"",
			`<style>${".x{color:red}".repeat(3000)}</style><p>BODY_CANARY</p>`,
			"--inner--",
		].join("\r\n");
		const mail = await parseMail(
			multipart([
				alternative,
				[
					"Content-Type: application/octet-stream",
					'Content-Disposition: attachment; filename="fixture.bin"',
					"Content-Transfer-Encoding: base64",
					"",
					bytes.toString("base64"),
				].join("\r\n"),
			]),
			evidence,
		);
		expect(mail.subject).toBe("Kept metadata");
		expect(mail.auth).toMatchObject({ dmarc: "pass", verifiedSender: "sender@example.test" });
		expect(mail.to).toEqual([{ address: "owner@example.test" }]);
		expect(mail.body).toEqual({
			text: "",
			links: [],
			suspectedInstructions: false,
			removals: { hidden: 0, invisible: 0, quoted: 0, truncated: 0, uris: 0 },
		});
		expect(mail.bodyRefusal).toBe("STRUCTURE_LIMIT");
		expect(mail.attachments).toEqual([
			{
				filename: "fixture.bin",
				mimeType: "application/octet-stream",
				size: bytes.length,
				sha256: hash(bytes),
			},
		]);
		expect(JSON.stringify(mail)).not.toMatch(
			/BODY_CANARY|UNSEEN_PLAIN_ALTERNATIVE|SYNTHETIC_ATTACHMENT/,
		);
	});

	it.each(["text/plain", "text/html"])(
		"withholds oversized %s without discarding metadata",
		async (type) => {
			const mail = await parseMail(
				raw([`Content-Type: ${type}`], "x".repeat(MAX_TEXT_BYTES + 1)),
				evidence,
			);
			expect(mail.subject).toBe("Kept metadata");
			expect(mail.auth.dmarc).toBe("pass");
			expect(mail.body.text).toBe("");
			expect(mail.bodyRefusal).toBe("INPUT_LIMIT");
		},
	);

	it("reaches postal-mime's actual root-inclusive part limit", async () => {
		const parts = Array.from({ length: 99 }, () => "Content-Type: text/plain\r\n\r\nvisible");
		const allowed = await parseMail(multipart(parts), evidence);
		expect(allowed.body.text).toContain("visible");
		await expect(parseMail(multipart([...parts, parts[0] ?? ""]), evidence)).rejects.toMatchObject({
			code: "INVALID_INPUT",
			message: "Content is invalid.",
		});
	});

	it("pins parser allocation and opaque-forward options at the actual parse call", async () => {
		const parse = vi.spyOn(PostalMime.prototype, "parse");
		await parseMail(raw([], "visible"), evidence);
		expect(parse).toHaveBeenCalledOnce();
		expect((parse.mock.contexts[0] as unknown as { options: unknown }).options).toEqual({
			maxNestingDepth: 12,
			maxHeadersSize: 65536,
			maxPartCount: 100,
			maxForwardedAddresses: 100,
			maxRfc822NestingDepth: 0,
			forceRfc822Attachments: true,
			attachmentEncoding: "arraybuffer",
		});
	});

	it("keeps many forwarded addresses opaque and retains only outer metadata", async () => {
		const forwarded =
			"Content-Type: message/rfc822\r\n\r\nFrom: nested@example.test\r\nTo: " +
			Array.from({ length: 120 }, (_, i) => `n${i}@example.test`).join(",") +
			"\r\n\r\nINNER_CANARY";
		const mail = await parseMail(
			multipart(["Content-Type: text/plain\r\n\r\nvisible", forwarded]),
			evidence,
		);
		expect(mail.body.text).toBe("visible");
		expect(mail.attachments).toHaveLength(1);
		expect(mail.attachments[0]?.mimeType).toBe("message/rfc822");
		expect(JSON.stringify(mail)).not.toContain("INNER_CANARY");
	});

	it("independently exercises RFC822 depth and forwarded-address limits with the companion option weakened", async () => {
		const spy = vi.spyOn(PostalMime.prototype, "parse");
		await parseMail(raw([], "visible"), evidence);
		const options = (spy.mock.contexts[0] as unknown as { options: PostalMimeOptions }).options;
		spy.mockRestore();
		const nested =
			"Content-Type: message/rfc822\r\n\r\nFrom: nested@example.test\r\nTo: " +
			Array.from({ length: 120 }, (_, i) => `n${i}@example.test`).join(",") +
			"\r\n\r\nINNER_CANARY";
		const bytes = multipart(["Content-Type: text/plain\r\n\r\nvisible", nested]);
		// The production force-attachment flag already disables both inline counters.
		// Weaken it only in this direct parser control to reach the configured depth.
		const opaque = await PostalMime.parse(bytes, { ...options, forceRfc822Attachments: false });
		expect(opaque.text).not.toContain("INNER_CANARY");
		expect(opaque.attachments[0]?.rfc822DepthExceeded).toBe(true);
		// With inline depth allowed, the configured address counter must actually fire.
		await expect(
			PostalMime.parse(bytes, {
				...options,
				forceRfc822Attachments: false,
				maxRfc822NestingDepth: 1,
			}),
		).rejects.toThrow("Maximum forwarded address count of 100");
		const visible = await PostalMime.parse(bytes, {
			...options,
			forceRfc822Attachments: false,
			maxRfc822NestingDepth: 1,
			maxForwardedAddresses: 121,
		});
		expect(visible.text).toContain("INNER_CANARY");
	});

	it("keeps an empty HTML alternative empty instead of exposing unseen plain text", async () => {
		const mail = await parseMail(
			raw(
				['Content-Type: multipart/alternative; boundary="a"'],
				[
					"--a",
					"Content-Type: text/plain",
					"",
					"UNSEEN_CANARY",
					"--a",
					"Content-Type: text/html",
					"",
					"",
					"--a--",
					"",
				].join("\r\n"),
			),
			evidence,
		);
		expect(mail.body.text).toBe("");
		expect(mail.bodyRefusal).toBeUndefined();
		expect(JSON.stringify(mail)).not.toContain("UNSEEN_CANARY");
	});

	it("keeps an HTML attachment out of body selection", async () => {
		const mail = await parseMail(
			multipart([
				"Content-Type: text/plain\r\n\r\nvisible",
				'Content-Type: text/html\r\nContent-Disposition: attachment; filename="note.html"\r\n\r\nATTACHED_CANARY',
			]),
			evidence,
		);
		expect(mail.body.text).toBe("visible");
		expect(mail.attachments[0]?.filename).toBe("note.html");
		expect(mail.bodyRefusal).toBeUndefined();
	});

	it("withholds only the body if pinned HTML-presence metadata becomes unavailable", async () => {
		const original = PostalMime.prototype.parse;
		vi.spyOn(PostalMime.prototype, "parse").mockImplementationOnce(async function (
			this: PostalMime,
			bytes,
		) {
			const parsed = await original.call(this, bytes);
			Reflect.deleteProperty(this, "textTypes");
			return parsed;
		});
		const mail = await parseMail(raw([], "BODY_CANARY"), evidence);
		expect(mail.subject).toBe("Kept metadata");
		expect(mail.auth.dmarc).toBe("pass");
		expect(mail.bodyRefusal).toBe("INVALID_INPUT");
		expect(mail.body.text).toBe("");
	});

	it.each(['"Team <Sales>"', '"A > B"', '"Quoted \\"nickname\\""'])(
		"retains verification and verified-send direction with quoted display name %s",
		async (name) => {
			const bytes = Buffer.from(
				`From: ${name} <owner@example.test>\r\n` +
					"Authentication-Results: mx.google.com; dmarc=pass header.from=example.test\r\n\r\nvisible",
			);
			const mail = await parseMail(bytes, {
				...evidence,
				sentEvidence: {
					kind: "verified-send",
					messageSha256: hash(bytes),
				},
			});
			expect(mail.auth).toMatchObject({ dmarc: "pass", verifiedSender: "owner@example.test" });
			expect(mail.direction).toBe("outbound");
		},
	);
});
