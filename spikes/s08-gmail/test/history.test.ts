import { afterEach, describe, expect, it } from "vitest";
import { Gmail } from "../src/api.ts";
import { readHistory, sentIn } from "../src/history.ts";
import { GMAIL_MODIFY } from "../src/oauth.ts";
import { type FakeGmail, startFakeGmail } from "./fake-gmail.ts";
import { TokenRegistry } from "./fake-google-oauth.ts";

let fake: FakeGmail | undefined;

async function setup() {
	const tokens = new TokenRegistry();
	fake = await startFakeGmail({ tokens });
	const gmail = new Gmail({
		accessToken: tokens.grant([GMAIL_MODIFY]).accessToken,
		root: fake.url,
	});
	return { fake, gmail };
}

const message = (subject: string): Buffer =>
	Buffer.from(`From: owner@example.com\r\nSubject: ${subject}\r\n\r\nbody\r\n`);

afterEach(async () => {
	if (fake === undefined) return;
	expect(fake.violations).toEqual([]);
	expect(fake.unimplemented).toEqual([]);
	await fake.close();
	fake = undefined;
});

describe("readHistory", () => {
	it("returns added messages and label changes since a history id, and the next start point", async () => {
		const { fake, gmail } = await setup();
		const start = String((await gmail.getProfile()).historyId);
		const inbound = fake.insert(message("inbound"), ["INBOX", "UNREAD"]);
		const sent = fake.insert(message("sent"), ["SENT"]);
		fake.relabel(inbound.id, [], ["UNREAD"]);
		const result = await readHistory(gmail, start);
		expect(result.expired).toBe(false);
		if (result.expired) return;
		expect(result.delta.historyId).toBe(String(fake.historyId()));
		expect(result.delta.added.map(({ id }) => id)).toEqual([inbound.id, sent.id]);
		expect(result.delta.labelsRemoved).toEqual([
			{ id: inbound.id, threadId: inbound.threadId, labelIds: ["INBOX"], changed: ["UNREAD"] },
		]);
		expect(result.delta.nextPageToken).toBeUndefined();
		const again = await readHistory(gmail, result.delta.historyId);
		expect(again.expired === false && again.delta.added).toEqual([]);
	});

	it("asks for a resync when Gmail no longer has the start point (404)", async () => {
		const { fake, gmail } = await setup();
		const start = String(fake.historyId());
		fake.insert(message("x"), ["INBOX"]);
		fake.expireHistory();
		expect(await readHistory(gmail, start)).toEqual({ expired: true });
	});

	it("reads 500 records a page and can stop early with a token to resume", async () => {
		const { fake, gmail } = await setup();
		const start = String(fake.historyId());
		for (let index = 0; index < 620; index++) fake.insert(message(`m${index}`), ["INBOX"]);
		const whole = await readHistory(gmail, start);
		expect(whole.expired === false && whole.delta.added.length).toBe(620);
		const first = await readHistory(gmail, start, { maxPages: 1 });
		if (first.expired) throw new Error("expired");
		expect(first.delta.added).toHaveLength(500);
		expect(first.delta.nextPageToken).toBeDefined();
		const rest = await readHistory(gmail, start, { pageToken: first.delta.nextPageToken ?? "" });
		expect(rest.expired === false && rest.delta.added.length).toBe(120);
	});

	it("filters by history type", async () => {
		const { fake, gmail } = await setup();
		const start = String(fake.historyId());
		const added = fake.insert(message("x"), ["INBOX", "UNREAD"]);
		fake.relabel(added.id, ["STARRED"], []);
		const result = await readHistory(gmail, start, { historyTypes: ["labelAdded"] });
		if (result.expired) throw new Error("expired");
		expect(result.delta.added).toEqual([]);
		expect(result.delta.labelsAdded.map(({ changed }) => changed)).toEqual([["STARRED"]]);
	});

	it("counts mail scheduled in the Gmail web UI as sent only once it goes out", async () => {
		const { fake, gmail } = await setup();
		const start = String(fake.historyId());
		const scheduled = fake.insert(message("later"), ["SCHEDULED"]);
		const sent = fake.insert(message("now"), ["SENT"]);
		const before = await readHistory(gmail, start);
		if (before.expired) throw new Error("expired");
		expect(sentIn(before.delta)).toEqual([sent.id]);
		fake.relabel(scheduled.id, ["SENT"], ["SCHEDULED"]);
		const after = await readHistory(gmail, before.delta.historyId);
		if (after.expired) throw new Error("expired");
		expect(sentIn(after.delta)).toEqual([scheduled.id]);
	});

	it("also when Gmail shows it as SENT and SCHEDULED, and only drops SCHEDULED", async () => {
		const { fake, gmail } = await setup();
		const start = String(fake.historyId());
		const scheduled = fake.insert(message("later"), ["SENT", "SCHEDULED"]);
		const old = fake.insert(message("old"), ["SENT", "UNREAD"]);
		const before = await readHistory(gmail, start);
		if (before.expired) throw new Error("expired");
		expect(sentIn(before.delta)).toEqual([old.id]);
		fake.relabel(scheduled.id, [], ["SCHEDULED"]);
		fake.relabel(old.id, ["STARRED"], ["UNREAD"]);
		const after = await readHistory(gmail, before.delta.historyId);
		if (after.expired) throw new Error("expired");
		expect(sentIn(after.delta)).toEqual([scheduled.id]);
	});
});
