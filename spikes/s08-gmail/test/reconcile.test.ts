import { afterEach, describe, expect, it } from "vitest";
import { Gmail, type MessagePart } from "../src/api.ts";
import { type MimeInput, newClaimStamp, type Rendered, renderMime } from "../src/mime.ts";
import { GMAIL_MODIFY } from "../src/oauth.ts";
import {
	type Attempt,
	afterReconcile,
	countsAsSent,
	plainText,
	reconcile,
} from "../src/reconcile.ts";
import { sendMessage } from "../src/send.ts";
import { type FakeGmail, type FakeGmailOptions, startFakeGmail } from "./fake-gmail.ts";
import { TokenRegistry } from "./fake-google-oauth.ts";

const owner = { name: "Owner Example", address: "owner@example.com" };
const alice = { name: "Alice Example", address: "alice@example.org" };
const carol = { address: "carol@example.net" };

const reply: MimeInput = {
	from: owner,
	to: [alice],
	cc: [carol],
	subject: "Re: Lunch on Thursday",
	text: "Thursday at noon works for me.\n",
	inReplyTo: "<thread-2@example.org>",
	references: ["<thread-2@example.org>"],
};

let fake: FakeGmail | undefined;

async function setup(options: Partial<FakeGmailOptions> = {}) {
	const tokens = new TokenRegistry();
	fake = await startFakeGmail({ tokens, ...options });
	const gmail = new Gmail({
		accessToken: tokens.grant([GMAIL_MODIFY]).accessToken,
		root: fake.url,
	});
	const inbound = await renderMime(
		{ from: alice, to: [owner], cc: [carol], subject: "Lunch on Thursday", text: "Thursday?\n" },
		{ ...newClaimStamp(alice.address), messageId: "<thread-2@example.org>" },
	);
	const { threadId } = fake.insert(inbound.raw, ["INBOX"], {
		internalDate: Date.now() - 86_400_000,
	});
	return { fake, gmail, threadId };
}

const render = (input: MimeInput): Promise<Rendered> =>
	renderMime(input, newClaimStamp(owner.address));
const raw = async (input: MimeInput): Promise<Buffer> => (await render(input)).raw;

const attemptOf = (
	rendered: Rendered,
	threadId: string | undefined,
	attemptedAt: number,
): Attempt => ({
	messageId: rendered.stamp.messageId,
	...(threadId === undefined ? {} : { threadId }),
	to: rendered.to,
	cc: rendered.cc,
	subject: rendered.subject,
	textSha256: rendered.textSha256,
	attemptedAt,
});

afterEach(async () => {
	if (fake === undefined) return;
	expect(fake.violations).toEqual([]);
	expect(fake.unimplemented).toEqual([]);
	await fake.close();
	fake = undefined;
});

