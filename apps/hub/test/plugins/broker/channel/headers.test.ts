import type { ChannelProfile } from "@draftyak/protocol/manifest";
import { describe, expect, it } from "vitest";
import {
	CHANNEL_REQUEST_HEADERS,
	channelRequestHeaders,
	METHOD_OVERRIDE_HEADERS,
} from "../../../../src/plugins/broker/channel/index.ts";

const PROFILES: readonly ChannelProfile[] = ["gmail-v1", "gmail-readonly-v1", "slack-v1"];
const DATE = "Wed, 21 Oct 2026 07:28:00 GMT";

function throwingRow(): unknown[] {
	const rows: unknown[] = [];
	Object.defineProperty(rows, "0", {
		enumerable: true,
		get() {
			throw new Error("DYTEST-getter");
		},
	});
	return rows;
}

describe("channel request headers", () => {
	it.each(PROFILES)(
		"forwards only the content headers for %s, lower-cased and in order",
		(profile) => {
			const result = channelRequestHeaders(profile, [
				["Accept", "application/json"],
				["Authorization", "Bearer DYTEST-plugin"],
				["Content-Type", "application/json; charset=UTF-8"],
				["Cookie", "sid=DYTEST-cookie"],
				["If-None-Match", '"etag-1"'],
				["X-Goog-Api-Key", "DYTEST-key"],
				["If-Modified-Since", DATE],
			]);
			expect(result).toEqual({
				headers: [
					["accept", "application/json"],
					["content-type", "application/json; charset=UTF-8"],
					["if-none-match", '"etag-1"'],
					["if-modified-since", DATE],
				],
			});
			expect(Object.isFrozen(result)).toBe(true);
			if (!("headers" in result)) throw new Error("expected headers");
			expect(Object.isFrozen(result.headers)).toBe(true);
			for (const row of result.headers) expect(Object.isFrozen(row)).toBe(true);
			expect(channelRequestHeaders(profile, [])).toEqual({ headers: [] });
		},
	);

	it.each([
		"authorization",
		"Proxy-Authorization",
		"cookie",
		"Host",
		"content-length",
		"Accept-Encoding",
		"connection",
		"keep-alive",
		"transfer-encoding",
		"te",
		"trailer",
		"upgrade",
		"proxy-connection",
		"expect",
		"range",
		"x-goog-api-key",
		"x-goog-user-project",
		"x-goog-fieldmask",
		"x-api-key",
		"user-agent",
		"origin",
		"referer",
		"forwarded",
		"x-forwarded-for",
		"x-forwarded-host",
	])("drops %s", (name) => {
		for (const profile of PROFILES)
			expect(
				channelRequestHeaders(profile, [
					[name, "DYTEST-value"],
					["accept", "*/*"],
				]),
			).toEqual({
				headers: [["accept", "*/*"]],
			});
	});

	it.each([
		"x-http-method-override",
		"X-HTTP-Method-Override",
		"x-http-method",
		"X-Http-Method",
		"x-method-override",
		"X-METHOD-OVERRIDE",
	])("refuses the method override header %s", (name) => {
		for (const profile of PROFILES)
			for (const value of ["GET", "DELETE", ""])
				expect(
					channelRequestHeaders(profile, [
						["accept", "*/*"],
						[name, value],
					]),
				).toEqual({
					denied: "method_override",
				});
	});

	it("refuses a repeated forwarded header in any case and ignores repeated dropped ones", () => {
		expect(
			channelRequestHeaders("gmail-v1", [
				["Accept", "a/b"],
				["accept", "c/d"],
			]),
		).toEqual({ denied: "headers_invalid" });
		expect(
			channelRequestHeaders("slack-v1", [
				["content-type", "application/json"],
				["Content-Type", "application/json"],
			]),
		).toEqual({ denied: "headers_invalid" });
		expect(
			channelRequestHeaders("gmail-readonly-v1", [
				["cookie", "a=1"],
				["Cookie", "b=2"],
			]),
		).toEqual({ headers: [] });
	});

	it("accepts headers up to the host header limit and refuses one character more", () => {
		const exact: [string, string][] = [
			["x-a", "a".repeat(8192)],
			["x-b", "b".repeat(8186)],
		];
		expect(channelRequestHeaders("gmail-v1", exact)).toEqual({ headers: [] });
		const over: [string, string][] = [
			["x-a", "a".repeat(8192)],
			["x-b", "b".repeat(8187)],
		];
		expect(channelRequestHeaders("gmail-v1", over)).toEqual({ denied: "headers_invalid" });
	});

	it.each([
		["no list", undefined],
		["null", null],
		["a string", "accept: */*"],
		["an object", { accept: "*/*" }],
		["a short row", [["accept"]]],
		["a long row", [["accept", "a", "b"]]],
		["a name with a space", [["acc ept", "a"]]],
		["an empty name", [["", "a"]]],
		["a numeric name", [[1, "a"]]],
		["a line break in a value", [["accept", "a\r\nx-injected: b"]]],
		["a leading space in a value", [["accept", " a"]]],
		["a non-ASCII value", [["accept", "café"]]],
		["a value over 8192 characters", [["accept", "a".repeat(8193)]]],
		["a name over 128 characters", [["x".repeat(129), "a"]]],
		["65 rows", Array.from({ length: 65 }, (_, index) => [`x-${index}`, "a"])],
		["a throwing element", throwingRow()],
		[
			"a throwing proxy",
			new Proxy([], {
				get() {
					throw new Error("DYTEST-trap");
				},
			}),
		],
	])("refuses %s", (_name, raw) => {
		expect(channelRequestHeaders("slack-v1", raw)).toEqual({ denied: "headers_invalid" });
	});

	it("uses the same allowlist for every profile and throws for an unknown one", () => {
		for (const profile of PROFILES)
			expect(CHANNEL_REQUEST_HEADERS[profile]).toEqual([
				"accept",
				"content-type",
				"if-modified-since",
				"if-none-match",
			]);
		expect(Object.isFrozen(CHANNEL_REQUEST_HEADERS)).toBe(true);
		expect(METHOD_OVERRIDE_HEADERS).toEqual([
			"x-http-method-override",
			"x-http-method",
			"x-method-override",
		]);
		expect(Object.isFrozen(METHOD_OVERRIDE_HEADERS)).toBe(true);
		for (const profile of ["gmail-v2", "toString", "__proto__"])
			expect(() => channelRequestHeaders(profile as ChannelProfile, [])).toThrow(TypeError);
	});
});
