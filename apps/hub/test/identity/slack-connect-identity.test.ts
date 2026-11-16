import { Buffer } from "node:buffer";
import { describe, expect, it, vi } from "vitest";
import {
	parseSlackConnectIdentity,
	SlackConnectIdentityError,
} from "../../src/identity/slack-connect-identity.ts";

const headers = (): string[] => [
	"Content-Type",
	"application/json; charset=utf-8",
	"X-OAuth-Scopes",
	"channels:read, chat:write",
	"X-Accepted-OAuth-Scopes",
	"admin:read",
];
const body = (fields: Record<string, unknown> = {}): Buffer =>
	Buffer.from(JSON.stringify({ ok: true, team_id: "T123", user_id: "U123", ...fields }));
const parse = (fields: Record<string, unknown> = {}, rawHeaders: unknown = headers()) =>
	parseSlackConnectIdentity(body(fields), rawHeaders);

function refused(bytes: unknown, rawHeaders: unknown = headers()): void {
	let failure: unknown;
	try {
		parseSlackConnectIdentity(bytes, rawHeaders);
	} catch (error) {
		failure = error;
	}
	expect(failure).toBeInstanceOf(SlackConnectIdentityError);
	if (!(failure instanceof SlackConnectIdentityError)) throw Error("Expected fixed refusal");
	expect(failure.code).toBe("SLACK_IDENTITY_UNAVAILABLE");
	expect(failure.message).toBe("Slack identity unavailable");
	expect(Object.hasOwn(failure, "cause")).toBe(false);
}

