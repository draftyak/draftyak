import MailComposer from "nodemailer/lib/mail-composer";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type ClaimStamp,
	type ListHeader,
	MAX_ATTACHMENTS,
	MAX_BYTES,
	MAX_LINE_BYTES,
	MAX_RECIPIENTS,
	MAX_REFERENCES,
	MimeError,
	type MimeInput,
	renderMime,
} from "../src/index.ts";
import { decodeHeader, getHeader, parseMessage } from "./mime-parse.ts";

const stamp = (): ClaimStamp => ({
	messageId: "<synthetic@example.test>",
	dateMs: 1_800_000_000_000,
	mimeBoundary: "0123456789abcdef01234567",
	uploadBoundary: "synthetic_upload_0123456789",
});
const input = (): MimeInput => ({
	from: { address: "owner@example.test" },
	to: [{ address: "recipient@example.test" }],
	subject: "Synthetic",
	text: "Synthetic body\n",
});
const listHeaders: readonly ListHeader[] = [
	"archive",
	"help",
	"id",
	"owner",
	"post",
	"subscribe",
	"unsubscribe",
	"unsubscribe-post",
];
const controls = [
	{ name: "CR", value: "\r", code: "HEADER_CRLF" },
	{ name: "LF", value: "\n", code: "HEADER_CRLF" },
	{ name: "CRLF", value: "\r\n", code: "HEADER_CRLF" },
	{ name: "NUL", value: "\0", code: "HEADER_CONTROL" },
	{ name: "lone surrogate", value: "\ud800", code: "HEADER_UNICODE" },
] as const;
interface HeaderCase {
	readonly field: string;
	readonly change: (value: string) => MimeInput;
}
const headers: readonly HeaderCase[] = [
	{ field: "Subject", change: (value) => ({ ...input(), subject: value }) },
	...(["from", "to", "cc", "bcc"] as const).flatMap((field) =>
		(["address", "name"] as const).map((member) => ({
			field: `${field}.${member}`,
			change: (value: string): MimeInput => {
				const box = { address: "recipient@example.test", [member]: value };
				return { ...input(), [field]: field === "from" ? box : [box] };
			},
		})),
	),
	{ field: "In-Reply-To", change: (value) => ({ ...input(), inReplyTo: value }) },
	{ field: "References", change: (value) => ({ ...input(), references: [value] }) },
	...listHeaders.map((field) => ({
		field: `List-${field}`,
		change: (value: string): MimeInput => ({ ...input(), list: { [field]: value } }),
	})),
	{
		field: "attachment filename",
		change: (value) => ({
			...input(),
			attachments: [
				{ filename: value, contentType: "text/plain", content: Buffer.from("payload") },
			],
		}),
	},
];
afterEach(() => vi.restoreAllMocks());

describe("header refusal matrix before composition", () => {
	for (const header of headers) {
		it.each(controls)(`refuses $name in ${header.field}`, async ({ value, code }) => {
			const compile = vi.spyOn(MailComposer.prototype, "compile");
			await expect(renderMime(header.change(`CANARY${value}INJECTED`), stamp())).rejects.toEqual(
				new MimeError(code),
			);
			expect(compile).not.toHaveBeenCalled();
		});
	}
	it.each(controls)("refuses $name in Message-ID", async ({ value, code }) => {
		const compile = vi.spyOn(MailComposer.prototype, "compile");
		await expect(
			renderMime(input(), { ...stamp(), messageId: `<CANARY${value}@example.test>` }),
		).rejects.toEqual(new MimeError(code));
		expect(compile).not.toHaveBeenCalled();
	});
	for (const field of ["mimeBoundary", "uploadBoundary"] as const) {
		it.each(controls)(`refuses $name in ${field}`, async ({ value }) => {
			const compile = vi.spyOn(MailComposer.prototype, "compile");
			await expect(
				renderMime(input(), { ...stamp(), [field]: `CANARY${value}INJECTED` }),
			).rejects.toEqual(new MimeError("BAD_STAMP"));
			expect(compile).not.toHaveBeenCalled();
		});
	}
	it.each(controls)("refuses $name in attachment Content-Type", async ({ value }) => {
		const compile = vi.spyOn(MailComposer.prototype, "compile");
		await expect(
			renderMime(
				{
					...input(),
					attachments: [
						{
							filename: "synthetic.txt",
							contentType: `text/plain${value}INJECTED`,
							content: Buffer.from("x"),
						},
					],
				},
				stamp(),
			),
		).rejects.toEqual(new MimeError("BAD_ATTACHMENT"));
		expect(compile).not.toHaveBeenCalled();
	});
});

