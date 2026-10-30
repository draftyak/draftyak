import type { ChannelProfile } from "@draftyak/protocol/manifest";
import { describe, expect, it } from "vitest";
import {
	CHANNEL_METHODS,
	type ChannelClassification,
	type ChannelMethod,
	type ChannelUrl,
	canonicalChannelUrl,
	classifyChannelRequest,
	PROFILE_CLASSES,
} from "../../../../src/plugins/broker/channel/index.ts";

const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";
const UPLOAD = "https://gmail.googleapis.com/upload/gmail/v1/users/me";
const RESUMABLE = "https://gmail.googleapis.com/resumable/upload/gmail/v1/users/me";
const SLACK = "https://slack.com/api";
const ID = "18c2f0a1b2c3d4e5";
const GMAIL_PROFILES = ["gmail-v1", "gmail-readonly-v1"] as const;
const PROFILES = [...GMAIL_PROFILES, "slack-v1"] as const;

function url(href: string): ChannelUrl {
	const parsed = canonicalChannelUrl(href);
	if (!parsed) throw new Error("Test URL is not canonical");
	return parsed;
}
function classify(profile: ChannelProfile, method: ChannelMethod, href: string) {
	const found = classifyChannelRequest(profile, method, url(href));
	expect(Object.isFrozen(found)).toBe(true);
	return found;
}
const READ: ChannelClassification = { class: "read" };
const ORGANIZE: ChannelClassification = { class: "organize" };
const SEND: ChannelClassification = { class: "send" };

