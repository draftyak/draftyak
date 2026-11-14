import { createHash } from "node:crypto";
import PostalMime from "postal-mime";
import { beforeAll, describe, expect, it } from "vitest";
import { ContentError, type ContentErrorCode, MAX_TEXT_BYTES } from "../src/limits.ts";
import { checkedParsedMail, type MailEvidence, type ParsedMail, parseMail } from "../src/mail.ts";
import { buildDraftRequest } from "../src/prompt.ts";
import { parseMailInWorker } from "../src/worker.ts";

const evidence: MailEvidence = {
	provider: "generic",
	ownerAddresses: ["owner@synthetic.invalid"],
};
const html = "<p>DYTEST visible <b>HTML</b></p>";
const raw = (type: string, body: string) =>
	Buffer.from(
		[
			"From: sender@synthetic.invalid",
			"To: owner@synthetic.invalid",
			"Subject: DYTEST mail HTML",
			"MIME-Version: 1.0",
			`Content-Type: ${type}`,
			"",
			body,
		].join("\r\n"),
	);
let actual: ParsedMail;
let decodedHtml: string;
beforeAll(async () => {
	const bytes = raw("text/html; charset=utf-8", html);
	const decoded = await PostalMime.parse(bytes);
	if (typeof decoded.html !== "string") throw new Error("DYTEST missing decoded HTML");
	decodedHtml = decoded.html;
	actual = await parseMail(bytes, evidence);
});

function altered(value: unknown): ParsedMail {
	return Object.defineProperty({ ...actual }, "untrustedHtml", {
		value,
		writable: true,
		enumerable: true,
		configurable: true,
	});
}
function refusal(mail: ParsedMail, code: ContentErrorCode): void {
	let error: unknown;
	try {
		checkedParsedMail(mail);
	} catch (caught) {
		error = caught;
	}
	expect(error).toBeInstanceOf(ContentError);
	expect(error).toMatchObject({ code });
}

describe("mail HTML postworker data boundary", () => {
	it("keeps display-only HTML outside the drafting prompt", async () => {
		const canary = "DYTEST_RAW_HTML_ONLY";
		const mail = await parseMail(
			raw("text/html; charset=utf-8", `<p>DYTEST visible prompt text</p><!--${canary}-->`),
			evidence,
		);
		expect(mail.untrustedHtml).toContain(canary);
		expect(mail.body.text).not.toContain(canary);
		const conversationId = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
		const message = {
			id: "01ARZ3NDEKTSV4RRFFQ69G5FAX",
			conversationId,
			body: mail.body,
			direction: mail.direction,
			dmarc: mail.auth.dmarc,
			subject: mail.subject,
			untrustedHtml: mail.untrustedHtml,
		};
		const prepared = buildDraftRequest({
			model: "synthetic-model",
			conversationId,
			messages: [message],
		});
		expect(prepared.request.prompt).toContain("DYTEST visible prompt text");
		expect(prepared.request.prompt).not.toContain(canary);
		expect(prepared.request.system).not.toContain(canary);
	});

	it("retains the actual accepted HTML and the original hygiene projection", () => {
		const result = checkedParsedMail(actual);
		expect(result.untrustedHtml).toBe(decodedHtml);
		expect(result.body).toBe(actual.body);
		expect(result.attachments).toBe(actual.attachments);
	});

	it("refuses a refusal that changes while taking the mail snapshot", () => {
		let reads = 0;
		const mail = Object.defineProperty({ ...actual }, "bodyRefusal", {
			enumerable: true,
			get: () => (++reads === 1 ? undefined : "INVALID_INPUT"),
		});
		refusal(mail, "INVALID_INPUT");
		expect(reads).toBe(2);
	});

	it.each([undefined, null, false, 17, {}, []])("refuses a non-string field %j", (value) => {
		refusal(altered(value), "INVALID_INPUT");
	});

	it("refuses an ill-formed HTML string", () => {
		refusal(altered("\ud800"), "INVALID_INPUT");
	});

	it("enforces UTF-8 bytes independently of UTF-16 length", () => {
		const value = "\u{1f600}".repeat(MAX_TEXT_BYTES / 4 + 1);
		expect(value.length).toBeLessThan(MAX_TEXT_BYTES);
		expect(Buffer.byteLength(value, "utf8")).toBeGreaterThan(MAX_TEXT_BYTES);
		refusal(altered(value), "INPUT_LIMIT");
	});

	it("accepts the exact UTF-8 display bound", () => {
		const value = "é".repeat(MAX_TEXT_BYTES / 2);
		expect(Buffer.byteLength(value, "utf8")).toBe(MAX_TEXT_BYTES);
		expect(checkedParsedMail(altered(value)).untrustedHtml).toBe(value);
	});

	it.each<ContentErrorCode>([
		"INPUT_LIMIT",
		"OUTPUT_LIMIT",
		"STRUCTURE_LIMIT",
		"INVALID_INPUT",
		"TIMEOUT",
		"STARTUP_TIMEOUT",
		"ABORTED",
		"BUSY",
		"WORKER_FAILED",
	])("refuses HTML alongside body refusal %s", (bodyRefusal) => {
		refusal({ ...actual, bodyRefusal }, "INVALID_INPUT");
	});

	it("refuses an accessor without reading it", () => {
		let reads = 0;
		const mail = Object.defineProperty({ ...actual }, "untrustedHtml", {
			get() {
				reads++;
				return html;
			},
			enumerable: true,
		});
		refusal(mail, "INVALID_INPUT");
		expect(reads).toBe(0);
	});

	it("returns the validated descriptor snapshot when a later field read differs", () => {
		const mail = new Proxy(actual, {
			get(target, key, receiver) {
				return key === "untrustedHtml"
					? "DYTEST changed after validation"
					: Reflect.get(target, key, receiver);
			},
		});
		expect(checkedParsedMail(mail).untrustedHtml).toBe(decodedHtml);
	});
});

