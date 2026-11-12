import { afterEach, describe, expect, it, vi } from "vitest";
import { manualClock } from "../src/faults.ts";
import { GmailState } from "../src/gmail/state.ts";
import { GmailInputError, MAX_GMAIL_RAW_BYTES, body as readBody } from "../src/gmail/wire.ts";
import { createGmailFake, GMAIL_HOST } from "../src/gmail.ts";
import { createRecorder } from "../src/recorder.ts";
import {
	discoveryProblems,
	discoveryRevision,
	discoverySha256,
	schemaProblems,
} from "./gmail-discovery.ts";
import { getWithHost, json, listeners, sha256 } from "./helpers.ts";

const START = Date.UTC(2026, 9, 19, 9);
const BASE = "/gmail/v1/users/me";
const MODIFY = "https://www.googleapis.com/auth/gmail.modify";
const READ = "https://www.googleapis.com/auth/gmail.readonly";
const METADATA = "https://www.googleapis.com/auth/gmail.metadata";
const SEND = "https://www.googleapis.com/auth/gmail.send";
const tokenScopes: Readonly<Record<string, readonly string[]>> = {
	"DYTEST-full": [MODIFY],
	"DYTEST-read": [READ],
	"DYTEST-metadata": [METADATA],
	"DYTEST-send": [SEND],
};
const grant = (token: string) =>
	tokenScopes[token] ? { scopes: tokenScopes[token], expiresAt: START + 3_600_000 } : undefined;
const raw = (id = "one", body = "DYTEST hello") =>
	Buffer.from(
		`From: DYTEST Owner <owner@draftyak.example>\r\nTo: DYTEST Peer <peer@draftyak.example>\r\nSubject: DYTEST plan\r\nMessage-ID: <${id}@draftyak.example>\r\nDate: Mon, 19 Oct 2026 08:00:00 +0000\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}\r\n`,
	);
type Gmail = ReturnType<typeof createGmailFake>;
type Options = Parameters<typeof createGmailFake>[0];
const create = (options: Partial<Options> = {}) =>
	createGmailFake({ accessGrant: grant, clock: manualClock(START), ...options });
const call = (fake: Gmail, path: string, init: RequestInit = {}, token = "DYTEST-full") =>
	fake.fetch(path.startsWith("https:") ? path : `${BASE}${path}`, {
		...init,
		headers: { authorization: `Bearer ${token}`, ...init.headers },
	});
const post = (value: unknown): RequestInit => ({
	method: "POST",
	headers: { "content-type": "application/json" },
	body: JSON.stringify(value),
});

describe("Gmail control snapshots", () => {
	const send = (fake: Gmail) =>
		call(fake, "/messages/send", post({ raw: raw().toString("base64url") }));
	it("does not trust a caller scope some method for send permission", async () => {
		const scopes = [READ];
		Object.defineProperty(scopes, "some", { value: () => true });
		const fake = create({ accessGrant: () => ({ scopes, expiresAt: START + 60_000 }) });
		const before = fake.historyId;
		expect((await send(fake)).status).toBe(403);
		expect(fake.historyId).toBe(before);
	});
	it("does not trust a caller scope includes method for metadata restrictions", async () => {
		const scopes = [METADATA];
		Object.defineProperty(scopes, "includes", { value: () => false });
		const fake = create({
			messages: [{ id: "m1", raw: raw() }],
			accessGrant: () => ({ scopes, expiresAt: START + 60_000 }),
		});
		expect((await call(fake, "/messages/m1?format=raw")).status).toBe(403);
	});
	it("copies indexed grant scopes without caller iteration", async () => {
		const scopes = [READ];
		let iterations = 0;
		scopes[Symbol.iterator] = function* () {
			iterations++;
			yield SEND;
			return undefined;
		};
		const fake = create({ accessGrant: () => ({ scopes, expiresAt: START + 60_000 }) });
		expect((await send(fake)).status).toBe(403);
		expect(iterations).toBe(0);
	});
	it("uses one captured grant scope array for permission", async () => {
		let reads = 0;
		const grant = {
			get scopes() {
				return ++reads === 1 ? [READ] : [SEND];
			},
			expiresAt: START + 60_000,
		};
		const fake = create({ accessGrant: () => grant });
		expect((await send(fake)).status).toBe(403);
		expect(reads).toBe(1);
	});
	it("uses one captured grant expiry for validation", async () => {
		let reads = 0;
		const grant = {
			scopes: [READ],
			get expiresAt() {
				return ++reads === 1 ? START + 60_000 : START - 1;
			},
		};
		const fake = create({ accessGrant: () => grant });
		expect((await call(fake, "/profile")).status).toBe(200);
		expect(reads).toBe(1);
	});
	it("keeps send capacity after reentrant step preparation", async () => {
		const fake = create();
		let entered = false;
		const step = {
			get kind(): "accept" {
				if (!entered) {
					entered = true;
					fake.queueSend(
						...Array.from({ length: 1024 }, () => ({
							kind: "mail-rate-limit" as const,
							retryAfterSeconds: 1,
						})),
					);
				}
				return "accept";
			},
		};
		expect(() => fake.queueSend(step)).toThrow();
		expect(() => fake.queueSend({ kind: "accept" })).toThrow();
		const response = await send(fake);
		expect(response.status).toBe(429);
		expect(response.headers.get("retry-after")).toBe("1");
		expect(fake.historyId).toBe("1000");
		expect(() => fake.queueSend({ kind: "accept" })).not.toThrow();
		expect(() => fake.queueSend({ kind: "accept" })).toThrow();
	});
	it("copies the same raw seed bytes that were validated", () => {
		const fake = create();
		const bytes = raw();
		let reads = 0;
		expect(() =>
			fake.addMessage({
				id: "m1",
				get raw() {
					return ++reads === 1 ? bytes : new Uint8Array(0);
				},
			}),
		).not.toThrow();
		expect(fake.message("m1").raw).toEqual(new Uint8Array(bytes));
		expect(reads).toBe(1);
	});
	it("captures a seed identifier before validating and storing it", () => {
		const fake = create();
		let reads = 0;
		const seed = {
			get id() {
				return ++reads === 1 ? "m1" : "DYTEST invalid id";
			},
			raw: raw(),
		};
		expect(() => fake.addMessage(seed)).not.toThrow();
		expect(fake.message("m1").id).toBe("m1");
		expect(reads).toBe(1);
	});
	it("captures a seed thread identifier before validating and storing it", () => {
		const fake = create();
		let reads = 0;
		fake.addMessage({
			id: "m1",
			get threadId() {
				return ++reads === 1 ? "t1" : "DYTEST invalid thread";
			},
			raw: raw(),
		});
		expect(fake.message("m1").threadId).toBe("t1");
		expect(reads).toBe(1);
	});
	it("checks duplicate identity against the prepared seed identifier", () => {
		const bytes = raw();
		const fake = create({ messages: [{ id: "m1", raw: bytes }] });
		let reads = 0;
		const before = fake.historyId;
		const seed = {
			get id() {
				return ++reads === 1 ? "m1" : "unused";
			},
			threadId: "t1",
			raw: raw("replacement"),
		};
		expect(() => fake.addMessage(seed)).toThrow();
		expect(fake.historyId).toBe(before);
		expect(fake.message("m1").raw).toEqual(new Uint8Array(bytes));
	});
	it("copies indexed labels without using later caller iterations", () => {
		const fake = create({ messages: [{ id: "m1", raw: raw() }] });
		const values = ["INBOX"];
		let passes = 0;
		values[Symbol.iterator] = function* () {
			yield ++passes <= 2 ? "INBOX" : "DYTEST invalid label";
			return undefined;
		};
		fake.setLabels("m1", values);
		expect(fake.message("m1").labelIds).toEqual(["INBOX"]);
		expect(passes).toBe(0);
	});
	it("validates indexed labels hidden by a caller iterator", () => {
		const fake = create({ messages: [{ id: "m1", raw: raw() }] });
		const values = ["DYTEST invalid label"];
		values[Symbol.iterator] = function* () {
			yield "INBOX";
			return undefined;
		};
		const before = fake.historyId;
		expect(() => fake.setLabels("m1", values)).toThrow();
		expect(fake.historyId).toBe(before);
	});
	it("captures send kind before validation and preparation", async () => {
		const fake = create();
		let reads = 0;
		const step = {
			get kind(): "accept" | "mail-rate-limit" {
				return ++reads === 1 ? "accept" : "mail-rate-limit";
			},
			retryAfterSeconds: -1,
		};
		expect(() => fake.queueSend(step)).not.toThrow();
		expect((await send(fake)).status).toBe(200);
		expect(reads).toBe(1);
	});
	it("retains the validated send date", async () => {
		const fake = create();
		const date = "Mon, 19 Oct 2026 09:00:00 +0000";
		let reads = 0;
		expect(() =>
			fake.queueSend({
				kind: "accept",
				get date() {
					return ++reads === 1 ? date : "\r\nX-DYTEST: unchecked";
				},
			}),
		).not.toThrow();
		const result = await json<{ id: string }>(send(fake));
		expect(Buffer.from(fake.message(result.id).raw).toString()).toContain(`Date: ${date}\r\n`);
		expect(Buffer.from(fake.message(result.id).raw).toString()).not.toContain("X-DYTEST");
		expect(reads).toBe(1);
	});
	it("retains the validated send message identifier", async () => {
		const fake = create();
		const messageId = "<DYTEST-checked@draftyak.example>";
		let reads = 0;
		expect(() =>
			fake.queueSend({
				kind: "accept",
				get messageId() {
					return ++reads === 1 ? messageId : "<DYTEST-unchecked@other.invalid>";
				},
			}),
		).not.toThrow();
		const result = await json<{ id: string }>(send(fake));
		expect(Buffer.from(fake.message(result.id).raw).toString()).toContain(
			`Message-ID: ${messageId}\r\n`,
		);
		expect(reads).toBe(1);
	});
	it("retains the validated retry delay", async () => {
		const fake = create();
		let reads = 0;
		expect(() =>
			fake.queueSend({
				kind: "mail-rate-limit",
				get retryAfterSeconds() {
					return ++reads === 1 ? 5 : -1;
				},
			}),
		).not.toThrow();
		const response = await send(fake);
		expect(response.status).toBe(429);
		expect(response.headers.get("retry-after")).toBe("5");
		expect(fake.historyId).toBe("1000");
		expect(reads).toBe(1);
	});
	it("retains validated budget units", async () => {
		let reads = 0;
		const fake = create({
			readBudget: {
				get units() {
					return ++reads === 1 ? 1 : 2;
				},
				windowMs: 60_000,
			},
		});
		expect((await call(fake, "/profile")).status).toBe(200);
		expect((await call(fake, "/profile")).status).toBe(429);
		expect(reads).toBe(1);
	});
	it("retains validated budget windows", async () => {
		let reads = 0;
		const clock = manualClock(START);
		const fake = create({
			clock,
			readBudget: {
				units: 1,
				get windowMs() {
					return ++reads === 1 ? 60_000 : 1;
				},
			},
		});
		expect((await call(fake, "/profile")).status).toBe(200);
		clock.advance(1);
		expect((await call(fake, "/profile")).status).toBe(429);
		expect(reads).toBe(1);
	});
});