const GMAIL_READS = [
	`${GMAIL}/messages`,
	`${GMAIL}/messages?q=in%3Ainbox&maxResults=50&pageToken=CAEQAA&labelIds=INBOX&labelIds=UNREAD`,
	`${GMAIL}/messages?fields=messages(id,threadId),nextPageToken`,
	`${GMAIL}/messages/${ID}`,
	`${GMAIL}/messages/${ID}?format=metadata&metadataHeaders=Subject`,
	`${GMAIL}/messages/${ID}/attachments/ANGjdJ8wXyZ_-0`,
	`${GMAIL}/threads`,
	`${GMAIL}/threads/${ID}?format=minimal`,
	`${GMAIL}/history?startHistoryId=1234&historyTypes=messageAdded`,
	`${GMAIL}/labels`,
	`${GMAIL}/labels/Label_12`,
	"https://www.googleapis.com/gmail/v1/users/me/messages",
	"https://gmail.googleapis.com/gmail/v1/users/user@example.com/labels",
];
const GMAIL_ORGANIZE = [
	`${GMAIL}/messages/batchModify`,
	`${GMAIL}/messages/${ID}/modify`,
	`${GMAIL}/threads/${ID}/modify`,
	"https://www.googleapis.com/gmail/v1/users/me/threads/abc/modify",
];
// Every spelling of a send endpoint, whatever the method, is send class, so only a ticket admits it.
const GMAIL_SENDS: readonly (readonly [ChannelMethod, string])[] = [
	["POST", `${GMAIL}/messages/send`],
	["POST", `${UPLOAD}/messages/send?uploadType=multipart`],
	["POST", "https://www.googleapis.com/upload/gmail/v1/users/me/messages/send?uploadType=media"],
	["POST", `${GMAIL}/drafts/send`],
	["POST", `${UPLOAD}/drafts/send?uploadType=multipart`],
	["POST", `${RESUMABLE}/messages/send?uploadType=resumable`],
	["PUT", `${RESUMABLE}/drafts/send?uploadType=resumable&upload_id=DYTEST1`],
	["GET", `${GMAIL}/messages/send`],
	["HEAD", `${GMAIL}/drafts/send`],
	["DELETE", `${UPLOAD}/messages/send`],
	["POST", `${GMAIL}/messages/SEND`],
	["POST", "https://gmail.googleapis.com/Upload/Gmail/V1/Users/me/Messages/Send"],
	["POST", `${GMAIL}/messages/send?$alt=json`],
	["POST", `${GMAIL}/messages/send?access_token=DYTEST-token`],
];
const GMAIL_OFF_PROFILE: readonly (readonly [ChannelMethod, string])[] = [
	["DELETE", `${GMAIL}/messages/${ID}`],
	["POST", `${GMAIL}/messages/${ID}/trash`],
	["POST", `${GMAIL}/messages/${ID}/untrash`],
	["POST", `${GMAIL}/threads/${ID}/trash`],
	["DELETE", `${GMAIL}/threads/${ID}`],
	["POST", `${GMAIL}/messages/batchDelete`],
	["POST", `${GMAIL}/messages`],
	["POST", `${GMAIL}/messages/import`],
	["POST", `${UPLOAD}/messages/import?uploadType=multipart`],
	["POST", `${GMAIL}/drafts`],
	["GET", `${GMAIL}/drafts`],
	["PUT", `${GMAIL}/drafts/${ID}`],
	["GET", `${GMAIL}/settings/filters`],
	["POST", `${GMAIL}/settings/forwardingAddresses`],
	["PUT", `${GMAIL}/settings/autoForwarding`],
	["GET", `${GMAIL}/profile`],
	["POST", `${GMAIL}/watch`],
	["POST", `${GMAIL}/stop`],
	["POST", `${GMAIL}/labels`],
	["PATCH", `${GMAIL}/labels/Label_12`],
	["DELETE", `${GMAIL}/labels/Label_12`],
	["HEAD", `${GMAIL}/messages`],
	["OPTIONS", `${GMAIL}/messages`],
	["POST", `${GMAIL}/messages/${ID}`],
	["GET", `${GMAIL}/messages/${ID}/modify`],
	["PUT", `${GMAIL}/threads/${ID}/modify`],
	["GET", `${GMAIL}/messages/batchModify/more`],
	["GET", `${GMAIL}/Messages`],
	["GET", "https://gmail.googleapis.com/gmail/v2/users/me/messages"],
	["GET", "https://gmail.googleapis.com/gmail/v1/users/me"],
	["GET", "https://gmail.googleapis.com/"],
	["GET", "https://www.googleapis.com/drive/v3/files"],
	["POST", "https://oauth2.googleapis.com/revoke?token=DYTEST-token"],
	["GET", "https://gmail.googleapis.com.example.com/gmail/v1/users/me/messages"],
	["GET", "https://mail.google.com/mail/feed/atom"],
	["GET", `${SLACK}/auth.test`],
];
const GMAIL_BATCH: readonly (readonly [ChannelMethod, string])[] = [
	["POST", "https://www.googleapis.com/batch/gmail/v1"],
	["POST", "https://gmail.googleapis.com/batch/gmail/v1"],
	["POST", "https://gmail.googleapis.com/batch"],
	["POST", "https://gmail.googleapis.com/Batch/gmail/v1"],
	["GET", "https://www.googleapis.com/batch"],
];
const SLACK_READS = [
	"conversations.history",
	"conversations.replies",
	"conversations.list",
	"conversations.info",
	"conversations.members",
	"users.list",
	"users.info",
	"auth.test",
	"apps.connections.open",
];
const SLACK_SENDS: readonly (readonly [ChannelMethod, string])[] = [
	["POST", `${SLACK}/chat.postMessage`],
	["GET", `${SLACK}/chat.postMessage?channel=C0123&text=hi`],
	["PUT", `${SLACK}/chat.postMessage`],
	["POST", `${SLACK}/chat.POSTMESSAGE`],
	["POST", "https://slack.com/API/chat.postMessage"],
	["POST", `${SLACK}/chat.postMessage?token=DYTEST-token`],
];
const SLACK_SCHEDULING: readonly (readonly [ChannelMethod, string])[] = [
	["POST", `${SLACK}/chat.scheduleMessage`],
	["GET", `${SLACK}/chat.scheduleMessage?channel=C0123&post_at=1900000000&text=hi`],
	["POST", `${SLACK}/chat.deleteScheduledMessage`],
	["POST", `${SLACK}/chat.scheduledMessages.list`],
	["GET", `${SLACK}/chat.scheduledMessages.list`],
	["POST", `${SLACK}/CHAT.SCHEDULEMESSAGE`],
	["POST", "https://slack.com/Api/chat.deleteScheduledMessage"],
];
const SLACK_HUB_ONLY: readonly (readonly [ChannelMethod, string])[] = [
	["POST", `${SLACK}/auth.revoke`],
	["GET", `${SLACK}/auth.revoke?test=true`],
	["POST", `${SLACK}/Auth.Revoke`],
	["POST", "https://slack.com/API/auth.revoke"],
];
const SLACK_OFF_PROFILE: readonly (readonly [ChannelMethod, string])[] = [
	["POST", `${SLACK}/chat.update`],
	["POST", `${SLACK}/chat.delete`],
	["POST", `${SLACK}/chat.postEphemeral`],
	["POST", `${SLACK}/chat.meMessage`],
	["POST", `${SLACK}/files.upload`],
	["POST", `${SLACK}/files.completeUploadExternal`],
	["POST", `${SLACK}/reactions.add`],
	["POST", `${SLACK}/conversations.join`],
	["POST", `${SLACK}/conversations.open`],
	["POST", `${SLACK}/users.profile.set`],
	["GET", `${SLACK}/search.messages`],
	["POST", `${SLACK}/oauth.v2.access`],
	["PUT", `${SLACK}/conversations.history`],
	["DELETE", `${SLACK}/auth.test`],
	["HEAD", `${SLACK}/auth.test`],
	["OPTIONS", `${SLACK}/auth.test`],
	["GET", `${SLACK}/Conversations.history`],
	["GET", "https://slack.com/API/conversations.history"],
	["GET", "https://slack.com/api"],
	["GET", `${SLACK}/conversations.history/more`],
	["GET", "https://slack.com/conversations.history"],
	["GET", "https://api.slack.com/api/auth.test"],
	["POST", "https://hooks.slack.com/api/chat.postMessage"],
	["GET", "https://files.slack.com/api/auth.test"],
	["GET", "https://wss-primary.slack.com/api/auth.test"],
	["GET", "https://slack.com.example.com/api/auth.test"],
	["GET", `${GMAIL}/messages`],
	["POST", "https://www.googleapis.com/batch/gmail/v1"],
];

