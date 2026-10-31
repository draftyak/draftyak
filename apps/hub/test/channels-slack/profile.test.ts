import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { classifySlackRequest } from "../../src/channels/slack/index.ts";

describe("slack-v1 Web API matching", () => {
	it.each([
		"conversations.history",
		"conversations.replies",
		"conversations.info",
		"users.conversations",
		"users.info",
	])("matches the supported GET read %s", (method) =>
		expect(classifySlackRequest({ method: "GET", url: `https://slack.com/api/${method}` })).toBe(
			"read",
		),
	);
	it.each(["auth.test", "apps.connections.open"])("matches the supported POST read %s", (method) =>
		expect(classifySlackRequest({ method: "POST", url: `https://slack.com/api/${method}` })).toBe(
			"read",
		),
	);
	it.each([
		[
			"users.conversations",
			"?types=public_channel%2Cprivate_channel&exclude_archived=true&limit=20&cursor=next%3Fpage",
		],
		["users.info", "?user=U0USER001&include_locale=true"],
	])("matches supported query keys for %s", (method, query) => {
		expect(
			classifySlackRequest({ method: "GET", url: `https://slack.com/api/${method}${query}` }),
		).toBe("read");
		for (const verb of ["POST", "HEAD", "get"])
			expect(
				classifySlackRequest({ method: verb, url: `https://slack.com/api/${method}${query}` }),
			).toBe("deny");
	});
	it.each([
		["users.conversations", "?limit=20&limit=21"],
		["users.info", "?user=U0USER001&user=U0OTHER01"],
	])("rejects credentials, overrides and duplicate query keys for %s", (method, duplicate) => {
		for (const query of ["?token=PRIVATE_CANARY", "?method=users.list", "?unknown=true", duplicate])
			expect(
				classifySlackRequest({ method: "GET", url: `https://slack.com/api/${method}${query}` }),
			).toBe("deny");
	});
	it.each([
		["users.conversations", "?user=U0OTHER01"],
		["users.info", "?limit=20"],
	])("rejects query keys outside the bounded %s profile", (method, query) => {
		expect(
			classifySlackRequest({ method: "GET", url: `https://slack.com/api/${method}${query}` }),
		).toBe("deny");
	});
	it.each([
		["conversations.list", "?types=public_channel&exclude_archived=true&limit=20&cursor=next"],
		["users.list", "?limit=20&cursor=next&include_locale=true"],
	])("denies workspace-wide list reads through %s", (method, query) => {
		for (const suffix of ["", query])
			expect(
				classifySlackRequest({ method: "GET", url: `https://slack.com/api/${method}${suffix}` }),
			).toBe("deny");
	});
	it.each(["GET", "POST", "DELETE"])("denies bare plugin auth.revoke with %s", (method) => {
		expect(classifySlackRequest({ method, url: "https://slack.com/api/auth.revoke" })).toBe("deny");
	});
	it("separates send from plugin reads", () => {
		expect(
			classifySlackRequest({ method: "POST", url: "https://slack.com/api/chat.postMessage" }),
		).toBe("send");
		expect(
			classifySlackRequest({ method: "GET", url: "https://slack.com/api/chat.postMessage" }),
		).toBe("deny");
	});
	it.each(["chat.postMessage", "auth.revoke", "auth.test", "apps.connections.open"])(
		"requires an exact target without query delimiters for %s",
		(method) => {
			for (const suffix of ["?", "?&", "?unknown=value"])
				expect(
					classifySlackRequest({ method: "POST", url: `https://slack.com/api/${method}${suffix}` }),
				).toBe("deny");
		},
	);
	it.each([
		["POST", "chat.postMessage"],
		["POST", "auth.revoke"],
		["POST", "auth.test"],
		["POST", "apps.connections.open"],
		["GET", "conversations.history"],
		["GET", "conversations.replies"],
		["GET", "conversations.info"],
		["GET", "users.conversations"],
		["GET", "users.info"],
	])("denies even an empty fragment on %s %s", (method, path) => {
		expect(classifySlackRequest({ method, url: `https://slack.com/api/${path}#` })).toBe("deny");
	});
	it.each(["%3F", "%23"])(
		"preserves percent-encoded query values while refusing encoded path delimiters: %s",
		(encoded) => {
			expect(
				classifySlackRequest({
					method: "GET",
					url: `https://slack.com/api/conversations.history?channel=C0CHAN001&cursor=next${encoded}page`,
				}),
			).toBe("read");
			expect(
				classifySlackRequest({
					method: "POST",
					url: `https://slack.com/api/chat.postMessage${encoded}`,
				}),
			).toBe("deny");
		},
	);
	it.each([
		"chat.scheduleMessage",
		"chat.deleteScheduledMessage",
		"chat.scheduledMessages.list",
		"chat.delete",
		"chat.update",
		"chat.meMessage",
		"conversations.archive",
		"conversations.mark",
		"files.uploadV2",
		"search.all",
	])("denies unsupported method %s", (method) => {
		for (const verb of ["GET", "POST", "DELETE"])
			expect(classifySlackRequest({ method: verb, url: `https://slack.com/api/${method}` })).toBe(
				"deny",
			);
	});
	it("matches documented query keys and rejects credentials, override parameters and duplicates", () => {
		expect(
			classifySlackRequest({
				method: "GET",
				url: "https://slack.com/api/conversations.history?channel=C0CHAN001&limit=20&oldest=1760000001.000100",
			}),
		).toBe("read");
		for (const suffix of [
			"?token=PRIVATE_CANARY",
			"?%74oken=PRIVATE_CANARY",
			"?channel=C0CHAN001&channel=C0OTHER01",
			"?method=chat.postMessage",
			"?unknown=true",
		])
			expect(
				classifySlackRequest({
					method: "GET",
					url: `https://slack.com/api/conversations.history${suffix}`,
				}),
			).toBe("deny");
		for (const method of ["chat.postMessage", "auth.revoke", "apps.connections.open"])
			expect(
				classifySlackRequest({
					method: "POST",
					url: `https://slack.com/api/${method}?token=PRIVATE_CANARY`,
				}),
			).toBe("deny");
	});
	it.each([
		"http://slack.com/api/chat.postMessage",
		"https://slack.com.evil.invalid/api/chat.postMessage",
		"https://user@slack.com/api/chat.postMessage",
		"https://slack.com:444/api/chat.postMessage",
		"https://slack.com/api/%63hat.postMessage",
		"https://slack.com/api/a/../chat.postMessage",
		"https://slack.com/api/chat.postMessage/",
		"https://slack.com/api/chat.postMessage#x",
		"https://SLACK.com/api/chat.postMessage",
		"https://slack.com/api/chat.postMessage\n",
	])("denies noncanonical or wrong-host target %s", (url) =>
		expect(classifySlackRequest({ method: "POST", url })).toBe("deny"),
	);
	it("denies untrusted shapes without invoking getters or leaking errors", () => {
		expect(classifySlackRequest(null)).toBe("deny");
		expect(
			classifySlackRequest({
				method: "POST",
				get url() {
					throw new Error("PRIVATE_CANARY");
				},
			}),
		).toBe("deny");
		expect(
			classifySlackRequest({
				method: "POST",
				url: "https://slack.com/api/chat.postMessage",
				headers: { "x-http-method-override": "DELETE" },
			}),
		).toBe("deny");
	});
	it("arbitrary API names never gain send authority (200 runs)", () => {
		fc.assert(
			fc.property(fc.stringMatching(/^[A-Za-z]{1,20}\.[A-Za-z]{1,20}$/), (method) => {
				if (method !== "chat.postMessage")
					expect(
						classifySlackRequest({ method: "POST", url: `https://slack.com/api/${method}` }),
					).not.toBe("send");
			}),
			{ numRuns: 200, seed: 6104 },
		);
	});
});
