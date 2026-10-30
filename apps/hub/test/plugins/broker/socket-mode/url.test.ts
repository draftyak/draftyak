import { describe, expect, it } from "vitest";
import {
	SOCKET_MODE_OPEN_RESPONSE_MAX_BYTES,
	SOCKET_MODE_URL_MAX_LENGTH,
	SocketModeRefusal,
	type SocketModeRefusalCode,
	socketModeEndpoint,
	socketModeOpenUrl,
} from "../../../../src/plugins/broker/socket-mode/index.ts";

const TICKET = "8f2c51d0-test-ticket";
const URL_TEXT = `wss://wss-primary.slack.com/link/?ticket=${TICKET}&app_id=A0TEST`;

function refusal(run: () => unknown): SocketModeRefusalCode | undefined {
	try {
		run();
	} catch (error) {
		if (error instanceof SocketModeRefusal) return error.code;
		throw error;
	}
	return undefined;
}

const body = (text: string): Uint8Array => new TextEncoder().encode(text);
const ok = (url: unknown): Uint8Array => body(JSON.stringify({ ok: true, url }));

describe("Socket Mode endpoint", () => {
	it("accepts Slack's own wss hosts and keeps the path and ticket for the transport only", () => {
		const endpoint = socketModeEndpoint(URL_TEXT);
		expect(endpoint).toEqual({
			host: "wss-primary.slack.com",
			port: 443,
			path: `/link/?ticket=${TICKET}&app_id=A0TEST`,
		});
		expect(Object.isFrozen(endpoint)).toBe(true);
		expect(socketModeEndpoint("wss://slack.com/")).toEqual({
			host: "slack.com",
			port: 443,
			path: "/",
		});
		expect(socketModeEndpoint("wss://a.b.slack.com/link").host).toBe("a.b.slack.com");
	});

	it("accepts the default port written out, as Slack's host rule allows", () => {
		expect(socketModeEndpoint("wss://wss-primary.slack.com:443/link/?ticket=t-1")).toEqual({
			host: "wss-primary.slack.com",
			port: 443,
			path: "/link/?ticket=t-1",
		});
		expect(socketModeEndpoint("wss://slack.com:443/")).toEqual({
			host: "slack.com",
			port: 443,
			path: "/",
		});
	});

	it("accepts a URL of exactly the length bound and refuses one character more", () => {
		const prefix = "wss://slack.com/link/?ticket=";
		const exact = prefix + "a".repeat(SOCKET_MODE_URL_MAX_LENGTH - prefix.length);
		expect(exact).toHaveLength(SOCKET_MODE_URL_MAX_LENGTH);
		expect(socketModeEndpoint(exact).path).toHaveLength(SOCKET_MODE_URL_MAX_LENGTH - 15);
		expect(refusal(() => socketModeEndpoint(`${exact}a`))).toBe("URL_TARGET");
	});

	it.each([
		["another host", "wss://example.com/link"],
		["a look-alike suffix", "wss://evilslack.com/link"],
		["Slack as a subdomain of another host", "wss://slack.com.example.com/link"],
		["a Slack host inside another host", "wss://wss-primary.slack.com.example.com/link"],
		["a trailing-dot host", "wss://slack.com./link"],
		["an upper-case host", "wss://WSS-PRIMARY.slack.com/link"],
		["a percent-encoded host", "wss://sl%61ck.com/link"],
		["an underscore in a host label", "wss://wss_primary.slack.com/link"],
		["an empty host label", "wss://wss..slack.com/link"],
		["a host label ending in a hyphen", "wss://wss-.slack.com/link"],
		["a host label of 64 characters", `wss://${"a".repeat(64)}.slack.com/link`],
		["an IPv4 literal", "wss://192.0.2.10/link"],
		["an IPv6 literal", "wss://[2001:db8::1]/link"],
		["a plaintext socket", "ws://wss-primary.slack.com/link"],
		["an https URL", "https://wss-primary.slack.com/link"],
		["an upper-case scheme", "WSS://wss-primary.slack.com/link"],
		["a user name", "wss://user@wss-primary.slack.com/link"],
		["a password", "wss://user:pass@wss-primary.slack.com/link"],
		["an empty user and password", "wss://:@wss-primary.slack.com/link"],
		["another port", "wss://wss-primary.slack.com:8443/link"],
		["the plaintext default port", "wss://wss-primary.slack.com:80/link"],
		["port 443 with a leading zero", "wss://wss-primary.slack.com:0443/link"],
		["port 443 without a path", "wss://wss-primary.slack.com:443"],
		["an empty port", "wss://wss-primary.slack.com:/link"],
		["port 443 on another host", "wss://example.com:443/link"],
		["port 443 after a user name", "wss://user@wss-primary.slack.com:443/link"],
		["port 443 on an upper-case host", "wss://WSS-PRIMARY.slack.com:443/link"],
		["port 443 with an upper-case scheme", "WSS://wss-primary.slack.com:443/link"],
		["port 443 before a backslash", "wss://slack.com:443\\link"],
		["a fragment", `${URL_TEXT}#part`],
		["an empty fragment", "wss://slack.com/#"],
		["no path", "wss://slack.com"],
		["a backslash", "wss://slack.com\\link"],
		["a backslash before the host suffix", "wss://example.com\\.slack.com/"],
		["a dot segment", "wss://slack.com/a/../link"],
		["an encoded dot segment", "wss://slack.com/a/%2e%2e/link"],
		["a space", "wss://slack.com/link /x"],
		["a tab", "wss://slack.com/li\tnk"],
		["a line feed", "wss://slack.com/li\nnk"],
		["leading space", " wss://slack.com/link"],
		["a relative URL", "/link"],
		["an empty string", ""],
	])("refuses %s", (_name, raw) => {
		expect(refusal(() => socketModeEndpoint(raw))).toBe("URL_TARGET");
	});

	it.each([null, undefined, 42, {}, new URL(URL_TEXT)])("refuses a non-string target %#", (raw) => {
		expect(refusal(() => socketModeEndpoint(raw))).toBe("URL_TARGET");
	});

	it("carries no URL or ticket in a refusal", () => {
		try {
			socketModeEndpoint(`wss://example.com/link/?ticket=${TICKET}`);
			expect.unreachable();
		} catch (error) {
			expect(error).toBeInstanceOf(SocketModeRefusal);
			const text = `${String(error)} ${JSON.stringify(error)} ${(error as Error).stack ?? ""}`;
			expect(text).not.toContain(TICKET);
			expect(text).not.toContain("example.com");
			expect(Object.keys(error as object).sort()).toEqual(["code", "hostError", "name"]);
		}
	});
});