describe("gmail-v1 and gmail-readonly-v1 classification", () => {
	it.each(GMAIL_PROFILES)("classifies GET reads for %s", (profile) => {
		for (const href of GMAIL_READS) expect(classify(profile, "GET", href)).toEqual(READ);
	});

	it.each(GMAIL_PROFILES)(
		"classifies POST modify and batchModify as organize for %s",
		(profile) => {
			for (const href of GMAIL_ORGANIZE) expect(classify(profile, "POST", href)).toEqual(ORGANIZE);
		},
	);

	it.each(GMAIL_SENDS)("classifies %s %s as send", (method, href) => {
		for (const profile of GMAIL_PROFILES) expect(classify(profile, method, href)).toEqual(SEND);
	});

	it.each(GMAIL_OFF_PROFILE)("denies %s %s", (method, href) => {
		for (const profile of GMAIL_PROFILES)
			expect(classify(profile, method, href)).toEqual({ denied: "off_profile" });
	});

	it.each(GMAIL_BATCH)("denies %s %s as batch", (method, href) => {
		for (const profile of GMAIL_PROFILES)
			expect(classify(profile, method, href)).toEqual({ denied: "gmail_batch" });
	});
});

describe("slack-v1 classification", () => {
	it.each(SLACK_READS)("classifies GET and POST %s as read", (name) => {
		expect(classify("slack-v1", "GET", `${SLACK}/${name}`)).toEqual(READ);
		expect(classify("slack-v1", "POST", `${SLACK}/${name}`)).toEqual(READ);
		expect(
			classify("slack-v1", "GET", `${SLACK}/${name}?channel=C0123&limit=20&cursor=dXNlcg%3D%3D`),
		).toEqual(READ);
	});

	it.each(SLACK_SENDS)("classifies %s %s as send", (method, href) => {
		expect(classify("slack-v1", method, href)).toEqual(SEND);
	});

	it.each(SLACK_SCHEDULING)("denies the scheduling request %s %s", (method, href) => {
		expect(classify("slack-v1", method, href)).toEqual({ denied: "slack_scheduling" });
	});

	it.each(SLACK_HUB_ONLY)("keeps %s %s to the hub", (method, href) => {
		expect(classify("slack-v1", method, href)).toEqual({ denied: "hub_only" });
	});

	it.each(SLACK_OFF_PROFILE)("denies %s %s", (method, href) => {
		expect(classify("slack-v1", method, href)).toEqual({ denied: "off_profile" });
	});
});

