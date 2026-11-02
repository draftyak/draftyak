import { describe, expect, it } from "vitest";
import { canonicalChannelUrl } from "../../../../src/plugins/broker/channel/index.ts";

const BACKSLASH = String.fromCharCode(92);
const TAB = String.fromCharCode(9);
const prefix = "https://slack.com/api/auth.test?x=";

describe("canonical channel URLs", () => {
	it("splits a canonical URL into its host, path segments and decoded query names", () => {
		const href =
			"https://gmail.googleapis.com/gmail/v1/users/user%40example.com/messages?q=in%3Ainbox&labelIds=INBOX&labelIds=UNREAD";
		const url = canonicalChannelUrl(href);
		expect(url).toEqual({
			href,
			host: "gmail.googleapis.com",
			segments: ["gmail", "v1", "users", "user%40example.com", "messages"],
			queryNames: ["q", "labelIds", "labelIds"],
		});
		expect(Object.isFrozen(url) && Object.isFrozen(url?.segments)).toBe(true);
		expect(Object.isFrozen(url?.queryNames)).toBe(true);
		expect(canonicalChannelUrl("https://slack.com/api/auth.test?%24alt=json")?.queryNames).toEqual([
			"$alt",
		]);
		expect(canonicalChannelUrl("https://slack.com/")?.segments).toEqual([]);
		// A query value may still carry an encoded percent sign, as a search for "100%" does.
		expect(canonicalChannelUrl("https://slack.com/api/search?q=100%25")?.queryNames).toEqual(["q"]);
	});

	it("accepts 8192 characters and refuses one more", () => {
		const longest = `${prefix}${"a".repeat(8192 - prefix.length)}`;
		expect(canonicalChannelUrl(longest)?.href).toBe(longest);
		expect(canonicalChannelUrl(`${longest}a`)).toBeUndefined();
	});

	it.each([
		["http", "http://slack.com/api/auth.test"],
		["a WebSocket scheme", "wss://slack.com/api/auth.test"],
		["an upper-case scheme", "HTTPS://slack.com/api/auth.test"],
		["userinfo", "https://user@slack.com/api/auth.test"],
		["userinfo with a password", "https://user:pw@slack.com/api/auth.test"],
		["an explicit port 443", "https://slack.com:443/api/auth.test"],
		["another port", "https://slack.com:8443/api/auth.test"],
		["a fragment", "https://slack.com/api/auth.test#x"],
		["an empty fragment", "https://slack.com/api/auth.test#"],
		["an upper-case host", "https://Slack.com/api/auth.test"],
		["a non-ASCII host", `https://sl${String.fromCharCode(0x430)}ck.com/api/auth.test`],
		["an IPv4 literal", "https://192.0.2.1/api/auth.test"],
		["an IPv6 literal", "https://[2001:db8::1]/api/auth.test"],
		["a trailing-dot host", "https://slack.com./api/auth.test"],
		["localhost", "https://localhost/api/auth.test"],
		["an internal name", "https://slack.internal/api/auth.test"],
		["a link-local name", "https://printer.local/api/auth.test"],
		["a dot-dot segment", "https://slack.com/api/../api/auth.test"],
		["a dot segment", "https://slack.com/api/./auth.test"],
		["an encoded dot-dot segment", "https://slack.com/api/%2E%2E/auth.test"],
		["an encoded slash", "https://slack.com/api%2Fauth.test"],
		["a lower-case encoded slash", "https://slack.com/api%2fauth.test"],
		["an encoded backslash", "https://slack.com/api%5Cauth.test"],
		["a double-encoded slash", "https://slack.com/api%252Fauth.test"],
		["a double-encoded dot-dot segment", "https://slack.com/api/%252E%252E/auth.test"],
		["an encoded percent sign in the path", "https://slack.com/api/auth.test%25"],
		["a backslash", `https://slack.com${BACKSLASH}api${BACKSLASH}auth.test`],
		["an empty segment", "https://slack.com//api/auth.test"],
		["a trailing slash", "https://slack.com/api/auth.test/"],
		["a lower-case escape", "https://slack.com/api/%c3%a9"],
		["an encoded unreserved character", "https://slack.com/api/%61uth.test"],
		["a raw space", "https://slack.com/api/auth test"],
		["a raw non-ASCII path", `https://slack.com/api/${String.fromCharCode(0xe9)}`],
		["a tab", `https://slack.com/api/auth.test${TAB}`],
		["an empty query", "https://slack.com/api/auth.test?"],
		["an apostrophe in the query", "https://slack.com/api/auth.test?a='b"],
		["a truncated escape", "https://slack.com/api/auth.test?a=%2"],
		["no path", "https://slack.com"],
	])("refuses %s", (_name, url) => {
		expect(canonicalChannelUrl(url)).toBeUndefined();
	});

	it.each([
		undefined,
		null,
		42,
		{},
		["https://slack.com/api/auth.test"],
		new URL("https://slack.com/api/auth.test"),
	])("refuses the non-string %s", (value) => {
		expect(canonicalChannelUrl(value)).toBeUndefined();
	});
});