describe("message-id grammar", () => {
	it.each([
		"<abc@mail_host.example>",
		"<abc@[192.0.2.1]>",
		"<abc@[IPv6:2001:db8::1]>",
		"<a.b+c!d@example.test>",
	])("accepts and preserves %s in all three message-id fields", async (id) => {
		const result = await renderMime(
			{ ...input(), inReplyTo: id, references: [id] },
			{ ...stamp(), messageId: id },
		);
		const parsed = parseMessage(result.raw);
		for (const field of ["Message-ID", "In-Reply-To", "References"])
			expect(getHeader(parsed, field)).toBe(id);
	});
	it.each([
		"abc@example.test",
		"<a b@example.test>",
		"<.abc@example.test>",
		"<abc..def@example.test>",
		"<abc@example..test>",
		"<abc@[bad\\literal]>",
		"<abc@例.example>",
	])("refuses malformed %s in all three fields", async (id) => {
		for (const [value, claim] of [
			[input(), { ...stamp(), messageId: id }],
			[{ ...input(), inReplyTo: id }, stamp()],
			[{ ...input(), references: [id] }, stamp()],
		] as const)
			await expect(renderMime(value, claim)).rejects.toEqual(new MimeError("BAD_MESSAGE_ID"));
	});
});

describe("renderer limits and safe attachment types", () => {
	it.each([
		{ name: "ASCII", subject: `${"word ".repeat(3276)}tail` },
		{ name: "multibyte UTF-8", subject: `${"é ".repeat(5460)}tail` },
	])("pins the 16384-byte input limit with a foldable $name Subject", async ({ name, subject }) => {
		expect(Buffer.byteLength(subject, "utf8")).toBe(16_384);
		if (name === "multibyte UTF-8") expect(subject.length).toBeLessThan(16_384);
		const compile = vi.spyOn(MailComposer.prototype, "compile");
		const result = await renderMime({ ...input(), subject }, stamp());
		expect(compile).toHaveBeenCalledOnce();
		expect(result.subject === subject).toBe(true);
		expect(decodeHeader(getHeader(parseMessage(result.raw), "Subject") ?? "") === subject).toBe(
			true,
		);
		compile.mockClear();
		const tooLarge = `${subject}x`;
		expect(Buffer.byteLength(tooLarge, "utf8")).toBe(16_385);
		let refusal: unknown;
		try {
			await renderMime({ ...input(), subject: tooLarge }, stamp());
		} catch (error) {
			refusal = error;
		}
		expect(refusal).toEqual(new MimeError("TOO_LARGE"));
		expect(compile).not.toHaveBeenCalled();
	});
	it("refuses no recipients and accepts 500 before refusing recipient 501 across collections", async () => {
		await expect(renderMime({ ...input(), to: [], cc: [], bcc: [] }, stamp())).rejects.toEqual(
			new MimeError("NO_RECIPIENTS"),
		);
		const to = Array.from({ length: MAX_RECIPIENTS }, (_, at) => ({
			address: `r${at}@example.test`,
		}));
		const result = await renderMime({ ...input(), to }, stamp());
		expect(getHeader(parseMessage(result.raw), "To")?.match(/r\d+@example\.test/g)).toHaveLength(
			500,
		);
		for (const extra of [
			{ to: [...to, { address: "r0@example.test" }] },
			{ to, cc: [{ address: "r0@example.test" }] },
			{ to, bcc: [{ address: "r0@example.test" }] },
		])
			await expect(renderMime({ ...input(), ...extra }, stamp())).rejects.toEqual(
				new MimeError("TOO_MANY_RECIPIENTS"),
			);
	});
	it.each([
		"recipient @example.test",
		"a@example.test,b@example.test",
		"no-at-sign",
		"名@example.test",
	])("refuses a bad address: %s", async (address) => {
		await expect(renderMime({ ...input(), to: [{ address }] }, stamp())).rejects.toEqual(
			new MimeError("BAD_ADDRESS"),
		);
	});
	it("accepts 1000 references before refusing reference 1001", async () => {
		const references = Array.from({ length: MAX_REFERENCES }, (_, at) => `<r${at}@example.test>`);
		const result = await renderMime({ ...input(), references }, stamp());
		expect(
			getHeader(parseMessage(result.raw), "References")?.match(/<r\d+@example\.test>/g),
		).toHaveLength(1000);
		await expect(
			renderMime({ ...input(), references: [...references, "<r0@example.test>"] }, stamp()),
		).rejects.toEqual(new MimeError("TOO_MANY_REFERENCES"));
	});
	it("accepts 100 content attachments before refusing attachment 101", async () => {
		const attachments = Array.from({ length: MAX_ATTACHMENTS }, (_, at) => ({
			filename: `${at}.txt`,
			contentType: "text/plain",
			content: Buffer.from("x"),
		}));
		const result = await renderMime({ ...input(), attachments }, stamp());
		expect(parseMessage(result.raw).parts).toHaveLength(101);
		await expect(
			renderMime(
				{
					...input(),
					attachments: [
						...attachments,
						{ filename: "0.txt", contentType: "text/plain", content: Buffer.from("x") },
					],
				},
				stamp(),
			),
		).rejects.toEqual(new MimeError("TOO_MANY_ATTACHMENTS"));
	});
	it.each(["multipart/mixed", "Multipart/Related", "message/rfc822", "MESSAGE/partial"])(
		"refuses a %s attachment before composition",
		async (contentType) => {
			const compile = vi.spyOn(MailComposer.prototype, "compile");
			await expect(
				renderMime(
					{
						...input(),
						attachments: [{ filename: "payload.bin", contentType, content: Buffer.from("x") }],
					},
					stamp(),
				),
			).rejects.toEqual(new MimeError("BAD_ATTACHMENT"));
			expect(compile).not.toHaveBeenCalled();
		},
	);
	it("refuses unknown and non-ASCII List-* values", async () => {
		await expect(
			renderMime({ ...input(), list: { secret: "<https://example.test>" } } as MimeInput, stamp()),
		).rejects.toEqual(new MimeError("BAD_LIST_HEADER"));
		for (const key of listHeaders)
			await expect(
				renderMime({ ...input(), list: { [key]: "Café <example.test>" } }, stamp()),
			).rejects.toEqual(new MimeError("BAD_LIST_HEADER"));
	});
	it("refuses a MIME boundary collision before composition", async () => {
		const compile = vi.spyOn(MailComposer.prototype, "compile");
		await expect(
			renderMime({ ...input(), text: `--_NmP-${stamp().mimeBoundary}-Part_1\n` }, stamp()),
		).rejects.toEqual(new MimeError("BOUNDARY_COLLISION"));
		expect(compile).not.toHaveBeenCalled();
	});
	it("enforces 35 MiB after real base64 composition, not only the raw attachment input", async () => {
		const compile = vi.spyOn(MailComposer.prototype, "compile");
		const content = new Uint8Array(30_000_000);
		expect(content.length).toBeLessThan(MAX_BYTES);
		await expect(
			renderMime(
				{
					...input(),
					attachments: [
						{ filename: "large.bin", contentType: "application/octet-stream", content },
					],
				},
				stamp(),
			),
		).rejects.toEqual(new MimeError("TOO_LARGE"));
		expect(compile).toHaveBeenCalledOnce();
	});
	it.each(["Subject", "To", "List-Id"] as const)(
		"accepts an actual 998-octet %s line and refuses its 999-octet neighbor",
		async (field) => {
			const value = (length: number): MimeInput =>
				field === "Subject"
					? { ...input(), subject: "x".repeat(length) }
					: field === "To"
						? { ...input(), to: [{ address: "r@example.test", name: "x".repeat(length) }] }
						: { ...input(), list: { id: "x".repeat(length) } };
			const result = await renderMime(value(997), stamp());
			const lines = result.raw.toString("latin1").split("\r\n");
			expect(Math.max(...lines.map((line) => line.length))).toBe(MAX_LINE_BYTES);
			expect(getHeader(parseMessage(result.raw), field)).toContain("x".repeat(997));
			await expect(renderMime(value(998), stamp())).rejects.toEqual(new MimeError("LINE_TOO_LONG"));
		},
	);
});

describe("Bcc waits for the transport decision", () => {
	it("refuses nonempty Bcc before constructing a MIME message", async () => {
		const compile = vi.spyOn(MailComposer.prototype, "compile");
		for (const to of [input().to, []]) {
			await expect(
				renderMime({ ...input(), to, bcc: [{ address: "archive@example.test" }] }, stamp()),
			).rejects.toEqual(new MimeError("BCC_UNAVAILABLE"));
		}
		expect(compile).not.toHaveBeenCalled();
	});
	it("accepts an empty Bcc list without emitting a Bcc header", async () => {
		const result = await renderMime({ ...input(), bcc: [] }, stamp());
		expect(getHeader(parseMessage(result.raw), "Bcc")).toBeUndefined();
	});
});
