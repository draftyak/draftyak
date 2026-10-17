import { describe, expect, it } from "vitest";
import { messageRef, reduceEvent, tsKey } from "../src/reduce.ts";
import { messageEvent, OWNER } from "./fake-slack.ts";

const CANARY = "canary-text-7f3a";
const KEYS = [
	"kind",
	"eventId",
	"eventTime",
	"team",
	"channel",
	"channelType",
	"ts",
	"threadTs",
	"user",
	"subtype",
	"change",
	"userTokens",
	"botTokens",
];

// Content Slack puts next to ids: everything here must be dropped.
const content = {
	text: CANARY,
	blocks: [{ type: "rich_text", elements: [{ type: "text", text: CANARY }] }],
	attachments: [{ fallback: CANARY, title: CANARY }],
	files: [{ id: "F0FILE001", name: `${CANARY}.pdf`, title: CANARY }],
	username: CANARY,
	icons: { emoji: CANARY },
	client_msg_id: "6b0e3c1a-0000-4000-8000-000000000000",
	app_context: { entities: [{ type: "slack#/types/channel_id", value: CANARY }] },
};

function reduced(event: Record<string, unknown>) {
	const out = reduceEvent(messageEvent(event, "EvTEST0001"));
	expect(JSON.stringify(out)).not.toContain(CANARY);
	if (out !== null) expect(KEYS).toEqual(expect.arrayContaining(Object.keys(out)));
	return out;
}

describe("reduceEvent", () => {
	it("keeps a DM's ids and timestamps and nothing else", () => {
		const out = reduced({
			channel: "D0DM00001",
			channel_type: "im",
			user: OWNER,
			ts: "1760000000.000100",
			event_ts: "1760000000.000100",
			...content,
		});
		expect(out).toEqual({
			kind: "message",
			eventId: "EvTEST0001",
			eventTime: 1_760_000_000,
			team: "T0FAKE001",
			channel: "D0DM00001",
			channelType: "im",
			ts: "1760000000.000100",
			threadTs: null,
			user: OWNER,
			subtype: null,
			change: "new",
		});
	});

	it("marks thread replies, edits, deletions and new replies to a parent", () => {
		const reply = reduced({
			channel: "C0CHAN001",
			channel_type: "channel",
			user: "U0OTHER01",
			ts: "1760000002.000200",
			thread_ts: "1760000001.000100",
			...content,
		});
		expect(reply).toMatchObject({ threadTs: "1760000001.000100", change: "new" });
		const edited = reduced({
			subtype: "message_changed",
			hidden: true,
			channel: "C0CHAN001",
			channel_type: "channel",
			ts: "1760000009.000900",
			message: { user: "U0OTHER01", ts: "1760000002.000200", ...content },
			previous_message: { user: "U0OTHER01", ts: "1760000002.000200", ...content },
		});
		expect(edited).toMatchObject({ ts: "1760000002.000200", change: "edited", user: "U0OTHER01" });
		const deleted = reduced({
			subtype: "message_deleted",
			hidden: true,
			channel: "G0GROUP01",
			channel_type: "group",
			ts: "1760000010.000100",
			deleted_ts: "1760000002.000200",
			previous_message: { user: "U0OTHER01", ts: "1760000002.000200", ...content },
		});
		expect(deleted).toMatchObject({
			ts: "1760000002.000200",
			change: "deleted",
			channelType: "group",
		});
		// Slack documents that message_replied reaches the Events API without its subtype.
		const replied = reduced({
			hidden: true,
			channel: "C0CHAN001",
			event_ts: "1760000003.000300",
			ts: "1760000003.000300",
			message: {
				user: OWNER,
				ts: "1760000001.000100",
				thread_ts: "1760000001.000100",
				reply_count: 1,
				replies: [{ user: "U0OTHER01", ts: "1760000002.000200" }],
				...content,
			},
		});
		expect(replied).toMatchObject({ ts: "1760000001.000100", threadTs: null, change: "replied" });
	});

	it("keeps Slack's documented subtypes and drops other values", () => {
		const broadcast = reduced({
			subtype: "thread_broadcast",
			channel: "C0CHAN001",
			user: "U0OTHER01",
			ts: "1760000004.000400",
			thread_ts: "1760000001.000100",
			root: { text: CANARY, user: OWNER, ts: "1760000001.000100" },
			...content,
		});
		expect(broadcast).toMatchObject({ subtype: "thread_broadcast", threadTs: "1760000001.000100" });
		const bot = reduced({
			subtype: "bot_message",
			bot_id: "B0BOT0001",
			channel: "C0CHAN001",
			ts: "1760000005.000500",
			...content,
		});
		expect(bot).toMatchObject({ subtype: "bot_message", user: null });
		const odd = reduced({ subtype: CANARY, channel: "C0CHAN001", ts: "1760000006.000600" });
		expect(odd).toMatchObject({ subtype: null });
	});

	it("drops a field that doesn't have its documented shape", () => {
		expect(reduced({ channel: CANARY, ts: "1760000000.000100" })).toBeNull();
		expect(reduced({ channel: "C0CHAN001", ts: CANARY })).toBeNull();
		const out = reduced({
			channel: "C0CHAN001",
			channel_type: CANARY,
			user: CANARY,
			ts: "1760000000.000100",
			thread_ts: CANARY,
		});
		expect(out).toMatchObject({ channelType: null, user: null, threadTs: null });
		const meta = reduceEvent({
			team_id: CANARY,
			event_id: CANARY,
			event_time: CANARY,
			event: { type: "message", channel: "C0CHAN001", ts: "1760000000.000100" },
		});
		expect(meta).toMatchObject({ eventId: null, eventTime: null, team: null });
	});

	it("reduces the revocation events to user ids, and drops every other event type", () => {
		const uninstalled = reduceEvent({
			team_id: "T0FAKE001",
			event_id: "EvUNINST01",
			event: { type: "app_uninstalled" },
		});
		expect(uninstalled).toEqual({
			kind: "app_uninstalled",
			eventId: "EvUNINST01",
			eventTime: null,
			team: "T0FAKE001",
		});
		const revoked = reduceEvent({
			event_id: "EvREVOKE01",
			event: { type: "tokens_revoked", tokens: { oauth: [OWNER, CANARY], bot: [] } },
		});
		expect(revoked).toMatchObject({ kind: "tokens_revoked", userTokens: [OWNER], botTokens: [] });
		for (const type of ["reaction_added", "channel_rename", "user_change", CANARY]) {
			expect(reduceEvent({ event: { type, name: CANARY, channel: "C0CHAN001" } })).toBeNull();
		}
		for (const payload of [null, 42, CANARY, [], { event: CANARY }, { event: [] }]) {
			expect(reduceEvent(payload)).toBeNull();
		}
	});
});

describe("messageRef and tsKey", () => {
	it("reads history items and orders timestamps exactly", () => {
		const ref = messageRef("C0CHAN001", "channel", {
			user: "U0OTHER01",
			ts: "1760000001.000100",
			thread_ts: "1760000001.000100",
			reply_count: 2,
			...content,
		});
		expect(ref).toEqual({
			channel: "C0CHAN001",
			channelType: "channel",
			ts: "1760000001.000100",
			threadTs: null,
			user: "U0OTHER01",
			subtype: null,
			change: "new",
		});
		expect(tsKey("1760000000.000002") > tsKey("1760000000.000001")).toBe(true);
		expect(tsKey("1760000000.1")).toBe(tsKey("1760000000.100000"));
		// Beyond a double's precision, which would make these equal.
		expect(tsKey("9999999999.999999") > tsKey("9999999999.999998")).toBe(true);
	});
});