describe("real mail worker HTML data", () => {
	it.each([html, ""])("preserves accepted HTML through the actual worker: %j", async (value) => {
		const bytes = raw("text/html; charset=utf-8", value);
		const decoded = await PostalMime.parse(bytes);
		const mail = await parseMailInWorker(bytes, evidence);
		expect(Object.hasOwn(mail, "untrustedHtml")).toBe(true);
		expect(mail.untrustedHtml).toBe(decoded.html ?? "");
		expect(mail.bodyRefusal).toBeUndefined();
	});

	it("keeps plain text outside the HTML field through the actual worker", async () => {
		const mail = await parseMailInWorker(
			raw("text/plain; charset=utf-8", "DYTEST plain body"),
			evidence,
		);
		expect(Object.hasOwn(mail, "untrustedHtml")).toBe(false);
		expect(mail.body.text).toBe("DYTEST plain body");
	});

	it("retains attachment metadata and withholds oversized HTML through the actual worker", async () => {
		const attachment = Buffer.from([1, 2, 3]);
		const body = [
			"--outer",
			"Content-Type: text/html; charset=utf-8",
			"",
			"x".repeat(MAX_TEXT_BYTES + 1),
			"--outer",
			"Content-Type: application/octet-stream",
			'Content-Disposition: attachment; filename="DYTEST.bin"',
			"Content-Transfer-Encoding: base64",
			"",
			attachment.toString("base64"),
			"--outer--",
			"",
		].join("\r\n");
		const mail = await parseMailInWorker(raw('multipart/mixed; boundary="outer"', body), evidence);
		expect(mail.bodyRefusal).toBe("INPUT_LIMIT");
		expect(Object.hasOwn(mail, "untrustedHtml")).toBe(false);
		expect(mail.body.text).toBe("");
		expect(mail.attachments).toEqual([
			{
				filename: "DYTEST.bin",
				mimeType: "application/octet-stream",
				size: attachment.length,
				sha256: createHash("sha256").update(attachment).digest("hex"),
			},
		]);
	});
});
