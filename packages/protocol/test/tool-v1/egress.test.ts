import { describe, expect, it } from "vitest";
import {
	checkUrlSecret,
	DnsHost,
	keepToolHeaders,
	PublicDnsHost,
	parseSecretRef,
	SecretRef,
	TOOL_FETCH_MAX_BYTES,
	TOOL_REQUEST_HEADERS,
	TOOL_REQUESTS_PER_LOOKUP,
	TOOL_RESPONSE_HEADERS,
	ToolEgressRule,
	URL_SECRET_MAX_LENGTH,
	UrlSecretName,
} from "../../src/tool-v1.ts";

// @draftyak/fakes' tool upstream (TOOL_UPSTREAM_HOST and TOOL_SECRET_PATH), whose secret path
// matches only byte for byte.
const FEED_HOST = "feeds.draftyak.example";
const SECRET_PATH = "/calendar/dytest-owner%40feeds.draftyak.example/private-5f3a9c1e/basic.ics";
const secretUrl = `https://${FEED_HOST}${SECRET_PATH}`;

describe("ToolEgressRule", () => {
	const secret = {
		class: "read",
		method: "GET",
		url: "secret://calendarUrl",
		maxBytes: 33_554_432,
		timeoutMs: 15_000,
	};
	const literal = {
		class: "read",
		method: "HEAD",
		host: "api.crm.draftyak.example",
		maxBytes: 4096,
		timeoutMs: 5000,
	};

	it("takes read-class GET or HEAD to a literal host or a secret:// reference", () => {
		expect(TOOL_FETCH_MAX_BYTES).toBe(32 * 1024 * 1024);
		for (const rule of [secret, literal, { ...literal, method: "GET" }]) {
			expect(ToolEgressRule.parse(rule)).toEqual(rule);
		}
	});

	it("refuses write classes, other methods, ws, saveAs, sends and oversized caps", () => {
		const refused = [
			{ ...secret, class: "organize" },
			{ ...secret, class: "send" },
			{ ...secret, method: "POST" },
			{ ...secret, method: "PUT" },
			{ ...secret, method: "get" },
			{ ...secret, ws: true },
			{ ...secret, saveAs: "blob" },
			{ ...secret, send: { render: "json-template" } },
			{ ...secret, maxBytes: TOOL_FETCH_MAX_BYTES + 1 },
			{ ...secret, maxBytes: 0 },
			{ ...secret, timeoutMs: 15_001 },
			{ ...secret, host: FEED_HOST },
			{ ...secret, url: "secret://calendarUrl/basic.ics" },
			{ ...secret, url: secretUrl },
			{ ...literal, host: "API.crm.draftyak.example" },
			{ ...literal, host: "api.crm.draftyak.example:8443" },
			{ ...literal, host: "203.0.113.7" },
			{ ...literal, host: "[2001:db8::1]" },
			{ ...literal, host: "localhost" },
			// Names that never resolve on the public DNS, as url-secrets refuse them.
			{ ...literal, host: "metadata.google.internal" },
			{ ...literal, host: "foo.localhost" },
			{ ...literal, host: "nas.local" },
			{ ...literal, host: "router.home.arpa" },
			{ ...literal, host: "calendarxyz.onion" },
			{ ...literal, host: "https://api.crm.draftyak.example" },
			{ class: "read", method: "GET", maxBytes: 1, timeoutMs: 1 },
		];
		for (const rule of refused)
			expect(ToolEgressRule.safeParse(rule).success, JSON.stringify(rule)).toBe(false);
	});

	it("limits a lookup to four requests and the headers to tool-*'s allowlists", () => {
		expect(TOOL_REQUESTS_PER_LOOKUP).toBe(4);
		const request: [string, string][] = [
			["Accept", "text/calendar"],
			["If-None-Match", '"abc"'],
			["IF-MODIFIED-SINCE", "Mon, 19 Oct 2026 08:00:00 GMT"],
			["Authorization", "Bearer x"],
			["X-HTTP-Method-Override", "POST"],
			["Cookie", "a=b"],
		];
		expect(keepToolHeaders(request, TOOL_REQUEST_HEADERS)).toEqual(request.slice(0, 3));
		const response: [string, string][] = [
			["content-type", "text/calendar; charset=utf-8"],
			["ETag", '"abc"'],
			["Last-Modified", "Mon, 19 Oct 2026 08:00:00 GMT"],
			["Content-Length", "520"],
			["Set-Cookie", "dytest-session=1"],
			["X-Upstream-Trace", "dytest"],
			["Location", "/feed.ics"],
		];
		expect(keepToolHeaders(response, TOOL_RESPONSE_HEADERS)).toEqual(response.slice(0, 4));
		for (const allowed of [TOOL_REQUEST_HEADERS, TOOL_RESPONSE_HEADERS]) {
			expect(Object.isFrozen(allowed)).toBe(true);
			expect(() => (allowed as unknown as string[]).push("cookie")).toThrow(TypeError);
		}
	});
});

