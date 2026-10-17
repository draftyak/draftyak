import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { Gmail, GmailError } from "../src/api.ts";
import { type MimeInput, newClaimStamp, renderMime } from "../src/mime.ts";
import { GMAIL_MODIFY } from "../src/oauth.ts";
import { ACCEPTED, DATE_AMBIGUITY_MS, multipartUpload, sendMessage } from "../src/send.ts";
import { type FakeGmail, type FakeGmailOptions, startFakeGmail } from "./fake-gmail.ts";
import { TokenRegistry } from "./fake-google-oauth.ts";
import {
	backend500,
	concurrent429,
	errorResponse,
	invalid400,
	mailSending429,
	rateLimit403,
} from "./google-errors.ts";
import { serve } from "./serve.ts";

const owner = { name: "Owner Example", address: "owner@example.com" };
const alice = { name: "Alice Example", address: "alice@example.org" };

let fake: FakeGmail | undefined;

async function setup(options: Partial<FakeGmailOptions> = {}) {
	const tokens = new TokenRegistry();
	fake = await startFakeGmail({ tokens, ...options });
	const { accessToken } = tokens.grant(["openid", "email", GMAIL_MODIFY]);
	const gmail = new Gmail({ accessToken, root: fake.url });
	// The message the owner replies to, already in the mailbox.
	const inbound = await renderMime(
		{ from: alice, to: [owner], subject: "Lunch on Thursday", text: "Thursday?\n" },
		{ ...newClaimStamp(alice.address), messageId: "<thread-2@example.org>" },
	);
	const thread = fake.insert(inbound.raw, ["INBOX", "UNREAD"]);
	return { fake, gmail, accessToken, threadId: thread.threadId };
}

// Answers 200 with a JSON length it never delivers: the body is cut off ("reset") or stalls.
async function brokenBody(mode: "reset" | "stall") {
	const server = createServer((request, response) => {
		request.resume().once("end", () => {
			response.writeHead(200, { "content-type": "application/json", "content-length": "1000" });
			response.write('{"id":"');
			if (mode === "reset") setImmediate(() => response.socket?.destroy());
		});
	});
	await new Promise<void>((resolve) => server.listen({ host: "127.0.0.1", port: 0 }, resolve));
	const { port } = server.address() as AddressInfo;
	return {
		url: `http://127.0.0.1:${port}`,
		close: () =>
			new Promise<void>((resolve) => {
				server.closeAllConnections();
				server.close(() => resolve());
			}),
	};
}

// A back-dated claim stamp, so a Date Gmail rewrote would differ from it (send.ts).
const pastStamp = () => newClaimStamp(owner.address, Date.now() - 90_000);

const reply: MimeInput = {
	from: owner,
	to: [alice],
	subject: "Re: Lunch on Thursday",
	text: "Thursday at noon works for me.\n",
	inReplyTo: "<thread-2@example.org>",
	references: ["<thread-2@example.org>"],
};

afterEach(async () => {
	if (fake === undefined) return;
	expect(fake.violations).toEqual([]);
	expect(fake.unimplemented).toEqual([]);
	await fake.close();
	fake = undefined;
});

