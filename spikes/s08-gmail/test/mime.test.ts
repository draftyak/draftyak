import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import * as nodemailerErrors from "nodemailer/lib/errors";
import MailComposer from "nodemailer/lib/mail-composer";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	composerOptions,
	decodeWords,
	MAX_RECIPIENTS,
	MimeError,
	type MimeInput,
	newClaimStamp,
	normalizeAddresses,
	normalizeSubject,
	renderMime,
	textSha256,
} from "../src/mime.ts";
import { GOLDEN_NODEMAILER, goldenCases, goldenDir } from "./golden.ts";
import { decodeHeader, getHeader, parseMessage } from "./mime-parse.ts";

const require = createRequire(import.meta.url);
const spikeDir = path.join(import.meta.dirname, "..");
const golden = (name: string): Buffer => readFileSync(path.join(goldenDir, `${name}.eml`));
const base = goldenCases["reply-ascii"] ?? (undefined as never);

afterEach(() => {
	vi.restoreAllMocks();
});

describe("golden MIME files", () => {
	it("were generated on the installed nodemailer, 10.1.2", () => {
		const manifest = JSON.parse(readFileSync(require.resolve("nodemailer/package.json"), "utf8"));
		expect(manifest.version).toBe(GOLDEN_NODEMAILER);
	});

	for (const [name, { input, stamp }] of Object.entries(goldenCases)) {
		it(`${name}.eml matches byte for byte`, async () => {
			const { raw } = await renderMime(input, stamp);
			expect(raw.toString("latin1")).toBe(golden(name).toString("latin1"));
		});

		it(`${name}.eml is CRLF, 7-bit headers and reads back to the input`, () => {
			const file = golden(name);
			expect(file.toString("latin1").replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
			const head = file.subarray(0, file.indexOf("\r\n\r\n")).toString("latin1");
			for (const line of head.split("\r\n")) {
				expect(line).toMatch(/^[\x20-\x7e]{1,998}$/);
			}
			const message = parseMessage(file);
			expect(decodeHeader(getHeader(message, "Subject") ?? "")).toBe(input.subject);
			expect(getHeader(message, "Message-ID")).toBe(stamp.messageId);
			expect(Date.parse(getHeader(message, "Date") ?? "")).toBe(stamp.date.getTime());
			const text = message.parts.length === 0 ? message : message.parts[0];
			expect(text?.body.toString("utf8").replace(/\r\n/g, "\n")).toBe(input.text);
		});
	}

	it("carries Bcc for Gmail and encodes non-ASCII names and filenames", () => {
		const message = parseMessage(golden("new-with-attachment"));
		expect(getHeader(message, "Bcc")).toBe("archive@example.com");
		expect(message.parts[1]?.filename).toBe("Übersicht März.txt");
		const unicode = parseMessage(golden("reply-unicode"));
		expect(decodeHeader(getHeader(unicode, "To") ?? "")).toBe("Zoë Ångström <zoe@example.org>");
		expect(normalizeSubject(getHeader(unicode, "Subject"))).toBe(
			goldenCases["reply-unicode"]?.input.subject,
		);
	});
});

describe("renderMime", () => {
	it("stamps the hub's own Message-ID and Date, once each", async () => {
		const stamp = newClaimStamp("owner@Example.com", Date.parse("2026-10-17T12:34:56.789Z"));
		expect(stamp.messageId).toMatch(/^<[0-9a-f]{32}@example\.com>$/);
		expect(stamp.date.toISOString()).toBe("2026-10-17T12:34:56.000Z");
		expect(stamp.baseBoundary).toMatch(/^[0-9a-f]{24}$/);
		expect(newClaimStamp("owner@example.com").messageId).not.toBe(stamp.messageId);
		const { raw, stamp: used } = await renderMime(base.input, stamp);
		const head = raw.subarray(0, raw.indexOf("\r\n\r\n")).toString("latin1");
		expect(head.match(/^Message-ID: .*$/gim)).toEqual([`Message-ID: ${stamp.messageId}`]);
		expect(head.match(/^Date: .*$/gim)).toEqual(["Date: Sat, 17 Oct 2026 12:34:56 +0000"]);
		expect(used).toBe(stamp);
	});

	it("returns what reconcile needs: normalized To and Cc, the subject and the body hash", async () => {
		const rendered = await renderMime(base.input, base.stamp);
		expect(rendered.to).toEqual(["alice@example.org"]);
		expect(rendered.cc).toEqual(["carol@example.net"]);
		expect(rendered.subject).toBe("Re: Lunch on Thursday");
		expect(rendered.textSha256).toBe(textSha256(base.input.text));
	});

	const crlf: [string, Partial<MimeInput>, string][] = [
		["Subject with CRLF", { subject: "Lunch\r\nBcc: eve@example.net" }, "subject"],
		["Subject with LF", { subject: "Lunch\nBcc: eve@example.net" }, "subject"],
		["Subject with CR", { subject: "Lunch\rX-Injected: 1" }, "subject"],
		[
			"List-Unsubscribe with CRLF",
			{ list: { unsubscribe: "<mailto:a@example.org>\r\nBcc: eve@example.net" } },
			"List-unsubscribe",
		],
		["List-Id with LF", { list: { id: "club\n<club.example.org>" } }, "List-id"],
		["List-Post with CR", { list: { post: "<mailto:a@example.org>\r" } }, "List-post"],
		[
			"a display name with LF",
			{ to: [{ name: "Alice\nBcc: eve@example.net", address: "alice@example.org" }] },
			"to",
		],
	];
	for (const [label, change, field] of crlf) {
		it(`refuses ${label} before MailComposer runs`, async () => {
			const compile = vi.spyOn(MailComposer.prototype, "compile");
			const input = { ...base.input, ...change };
			await expect(renderMime(input, base.stamp)).rejects.toMatchObject({
				name: "MimeError",
				code: "HEADER_CRLF",
				field,
			});
			expect(compile).not.toHaveBeenCalled();
		});
	}

	it("(MailComposer alone would turn a line break into a space and send other text)", async () => {
		const options = composerOptions(
			{ ...base.input, subject: "Lunch\r\nBcc: eve@example.net" },
			base.stamp,
		);
		const raw = (await new MailComposer(options).compile().build()).toString("latin1");
		expect(raw).toContain("Subject: Lunch Bcc: eve@example.net\r\n");
		expect(raw).not.toMatch(/^Bcc:/m);
	});

	const refused: [string, Partial<MimeInput>, string][] = [
		["a NUL in the subject", { subject: "a\u0000b" }, "HEADER_CONTROL"],
		["an address with a space", { to: [{ address: "alice @example.org" }] }, "BAD_ADDRESS"],
		[
			"an address with a comma",
			{ cc: [{ address: "a@example.org,eve@example.net" }] },
			"BAD_ADDRESS",
		],
		["no recipient", { to: [], cc: [] }, "NO_RECIPIENTS"],
		["a bad In-Reply-To", { inReplyTo: "thread-2@example.org" }, "BAD_MESSAGE_ID"],
		["a bad References entry", { references: ["<a b@example.org>"] }, "BAD_MESSAGE_ID"],
		["an unknown List-* name", { list: { secret: "<https://example.org>" } }, "BAD_LIST_HEADER"],
		["a non-ASCII List-* value", { list: { id: "Café <club.example.org>" } }, "BAD_LIST_HEADER"],
	];
	for (const [label, change, code] of refused) {
		it(`refuses ${label} (${code})`, async () => {
			await expect(renderMime({ ...base.input, ...change }, base.stamp)).rejects.toMatchObject({
				code,
			});
		});
	}

	it("refuses attachments read from a path or a URL, and other content", async () => {
		const bytes = new TextEncoder().encode("PAYLOAD-123\nline2\n");
		const sources = [
			{ filename: "a.txt", contentType: "text/plain", path: "C:/Windows/win.ini" },
			{ filename: "a.txt", contentType: "text/plain", href: "https://example.org/a.txt" },
			{ filename: "a.txt", contentType: "text/plain", content: "not bytes" },
			{ filename: "a.txt", contentType: "text/plain;\r\nx", content: new Uint8Array(1) },
			{ filename: "a.bin", contentType: "multipart/mixed", content: bytes },
			{ filename: "a.bin", contentType: "Multipart/Related", content: bytes },
			{ filename: "a.eml", contentType: "message/rfc822", content: bytes },
		];
		for (const attachment of sources) {
			const input = { ...base.input, attachments: [attachment] } as unknown as MimeInput;
			await expect(renderMime(input, base.stamp), attachment.contentType).rejects.toBeInstanceOf(
				MimeError,
			);
		}
	});

	it("refuses a header line over 998 characters, which MailComposer can't fold", async () => {
		const cases: [Partial<MimeInput>, string][] = [
			[{ subject: "x".repeat(2000) }, "Subject"],
			[{ list: { id: "y".repeat(998) } }, "List-ID"],
			[{ to: [{ address: `${"z".repeat(990)}@example.org` }] }, "To"],
		];
		for (const [change, field] of cases) {
			await expect(renderMime({ ...base.input, ...change }, base.stamp)).rejects.toMatchObject({
				code: "LINE_TOO_LONG",
				field,
			});
		}
		const words = Array.from({ length: 300 }, (_, index) => `word${index}`).join(" ");
		const { raw } = await renderMime({ ...base.input, subject: words }, base.stamp);
		expect(
			raw
				.toString("latin1")
				.split("\r\n")
				.every((line) => line.length <= 998),
		).toBe(true);
	});

	it("keeps to 500 recipients and 35 MB", async () => {
		const many = Array.from({ length: MAX_RECIPIENTS }, (_, i) => ({
			address: `r${i}@example.org`,
		}));
		await expect(
			renderMime({ ...base.input, to: many, cc: [] }, base.stamp),
		).resolves.toBeDefined();
		await expect(
			renderMime({ ...base.input, to: many, cc: [{ address: "one@example.org" }] }, base.stamp),
		).rejects.toMatchObject({ code: "TOO_MANY_RECIPIENTS" });
		const big = {
			filename: "big.bin",
			contentType: "application/octet-stream",
			content: new Uint8Array(36_700_161),
		};
		await expect(
			renderMime({ ...base.input, attachments: [big] }, base.stamp),
		).rejects.toMatchObject({
			code: "TOO_LARGE",
		});
		const near = { ...big, content: new Uint8Array(30_000_000) };
		await expect(
			renderMime({ ...base.input, attachments: [near] }, base.stamp),
		).rejects.toMatchObject({
			code: "TOO_LARGE",
		});
	});

	it("refuses a malformed claim stamp", async () => {
		const bad = [
			{ ...base.stamp, messageId: "no-brackets@example.com" },
			{ ...base.stamp, baseBoundary: "short" },
			{ ...base.stamp, date: new Date(Number.NaN) },
		];
		for (const stamp of bad)
			await expect(renderMime(base.input, stamp)).rejects.toBeInstanceOf(MimeError);
	});
});

describe("nodemailer 10.1.2 as the hub uses it (V1)", () => {
	it("loads the ESM build for this ESM package, and the CJS build writes the same bytes", async () => {
		const resolved = execFileSync(
			process.execPath,
			[
				"--input-type=module",
				"-e",
				"console.log(import.meta.resolve('nodemailer/lib/mail-composer'))",
			],
			{ cwd: spikeDir, encoding: "utf8" },
		).trim();
		expect(resolved).toMatch(/\/nodemailer\/dist\/esm\/mail-composer\/index\.js$/);
		expect(require.resolve("nodemailer/lib/mail-composer")).toMatch(/[\\/]dist[\\/]cjs[\\/]/);
		const Cjs = require("nodemailer/lib/mail-composer") as typeof MailComposer;
		expect(Cjs).not.toBe(MailComposer);
		for (const [name, { input, stamp }] of Object.entries(goldenCases)) {
			const node = new Cjs(composerOptions(input, stamp)).compile();
			node.keepBcc = true;
			expect((await node.build()).equals(golden(name)), name).toBe(true);
		}
	});

	it("names the missing-credentials error ENOAUTH (NoAuth before 8.0.0)", () => {
		expect(nodemailerErrors.ENOAUTH).toBe("ENOAUTH");
		expect(Object.keys(nodemailerErrors.ERROR_CODES)).toContain("ENOAUTH");
		expect("NoAuth" in nodemailerErrors).toBe(false);
	});

	it("never reads a file or fetches a URL for the hub's messages", async () => {
		const options = composerOptions(base.input, base.stamp);
		expect(options).toMatchObject({ disableFileAccess: true, disableUrlAccess: true });
		const attempts = [
			[{ filename: "a.txt", href: "https://example.org/a.txt" }, nodemailerErrors.EURLACCESS],
			[
				{ filename: "a.txt", path: path.join(spikeDir, "package.json") },
				nodemailerErrors.EFILEACCESS,
			],
		] as const;
		for (const [attachment, code] of attempts) {
			const composer = new MailComposer({ ...options, attachments: [attachment] });
			await expect(composer.compile().build()).rejects.toMatchObject({ code });
		}
	});
});

describe("normalization for reconcile", () => {
	it("decodes RFC 2047 words, joining adjacent ones", () => {
		expect(decodeWords("Re: =?UTF-8?Q?Caf=C3=A9?= at noon")).toBe("Re: Café at noon");
		expect(decodeWords("=?UTF-8?Q?=C3?= =?UTF-8?Q?=A9?=")).toBe("é");
		expect(decodeWords("=?utf-8?b?R3LDvMOfZQ==?=")).toBe("Grüße");
		expect(decodeWords("=?ISO-8859-1?Q?Gr=FC=DFe?= aus")).toBe("Grüße aus");
		expect(decodeWords("plain =? text")).toBe("plain =? text");
	});

	it("compares subjects after decoding and folding", () => {
		const head = golden("reply-unicode").toString("latin1");
		const folded = /^Subject: (.*(?:\r\n .*)*)$/m.exec(head)?.[1] ?? "";
		expect(normalizeSubject(folded)).toBe(goldenCases["reply-unicode"]?.input.subject);
		expect(normalizeSubject("  Re:   Lunch \t on Thursday ")).toBe("Re: Lunch on Thursday");
	});

	it("compares addresses without names, case or order", () => {
		expect(
			normalizeAddresses('"Alice" <ALICE@Example.org>, bob@example.org, alice@example.org'),
		).toEqual(["alice@example.org", "bob@example.org"]);
		expect(normalizeAddresses("Team: a@example.org, b@example.org;")).toEqual([
			"a@example.org",
			"b@example.org",
		]);
		expect(normalizeAddresses(undefined)).toEqual([]);
	});

	it("writes internationalized domains in ASCII, as MailComposer sends them", () => {
		expect(
			normalizeAddresses(["hans@bücher.example", "Jürgen <j@MÜNCHEN.example>", "a@[192.0.2.1]"]),
		).toEqual(["a@[192.0.2.1]", "hans@xn--bcher-kva.example", "j@xn--mnchen-3ya.example"]);
		expect(normalizeAddresses("hans@xn--bcher-kva.example")).toEqual([
			"hans@xn--bcher-kva.example",
		]);
	});

	it("hashes the body without line-ending or trailing-newline differences", () => {
		expect(textSha256("a\r\nb\r\n")).toBe(textSha256("a\nb"));
		expect(textSha256("a\nb\n\n")).toBe(textSha256("a\nb"));
		expect(textSha256("a\nb ")).not.toBe(textSha256("a\nb"));
		expect(textSha256("a\n\nb")).not.toBe(textSha256("a\nb"));
	});
});