describe("Slack connect identity response DATA", () => {
	it("captures actual identity and returned scopes without granting scope policy", () => {
		const result = parse({ bot_id: "BOTHER", checked: true, url: "https://example.invalid/" });
		expect(result).toEqual({
			teamId: "T123",
			selfUserId: "U123",
			scopes: ["channels:read", "chat:write"],
		});
		expect(Object.keys(result)).toEqual(["teamId", "selfUserId", "scopes"]);
		expect(Object.isFrozen(result)).toBe(true);
		expect(Object.isFrozen(result.scopes)).toBe(true);
	});

	it("owns the body snapshot and returns metadata detached from both inputs", () => {
		const bytes = body();
		const before = Buffer.from(bytes);
		const rawHeaders = headers();
		const result = parseSlackConnectIdentity(bytes, rawHeaders);
		expect(bytes.equals(before)).toBe(true);
		bytes.fill(0);
		rawHeaders[3] = "different:scope";
		expect(result.selfUserId).toBe("U123");
		expect(result.scopes).toEqual(["channels:read", "chat:write"]);
	});

	it("accepts explicit null team and exact ProviderId boundaries", () => {
		expect(parse({ team_id: null, user_id: "!" }).teamId).toBeNull();
		const id = "~".repeat(256);
		expect(parse({ team_id: id, user_id: id }).selfUserId).toBe(id);
	});

	it.each(["", "x".repeat(257), " U123", "U123\n", "U123\t", "U123\u007f", "é"])(
		"refuses an out-of-grammar provider id %#",
		(value) => {
			refused(body({ user_id: value }));
			refused(body({ team_id: value }));
		},
	);

	it.each([
		'{"ok":false,"team_id":"T123","user_id":"U123"}',
		'{"ok":1,"team_id":"T123","user_id":"U123"}',
		'{"team_id":"T123","user_id":"U123"}',
		'{"ok":true,"user_id":"U123"}',
		'{"ok":true,"team_id":"T123","bot_id":"B123"}',
		'{"ok":true,"team_id":"T123","user_id":null}',
		"null",
		"[]",
		'{"ok":false,"ok":true,"team_id":"T123","user_id":"U123"}',
		'{"ok":true,"team_id":"T123","user_id":"U123","user_\\u0069d":"U456"}',
		'{"ok":true,"team_id":"T123","user_id":"U123","extra":{"x":1,"x":2}}',
		'{"ok":true,"team_id":"T123","user_id":"U123"} true',
		'{"ok":true,"team_id":"T123","user_id":"U123",}',
	])("requires successful auth.test fields and strict unambiguous JSON %#", (json) =>
		refused(Buffer.from(json)),
	);

	it("refuses invalid UTF-8 and excessive JSON nesting", () => {
		refused(
			Buffer.concat([
				Buffer.from('{"ok":true,"team_id":"T123","user_id":"U123","extra":"'),
				Buffer.from([0xff]),
				Buffer.from('"}'),
			]),
		);
		refused(
			Buffer.from(
				'{"ok":true,"team_id":"T123","user_id":"U123","extra":' +
					"[".repeat(65) +
					"0" +
					"]".repeat(65) +
					"}",
			),
		);
	});

	it("bounds response bytes while allowing an exact 64 KiB JSON document", () => {
		const empty = body({ padding: "" });
		const exact = body({ padding: "x".repeat(65_536 - empty.length) });
		expect(exact.length).toBe(65_536);
		expect(parseSlackConnectIdentity(exact, headers()).selfUserId).toBe("U123");
		refused(Buffer.alloc(0));
		refused(Buffer.concat([exact, Buffer.from(" ")]));
	});

	it("accepts a genuine nonshared Uint8Array without reading overridden properties", () => {
		const bytes = new Uint8Array(body());
		const get = vi.fn();
		for (const key of ["buffer", "byteLength", "length"])
			Object.defineProperty(bytes, key, { get });
		expect(parseSlackConnectIdentity(bytes, headers()).selfUserId).toBe("U123");
		expect(get).not.toHaveBeenCalled();
	});

	it("rejects proxy, structural, shared and detached bodies without invoking hooks", () => {
		const get = vi.fn();
		refused(new Proxy(body(), { get }));
		refused(Object.defineProperty({}, "byteLength", { get }));
		refused(new DataView(new ArrayBuffer(8)));
		refused(new Uint16Array(8));
		const shared = new Uint8Array(new SharedArrayBuffer(body().length));
		shared.set(body());
		refused(shared);
		const detached = new Uint8Array(64);
		structuredClone(detached.buffer, { transfer: [detached.buffer] });
		refused(detached);
		expect(get).not.toHaveBeenCalled();
	});

	it("uses unique case-insensitive returned scopes and never accepted-scopes fallback", () => {
		expect(
			parseSlackConnectIdentity(body(), ["x-OAuTh-SCoPes", " unfamiliar:scope\t"]).scopes,
		).toEqual(["unfamiliar:scope"]);
		refused(body(), ["x-accepted-oauth-scopes", "channels:read"]);
		refused(body(), ["X-OAuth-Scopes", "channels:read", "x-oauth-scopes", "chat:write"]);
		expect(parseSlackConnectIdentity(body(), ["x-oauth-scopes", ""]).scopes).toEqual([]);
	});

	it.each(["a,,b", ",a", "a,", "a,a", "a b", '"a"', "a\\b", "a\rb", "a\nb", "é"])(
		"refuses ambiguous or corrupt scope syntax %#",
		(value) => refused(body(), ["x-oauth-scopes", value]),
	);

	it("rejects proxy and accessor headers before running any supplied hook", () => {
		const get = vi.fn();
		refused(body(), new Proxy(headers(), { get, ownKeys: get }));
		const accessor = headers();
		Object.defineProperty(accessor, "3", { get });
		refused(body(), accessor);
		expect(get).not.toHaveBeenCalled();
	});

	it("refuses malformed raw header arrays instead of coercing values", () => {
		refused(body(), { "x-oauth-scopes": "channels:read" });
		refused(body(), ["x-oauth-scopes"]);
		refused(body(), ["x-oauth-scopes", 1]);
		refused(body(), ["x-oauth-scopes", "channels:read", "Bad Name", "value"]);
		const sparse = headers();
		delete sparse[0];
		refused(body(), sparse);
	});

	it("enforces exact raw-header pair and framing byte bounds", () => {
		const many = ["x-oauth-scopes", "channels:read"];
		for (let index = 0; index < 127; index++) many.push("X-Extra", "");
		expect(parseSlackConnectIdentity(body(), many).scopes.length).toBe(1);
		refused(body(), [...many, "X-Extra", ""]);
		const framed = ["x-oauth-scopes", "channels:read", "X-Padding", ""];
		const used = framed.reduce((sum, value) => sum + Buffer.byteLength(value), 8);
		framed[3] = "x".repeat(16_384 - used);
		expect(parseSlackConnectIdentity(body(), framed).selfUserId).toBe("U123");
		framed[3] += "x";
		refused(body(), framed);
	});
});