describe("sendMessage", () => {
	it("uploads the exact bytes into the thread, then reads the metadata back", async () => {
		const { fake, gmail, threadId } = await setup();
		const rendered = await renderMime(reply, pastStamp());
		const result = await sendMessage(gmail, rendered, { threadId });
		expect(result).toMatchObject({
			status: ACCEPTED,
			threadId,
			threadKept: true,
			labelIds: ["SENT"],
			readBack: { labelIds: ["SENT"], messageId: rendered.stamp.messageId },
			messageIdKept: true,
			dateKept: true,
		});
		expect(fake.calls).toEqual(["gmail.users.messages.send", "gmail.users.messages.get"]);
		expect(fake.messages.get(result.id)?.raw.equals(rendered.raw)).toBe(true);
	});

	it("reports a Message-ID and Date that Gmail replaced (what S8 checks live)", async () => {
		const { gmail, threadId } = await setup({ messageIdPolicy: "replace", datePolicy: "replace" });
		const stamp = newClaimStamp(owner.address, Date.now() - 3_600_000);
		const result = await sendMessage(gmail, await renderMime(reply, stamp), { threadId });
		expect(result.messageIdKept).toBe(false);
		expect(result.dateKept).toBe(false);
		expect(result.readBack?.messageId).toMatch(/^<fake\.[0-9a-f]+@mail\.gmail\.com>$/);
	});

	it("can't tell a kept Date from Gmail's own when the stamp is the send time", async () => {
		const { fake, gmail, threadId } = await setup();
		const rendered = await renderMime(reply, newClaimStamp(owner.address));
		const result = await sendMessage(gmail, rendered, { threadId });
		const received = fake.messages.get(result.id)?.internalDate ?? 0;
		expect(Math.abs(received - rendered.stamp.date.getTime())).toBeLessThan(DATE_AMBIGUITY_MS);
		expect(result).toMatchObject({ messageIdKept: true, dateKept: "inconclusive" });
		expect(result.readBack?.internalDate).toBe(received);
	});

	it("notices when Gmail starts a new thread instead", async () => {
		const { gmail, threadId } = await setup();
		const loose = { ...reply, subject: "Something else" };
		const result = await sendMessage(gmail, await renderMime(loose, newClaimStamp(owner.address)), {
			threadId,
		});
		expect(result.threadKept).toBe(false);
		expect(result.threadId).not.toBe(threadId);
	});

	it("starts a new thread without a threadId", async () => {
		const { gmail } = await setup();
		const input = { from: owner, to: [alice], subject: "Hello", text: "Hi Alice.\n" };
		const result = await sendMessage(gmail, await renderMime(input, newClaimStamp(owner.address)));
		expect(result).toMatchObject({ status: ACCEPTED, threadKept: null, messageIdKept: true });
	});

	it("keeps the send when only the read-back fails", async () => {
		const { fake, gmail, threadId } = await setup();
		fake.failNext("gmail.users.messages.get", errorResponse(500, backend500));
		const result = await sendMessage(gmail, await renderMime(reply, newClaimStamp(owner.address)), {
			threadId,
		});
		expect(result).toMatchObject({
			status: ACCEPTED,
			readBack: null,
			messageIdKept: null,
			dateKept: null,
		});
	});

	it("keeps the send when the read-back's body is cut off", async () => {
		const { fake, accessToken, threadId } = await setup();
		const cut = await brokenBody("reset");
		try {
			const readsCut: typeof fetch = (input, init) =>
				fetch(init?.method === "GET" ? String(input).replace(fake.url, cut.url) : input, init);
			const gmail = new Gmail({ accessToken, root: fake.url, fetch: readsCut });
			const rendered = await renderMime(reply, newClaimStamp(owner.address));
			const result = await sendMessage(gmail, rendered, { threadId });
			expect(result).toMatchObject({ status: ACCEPTED, threadKept: true, readBack: null });
			expect(fake.messages.get(result.id)?.raw.equals(rendered.raw)).toBe(true);
		} finally {
			await cut.close();
		}
	});

	it("keeps the send when the read-back can't even start (no token for it)", async () => {
		const { fake, accessToken, threadId } = await setup();
		let calls = 0;
		const token = (): string => {
			if (calls++ > 0) throw new Error("token refresh failed");
			return accessToken;
		};
		const gmail = new Gmail({ accessToken: token, root: fake.url });
		const result = await sendMessage(gmail, await renderMime(reply, pastStamp()), { threadId });
		expect(result).toMatchObject({ status: ACCEPTED, readBack: null, dateKept: null });
		expect(fake.calls).toEqual(["gmail.users.messages.send"]);
	});

	it("leaves a send UNKNOWN when the answer's body is cut off or stalls", async () => {
		const rendered = await renderMime(reply, newClaimStamp(owner.address));
		for (const [mode, reason] of [
			["reset", /^body_UND_ERR_SOCKET$/],
			["stall", /^body_timeout$/],
		] as const) {
			const broken = await brokenBody(mode);
			try {
				const gmail = new Gmail({ accessToken: "x", root: broken.url, timeoutMs: 500 });
				const error = await sendMessage(gmail, rendered).catch((caught: unknown) => caught);
				expect(error).toBeInstanceOf(GmailError);
				expect(error).toMatchObject({ status: 200, outcome: { kind: "unknown" } });
				expect((error as GmailError).outcome).toMatchObject({
					reason: expect.stringMatching(reason),
				});
			} finally {
				await broken.close();
			}
		}
	});

	it("classifies a refused send, and nothing reaches the mailbox", async () => {
		const { fake, gmail, threadId } = await setup();
		const before = fake.messages.size;
		const cases: [Response, object][] = [
			[
				errorResponse(429, mailSending429("2026-10-17T23:00:00Z")),
				{ kind: "retry", reason: "mail_sending" },
			],
			[errorResponse(429, concurrent429), { kind: "retry", reason: "concurrent" }],
			[errorResponse(403, rateLimit403), { kind: "retry", reason: "rate_limit" }],
			[errorResponse(400, invalid400), { kind: "failed", reason: "invalidArgument" }],
			[errorResponse(500, backend500), { kind: "unknown", reason: "http_500" }],
		];
		for (const [response, outcome] of cases) {
			fake.failNext("gmail.users.messages.send", response);
			const rendered = await renderMime(reply, newClaimStamp(owner.address));
			const error = await sendMessage(gmail, rendered, { threadId }).catch(
				(caught: unknown) => caught,
			);
			expect(error).toBeInstanceOf(GmailError);
			expect((error as GmailError).outcome).toMatchObject(outcome);
		}
		expect(fake.messages.size).toBe(before);
	});

	it("fails on an unknown thread, and on a request that never reached a server", async () => {
		const { gmail } = await setup();
		const rendered = await renderMime(reply, newClaimStamp(owner.address));
		await expect(
			sendMessage(gmail, rendered, { threadId: "0123456789abcdef" }),
		).rejects.toMatchObject({
			status: 404,
			outcome: { kind: "failed", reason: "notFound" },
		});
		const closed = await serve(() => new Response(null));
		await closed.close();
		const offline = new Gmail({ accessToken: "x", root: closed.url });
		await expect(sendMessage(offline, rendered)).rejects.toMatchObject({
			status: 0,
			outcome: { kind: "retry", reason: "not_written" },
		});
	});
});

describe("multipartUpload", () => {
	it("is multipart/related: the JSON metadata, then the message as message/rfc822", () => {
		const raw = Buffer.from("Subject: x\r\n\r\nbody\r\n");
		const { body, contentType } = multipartUpload({ threadId: "t1" }, raw);
		const boundary = /boundary=(\S+)$/.exec(contentType)?.[1] ?? "";
		expect(contentType).toBe(`multipart/related; boundary=${boundary}`);
		expect(Buffer.from(body).toString("latin1")).toBe(
			`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n{"threadId":"t1"}\r\n` +
				`--${boundary}\r\nContent-Type: message/rfc822\r\n\r\nSubject: x\r\n\r\nbody\r\n\r\n--${boundary}--\r\n`,
		);
		expect(raw.includes(boundary)).toBe(false);
	});
});