describe("reconcile", () => {
	it("finds the message by rfc822msgid: when Gmail keeps our Message-ID", async () => {
		const { fake, gmail, threadId } = await setup({ messageIdPolicy: "keep" });
		const attemptedAt = Date.now();
		const rendered = await render(reply);
		const sent = await sendMessage(gmail, rendered, { threadId });
		const result = await reconcile(gmail, attemptOf(rendered, threadId, attemptedAt));
		expect(result).toEqual({ status: "sent", id: sent.id, threadId, via: "rfc822msgid" });
		expect(fake.calls.slice(-2)).toEqual(["gmail.users.messages.list", "gmail.users.messages.get"]);
	});

	it("never takes a scheduled or draft copy with our Message-ID as sent", async () => {
		for (const labels of [["SENT", "SCHEDULED"], ["DRAFT"]]) {
			const { fake, gmail, threadId } = await setup({ messageIdPolicy: "keep" });
			const attemptedAt = Date.now();
			const rendered = await render(reply);
			fake.insert(rendered.raw, labels, { threadId, internalDate: attemptedAt + 1000 });
			const result = await reconcile(gmail, attemptOf(rendered, threadId, attemptedAt));
			expect(result, labels.join()).toMatchObject({ status: "not_found", complete: true });
			expect(fake.searches[0]).toBe(`rfc822msgid:${rendered.stamp.messageId.slice(1, -1)}`);
			expect(fake.violations).toEqual([]);
			await fake.close();
		}
		fake = undefined;
	});

	it("falls back to in:sent and picks only the right message among decoys", async () => {
		const { fake, gmail, threadId } = await setup({ messageIdPolicy: "replace" });
		const attemptedAt = Date.now();
		const later = { threadId, internalDate: attemptedAt + 1000 };
		const decoys: [
			string,
			Promise<Buffer>,
			string[],
			{ threadId?: string; internalDate: number },
		][] = [
			[
				"an earlier revision (other body)",
				raw({ ...reply, text: "Thursday works.\n" }),
				["SENT"],
				later,
			],
			[
				"the same mail in another thread",
				raw(reply),
				["SENT"],
				{ internalDate: later.internalDate },
			],
			[
				"an extra To recipient",
				raw({ ...reply, to: [alice, { address: "dave@example.org" }] }),
				["SENT"],
				later,
			],
			["no Cc", raw({ ...reply, cc: [] }), ["SENT"], later],
			[
				"sent before the attempt",
				raw(reply),
				["SENT"],
				{ threadId, internalDate: attemptedAt - 600_000 },
			],
			["scheduled in the Gmail web UI", raw(reply), ["SENT", "SCHEDULED"], later],
			["a draft", raw(reply), ["DRAFT"], later],
			["another subject", raw({ ...reply, subject: "Re: Lunch on Thursday?" }), ["SENT"], later],
		];
		const decoyIds: string[] = [];
		for (const [, bytes, labels, place] of decoys)
			decoyIds.push(fake.insert(await bytes, labels, place).id);
		const rendered = await render(reply);
		const sent = await sendMessage(gmail, rendered, { threadId });
		expect(sent.messageIdKept).toBe(false);
		const result = await reconcile(gmail, attemptOf(rendered, threadId, attemptedAt));
		expect(result).toEqual({ status: "sent", id: sent.id, threadId, via: "fallback" });
		expect(decoyIds).not.toContain(sent.id);
	});

	it("searches in:sent from two minutes before the attempt", async () => {
		const { fake, gmail, threadId } = await setup({ messageIdPolicy: "replace" });
		const attemptedAt = Date.parse("2026-10-17T12:00:30.500Z");
		const rendered = await render(reply);
		await reconcile(gmail, attemptOf(rendered, threadId, attemptedAt));
		expect(fake.searches).toEqual([
			`rfc822msgid:${rendered.stamp.messageId.slice(1, -1)}`,
			`in:sent after:${Date.parse("2026-10-17T11:58:30Z") / 1000}`,
		]);
	});

	it("checks the time itself where Gmail's after: is coarser", async () => {
		const { fake, gmail, threadId } = await setup({
			messageIdPolicy: "replace",
			searchAfter: "day",
		});
		const attemptedAt = Date.now();
		const rendered = await render(reply);
		const early = fake.insert(await raw(reply), ["SENT"], {
			threadId,
			internalDate: attemptedAt - 130_000,
		});
		const sent = await sendMessage(gmail, rendered, { threadId });
		const result = await reconcile(gmail, attemptOf(rendered, threadId, attemptedAt));
		expect(result).toEqual({ status: "sent", id: sent.id, threadId, via: "fallback" });
		expect(result.status === "sent" && result.id).not.toBe(early.id);
	});

	it("returns not_found among decoys alone, so the item goes to re-approval, never a resend", async () => {
		const { fake, gmail, threadId } = await setup({ messageIdPolicy: "replace" });
		const attemptedAt = Date.now();
		const later = { threadId, internalDate: attemptedAt + 1000 };
		fake.insert(await raw({ ...reply, text: "Thursday works.\n" }), ["SENT"], later);
		fake.insert(await raw(reply), ["SENT", "SCHEDULED"], later);
		fake.insert(await raw(reply), ["SCHEDULED"], later);
		const rendered = await render(reply);
		const result = await reconcile(gmail, attemptOf(rendered, threadId, attemptedAt));
		expect(result).toEqual({ status: "not_found", scanned: 2, complete: true });
		expect(fake.calls).not.toContain("gmail.users.messages.send");
	});

	it("finds a reply Gmail moved to a new thread, never a copy in an older one", async () => {
		const { fake, gmail, threadId } = await setup({ messageIdPolicy: "replace" });
		const attemptedAt = Date.now();
		const edited = { ...reply, subject: "Lunch moved to Friday" };
		const older = fake.insert(await raw(edited), ["SENT"], {
			internalDate: attemptedAt - 86_400_000,
		});
		fake.insert(await raw(edited), ["SENT"], {
			threadId: older.threadId,
			internalDate: attemptedAt + 500,
		});
		const rendered = await render(edited);
		const sent = await sendMessage(gmail, rendered, { threadId });
		expect(sent.threadKept).toBe(false);
		const result = await reconcile(gmail, attemptOf(rendered, threadId, attemptedAt));
		expect(result).toEqual({
			status: "sent",
			id: sent.id,
			threadId: sent.threadId,
			via: "fallback",
		});
		expect(fake.calls.filter((id) => id === "gmail.users.threads.get")).toHaveLength(2);
	});

	it("matches recipients on internationalized domains, as MailComposer writes them", async () => {
		for (const headerValues of ["decoded", "raw"] as const) {
			const { fake, gmail } = await setup({ messageIdPolicy: "replace", headerValues });
			const attemptedAt = Date.now();
			const input: MimeInput = {
				from: owner,
				to: [{ address: "hans@bücher.example" }],
				cc: [{ name: "Jürgen", address: "j@MÜNCHEN.example" }],
				subject: "Termin",
				text: "Freitag?\n",
			};
			const rendered = await render(input);
			expect(rendered.raw.toString("latin1")).toContain("To: hans@xn--bcher-kva.example\r\n");
			expect(rendered.to).toEqual(["hans@xn--bcher-kva.example"]);
			const sent = await sendMessage(gmail, rendered);
			const result = await reconcile(gmail, attemptOf(rendered, undefined, attemptedAt));
			expect(result, headerValues).toMatchObject({ status: "sent", id: sent.id, via: "fallback" });
			expect(fake.violations).toEqual([]);
			await fake.close();
		}
		fake = undefined;
	});

	it("can miss a send Gmail hasn't indexed yet, so a not_found is worth repeating", async () => {
		let clock = Date.now();
		const { fake, gmail, threadId } = await setup({ searchLagMs: 5_000, now: () => clock });
		const attemptedAt = clock;
		const rendered = await render(reply);
		const sent = await sendMessage(gmail, rendered, { threadId });
		const attempt = attemptOf(rendered, threadId, attemptedAt);
		expect(await reconcile(gmail, attempt)).toEqual({
			status: "not_found",
			scanned: 0,
			complete: true,
		});
		clock += 5_000;
		expect(await reconcile(gmail, attempt)).toEqual({
			status: "sent",
			id: sent.id,
			threadId,
			via: "rfc822msgid",
		});
		expect(fake.violations).toEqual([]);
	});

	it("matches through display names, address case and encoded subjects", async () => {
		const { fake, gmail, threadId } = await setup({ headerValues: "raw" });
		const attemptedAt = Date.now();
		const unicode = { ...reply, subject: "Re: Café au lait – Donnerstag", text: "Grüße 👋\n" };
		const rendered = await render(unicode);
		const variant = await raw({
			...unicode,
			to: [{ name: "A. Example", address: "ALICE@Example.ORG" }],
			cc: [{ name: "Carol", address: "Carol@example.net" }],
		});
		const stored = fake.insert(variant, ["SENT"], { threadId, internalDate: attemptedAt + 500 });
		const result = await reconcile(gmail, attemptOf(rendered, threadId, attemptedAt));
		expect(result).toEqual({ status: "sent", id: stored.id, threadId, via: "fallback" });
	});

	it("reads only same-thread candidates and follows the pages", async () => {
		const { fake, gmail, threadId } = await setup({ messageIdPolicy: "replace" });
		const attemptedAt = Date.now();
		const rendered = await render(reply);
		const sent = await sendMessage(gmail, rendered, { threadId });
		const other = await raw({ ...reply, subject: "Elsewhere" });
		for (let index = 1; index <= 120; index++) {
			fake.insert(other, ["SENT"], { internalDate: attemptedAt + 10_000 + index });
		}
		const before = fake.calls.length;
		const attempt = attemptOf(rendered, threadId, attemptedAt);
		const result = await reconcile(gmail, attempt, { byMessageId: false });
		expect(result).toEqual({ status: "sent", id: sent.id, threadId, via: "fallback" });
		const calls = fake.calls.slice(before);
		expect(calls.filter((id) => id === "gmail.users.messages.list")).toHaveLength(2);
		expect(calls.filter((id) => id === "gmail.users.messages.get")).toHaveLength(2);
		const short = await reconcile(gmail, attempt, { byMessageId: false, maxPages: 1 });
		expect(short).toEqual({ status: "not_found", scanned: 0, complete: false });
	});

	it("matches a new thread on headers and body alone", async () => {
		const { fake, gmail } = await setup({ messageIdPolicy: "replace" });
		const attemptedAt = Date.now();
		const fresh: MimeInput = { from: owner, to: [alice], subject: "Hello", text: "Hi Alice.\n" };
		fake.insert(await raw({ ...fresh, text: "Hi Alice!\n" }), ["SENT"], {
			internalDate: attemptedAt + 1,
		});
		const rendered = await render(fresh);
		const sent = await sendMessage(gmail, rendered);
		const result = await reconcile(gmail, attemptOf(rendered, undefined, attemptedAt));
		expect(result).toEqual({
			status: "sent",
			id: sent.id,
			threadId: sent.threadId,
			via: "fallback",
		});
	});

	it("reports two copies as ambiguous", async () => {
		const { fake, gmail, threadId } = await setup({ messageIdPolicy: "keep" });
		const attemptedAt = Date.now();
		const rendered = await render(reply);
		const sent = await sendMessage(gmail, rendered, { threadId });
		const copy = fake.insert(rendered.raw, ["SENT"], { threadId, internalDate: attemptedAt + 1 });
		const result = await reconcile(gmail, attemptOf(rendered, threadId, attemptedAt));
		expect(result.status).toBe("ambiguous");
		expect(result.status === "ambiguous" && [...result.ids].toSorted()).toEqual(
			[sent.id, copy.id].toSorted(),
		);
	});
});

