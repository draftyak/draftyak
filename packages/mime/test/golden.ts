import path from "node:path";
import type { ClaimStamp, MimeInput } from "../src/index.ts";

// The golden MIME cases. Regenerate with `node test/make-golden.ts` from packages/mime, only
// after a deliberate nodemailer bump, and review the diff: the files were generated on 10.1.2.
export const GOLDEN_NODEMAILER = "10.1.2";
export const goldenDir: string = path.join(import.meta.dirname, "fixtures");

const stamp = (n: number): ClaimStamp => ({
	messageId: `<golden-${n}.4f2a9c1e@example.com>`,
	dateMs: Date.parse("2026-10-17T12:00:00Z"),
	mimeBoundary: "0123456789abcdef01234567",
	uploadBoundary: "draftyak_upload_0123456789abcdef",
});

const owner = { name: "Owner Example", address: "owner@example.com" };

export const goldenCases: Readonly<Record<string, { input: MimeInput; stamp: ClaimStamp }>> = {
	"reply-ascii": {
		input: {
			from: owner,
			to: [{ name: "Alice Example", address: "alice@example.org" }],
			cc: [{ address: "carol@example.net" }],
			subject: "Re: Lunch on Thursday",
			text: "Hi Alice,\n\nThursday at noon works for me.\n\nOwner\n",
			inReplyTo: "<thread-2@example.org>",
			references: ["<thread-1@example.org>", "<thread-2@example.org>"],
		},
		stamp: stamp(1),
	},
	"reply-unicode": {
		input: {
			from: { name: "Ówner Exämple", address: "owner@example.com" },
			to: [{ name: "Zoë Ångström", address: "zoe@example.org" }],
			subject:
				"Re: Café au lait – a long subject that MailComposer has to fold across several header lines",
			text: "Grüße aus Köln 👋\n\nDer Termin am Donnerstag passt — bis dann.\n\n— Ówner\n",
			inReplyTo: "<thread-9@example.org>",
			references: ["<thread-9@example.org>"],
		},
		stamp: stamp(2),
	},
	"new-with-attachment": {
		input: {
			from: owner,
			to: [{ name: 'Bob, the "Builder"', address: "bob@example.org" }],
			bcc: [{ address: "archive@example.com" }],
			subject: "Notes from today",
			text: "The notes are attached.\n",
			attachments: [
				{
					filename: "Übersicht März.txt",
					contentType: "text/plain",
					content: new TextEncoder().encode("line 1\nline 2\n"),
				},
			],
		},
		stamp: stamp(3),
	},
	"list-headers": {
		input: {
			from: owner,
			to: [{ address: "members@example.org" }],
			subject: "Club update",
			text: "Meeting moved to Friday.\n",
			list: {
				id: "Example club <club.example.org>",
				unsubscribe: "<mailto:leave@example.org?subject=unsubscribe>",
				"unsubscribe-post": "List-Unsubscribe=One-Click",
			},
		},
		stamp: stamp(4),
	},
};
