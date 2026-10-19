import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { classifySlackRequest } from "../src/index.ts";

describe("slack-v1 Web API matching", () => {
	it.each([
		"conversations.history",
		"conversations.replies",
		"conversations.info",
		"conversations.list",
		"users.conversations",
		"users.info",
		"users.list",
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
	it("separates send and hub-only revoke from plugin reads", () => {
		expect(
			classifySlackRequest({ method: "POST", url: "https://slack.com/api/chat.postMessage" }),
		).toBe("send");
		expect(classifySlackRequest({ method: "POST", url: "https://slack.com/api/auth.revoke" })).toBe(
			"hub-only",
		);
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
		["GET", "conversations.list"],
		["GET", "users.conversations"],
		["GET", "users.info"],
		["GET", "users.list"],
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
