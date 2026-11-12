import { DraftContent } from "@draftyak/protocol/entities/draft";
import { jcsSha256 } from "@draftyak/protocol/hash";
import { expect, it } from "vitest";
import { normalizeDraftBody, normalizeDraftContent } from "../../src/drafts/normalize.ts";

const attachment = {
	blobId: "01JC0000000000000000000001",
	filename: "DYTEST-report.txt",
	contentType: "text/plain",
	size: 12,
	sha256: "ab".repeat(32),
};
const email = (body = "DYTEST-text") => ({
	channel: "email" as const,
	to: ["recipient@example.test"],
	cc: [],
	bcc: [],
	subject: "DYTEST-review",
	body,
	attachments: [attachment],
});

it("normalizes CRLF, lone CR and NFC without trimming or cleaning draft text", () => {
	const raw = " Cafe\u0301\r\nfirst\rsecond\n\t\0\u202e\u200b ";
	const expected = " Café\nfirst\nsecond\n\t\0\u202e\u200b ";
	expect(normalizeDraftBody(raw)).toBe(expected);
	expect(normalizeDraftContent(email(raw))).toEqual({ ...email(), body: expected });
	expect(normalizeDraftBody(expected)).toBe(expected);
});

it("normalizes chat bodies without changing thread and broadcast facts", () => {
	const input = { channel: "chat", threadTs: "123.456", broadcast: true, body: "e\u0301\r" };
	expect(normalizeDraftContent(input)).toEqual({ ...input, body: "é\n" });
	expect(normalizeDraftContent({ ...input, threadTs: null, broadcast: false })).toEqual({
		...input,
		threadTs: null,
		broadcast: false,
		body: "é\n",
	});
});

it.each([
	["TEXT/PLAIN; charset=UTF-8", "text/plain"],
	["  Application/PDF ; parameter=value", "application/pdf"],
	["image/SVG+xml", "image/svg+xml"],
	["not a media type", "application/octet-stream"],
	["", "application/octet-stream"],
	["text/plain\r\nDYTEST-header:value", "application/octet-stream"],
	[null, "application/octet-stream"],
	[undefined, "application/octet-stream"],
	[42, "application/octet-stream"],
])("normalizes attachment media type %j while preserving file metadata", (type, expected) => {
	const input = { ...email(), attachments: [{ ...attachment, contentType: type }] };
	const output = normalizeDraftContent(input);
	expect(output).toEqual({
		...email(),
		attachments: [{ ...attachment, contentType: expected }],
	});
	expect(input.attachments[0]?.contentType).toBe(type);
	expect(DraftContent.safeParse(output).success).toBe(true);
});

it("does not coerce unreadable media values or replace accessors with the fallback", () => {
	let calls = 0;
	const contentType = {
		toString() {
			calls++;
			throw new Error("DYTEST-private-value");
		},
	};
	expect(
		normalizeDraftContent({ ...email(), attachments: [{ ...attachment, contentType }] }),
	).toEqual({
		...email(),
		attachments: [{ ...attachment, contentType: "application/octet-stream" }],
	});
	expect(calls).toBe(0);
	const accessor = { ...attachment };
	Object.defineProperty(accessor, "contentType", {
		get() {
			calls++;
			return "text/plain";
		},
	});
	expect(() => normalizeDraftContent({ ...email(), attachments: [accessor] })).toThrow(
		"Draft content refused.",
	);
	expect(calls).toBe(0);
});

it("refuses hidden fields and array elements instead of copying them into JSON data", () => {
	const hidden = email();
	Object.defineProperty(hidden, "subject", { enumerable: false });
	expect(() => normalizeDraftContent(hidden)).toThrow("Draft content refused.");
	const addresses = ["recipient@example.test"];
	Object.defineProperty(addresses, "0", { enumerable: false });
	expect(() => normalizeDraftContent({ ...email(), to: addresses })).toThrow(
		"Draft content refused.",
	);
});

it.each(["\r", "\n", "\r\n"])("refuses rather than folds one-line field breaks %j", (line) => {
	expect(() => normalizeDraftContent({ ...email(), subject: `DYTEST${line}subject` })).toThrow(
		"Draft content refused.",
	);
	expect(() =>
		normalizeDraftContent({
			...email(),
			attachments: [{ ...attachment, filename: `DYTEST${line}name` }],
		}),
	).toThrow("Draft content refused.");
});

it("keeps the separate raw body UTF-16 budget inclusive", () => {
	expect(normalizeDraftBody("x".repeat(400_000))).toHaveLength(400_000);
	expect(normalizeDraftBody("🦬".repeat(200_000))).toHaveLength(400_000);
	expect(() => normalizeDraftBody("x".repeat(400_001))).toThrow("Draft content refused.");
	expect(() => normalizeDraftBody(`${"🦬".repeat(200_000)}x`)).toThrow("Draft content refused.");
	expect(() => normalizeDraftContent(email("x".repeat(400_000)))).toThrow();
});

it.each([null, undefined, 1, true, {}, [], Object("DYTEST-text"), "\ud800", "x\udfffy"])(
	"refuses body input without conversion or replacement %j",
	(body) => {
		expect(() => normalizeDraftBody(body as string)).toThrow("Draft content refused.");
		expect(() => normalizeDraftContent({ ...email(), body })).toThrow("Draft content refused.");
	},
);

it("retains shared schema refusal and content-free errors for malformed content", () => {
	const invalid: unknown[] = [
		null,
		[],
		{ ...email(), channel: "sms" },
		{ ...email(), extra: "DYTEST-private-value" },
		{ ...email(), subject: 17 },
		{ ...email(), to: ["DYTEST-bad-address"] },
		{ ...email(), attachments: [{ ...attachment, sha256: "AB".repeat(32) }] },
		{ ...email(), attachments: [{ ...attachment, size: Number.MAX_SAFE_INTEGER + 1 }] },
		{ channel: "chat", body: "DYTEST", threadTs: null, broadcast: true },
		{ channel: "chat", body: "DYTEST", threadTs: "", broadcast: false },
	];
	for (const input of invalid)
		expect(() => normalizeDraftContent(input)).toThrow(/^Draft content refused\.$/);
});

it("normalizes before canonical hashing and remains idempotent", () => {
	const nfd = email("Cafe\u0301\r\nDYTEST"),
		nfc = email("Café\nDYTEST");
	const output = normalizeDraftContent(nfd);
	expect(output).toEqual(nfc);
	expect(jcsSha256(output)).toBe(jcsSha256(normalizeDraftContent(nfc)));
	expect(normalizeDraftContent(output)).toEqual(output);
});