describe("Gmail discovery and boundary controls", () => {
	it("retries a non-final page with the same continuation and no extra cursor reservations", async () => {
		const fake = create({ messages: [1, 2, 3].map((n) => ({ id: `m${n}`, raw: raw() })) });
		const first = await json<{ nextPageToken: string }>(call(fake, "/messages?maxResults=1"));
		const path = `/messages?maxResults=1&pageToken=${first.nextPageToken}`;
		const second = await json<{ messages: { id: string }[]; nextPageToken: string }>(
			call(fake, path),
		);
		expect(second.messages).toEqual([{ id: "m2", threadId: "m2" }]);
		for (let n = 0; n < 129; n++) expect(await json(call(fake, path))).toEqual(second);
		expect(
			await json(call(fake, `/messages?maxResults=1&pageToken=${second.nextPageToken}`)),
		).toMatchObject({ messages: [{ id: "m3", threadId: "m3" }] });
	});
	it.each([
		["messages", "addition"],
		["messages", "removal"],
		["threads", "addition"],
		["threads", "removal"],
	] as const)(
		"keeps complete %s continuation responses stable after a matching %s",
		async (route, change) => {
			const fake = create({
				messages: [1, 2, 3].map((n) => ({
					id: `m${n}`,
					threadId: `t${n}`,
					raw: raw(String(n)),
					labelIds: ["INBOX"],
				})),
			});
			const path = `/${route}?maxResults=1&labelIds=INBOX&q=in%3Ainbox`;
			type Page = Record<string, unknown> & { resultSizeEstimate: number; nextPageToken: string };
			const first = await json<Page>(call(fake, path));
			expect(first.resultSizeEstimate).toBe(3);
			const continuation = `${path}&pageToken=${encodeURIComponent(first.nextPageToken)}`;
			const second = await json<Page>(call(fake, continuation));
			expect(second[route]).toEqual(
				route === "messages" ? [{ id: "m2", threadId: "t2" }] : [{ id: "t2" }],
			);
			expect(second.resultSizeEstimate).toBe(3);
			expect(second.nextPageToken).toBeTypeOf("string");
			if (change === "addition")
				fake.addMessage({ id: "m4", threadId: "t4", raw: raw("four"), labelIds: ["INBOX"] });
			else fake.deleteMessage("m2");
			expect(await json(call(fake, path))).toMatchObject({
				resultSizeEstimate: change === "addition" ? 4 : 2,
			});
			for (let retry = 0; retry < 2; retry++)
				expect(await json(call(fake, continuation))).toEqual(second);
			const last = await json<Page>(
				call(fake, `${path}&pageToken=${encodeURIComponent(second.nextPageToken)}`),
			);
			expect(last).toEqual({
				[route]: route === "messages" ? [{ id: "m3", threadId: "t3" }] : [{ id: "t3" }],
				resultSizeEstimate: 3,
			});
		},
	);
	it.each(["messages", "threads"] as const)(
		"counts the complete filtered %s snapshot before pagination",
		async (route) => {
			const fake = create({
				messages: [
					{ id: "m1", threadId: "t1", raw: raw("one"), labelIds: ["INBOX"] },
					{ id: "m2", threadId: "t1", raw: raw("two"), labelIds: ["INBOX"] },
					{ id: "m3", threadId: "t2", raw: raw("three"), labelIds: ["INBOX"] },
					{ id: "m4", threadId: "t3", raw: raw("four"), labelIds: ["SENT"] },
				],
			});
			const path = `/${route}?maxResults=1&labelIds=INBOX&q=in%3Ainbox`;
			const expected =
				route === "messages"
					? [
							{ id: "m1", threadId: "t1" },
							{ id: "m2", threadId: "t1" },
							{ id: "m3", threadId: "t2" },
						]
					: [{ id: "t1" }, { id: "t2" }];
			let next = path;
			for (const row of expected) {
				const page = await json<Record<string, unknown> & { nextPageToken?: string }>(
					call(fake, next),
				);
				expect(page[route]).toEqual([row]);
				expect(page.resultSizeEstimate).toBe(expected.length);
				next = page.nextPageToken
					? `${path}&pageToken=${encodeURIComponent(page.nextPageToken)}`
					: "";
			}
			expect(next).toBe("");
			expect(await json(call(fake, `/${route}?maxResults=1&labelIds=UNREAD`))).toEqual({
				[route]: [],
				resultSizeEstimate: 0,
			});
		},
	);
	it("the independent oracle refuses altered methods, paths, query fields and send bodies", async () => {
		const fake = create();
		const profile = await json(call(fake, "/profile"));
		const record = fake.recorder.takeRequests()[0];
		if (!record) throw new Error("DYTEST missing profile record");
		expect(discoveryProblems(record, profile)).toEqual([]);
		for (const changed of [
			{ ...record, method: "PATCH" },
			{ ...record, path: "/gmail/v1/users//profile" },
			{ ...record, path: `${BASE}/not-a-method` },
			{ ...record, query: "notAParameter=1" },
			{ ...record, path: `${BASE}/messages`, query: "maxResults=1&maxResults=2" },
			{ ...record, path: `${BASE}/messages`, query: "includeSpamTrash=perhaps" },
		])
			expect(discoveryProblems(changed, profile)).not.toEqual([]);
		const sent = await json(
			call(fake, "/messages/send", post({ raw: raw().toString("base64url") })),
		);
		const send = fake.recorder.takeRequests()[0];
		if (!send) throw new Error("DYTEST missing send record");
		expect(discoveryProblems(send, sent)).toEqual([]);
		for (const value of [{}, { raw: raw().toString("base64url"), unknown: true }]) {
			expect(
				discoveryProblems({ ...send, body: Buffer.from(JSON.stringify(value)) }, sent),
			).not.toEqual([]);
		}
		expect(discoveryProblems(record, profile)).toEqual([]);
	});

	it("requires the fixture history checkpoint without inventing required discovery query metadata", async () => {
		const fake = create();
		for (const start of ["", "-1", "01", "1.5", "18446744073709551616"])
			expect((await call(fake, `/history?startHistoryId=${start}`)).status).toBe(400);
		expect((await call(fake, "/history")).status).toBe(400);
		expect((await call(fake, "/history?startHistoryId=18446744073709551615")).status).toBe(404);
		expect((await call(fake, `/history?startHistoryId=${fake.historyId}`)).status).toBe(200);
	});

	it("binds cursors to bearer, route and filters, then retires them at expiry or clock rollback", async () => {
		const clock = manualClock(START);
		const fake = create({
			clock,
			messages: [1, 2, 3].map((n) => ({ id: `m${n}`, raw: raw(String(n)) })),
		});
		const next = async () =>
			(await json<{ nextPageToken: string }>(call(fake, "/messages?maxResults=1"))).nextPageToken;
		const token = await next();
		const suffix = `maxResults=1&pageToken=${encodeURIComponent(token)}`;
		for (const [path, bearer] of [
			[`/messages?${suffix}`, "DYTEST-read"],
			[`/threads?${suffix}`, "DYTEST-full"],
			[`/messages?${suffix}&labelIds=SENT`, "DYTEST-full"],
		] as const)
			expect((await call(fake, path, {}, bearer)).status).toBe(400);
		clock.advance(59_999);
		expect((await call(fake, `/messages?${suffix}`)).status).toBe(200);
		clock.advance(1);
		expect((await call(fake, `/messages?${suffix}`)).status).toBe(400);
		const rolled = await next();
		clock.set(START);
		expect((await call(fake, `/messages?maxResults=1&pageToken=${rolled}`)).status).toBe(400);
		expect((await call(fake, "/messages?maxResults=1")).status).toBe(200);
	});

	it("read-only cannot mutate by either route and rejected grants leave history untouched", async () => {
		const clock = manualClock(START);
		const fake = create({ clock, messages: [{ id: "m1", raw: raw() }] });
		const checkpoint = fake.historyId;
		for (const [path, value] of [
			["/messages/send", { raw: raw().toString("base64url") }],
			["/messages/m1/modify", { addLabelIds: ["SENT"] }],
			["/messages/batchModify", { ids: ["m1"], addLabelIds: ["SENT"] }],
		] as const) {
			expect((await call(fake, path, post(value), "DYTEST-read")).status).toBe(403);
			expect(fake.historyId).toBe(checkpoint);
		}
		clock.advance(3_600_000);
		expect(
			(await call(fake, "/messages/send", post({ raw: raw().toString("base64url") }))).status,
		).toBe(401);
		expect(fake.historyId).toBe(checkpoint);
	});

	it("distinguishes both sending 429 classes and resets each budget at the exact window", async () => {
		const clock = manualClock(START);
		const fake = create({ clock });
		const checkpoint = fake.historyId;
		fake.queueSend(
			{ kind: "mail-rate-limit", retryAfterSeconds: 14_400 },
			{ kind: "concurrent-rate-limit", retryAfterSeconds: 2 },
		);
		for (const [message, seconds] of [
			["Mail sending quota exceeded", 14_400],
			["Too many concurrent requests", 2],
		] as const) {
			const response = await call(
				fake,
				"/messages/send",
				post({ raw: raw().toString("base64url") }),
			);
			expect(response.status).toBe(429);
			expect(await response.json()).toMatchObject({
				error: {
					code: 429,
					message,
					errors: [{ domain: "global", reason: "rateLimitExceeded", message }],
				},
			});
			expect(response.headers.get("retry-after")).toBe(String(seconds));
			expect(response.headers.get("date")).toBe(new Date(START).toUTCString());
			expect(fake.historyId).toBe(checkpoint);
		}
		const limited = create({
			clock,
			readBudget: { units: 1, windowMs: 60_000 },
			sendBudget: { units: 1, windowMs: 60_000 },
		});
		expect((await call(limited, "/profile")).status).toBe(200);
		expect(
			(await call(limited, "/messages/send", post({ raw: raw().toString("base64url") }))).status,
		).toBe(200);
		const sent = limited.historyId;
		clock.advance(59_999);
		expect((await call(limited, "/profile")).status).toBe(429);
		expect(
			(await call(limited, "/messages/send", post({ raw: raw().toString("base64url") }))).status,
		).toBe(429);
		expect(limited.historyId).toBe(sent);
		clock.advance(1);
		expect((await call(limited, "/profile")).status).toBe(200);
		expect(
			(await call(limited, "/messages/send", post({ raw: raw("two").toString("base64url") })))
				.status,
		).toBe(200);
		clock.set(START);
		expect((await call(limited, "/profile")).status).toBe(200);
	});

	it("rewrites folded identity headers while preserving binary body octets and detached metadata", async () => {
		const fake = create();
		const mime = Buffer.concat([
			Buffer.from(
				"From: owner@draftyak.example\r\nTo: peer@draftyak.example\r\nSubject: DYTEST\r\nMessage-ID: <old@draftyak.example>\r\n\tDYTEST continuation\r\nDate: Mon, 19 Oct 2026 08:00:00 +0000\r\n\r\n",
			),
			Buffer.from([0xff, 0, 0x80, 13, 10]),
		]);
		const date = "Mon, 19 Oct 2026 10:00:00 +0000";
		fake.queueSend({ kind: "accept", date, messageId: "<new@draftyak.example>" });
		const sent = await json<{ id: string; threadId: string; labelIds: string[] }>(
			fake.fetch("/upload/gmail/v1/users/me/messages/send?uploadType=multipart", upload(mime)),
		);
		const stored = fake.message(sent.id);
		const expected = Buffer.concat([
			Buffer.from(
				"From: owner@draftyak.example\r\nTo: peer@draftyak.example\r\nSubject: DYTEST\r\nMessage-ID: <new@draftyak.example>\r\nDate: Mon, 19 Oct 2026 10:00:00 +0000\r\n\r\n",
			),
			Buffer.from([0xff, 0, 0x80, 13, 10]),
		]);
		expect(Buffer.from(stored.raw)).toEqual(expected);
		expect(sent.threadId).toBe(stored.threadId);
		expect(sent.labelIds).toEqual(["SENT"]);
		sent.labelIds.push("TRASH");
		stored.raw.fill(0);
		const metadata = await json<{
			payload: { headers: { name: string; value: string }[] };
			labelIds: string[];
		}>(call(fake, `/messages/${sent.id}?format=metadata`));
		expect(metadata.labelIds).toEqual(["SENT"]);
		expect(metadata.payload.headers).toEqual(
			expect.arrayContaining([
				{ name: "Message-ID", value: "<new@draftyak.example>" },
				{ name: "Date", value: date },
			]),
		);
		const read = await json<{ raw: string }>(call(fake, `/messages/${sent.id}?format=raw`));
		expect(Buffer.from(read.raw, "base64url")).toEqual(expected);
	});

	it("before-effect drops leave no mailbox record and after-effect drops leave exactly one history event", async () => {
		for (const after of [false, true]) {
			const fake = create();
			const checkpoint = fake.historyId;
			fake.faults.add({ kind: "drop", after, method: "POST", path: `${BASE}/messages/send` });
			await expect(
				call(fake, "/messages/send", post({ raw: raw().toString("base64url") })),
			).rejects.toThrow("fetch failed");
			const rows = await json<{ messages: { id: string }[] }>(call(fake, "/messages?q=in%3Asent"));
			expect(rows.messages).toHaveLength(after ? 1 : 0);
			const history = await json<{ history: unknown[] }>(
				call(fake, `/history?startHistoryId=${checkpoint}`),
			);
			expect(history.history).toHaveLength(after ? 1 : 0);
			if (after) expect(Buffer.from(fake.message(rows.messages[0]?.id ?? "").raw)).toEqual(raw());
		}
	});

	it("enforces message count and retained history floors without partial additions", async () => {
		const fake = create({
			messages: Array.from({ length: 1024 }, (_, n) => ({ id: `m${n}`, raw: raw() })),
		});
		const checkpoint = fake.historyId;
		expect(() => fake.addMessage({ id: "overflow", raw: raw() })).toThrow();
		expect(fake.historyId).toBe(checkpoint);
		fake.deleteMessage("m0");
		fake.addMessage({ id: "replacement", raw: raw() });
		const historyFake = create();
		for (let n = 0; n < 2049; n++) {
			historyFake.addMessage({ id: "entry", raw: raw() });
			historyFake.deleteMessage("entry");
		}
		expect((await call(historyFake, "/history?startHistoryId=3050")).status).toBe(200);
		expect((await call(historyFake, "/history?startHistoryId=3049")).status).toBe(404);
	});

	it("enforces cursor count, retained snapshot bytes and send queue bounds", async () => {
		const clock = manualClock(START);
		const state = new GmailState(clock);
		for (let n = 0; n < 128; n++)
			expect(state.page("key", null, [{ id: "a" }, { id: "b" }], 1).nextPageToken).toBeDefined();
		expect(() => state.page("key", null, [{ id: "a" }, { id: "b" }], 1)).toThrow();
		clock.advance(60_000);
		expect(state.page("key", null, [{ id: "a" }, { id: "b" }], 1).nextPageToken).toBeDefined();
		const empty = new GmailState(clock);
		expect(() => empty.page("key", null, [{ data: "x".repeat(4 * 1024 * 1024) }, {}], 1)).toThrow();
		expect(empty.page("key", null, [{ data: "x" }, {}], 1).nextPageToken).toBeDefined();
		const fake = create();
		fake.queueSend(...Array.from({ length: 1024 }, () => ({ kind: "accept" as const })));
		expect(() => fake.queueSend({ kind: "accept" })).toThrow();
		expect(
			(await call(fake, "/messages/send", post({ raw: raw().toString("base64url") }))).status,
		).toBe(200);
		expect(() => fake.queueSend({ kind: "accept" })).not.toThrow();
	});

	it("bounds raw and aggregate mailbox bytes at their advertised exact limits", () => {
		const padded = (size: number) => {
			const bytes = Buffer.alloc(size, 120);
			raw().copy(bytes);
			return bytes;
		};
		const state = new GmailState(manualClock(START));
		state.add({ id: "maximum", raw: padded(36_700_160) });
		state.remove("maximum");
		expect(() => state.add({ id: "tooLarge", raw: padded(36_700_161) })).toThrow();
		state.add({ id: "first", raw: padded(32 * 1024 * 1024) });
		state.add({ id: "second", raw: padded(32 * 1024 * 1024) });
		expect(() => state.add({ id: "overTotal", raw: raw() })).toThrow();
		state.remove("first");
		expect(() => state.add({ id: "replacement", raw: raw() })).not.toThrow();
	});

	it("bounds copied raw bytes when caller byteLength is shadowed", () => {
		const state = new GmailState(manualClock(START));
		state.add({ id: "before", raw: raw() });
		const messages = structuredClone(state.messages);
		const history = structuredClone(state.history);
		const sequence = state.sequence;
		const oversized = new Uint8Array(MAX_GMAIL_RAW_BYTES + 1).fill(120);
		oversized.set(raw());
		expect(oversized.byteLength).toBe(MAX_GMAIL_RAW_BYTES + 1);
		Object.defineProperty(oversized, "byteLength", { value: 1 });
		expect(oversized.byteLength).toBe(1);
		expect(() => state.add({ id: "tooLarge", raw: oversized })).toThrow(GmailInputError);
		expect(state.messages).toEqual(messages);
		expect(state.history).toEqual(history);
		expect(state.sequence).toBe(sequence);
		const exact = oversized.subarray(0, MAX_GMAIL_RAW_BYTES);
		expect(exact.byteLength).toBe(MAX_GMAIL_RAW_BYTES);
		expect(() => state.add({ id: "maximum", raw: exact })).not.toThrow();
		expect(state.get("maximum").raw.byteLength).toBe(MAX_GMAIL_RAW_BYTES);
		expect(state.sequence).toBe(sequence + 1n);
		expect(state.history).toHaveLength(history.length + 1);
	});

	it("caps app-side request bytes and yielded chunks, cancelling the refused stream", async () => {
		const request = (size: number, chunks: number, cancelled: () => void) => {
			let sent = 0;
			const stream = new ReadableStream<Uint8Array>({
				pull(controller) {
					if (sent++ < chunks) controller.enqueue(new Uint8Array(size));
					else controller.close();
				},
				cancel: cancelled,
			});
			const init = { method: "POST", body: stream, duplex: "half" };
			return new Request(`https://${GMAIL_HOST}/`, init);
		};
		expect((await readBody(request(50 * 1024 * 1024, 1, () => {}))).length).toBe(50 * 1024 * 1024);
		let cancelled = 0;
		await expect(
			readBody(
				request(50 * 1024 * 1024 + 1, 1, () => {
					cancelled++;
				}),
			).then(() => "accepted"),
		).rejects.toThrow();
		expect(cancelled).toBe(1);
		expect((await readBody(request(0, 65_536, () => {}))).length).toBe(0);
		await expect(
			readBody(
				request(0, 65_537, () => {
					cancelled++;
				}),
			).then(() => "accepted"),
		).rejects.toThrow();
		expect(cancelled).toBe(2);
	});
});
const upload = (mime: Uint8Array, metadata: Record<string, string> = {}) => {
	const boundary = "DYTEST_upload_01";
	return {
		method: "POST",
		headers: {
			authorization: "Bearer DYTEST-full",
			"content-type": `multipart/related; boundary="${boundary}"`,
		},
		body: Buffer.concat([
			Buffer.from(
				`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: message/rfc822\r\n\r\n`,
			),
			mime,
			Buffer.from(`\r\n--${boundary}--\r\n`),
		]),
	};
};
const open = listeners();
afterEach(async () => {
	vi.restoreAllMocks();
	await open.closeAll();
});