describe("query rules", () => {
	it.each([
		["gmail-v1", "GET", `${GMAIL}/messages?$alt=media`],
		["gmail-v1", "GET", `${GMAIL}/messages?q=x&$fields=messages`],
		["gmail-v1", "GET", `${GMAIL}/messages?$.xgafv=2`],
		["gmail-v1", "GET", `${GMAIL}/messages?%24prettyPrint=false`],
		["gmail-v1", "POST", `${GMAIL}/messages/batchModify?$callback=f`],
		["gmail-readonly-v1", "GET", `${GMAIL}/labels?$key=DYTEST-key`],
		["slack-v1", "GET", `${SLACK}/conversations.history?$alt=json`],
	] as const)("refuses a system parameter on %s %s %s", (profile, method, href) => {
		expect(classify(profile, method, href)).toEqual({ denied: "system_parameter" });
	});

	it.each([
		["gmail-v1", "GET", `${GMAIL}/messages?access_token=DYTEST-token`],
		["gmail-v1", "GET", `${GMAIL}/messages?maxResults=1&key=DYTEST-key`],
		["gmail-v1", "POST", `${GMAIL}/threads/${ID}/modify?oauth_token=DYTEST-token`],
		["gmail-readonly-v1", "GET", `${GMAIL}/history?startHistoryId=1&access_token=DYTEST-token`],
		["slack-v1", "GET", `${SLACK}/auth.test?token=DYTEST-token`],
		["slack-v1", "POST", `${SLACK}/conversations.list?limit=10&token=DYTEST-token`],
		["gmail-v1", "GET", `${GMAIL}/messages?Access_Token=DYTEST-token`],
		["gmail-v1", "GET", `${GMAIL}/labels?KEY=DYTEST-key`],
		["gmail-readonly-v1", "GET", `${GMAIL}/threads?OAUTH_TOKEN=DYTEST-token`],
		["slack-v1", "GET", `${SLACK}/conversations.info?channel=C0123&Token=DYTEST-token`],
	] as const)("refuses a query credential on %s %s %s", (profile, method, href) => {
		expect(classify(profile, method, href)).toEqual({ denied: "query_credential" });
	});
});

describe("profile classes", () => {
	it("permits read everywhere, organize on gmail-v1 and send on gmail-v1 and slack-v1", () => {
		expect(PROFILE_CLASSES).toEqual({
			"gmail-v1": ["read", "organize", "send"],
			"gmail-readonly-v1": ["read"],
			"slack-v1": ["read", "send"],
		});
		expect(Object.isFrozen(PROFILE_CLASSES)).toBe(true);
		for (const profile of PROFILES) expect(Object.isFrozen(PROFILE_CLASSES[profile])).toBe(true);
		expect(CHANNEL_METHODS).toEqual(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);
		expect(Object.isFrozen(CHANNEL_METHODS)).toBe(true);
	});

	it.each(["gmail-v2", "toString", "__proto__", "constructor", ""])(
		"throws for the unknown profile %j",
		(profile) => {
			expect(() =>
				classifyChannelRequest(profile as ChannelProfile, "GET", url(`${GMAIL}/messages`)),
			).toThrow(TypeError);
		},
	);
});