describe("secret:// references", () => {
	it("are exactly secret://<name>, with nothing added", () => {
		expect(parseSecretRef("secret://calendarUrl")).toBe("calendarUrl");
		expect(parseSecretRef("secret://feed2")).toBe("feed2");
		const refused = [
			"secret://calendarUrl/",
			"secret://calendarUrl/basic.ics",
			"secret://calendarUrl?x=1",
			"secret://calendarUrl?",
			"secret://calendarUrl#frag",
			"secret://calendarUrl#",
			"secret://calendarUrl:443",
			"secret://user@calendarUrl",
			"secret://calendar%55rl",
			"secret:///calendarUrl",
			"secret:calendarUrl",
			"SECRET://calendarUrl",
			" secret://calendarUrl",
			"secret://calendarUrl\n",
			"secret://CalendarUrl",
			"secret://calendar_url",
			`secret://a${"b".repeat(32)}`,
			"secret://",
			secretUrl,
		];
		for (const url of refused) {
			expect(parseSecretRef(url), JSON.stringify(url)).toBeUndefined();
			expect(SecretRef.safeParse(url).success).toBe(false);
		}
	});

	it("name a manifest's url-secret in lowerCamelCase", () => {
		for (const name of ["calendarUrl", "feed", `a${"B".repeat(31)}`]) {
			expect(UrlSecretName.safeParse(name).success).toBe(true);
		}
		for (const name of ["CalendarUrl", "calendar-url", "1feed", "", `a${"b".repeat(32)}`]) {
			expect(UrlSecretName.safeParse(name).success).toBe(false);
		}
	});
});