describe("Gmail shared request intake", () => {
	const streamingPost = (body: ReadableStream<Uint8Array>, signal?: AbortSignal): RequestInit =>
		({
			method: "POST",
			headers: { "content-type": "application/json" },
			body,
			signal,
			duplex: "half",
		}) as RequestInit;
	const oversized = () => {
		let pulls = 0;
		let cancelled = false;
		const chunk = new Uint8Array(1024 * 1024).fill(0x20);
		return {
			body: new ReadableStream<Uint8Array>({
				pull(controller) {
					if (++pulls > 54) controller.error(new Error("DYTEST intake guard did not stop"));
					else controller.enqueue(chunk);
				},
				cancel() {
					cancelled = true;
				},
			}),
			get pulls() {
				return pulls;
			},
			get cancelled() {
				return cancelled;
			},
		};
	};
	const assertOverflowTrace = (fake: Gmail) => {
		const records = fake.recorder.takeRequests();
		expect(records).toHaveLength(1);
		const record = records[0];
		if (!record) throw new Error("DYTEST missing refused intake record");
		expect(record.target).toBe(`${BASE}/messages/send`);
		expect(record.headers).toEqual({});
		expect(record.headerNames).toContain("authorization");
		expect(record.bodyLength).toBe(51 * 1024 * 1024);
		expect(record.body.byteLength).toBe(65_536);
		expect(record.body.every((byte) => byte === 0x20)).toBe(true);
		expect(record.bodySha256).toBe(sha256(Buffer.alloc(51 * 1024 * 1024, 0x20)));
		expect(record.refused).toBe("request_body_too_large");
	};

	it("admits an exact 50 MiB valid send and refuses one more byte before Gmail state changes", async () => {
		const fake = create();
		const mime = raw("intake-exact", "DYTEST exact intake bytes");
		const document = JSON.stringify({ raw: mime.toString("base64url") });
		const exact = Buffer.alloc(50 * 1024 * 1024, 0x20);
		exact.write(document);
		const sent = await call(fake, "/messages/send", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: exact,
		});
		expect(sent.status).toBe(200);
		const identity = (await sent.json()) as { id: string; threadId: string; labelIds: string[] };
		expect(identity).toMatchObject({ id: "sent_1", threadId: "sent_1", labelIds: ["SENT"] });
		expect(Buffer.from(fake.message(identity.id).raw)).toEqual(mime);
		const accepted = fake.recorder.takeRequests()[0];
		expect(accepted?.bodyLength).toBe(50 * 1024 * 1024);
		expect(accepted?.bodySha256).toBe(sha256(exact));
		expect(accepted?.refused).toBeUndefined();
		const checkpoint = fake.historyId;
		const extra = Buffer.concat([exact, Buffer.from(" ")]);
		const refused = await call(fake, "/messages/send", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: extra,
		});
		expect(refused.status).toBe(413);
		expect(refused.headers.get("date")).toBe(new Date(START).toUTCString());
		expect(await refused.json()).toEqual({ error: "request_body_too_large" });
		expect(fake.historyId).toBe(checkpoint);
		const rejected = fake.recorder.takeRequests()[0];
		expect(rejected?.bodyLength).toBe(50 * 1024 * 1024 + 1);
		expect(rejected?.body.byteLength).toBe(65_536);
		expect(rejected?.bodySha256).toBe(sha256(extra));
		expect(rejected?.refused).toBe("request_body_too_large");
		expect((await json<{ messages: unknown[] }>(call(fake, "/messages"))).messages).toHaveLength(1);
	});

	it("cancels overflow without spending Gmail quota or consuming a queued send step", async () => {
		const fake = create({ sendBudget: { units: 1, windowMs: 60_000 } });
		fake.queueSend({ kind: "accept", messageId: "<intake-queued@draftyak.example>" });
		const checkpoint = fake.historyId;
		const upload = oversized();
		const abort = new AbortController();
		const timeout = setTimeout(() => abort.abort(new Error("DYTEST intake timeout")), 3_000);
		try {
			const response = await call(fake, "/messages/send", streamingPost(upload.body, abort.signal));
			expect(response.status).toBe(413);
			expect(upload.cancelled).toBe(true);
			expect(upload.pulls).toBeLessThanOrEqual(52);
			expect(fake.historyId).toBe(checkpoint);
			assertOverflowTrace(fake);
			const sent = await json<{ id: string }>(
				call(fake, "/messages/send", post({ raw: raw("after-intake").toString("base64url") })),
			);
			expect(Buffer.from(fake.message(sent.id).raw).toString("latin1")).toContain(
				"Message-ID: <intake-queued@draftyak.example>\r\n",
			);
			expect(
				(await call(fake, "/messages/send", post({ raw: raw().toString("base64url") }))).status,
			).toBe(429);
		} finally {
			clearTimeout(timeout);
		}
	});

	it("records overflow while consuming the fault reserved at arrival", async () => {
		const fake = create();
		fake.faults.add({ kind: "server-error", method: "POST", path: `${BASE}/messages/send` });
		const checkpoint = fake.historyId;
		const upload = oversized();
		const response = await call(fake, "/messages/send", streamingPost(upload.body));
		expect(response.status).toBe(503);
		expect(response.headers.get("date")).toBe(new Date(START).toUTCString());
		expect(upload.cancelled).toBe(true);
		expect(upload.pulls).toBeLessThanOrEqual(52);
		expect(fake.faults.pending()).toEqual([]);
		expect(fake.historyId).toBe(checkpoint);
		assertOverflowTrace(fake);
		expect(
			(await call(fake, "/messages/send", post({ raw: raw().toString("base64url") }))).status,
		).toBe(200);
	});

	it("discards malformed intake without reaching the Gmail app", async () => {
		const accessGrant = vi.fn(grant);
		const fake = create({ accessGrant });
		let cancelled: unknown;
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue("DYTEST invalid chunk" as unknown as Uint8Array);
			},
			cancel(reason) {
				cancelled = reason;
			},
		});
		await expect(call(fake, "/messages/send", streamingPost(body))).rejects.toThrow(TypeError);
		expect(cancelled).toBeInstanceOf(TypeError);
		expect(accessGrant).not.toHaveBeenCalled();
		expect(fake.historyId).toBe("1000");
		expect(fake.recorder.takeRequests()).toEqual([]);
	});

	it("aborts a partial upload and releases its incomplete record before the next request", async () => {
		const fake = create();
		const abort = new AbortController();
		const reason = new Error("DYTEST partial intake cancelled");
		let started = (): void => {};
		const reading = new Promise<void>((resolve) => {
			started = resolve;
		});
		let cancelled: unknown;
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(Buffer.from("DYTEST partial form"));
			},
			pull() {
				started();
			},
			cancel(value) {
				cancelled = value;
			},
		});
		const pending = call(fake, "/messages/send", streamingPost(body, abort.signal));
		const assertion = expect(pending).rejects.toBe(reason);
		await reading;
		abort.abort(reason);
		await assertion;
		expect(cancelled).toBe(reason);
		expect(fake.historyId).toBe("1000");
		expect(fake.recorder.takeRequests()).toEqual([]);
		expect(
			(await call(fake, "/messages/send", post({ raw: raw().toString("base64url") }))).status,
		).toBe(200);
		expect(fake.recorder.takeRequests()).toHaveLength(1);
	});

	it("uses a custom begin writer and preserves raw targets, body hashes and header-value redaction", async () => {
		const delegate = createRecorder({ maxBodyBytes: 64, headerValues: ["x-dytest"] });
		let begun = 0;
		const recorder = {
			begin(request: Request) {
				expect(this).toBe(recorder);
				begun++;
				return delegate.begin(request);
			},
			record: vi.fn((request: Request) => delegate.record(request)),
			takeRequests: () => delegate.takeRequests(),
		};
		const fake = create({ recorder });
		const mime = Buffer.concat([raw("intake-binary"), Buffer.from([0, 0xff, 0x80])]);
		const payload = JSON.stringify({ raw: mime.toString("base64url") });
		const response = await call(fake, "/messages/send?fields=id%2CthreadId", {
			method: "POST",
			headers: { "content-type": "application/json", "x-dytest": "DYTEST writer" },
			body: payload,
		});
		expect(response.status).toBe(200);
		const sent = (await response.json()) as { id: string; threadId: string };
		expect(sent).toEqual({ id: "sent_1", threadId: "sent_1" });
		expect(Buffer.from(fake.message(sent.id).raw)).toEqual(mime);
		expect(begun).toBe(1);
		expect(recorder.record).not.toHaveBeenCalled();
		const record = recorder.takeRequests()[0];
		expect(record?.target).toBe(`${BASE}/messages/send?fields=id%2CthreadId`);
		expect(record?.headers).toEqual({ "x-dytest": "DYTEST writer" });
		expect(record?.body.byteLength).toBe(64);
		expect(record?.bodySha256).toBe(sha256(payload));
		expect(record?.refused).toBeUndefined();
		expect(() =>
			create({ recorder: { record: delegate.record, takeRequests: delegate.takeRequests } }),
		).toThrow("requires recorder.begin");
	});

	it("serves under-cap bytes and the same oversize refusal through its loopback listener", async () => {
		const fake = create({ recorder: createRecorder({ maxBodyBytes: 32 }) });
		const listener = open.keep(await fake.listen());
		const mime = raw("loopback-intake");
		const request = (body: BodyInit) =>
			fetch(`${listener.origin}${BASE}/messages/send`, {
				method: "POST",
				headers: { authorization: "Bearer DYTEST-full", "content-type": "application/json" },
				body,
			});
		const sent = await request(JSON.stringify({ raw: mime.toString("base64url") }));
		expect(sent.status).toBe(200);
		const identity = (await sent.json()) as { id: string };
		expect(Buffer.from(fake.message(identity.id).raw)).toEqual(mime);
		fake.recorder.takeRequests();
		const checkpoint = fake.historyId;
		const oversize = Buffer.alloc(50 * 1024 * 1024 + 1, 0x20);
		const response = await request(oversize);
		expect(response.status).toBe(413);
		expect(await response.json()).toEqual({ error: "request_body_too_large" });
		expect(response.headers.get("date")).toBe(new Date(START).toUTCString());
		expect(fake.historyId).toBe(checkpoint);
		const refused = fake.recorder.takeRequests()[0];
		expect(refused?.body.byteLength).toBe(32);
		expect(refused?.bodyLength).toBe(50 * 1024 * 1024 + 1);
		expect(refused?.bodySha256).toBe(sha256(oversize));
		expect(refused?.refused).toBe("request_body_too_large");
	});
});