describe("afterReconcile: the outbox step", () => {
	it("is SENT for a match, flagged SENT for two copies, and re-approval only when not found", () => {
		const sent = { status: "sent", id: "m1", threadId: "t1", via: "fallback" } as const;
		expect(afterReconcile(sent)).toEqual({ state: "SENT", flagged: false });
		expect(afterReconcile({ status: "ambiguous", ids: ["m1", "m2"] })).toEqual({
			state: "SENT",
			flagged: true,
		});
		for (const complete of [true, false]) {
			expect(afterReconcile({ status: "not_found", scanned: 3, complete })).toEqual({
				state: "NEEDS_REAPPROVAL",
				reason: "not_found",
			});
		}
	});
});

describe("countsAsSent and plainText", () => {
	it("counts SENT only, never Gmail-UI scheduled mail or drafts", () => {
		expect(countsAsSent(["SENT"])).toBe(true);
		expect(countsAsSent(["SENT", "IMPORTANT"])).toBe(true);
		expect(countsAsSent(["SENT", "SCHEDULED"])).toBe(false);
		expect(countsAsSent(["SCHEDULED"])).toBe(false);
		expect(countsAsSent(["SENT", "DRAFT"])).toBe(false);
		expect(countsAsSent(["INBOX"])).toBe(false);
		expect(countsAsSent(undefined)).toBe(false);
	});

	it("takes the first text/plain part that isn't an attachment, in its charset", () => {
		const data = (text: string, encoding: BufferEncoding = "utf8") =>
			Buffer.from(text, encoding).toString("base64url");
		const payload: MessagePart = {
			mimeType: "multipart/mixed",
			parts: [
				{ mimeType: "text/plain", filename: "notes.txt", body: { data: data("attachment") } },
				{
					mimeType: "multipart/alternative",
					parts: [
						{
							mimeType: "text/plain",
							filename: "",
							headers: [{ name: "Content-Type", value: 'text/plain; charset="iso-8859-1"' }],
							body: { data: data("Grüße", "latin1") },
						},
						{ mimeType: "text/html", body: { data: data("<p>x</p>") } },
					],
				},
			],
		};
		expect(plainText(payload)).toBe("Grüße");
		expect(plainText({ mimeType: "text/html", body: { data: data("x") } })).toBeUndefined();
		expect(plainText({ mimeType: "text/plain", body: { size: 0 } })).toBe("");
	});
});