describe("checkUrlSecret", () => {
	const refusal = (input: string): string | undefined => {
		const checked = checkUrlSecret(input);
		return checked.ok ? undefined : checked.refusal;
	};

	it("keeps the owner's address byte for byte, %40 included", () => {
		expect(checkUrlSecret(secretUrl)).toEqual({ ok: true, url: secretUrl, host: FEED_HOST });
		for (const url of [
			`https://${FEED_HOST}/calendar/a%2540b/basic.ics`,
			`https://${FEED_HOST}/owa/calendar/dytest@draftyak.example/x/calendar.ics`,
			`https://${FEED_HOST}/feed.ics?token=s3cr%40t&x=%2F`,
			`https://${FEED_HOST}:8443/feed.ics`,
		]) {
			expect(checkUrlSecret(url)).toMatchObject({ ok: true, url });
		}
		expect(checkUrlSecret(`https://${FEED_HOST}:8443/feed.ics`)).toMatchObject({
			host: `${FEED_HOST}:8443`,
		});
	});

	it("shows a pasted webcal:// address as https://, and ignores surrounding space", () => {
		expect(checkUrlSecret(`webcal://${FEED_HOST}${SECRET_PATH}`)).toEqual({
			ok: true,
			url: secretUrl,
			host: FEED_HOST,
		});
		expect(checkUrlSecret(`WEBCAL://${FEED_HOST}/feed.ics`)).toMatchObject({
			url: `https://${FEED_HOST}/feed.ics`,
		});
		expect(checkUrlSecret(`  ${secretUrl}\r\n`)).toMatchObject({ ok: true, url: secretUrl });
	});

	it("refuses userinfo, http: and other schemes", () => {
		expect(refusal(`https://dytest@${FEED_HOST}/feed.ics`)).toBe("URL_SECRET_USERINFO");
		expect(refusal(`https://dytest:pw@${FEED_HOST}/feed.ics`)).toBe("URL_SECRET_USERINFO");
		expect(refusal(`https://:pw@${FEED_HOST}/feed.ics`)).toBe("URL_SECRET_USERINFO");
		for (const url of [
			`http://${FEED_HOST}/feed.ics`,
			`ftp://${FEED_HOST}/f`,
			"secret://calendarUrl",
		]) {
			expect(refusal(url)).toBe("URL_SECRET_NOT_HTTPS");
		}
		for (const url of [
			"",
			"calendar",
			`${FEED_HOST}/feed.ics`,
			"https://",
			"https://exa mple.com/",
		]) {
			expect(refusal(url), url).toBe("URL_SECRET_INVALID");
		}
	});

	it("refuses IP literals and names that aren't public DNS hosts", () => {
		const hosts = [
			"10.0.0.5",
			"127.0.0.1",
			"192.168.1.10",
			"169.254.169.254",
			"100.64.0.1",
			"203.0.113.7",
			"[::1]",
			"[fd00::1]",
			"[::ffff:127.0.0.1]",
			"0x7f.1",
			"localhost",
			"calendar.localhost",
			"intranet",
			"nas.local",
			"calendar.internal",
			"nas.home.arpa",
			"calendarxyz.onion",
			"feeds.draftyak.example.",
			"under_score.draftyak.example",
		];
		for (const host of hosts)
			expect(refusal(`https://${host}/feed.ics`), host).toBe("URL_SECRET_HOST");
		expect(DnsHost.safeParse(FEED_HOST).success).toBe(true);
		expect(PublicDnsHost.safeParse(FEED_HOST).success).toBe(true);
		expect(PublicDnsHost.safeParse("calendar.internal").success).toBe(false);
	});

	it("refuses a fragment and any address fetch would change, as the tool upstream does", () => {
		expect(refusal(`${secretUrl}#frag`)).toBe("URL_SECRET_FRAGMENT");
		expect(refusal(`${secretUrl}#`)).toBe("URL_SECRET_FRAGMENT");
		const altered = [
			secretUrl.replace("/basic.ics", "/./basic.ics"),
			secretUrl.replace("/basic.ics", "/extra/../basic.ics"),
			secretUrl.replace("/basic.ics", "/extra/%2e%2e/basic.ics"),
			secretUrl.replace("/calendar/", "\\calendar\\"),
			secretUrl.replace("calendar", "cal\tendar"),
			secretUrl.replace("basic", "bas ic"),
			`https://Feeds.Draftyak.Example${SECRET_PATH}`,
			`https://${FEED_HOST}:443${SECRET_PATH}`,
			`https://${FEED_HOST}`,
			`https://bücher.example/feed.ics`,
			`https://%66eeds.draftyak.example/feed.ics`,
			`HTTPS:${FEED_HOST}/feed.ics`,
			`https://${FEED_HOST}/feed{x}.ics`,
			`https://${FEED_HOST}/feed.ics?q="x"`,
		];
		for (const url of altered) expect(refusal(url), url).toBe("URL_SECRET_NOT_CANONICAL");
	});

	it("takes at most 2,048 characters", () => {
		const at = (length: number) =>
			`https://${FEED_HOST}/${"a".repeat(length - FEED_HOST.length - 9)}`;
		expect(at(URL_SECRET_MAX_LENGTH)).toHaveLength(2048);
		expect(checkUrlSecret(at(2048)).ok).toBe(true);
		expect(refusal(at(2049))).toBe("URL_SECRET_TOO_LONG");
		expect(refusal(`webcal${at(2048).slice(5)}`)).toBeUndefined();
	});
});