describe("reusable Gmail fake", () => {
	it("uses the exact logical provider host without any outbound fetch", async () => {
		const outbound = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("DYTEST no egress"));
		const fake = create();
		expect(GMAIL_HOST).toBe("gmail.googleapis.com");
		expect((await call(fake, `https://${GMAIL_HOST}${BASE}/profile`)).status).toBe(200);
		expect(
			(await call(fake, "https://foreign.draftyak.example/gmail/v1/users/me/profile")).status,
		).toBe(421);
		expect(outbound).not.toHaveBeenCalled();
	});

	it("pins discovery bytes and independently checks request and response schemas", async () => {
		expect(discoveryRevision).toBe("20261012");
		expect(discoverySha256).toBe(
			"1eefc40da41cc5d19736d26b16f7f276a0300307c36b9abe33dc6c3ab12f414b",
		);
		const fake = create({
			messages: [{ id: "m1", threadId: "t1", raw: raw(), labelIds: ["INBOX", "UNREAD"] }],
		});
		for (const path of [
			"/profile",
			"/messages?maxResults=1&labelIds=INBOX",
			"/messages/m1?format=raw",
			"/messages/m1?format=full",
			"/messages/m1?format=metadata&metadataHeaders=Subject",
			"/threads?maxResults=1",
			"/threads/t1?format=metadata",
			`/history?startHistoryId=${fake.historyId}`,
		]) {
			const response = await call(fake, path);
			expect(response.status, path).toBe(200);
			const [record] = fake.recorder.takeRequests();
			expect(record).toBeDefined();
			if (!record) throw new Error("DYTEST missing record");
			expect(discoveryProblems(record, await response.json()), path).toEqual([]);
		}
		expect(schemaProblems({ messagesTotal: "not an integer" }, { $ref: "Profile" })).not.toEqual(
			[],
		);
		expect(schemaProblems({ unknown: true }, { $ref: "Message" })).not.toEqual([]);
		expect(schemaProblems({ messagesTotal: 2_147_483_648 }, { $ref: "Profile" })).not.toEqual([]);
		expect(
			schemaProblems({ resultSizeEstimate: -1 }, { $ref: "ListMessagesResponse" }),
		).not.toEqual([]);
		expect(schemaProblems({ historyId: "18446744073709551616" }, { $ref: "Profile" })).not.toEqual(
			[],
		);
	});

	it("lists identifiers only, pages without duplicates, and refuses foreign filter tokens", async () => {
		const fake = create({
			messages: [1, 2, 3].map((n) => ({
				id: `m${n}`,
				threadId: `t${n}`,
				raw: raw(String(n)),
				labelIds: ["INBOX"],
			})),
		});
		const first = await json<{ messages: unknown[]; nextPageToken: string }>(
			call(fake, "/messages?maxResults=2"),
		);
		expect(first.messages).toEqual([
			{ id: "m1", threadId: "t1" },
			{ id: "m2", threadId: "t2" },
		]);
		const second = await json<{ messages: unknown[]; nextPageToken?: string }>(
			call(fake, `/messages?maxResults=2&pageToken=${encodeURIComponent(first.nextPageToken)}`),
		);
		expect(second.messages).toEqual([{ id: "m3", threadId: "t3" }]);
		expect(second.nextPageToken).toBeUndefined();
		expect(
			(
				await call(
					fake,
					`/messages?maxResults=2&labelIds=SENT&pageToken=${encodeURIComponent(first.nextPageToken)}`,
				)
			).status,
		).toBe(400);
		expect((await call(fake, "/messages?pageToken=DYTEST-invalid")).status).toBe(400);
	});

	it("keeps metadata lazy and raw MIME byte exact, including non-UTF8 body octets", async () => {
		const mime = Buffer.concat([raw("binary", "DYTEST binary"), Buffer.from([0xff, 0x00, 0x80])]);
		const fake = create({ messages: [{ id: "m1", raw: mime, labelIds: ["INBOX"] }] });
		const metadata = await json<Record<string, unknown>>(
			call(fake, "/messages/m1?format=metadata&metadataHeaders=Subject&metadataHeaders=Message-ID"),
		);
		expect(metadata.raw).toBeUndefined();
		expect(metadata.payload).toEqual({
			headers: [
				{ name: "Subject", value: "DYTEST plan" },
				{ name: "Message-ID", value: "<binary@draftyak.example>" },
			],
		});
		const minimal = await json<Record<string, unknown>>(call(fake, "/messages/m1?format=minimal"));
		expect(minimal.raw).toBeUndefined();
		expect(minimal.payload).toBeUndefined();
		const fetched = await json<{ raw: string }>(call(fake, "/messages/m1?format=raw"));
		expect(Buffer.from(fetched.raw, "base64url")).toEqual(mime);
	});

	it("returns every thread message with its own labels and headers", async () => {
		const fake = create({
			messages: [
				{ id: "m1", threadId: "t1", raw: raw("one"), labelIds: ["INBOX"] },
				{ id: "m2", threadId: "t1", raw: raw("two"), labelIds: ["SENT"] },
			],
		});
		const thread = await json<{
			id: string;
			messages: { id: string; labelIds: string[]; payload: unknown }[];
		}>(call(fake, "/threads/t1?format=metadata&metadataHeaders=Message-ID"));
		expect(thread.id).toBe("t1");
		expect(thread.messages.map((m) => [m.id, m.labelIds])).toEqual([
			["m1", ["INBOX"]],
			["m2", ["SENT"]],
		]);
		expect(thread.messages[1]?.payload).toEqual({
			headers: [{ name: "Message-ID", value: "<two@draftyak.example>" }],
		});
	});

	it("keeps multipart mail raw or metadata-only instead of inventing a full MIME tree", async () => {
		const mime = Buffer.from(
			raw()
				.toString()
				.replace(
					"Content-Type: text/plain; charset=utf-8",
					"Content-Type: Multipart/alternative; boundary=DYTEST_parts",
				)
				.replace(
					"DYTEST hello\r\n",
					"--DYTEST_parts\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nDYTEST hello\r\n--DYTEST_parts--\r\n",
				),
		);
		const fake = create({ messages: [{ id: "m1", raw: mime }] });
		expect((await call(fake, "/messages/m1?format=metadata")).status).toBe(200);
		const read = await json<{ raw: string }>(call(fake, "/messages/m1?format=raw"));
		expect(Buffer.from(read.raw, "base64url")).toEqual(mime);
		expect((await call(fake, "/messages/m1?format=full")).status).toBe(400);
	});

	it("emits added/label/deleted history and expires the old checkpoint for rescan", async () => {
		const fake = create();
		const checkpoint = fake.historyId;
		fake.addMessage({ id: "m1", raw: raw(), labelIds: ["INBOX"] });
		fake.setLabels("m1", ["INBOX", "UNREAD"]);
		fake.setLabels("m1", ["INBOX"]);
		fake.deleteMessage("m1");
		const response = await json<{ history: Record<string, unknown>[]; historyId: string }>(
			call(fake, `/history?startHistoryId=${checkpoint}`),
		);
		expect(response.history.flatMap((row) => Object.keys(row))).toEqual(
			expect.arrayContaining(["messagesAdded", "labelsAdded", "labelsRemoved", "messagesDeleted"]),
		);
		expect(response.historyId).toBe(fake.historyId);
		fake.expireHistory(fake.historyId);
		expect((await call(fake, `/history?startHistoryId=${checkpoint}`)).status).toBe(404);
		expect((await call(fake, "/messages")).status).toBe(200);
	});

	it("validates history filters and paginates chronological records", async () => {
		const fake = create();
		const checkpoint = fake.historyId;
		for (let n = 1; n <= 3; n++)
			fake.addMessage({ id: `m${n}`, raw: raw(String(n)), labelIds: ["INBOX"] });
		const first = await json<{
			history: { id: string }[];
			nextPageToken: string;
			historyId: string;
		}>(call(fake, `/history?startHistoryId=${checkpoint}&historyTypes=messageAdded&maxResults=2`));
		fake.addMessage({ id: "m4", raw: raw("four"), labelIds: ["INBOX"] });
		const second = await json<{ history: { id: string }[]; historyId: string }>(
			call(
				fake,
				`/history?startHistoryId=${checkpoint}&historyTypes=messageAdded&maxResults=2&pageToken=${encodeURIComponent(first.nextPageToken)}`,
			),
		);
		const ids = [...first.history, ...second.history].map((row) => BigInt(row.id));
		expect(ids).toHaveLength(3);
		expect(ids.every((value, index) => index === 0 || value > (ids[index - 1] ?? value))).toBe(
			true,
		);
		expect(second.historyId).toBe(first.historyId);
		const later = await json<{ history: { messagesAdded: { message: { id: string } }[] }[] }>(
			call(fake, `/history?startHistoryId=${second.historyId}`),
		);
		expect(
			later.history.flatMap((row) => row.messagesAdded.map((item) => item.message.id)),
		).toEqual(["m4"]);
		expect((await call(fake, "/history?startHistoryId=not-a-number")).status).toBe(400);
	});

	it("refuses absent, expired and insufficient grants without creating a send", async () => {
		const clock = manualClock(START);
		const fake = create({ clock });
		expect((await fake.fetch(`${BASE}/profile`)).status).toBe(401);
		expect((await call(fake, "/profile", {}, "DYTEST-unknown")).status).toBe(401);
		clock.advance(3_600_000);
		expect((await call(fake, "/profile")).status).toBe(401);
		clock.set(START);
		for (const token of ["DYTEST-read", "DYTEST-metadata"])
			expect(
				(await call(fake, "/messages/send", post({ raw: raw().toString("base64url") }), token))
					.status,
			).toBe(403);
		expect((await call(fake, "/messages", {}, "DYTEST-send")).status).toBe(403);
		expect(await json(call(fake, "/messages"))).toMatchObject({ resultSizeEstimate: 0 });
	});

	it("metadata grants cannot retrieve bodies or search, while read-only can read raw", async () => {
		const fake = create({ messages: [{ id: "m1", raw: raw() }] });
		expect((await call(fake, "/messages/m1?format=metadata", {}, "DYTEST-metadata")).status).toBe(
			200,
		);
		for (const path of [
			"/messages/m1?format=raw",
			"/messages/m1?format=full",
			"/messages?q=in%3Asent",
			"/threads?q=in%3Asent",
		])
			expect((await call(fake, path, {}, "DYTEST-metadata")).status).toBe(403);
		expect((await call(fake, "/messages/m1?format=raw", {}, "DYTEST-read")).status).toBe(200);
	});

	it("sends exact JSON raw once and supports actual provider metadata read-back", async () => {
		const fake = create();
		const mime = raw();
		const body = { raw: mime.toString("base64url") };
		const response = await call(fake, "/messages/send", post(body));
		expect(response.status).toBe(200);
		const sent = (await response.json()) as { id: string; threadId: string; labelIds: string[] };
		const [record] = fake.recorder.takeRequests();
		if (!record) throw new Error("DYTEST missing record");
		expect(discoveryProblems(record, sent)).toEqual([]);
		expect(record.bodySha256).toBe(sha256(JSON.stringify(body)));
		expect(record.headers).toEqual({});
		expect(sent.labelIds).toContain("SENT");
		const read = await json<{ raw: string; threadId: string }>(
			call(fake, `/messages/${sent.id}?format=raw`),
		);
		expect(Buffer.from(read.raw, "base64url")).toEqual(mime);
		expect(read.threadId).toBe(sent.threadId);
	});

	it("accepts the approved exact multipart upload and preserves binary raw bytes", async () => {
		const mime = Buffer.concat([raw("binary"), Buffer.from([0xff, 0x80])]);
		const fake = create();
		const response = await fake.fetch(
			"/upload/gmail/v1/users/me/messages/send?uploadType=multipart",
			upload(mime),
		);
		expect(response.status).toBe(200);
		const sent = (await response.json()) as { id: string };
		const record = fake.recorder.takeRequests()[0];
		if (!record) throw new Error("DYTEST missing upload");
		expect(record.bodySha256).toBe(sha256(upload(mime).body));
		expect(discoveryProblems(record, sent)).toEqual([]);
		const read = await json<{ raw: string }>(call(fake, `/messages/${sent.id}?format=raw`));
		expect(Buffer.from(read.raw, "base64url")).toEqual(mime);
	});

	it("requires thread Subject and parent headers before joining an existing thread", async () => {
		const fake = create({ messages: [{ id: "m1", threadId: "t1", raw: raw("parent") }] });
		const reply = Buffer.from(
			raw("reply")
				.toString()
				.replace(
					"\r\nMIME-Version",
					"\r\nReferences: <parent@draftyak.example>\r\nIn-Reply-To: <parent@draftyak.example>\r\nMIME-Version",
				),
		);
		const sent = await json<{ threadId: string }>(
			call(fake, "/messages/send", post({ threadId: "t1", raw: reply.toString("base64url") })),
		);
		expect(sent.threadId).toBe("t1");
		expect(
			(
				await call(
					fake,
					"/messages/send",
					post({ threadId: "t1", raw: raw("unrelated").toString("base64url") }),
				)
			).status,
		).toBe(400);
		// Strict fixture-subset refusals, not observations of Gmail's thread assignment.
		for (const changed of [
			reply.toString().replace("Subject: DYTEST plan", "Subject: DYTEST different"),
			reply.toString().replace("References: <parent@draftyak.example>\r\n", ""),
			reply.toString().replace("In-Reply-To: <parent@draftyak.example>\r\n", ""),
		])
			expect(
				(
					await call(
						fake,
						"/messages/send",
						post({ threadId: "t1", raw: Buffer.from(changed).toString("base64url") }),
					)
				).status,
			).toBe(400);
	});

	it("scripts Date and Message-ID replacement without changing body octets", async () => {
		const fake = create();
		const replacementDate = "Mon, 19 Oct 2026 09:00:00 +0000";
		fake.queueSend({
			kind: "accept",
			date: replacementDate,
			messageId: "<DYTEST-replaced@draftyak.example>",
		});
		const sent = await json<{ id: string }>(
			call(fake, "/messages/send", post({ raw: raw().toString("base64url") })),
		);
		const read = await json<{ raw: string }>(call(fake, `/messages/${sent.id}?format=raw`));
		const expected = raw()
			.toString()
			.replace("<one@draftyak.example>", "<DYTEST-replaced@draftyak.example>")
			.replace("Mon, 19 Oct 2026 08:00:00 +0000", replacementDate);
		expect(Buffer.from(read.raw, "base64url")).toEqual(Buffer.from(expected));
	});

	it("models long sending and concurrency 429s without a send or real wait", async () => {
		const clock = manualClock(START);
		const fake = create({ clock });
		fake.queueSend(
			{ kind: "mail-rate-limit", retryAfterSeconds: 14_400 },
			{ kind: "concurrent-rate-limit", retryAfterSeconds: 2 },
		);
		for (const seconds of [14_400, 2]) {
			const response = await call(
				fake,
				"/messages/send",
				post({ raw: raw().toString("base64url") }),
			);
			expect(response.status).toBe(429);
			expect(response.headers.get("retry-after")).toBe(String(seconds));
			expect(response.headers.get("date")).toBe(new Date(START).toUTCString());
		}
		expect(await json(call(fake, "/messages"))).toMatchObject({ resultSizeEstimate: 0 });
	});

	it("a lost reply leaves a sent record for conservative reconciliation", async () => {
		const fake = create();
		fake.faults.add({ kind: "drop", after: true, method: "POST", path: `${BASE}/messages/send` });
		await expect(
			call(fake, "/messages/send", post({ raw: raw().toString("base64url") })),
		).rejects.toThrow("fetch failed");
		const result = await json<{ messages: unknown[] }>(
			call(fake, "/messages?q=in%3Asent%20rfc822msgid%3Aone%40draftyak.example"),
		);
		expect(result.messages).toHaveLength(1);
	});

	it("exposes Gmail-UI scheduled mail without counting it as sent", async () => {
		const fake = create({
			messages: [
				{ id: "scheduled", raw: raw("scheduled"), labelIds: ["DRAFT", "SCHEDULED"] },
				{ id: "sent", raw: raw("sent"), labelIds: ["SENT"] },
			],
		});
		const sent = await json<{ messages: { id: string }[] }>(call(fake, "/messages?q=in%3Asent"));
		expect(sent.messages.map((message) => message.id)).toEqual(["sent"]);
		const scheduled = await json<{ messages: { id: string }[] }>(
			call(fake, "/messages?q=in%3Ascheduled"),
		);
		expect(scheduled.messages.map((message) => message.id)).toEqual(["scheduled"]);
	});

	it("supports readonly refusal and approved label mutations with discovery-valid results", async () => {
		const fake = create({ messages: [{ id: "m1", raw: raw(), labelIds: ["INBOX", "UNREAD"] }] });
		const change = post({ addLabelIds: ["STARRED"], removeLabelIds: ["UNREAD"] });
		expect((await call(fake, "/messages/m1/modify", change, "DYTEST-read")).status).toBe(403);
		fake.recorder.takeRequests();
		const response = await call(fake, "/messages/m1/modify", change);
		expect(response.status).toBe(200);
		const changed = await response.json();
		const record = fake.recorder.takeRequests()[0];
		if (!record) throw new Error("DYTEST missing mutation");
		expect(discoveryProblems(record, changed)).toEqual([]);
		expect(changed).toMatchObject({ labelIds: ["INBOX", "STARRED"] });
	});

	it("rejects unsupported wire shapes before any mailbox change", async () => {
		const fake = create();
		for (const path of [
			"/messages?sendAt=1",
			"/messages?maxResults=0",
			"/messages?maxResults=501",
			"/messages?q=a&q=b",
			"/messages/unknown?format=everything",
			"/history?startHistoryId=1&historyTypes=not-real",
			"/messages?%24.xgafv=2",
			"/messages?q=unsupported%3Asyntax",
		])
			expect((await call(fake, path)).status, path).toBe(400);
		for (const value of [
			{},
			{ raw: "not+base64url=" },
			{ raw: raw().toString("base64url"), sendAt: 1 },
		])
			expect((await call(fake, "/messages/send", post(value))).status).toBe(400);
		expect(
			(
				await call(fake, "/messages/send", {
					...post({ raw: raw().toString("base64url") }),
					headers: { "content-type": "text/plain" },
				})
			).status,
		).toBe(415);
		expect(
			(
				await call(
					fake,
					"/messages/send?uploadType=multipart",
					post({ raw: raw().toString("base64url") }),
				)
			).status,
		).toBe(400);
		expect(
			(
				await fake.fetch(
					"/upload/gmail/v1/users/me/messages/send?uploadType=resumable",
					upload(raw()),
				)
			).status,
		).toBe(400);
		for (const [before, after] of [
			["Content-Type: application/json; charset=UTF-8", "Content-Type: application/jsonish"],
			["Content-Type: message/rfc822", "Content-Type: message/"],
		] as const) {
			const invalid = upload(raw());
			expect(
				(
					await fake.fetch("/upload/gmail/v1/users/me/messages/send?uploadType=multipart", {
						...invalid,
						body: Buffer.from(invalid.body.toString("latin1").replace(before, after), "latin1"),
					})
				).status,
			).toBe(400);
		}
		expect((await call(fake, "/upload-not-used")).status).toBe(404);
		expect(
			(
				await fake.fetch("/upload/gmail/v1/users/me/messages/send?uploadType=multipart", {
					...post({ raw: raw().toString("base64url") }),
					headers: { authorization: "Bearer DYTEST-full", "content-type": "application/json" },
				})
			).status,
		).toBe(415);
		for (const name of ["x-http-method", "x-http-method-override", "x-method-override"])
			expect((await call(fake, "/profile", { headers: { [name]: "POST" } })).status).toBe(400);
		expect(await json(call(fake, "/messages"))).toMatchObject({ resultSizeEstimate: 0 });
	});

	it("counts independent read and send fixture budgets without creating an over-budget send", async () => {
		const clock = manualClock(START);
		const fake = create({
			clock,
			readBudget: { units: 1, windowMs: 60_000 },
			sendBudget: { units: 1, windowMs: 60_000 },
		});
		expect((await call(fake, "/profile")).status).toBe(200);
		expect((await call(fake, "/profile")).status).toBe(429);
		expect(
			(await call(fake, "/messages/send", post({ raw: raw().toString("base64url") }))).status,
		).toBe(200);
		expect(
			(await call(fake, "/messages/send", post({ raw: raw("two").toString("base64url") }))).status,
		).toBe(429);
		clock.advance(60_000);
		expect(await json(call(fake, "/messages"))).toMatchObject({ resultSizeEstimate: 1 });
	});

	it("refuses malformed projections before applying sends or label mutations", async () => {
		const fake = create({ messages: [{ id: "m1", raw: raw(), labelIds: ["INBOX"] }] });
		const before = fake.historyId;
		for (const fields of ["(", "constructor"]) {
			const suffix = `?fields=${encodeURIComponent(fields)}`;
			for (const [path, value] of [
				["/messages/send", { raw: raw("new").toString("base64url") }],
				["/messages/m1/modify", { addLabelIds: ["STARRED"] }],
				["/messages/batchModify", { ids: ["m1"], addLabelIds: ["STARRED"] }],
			] as const) {
				expect((await call(fake, `${path}${suffix}`, post(value))).status).toBe(400);
				expect(fake.historyId).toBe(before);
				expect(fake.message("m1").labelIds).toEqual(["INBOX"]);
			}
		}
		expect(await json(call(fake, "/messages"))).toMatchObject({ resultSizeEstimate: 1 });
	});

	it("projects bounded fields without descending into inherited selection properties", async () => {
		const fake = create({ messages: [{ id: "m1", raw: raw() }] });
		const selected = await json(call(fake, "/messages?fields=messages(id),resultSizeEstimate"));
		expect(selected).toEqual({ messages: [{ id: "m1" }], resultSizeEstimate: 1 });
		const name = "DYTEST_projection_canary";
		const before = Object.getOwnPropertyDescriptor(Object.prototype, name);
		try {
			const response = await call(fake, `/profile?fields=__proto__/${name}`);
			await response.arrayBuffer();
			expect([200, 400]).toContain(response.status);
			expect(Object.getOwnPropertyDescriptor(Object.prototype, name)).toEqual(before);
		} finally {
			if (before) Object.defineProperty(Object.prototype, name, before);
			else Reflect.deleteProperty(Object.prototype, name);
		}
	});

	it("copies fixture input and output without exposing mutable mailbox state", async () => {
		const mime = raw();
		const labels = ["INBOX"];
		const fake = create({ messages: [{ id: "m1", raw: mime, labelIds: labels }] });
		const expected = Buffer.from(mime);
		mime.fill(0);
		labels.push("SENT");
		const first = fake.message("m1");
		if (!first) throw new Error("DYTEST missing message");
		first.raw.fill(0);
		const fetched = await json<{ raw: string; labelIds: string[] }>(
			call(fake, "/messages/m1?format=raw"),
		);
		expect(Buffer.from(fetched.raw, "base64url")).toEqual(expected);
		expect(fetched.labelIds).toEqual(["INBOX"]);
	});

	it("rejects invalid seed/control batches without partially changing mailbox or send queue", async () => {
		const fake = create({ messages: [{ id: "m1", raw: raw() }] });
		const before = fake.historyId;
		expect(() => fake.addMessage({ id: "m1", raw: raw("duplicate") })).toThrow();
		expect(() => fake.setLabels("m1", ["INBOX", "\r\nDYTEST"])).toThrow();
		expect(fake.historyId).toBe(before);
		expect(() =>
			fake.queueSend(
				{ kind: "mail-rate-limit", retryAfterSeconds: 5 },
				{ kind: "concurrent-rate-limit", retryAfterSeconds: -1 },
			),
		).toThrow();
		expect(
			(await call(fake, "/messages/send", post({ raw: raw("two").toString("base64url") }))).status,
		).toBe(200);
		expect(() => create({ readBudget: { units: -1, windowMs: 60_000 } })).toThrow();
	});

	it("uses the shared loopback listener and preserves credential value redaction", async () => {
		const recorder = createRecorder();
		const fake = create({ recorder });
		const listening = open.keep(await fake.listen());
		const denied = await getWithHost(listening, `${BASE}/profile`, GMAIL_HOST);
		expect(denied.status).toBe(401);
		recorder.takeRequests();
		await call(fake, "/profile");
		const record = recorder.takeRequests()[0];
		expect(record?.headerNames).toContain("authorization");
		expect(record?.headers).toEqual({});
	});
});