describe("apps.connections.open response", () => {
	it("returns the wss URL from a successful response", () => {
		expect(socketModeOpenUrl({ status: 200, body: ok(URL_TEXT) })).toBe(URL_TEXT);
		const spaced = body(` {"url": ${JSON.stringify(URL_TEXT)} , "ok" : true , "warning": "x"} `);
		expect(socketModeOpenUrl({ status: 200, body: spaced })).toBe(URL_TEXT);
	});

	it.each([101, 201, 204, 301, 302, 303, 307, 308, 400, 401, 429, 500, 503])(
		"refuses status %i: redirects and failures are never followed",
		(status) => {
			expect(refusal(() => socketModeOpenUrl({ status, body: ok(URL_TEXT) }))).toBe("URL_RESPONSE");
		},
	);

	it("accepts a body of exactly the size bound and refuses one byte more", () => {
		const base = JSON.stringify({ ok: true, url: URL_TEXT, pad: "" });
		const exact = JSON.stringify({
			ok: true,
			url: URL_TEXT,
			pad: "x".repeat(SOCKET_MODE_OPEN_RESPONSE_MAX_BYTES - base.length),
		});
		expect(body(exact).byteLength).toBe(SOCKET_MODE_OPEN_RESPONSE_MAX_BYTES);
		expect(socketModeOpenUrl({ status: 200, body: body(exact) })).toBe(URL_TEXT);
		expect(refusal(() => socketModeOpenUrl({ status: 200, body: body(`${exact} `) }))).toBe(
			"URL_RESPONSE",
		);
	});

	it.each([
		["ok false", JSON.stringify({ ok: false, url: URL_TEXT })],
		["ok as a string", JSON.stringify({ ok: "true", url: URL_TEXT })],
		["no ok", JSON.stringify({ url: URL_TEXT })],
		["no url", JSON.stringify({ ok: true })],
		["a non-string url", JSON.stringify({ ok: true, url: [URL_TEXT] })],
		["a duplicate url", `{"ok":true,"url":"wss://slack.com/a","url":${JSON.stringify(URL_TEXT)}}`],
		[
			"a duplicate escaped name",
			`{"ok":true,"url":"wss://slack.com/a","\\u0075rl":"wss://slack.com/b"}`,
		],
		["an array", JSON.stringify([{ ok: true, url: URL_TEXT }])],
		["a string", JSON.stringify(URL_TEXT)],
		["trailing data", `${JSON.stringify({ ok: true, url: URL_TEXT })} {}`],
		["a byte order mark", `\ufeff${JSON.stringify({ ok: true, url: URL_TEXT })}`],
		["an empty body", ""],
	])("refuses %s", (_name, text) => {
		expect(refusal(() => socketModeOpenUrl({ status: 200, body: body(text) }))).toBe(
			"URL_RESPONSE",
		);
	});

	it("refuses invalid UTF-8", () => {
		const bytes = Buffer.concat([
			Buffer.from('{"ok":true,"url":"wss://slack.com/'),
			Buffer.from([0xc0, 0x80]),
			Buffer.from('"}'),
		]);
		expect(refusal(() => socketModeOpenUrl({ status: 200, body: bytes }))).toBe("URL_RESPONSE");
	});

	it("refuses a successful response whose URL is not one of Slack's wss hosts", () => {
		for (const url of [
			"wss://example.com/link",
			"ws://wss-primary.slack.com/link",
			`${URL_TEXT}#x`,
		])
			expect(refusal(() => socketModeOpenUrl({ status: 200, body: ok(url) }))).toBe("URL_TARGET");
	});

	it("reads only own data fields of a plain response", () => {
		const getter = Object.defineProperty({ body: ok(URL_TEXT) }, "status", {
			get: () => 200,
			enumerable: true,
		});
		const inherited = Object.assign(Object.create({ status: 200 }) as object, {
			body: ok(URL_TEXT),
		});
		const hidden = Object.defineProperty({ status: 200 }, "body", {
			value: ok(URL_TEXT),
			enumerable: false,
		});
		const proxy = new Proxy({ status: 200, body: ok(URL_TEXT) }, {});
		for (const response of [
			getter,
			inherited,
			hidden,
			proxy,
			null,
			"200",
			{ status: 200, body: JSON.stringify({ ok: true, url: URL_TEXT }) },
			{ status: 200, body: ok(URL_TEXT).buffer },
			{ status: 200, body: [...ok(URL_TEXT)] },
			{ status: "200", body: ok(URL_TEXT) },
		])
			expect(
				refusal(() =>
					socketModeOpenUrl(response as unknown as Parameters<typeof socketModeOpenUrl>[0]),
				),
			).toBe("URL_RESPONSE");
	});
});
