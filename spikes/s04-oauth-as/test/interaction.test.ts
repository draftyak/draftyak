import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { type ConsentRequest, ConsentStub, LIMITS, MAX_ENTRIES } from "../src/consent.ts";
import { OWNER } from "../src/provider.ts";
import {
	type As,
	authorize,
	authorizeUrl,
	Browser,
	exchange,
	finish,
	publicClient,
	startAs,
	startAuthorization,
} from "./flow.ts";

const HOSTILE_NAME = `<img src=x onerror=alert(1)> "Evil" & Co's`;
const client = publicClient("spike-public", HOSTILE_NAME);
let as: As;

beforeAll(async () => {
	as = await startAs([client]);
});
afterAll(async () => {
	await as?.close();
});

const interactionUrl = (target: As, uid: string, suffix = ""): string =>
	`${target.origin}/oauth/interaction/${uid}${suffix}`;

describe("routing", () => {
	test("Hono answers /oauth/interaction/* ahead of every forwarded provider route", async () => {
		const paths = as.app.routes.map((route) => route.path);
		const lastInteraction = paths.lastIndexOf("/oauth/interaction/:uid/finish");
		const firstForwarded = paths.indexOf("/oauth/authorize");
		expect(lastInteraction).toBeGreaterThan(0);
		expect(lastInteraction).toBeLessThan(firstForwarded);
		const response = await fetch(interactionUrl(as, "not-an-interaction"));
		expect(response.status).toBe(400);
		expect(await response.text()).toContain("<title>DraftYak sign-in</title>");
	});

	test("an interaction route works only in the browser that started it", async () => {
		const browser = new Browser();
		const started = await startAuthorization(as, browser, client);
		const stranger = new Browser();
		expect((await stranger.get(interactionUrl(as, started.uid))).status).toBe(400);
		const poll = await stranger.get(interactionUrl(as, started.uid, "/status"), {
			"x-draftyak-csrf": started.csrf,
		});
		expect(poll.status).toBe(403);
		as.consent.approve(started.uid, started.code);
		expect((await stranger.get(interactionUrl(as, started.uid, "/finish"))).status).toBe(400);
		expect((await finish(as, browser, started.uid)).searchParams.has("code")).toBe(true);
	});

	test("one interaction's cookie opens no other interaction", async () => {
		const browser = new Browser();
		const first = await startAuthorization(as, browser, client);
		// The jar now holds only the second interaction's cookie.
		const second = await startAuthorization(as, browser, client);
		expect((await browser.get(interactionUrl(as, first.uid))).status).toBe(400);
		const poll = await browser.get(interactionUrl(as, first.uid, "/status"), {
			"x-draftyak-csrf": first.csrf,
		});
		expect(poll.status).toBe(403);
		as.consent.approve(first.uid, first.code);
		expect((await browser.get(interactionUrl(as, first.uid, "/finish"))).status).toBe(400);
		expect((await browser.get(interactionUrl(as, second.uid))).status).toBe(200);
	});

	test("HEAD is refused wherever a GET acts, and changes nothing", async () => {
		const browser = new Browser();
		const { url } = authorizeUrl(as, client);
		const refused = async (target: string) => {
			const response = await browser.get(target, {}, "HEAD");
			expect(response.status, target).toBe(405);
			expect(response.headers.get("allow"), target).toBe("GET");
		};
		await refused(url);
		const location = (await browser.get(url)).headers.get("location") ?? "";
		const pageUrl = new URL(location, as.origin).href;
		const pushes = as.pushes.length;
		await refused(pageUrl);
		expect(as.pushes.length).toBe(pushes);
		const html = await (await browser.get(pageUrl)).text();
		expect(as.pushes.length).toBe(pushes + 1);
		const uid = pageUrl.slice(pageUrl.lastIndexOf("/") + 1);
		as.consent.approve(uid, /<strong id="code">(\d\d)<\/strong>/.exec(html)?.[1] ?? "");
		await refused(interactionUrl(as, uid, "/finish"));
		const finished = await browser.get(interactionUrl(as, uid, "/finish"));
		expect(finished.status).toBe(303);
		const resume = new URL(finished.headers.get("location") ?? "", as.origin).href;
		await refused(resume);
		const resumed = await browser.get(resume);
		expect(new URL(resumed.headers.get("location") ?? "").searchParams.has("code")).toBe(true);
	});
});

describe("the consent page", () => {
	test("shows the self-declared client name, the redirect host, the scopes and a 2-digit code", async () => {
		const { html, code } = await startAuthorization(as, new Browser(), client);
		expect(code).toMatch(/^\d\d$/);
		expect(/<strong id="client">(.*?)<\/strong> \(self-declared\)/.exec(html)?.[1]).toBe(
			"&#60;img src=x onerror=alert(1)&#62; &#34;Evil&#34; &#38; Co&#39;s",
		);
		expect(html).not.toContain("<img");
		expect(/<strong id="host">(.*?)<\/strong>/.exec(html)?.[1]).toBe("client.example");
		expect([...html.matchAll(/<li>(.*?)<\/li>/g)].map((match) => match[1])).toStrictEqual([
			"inbox:read",
			"inbox:organize",
			"drafts:write",
			"outbox:propose",
		]);
		const text = html.replace(/<script[\s\S]*<\/script>/, "");
		expect(text).not.toMatch(new RegExp(`account|${OWNER}`, "i"));
	});

	test("runs only its own hash-pinned script and can't be framed", async () => {
		const { page, html } = await startAuthorization(as, new Browser(), client);
		const script = /<script data-csrf="[^"]+">(.*?)<\/script>/s.exec(html)?.[1] ?? "";
		expect([...html.matchAll(/<script/g)]).toHaveLength(1);
		const hash = createHash("sha256").update(script).digest("base64");
		expect(page.headers.get("content-security-policy")).toBe(
			`default-src 'none'; script-src 'sha256-${hash}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
		);
		expect(page.headers.get("x-frame-options")).toBe("DENY");
		expect(page.headers.get("cache-control")).toBe("no-store");
		expect(page.headers.get("referrer-policy")).toBe("no-referrer");
		expect(page.headers.get("x-content-type-options")).toBe("nosniff");
	});
});

describe("the paired desktop", () => {
	test("gets each request once, with address and user agent, but never the code", async () => {
		const browser = new Browser();
		const before = as.pushes.length;
		const started = await startAuthorization(as, browser, client);
		const again = await browser.get(interactionUrl(as, started.uid));
		expect(await again.text()).toContain(`<strong id="code">${started.code}</strong>`);
		expect(as.pushes.length).toBe(before + 1);
		const push = as.pushes.at(-1);
		expect(push).toStrictEqual({
			uid: started.uid,
			clientId: client.id,
			clientName: HOSTILE_NAME,
			redirectHost: "client.example",
			scopes: ["inbox:read", "inbox:organize", "drafts:write", "outbox:propose"],
			ip: expect.stringMatching(/^(::ffff:)?127\.0\.0\.1$/),
			userAgent: "spike-browser/1",
		});
	});

	test("a wrong typed code denies the request for good", async () => {
		const browser = new Browser();
		const started = await startAuthorization(as, browser, client);
		const wrong = String((Number(started.code) + 1) % 100).padStart(2, "0");
		expect(as.consent.approve(started.uid, wrong)).toBe("denied");
		expect(as.consent.approve(started.uid, started.code)).toBe("denied");
		const callback = await finish(as, browser, started.uid);
		expect(callback.searchParams.get("error")).toBe("access_denied");
		expect(callback.searchParams.get("iss")).toBe(as.origin);
	});

	test("the owner's ticks decide the scopes", async () => {
		const authorized = await authorize(as, client, { scopes: ["inbox:read", "inbox:organize"] });
		const { body } = await exchange(as, client, authorized);
		expect(body.scope).toBe("inbox:read inbox:organize");
	});
});

describe("the status poll", () => {
	test("is bound to the page's CSRF token and the browser's interaction cookie", async () => {
		const browser = new Browser();
		const started = await startAuthorization(as, browser, client);
		const url = interactionUrl(as, started.uid, "/status");
		expect((await browser.get(url)).status).toBe(403);
		expect((await browser.get(url, { "x-draftyak-csrf": `${started.csrf}x` })).status).toBe(403);
		const other = await startAuthorization(as, new Browser(), client);
		expect(other.csrf).not.toBe(started.csrf);
		expect((await browser.get(url, { "x-draftyak-csrf": other.csrf })).status).toBe(403);
		const pending = await browser.get(url, { "x-draftyak-csrf": started.csrf });
		expect(pending.status).toBe(200);
		expect(pending.headers.get("cache-control")).toBe("no-store");
		expect(await pending.json()).toStrictEqual({ state: "pending" });
		as.consent.approve(started.uid, started.code);
		const approved = await browser.get(url, { "x-draftyak-csrf": started.csrf });
		expect(await approved.json()).toStrictEqual({ state: "approved" });
	});
});

describe("finish", () => {
	test("waits for the desktop, then finishes the authorization once", async () => {
		const browser = new Browser();
		const started = await startAuthorization(as, browser, client);
		const early = await browser.get(interactionUrl(as, started.uid, "/finish"));
		expect(early.status).toBe(409);
		as.consent.approve(started.uid, started.code);
		const done = await browser.get(interactionUrl(as, started.uid, "/finish"));
		expect(done.status).toBe(303);
		expect(done.headers.get("location")).toBe(`/oauth/authorize/${started.uid}`);
		const returnTo = new URL(done.headers.get("location") ?? "", as.origin);
		expect((await browser.get(interactionUrl(as, started.uid, "/finish"))).status).toBe(410);
		const resumed = await browser.get(returnTo.href);
		const callback = new URL(resumed.headers.get("location") ?? "");
		expect(callback.searchParams.get("state")).toBe(started.state);
		expect(callback.searchParams.get("iss")).toBe(as.origin);
		expect(callback.searchParams.get("code")).toMatch(/^[\w-]{43}$/);
		expect((await browser.get(interactionUrl(as, started.uid, "/finish"))).status).toBe(400);
	});

	test("every authorization needs a fresh consent, even with a session", async () => {
		const browser = new Browser();
		await authorize(as, client, {}, browser);
		expect(browser.cookie("_session")).toBeDefined();
		const before = as.pushes.length;
		const second = await startAuthorization(as, browser, client);
		expect(as.pushes.length).toBe(before + 1);
		expect(as.pushes.at(-1)?.uid).toBe(second.uid);
	});
});

describe("consent limits", () => {
	let now = Date.now();
	let limited: As;

	beforeAll(async () => {
		limited = await startAs([client], { consent: { limits: LIMITS, now: () => now } });
	});
	afterAll(async () => {
		await limited?.close();
	});

	const state = async (target: As) => {
		const browser = new Browser();
		const started = await startAuthorization(target, browser, client);
		const poll = await browser.get(interactionUrl(target, started.uid, "/status"), {
			"x-draftyak-csrf": started.csrf,
		});
		const { state } = (await poll.json()) as { state: string };
		return { state, started, browser };
	};

	test("3 pushes a minute, then refused until the minute passes", async () => {
		now += 86_400_000;
		const pushed = limited.pushes.length;
		for (let i = 0; i < LIMITS.perMinute; i++) expect((await state(limited)).state).toBe("pending");
		const refused = await state(limited);
		expect(refused.state).toBe("refused");
		expect(refused.started.html).toContain("Too many sign-in requests");
		expect(refused.started.html).not.toContain('id="code"');
		expect(limited.pushes.length).toBe(pushed + LIMITS.perMinute);
		const callback = await finish(limited, refused.browser, refused.started.uid);
		expect(callback.searchParams.get("error")).toBe("temporarily_unavailable");
		now += 61_000;
		expect((await state(limited)).state).toBe("pending");
	});

	test("20 pushes a day", async () => {
		now += 86_400_000;
		for (let i = 0; i < LIMITS.perDay; i++) {
			expect((await state(limited)).state).toBe("pending");
			now += 21_000;
		}
		now += 61_000;
		expect((await state(limited)).state).toBe("refused");
		now += 86_400_000;
		expect((await state(limited)).state).toBe("pending");
	});

	test("five denials in a row pause consent for 15 minutes", async () => {
		const deny = async (count: number) => {
			for (let i = 0; i < count; i++) {
				now += 61_000;
				const { started } = await state(limited);
				expect(limited.consent.deny(started.uid)).toBe("denied");
			}
		};
		now += 86_400_000;
		await deny(LIMITS.denialsToPause - 1);
		now += 61_000;
		const approved = await state(limited);
		expect(limited.consent.approve(approved.started.uid, approved.started.code)).toBe("approved");
		await deny(LIMITS.denialsToPause - 1);
		now += 61_000;
		expect((await state(limited)).state).toBe("pending");
		await deny(1);
		now += 61_000;
		expect((await state(limited)).state).toBe("refused");
		now += LIMITS.pauseMs;
		expect((await state(limited)).state).toBe("pending");
	});

	test("a consent lives as long as its interaction", async () => {
		now += 86_400_000;
		const { started, browser } = await state(limited);
		now += 11 * 60_000;
		const poll = await browser.get(interactionUrl(limited, started.uid, "/status"), {
			"x-draftyak-csrf": started.csrf,
		});
		expect(poll.status).toBe(403);
		expect((await browser.get(interactionUrl(limited, started.uid, "/finish"))).status).toBe(410);
	});
});

describe("what consent holds", () => {
	const request = (uid: string): ConsentRequest => ({
		uid,
		clientId: client.id,
		clientName: "Spike",
		redirectHost: "client.example",
		scopes: ["inbox:read"],
		ip: "127.0.0.1",
		userAgent: "spike-browser/1",
	});
	const TTL_MS = 600_000;

	test(`at most ${MAX_ENTRIES} consents; refused ones keep no request and make room, oldest first`, () => {
		const pushed: string[] = [];
		const stub = new ConsentStub({ onPush: (r) => pushed.push(r.uid), limits: { perMinute: 1 } });
		expect(stub.open(request("kept"), TTL_MS).state).toBe("pending");
		const refusals = MAX_ENTRIES + 10;
		for (let i = 0; i < refusals; i++) {
			const refused = stub.open(request(`refused-${i}`), TTL_MS);
			expect(refused).toMatchObject({ state: "refused", code: "" });
			expect(refused).not.toHaveProperty("request");
		}
		// The pending consent and the newest refused ones fill the map.
		const dropped = refusals - (MAX_ENTRIES - 1);
		expect(stub.state("kept")).toBe("pending");
		expect(stub.state(`refused-${dropped - 1}`)).toBeUndefined();
		expect(stub.state(`refused-${dropped}`)).toBe("refused");
		expect(pushed).toStrictEqual(["kept"]);
	});

	test("with every slot pushed, a new request is refused and not kept", () => {
		const stub = new ConsentStub({ limits: { perMinute: MAX_ENTRIES, perDay: MAX_ENTRIES } });
		for (let i = 0; i < MAX_ENTRIES; i++) {
			expect(stub.open(request(`pushed-${i}`), TTL_MS).state).toBe("pending");
		}
		expect(stub.open(request("overflow"), TTL_MS).state).toBe("refused");
		expect(stub.state("overflow")).toBeUndefined();
		expect(stub.state("pushed-0")).toBe("pending");
	});

	test("client-sent text is cut to 256 characters on the page and the desktop", async () => {
		const long = publicClient("spike-long-name", "N".repeat(1000));
		const target = await startAs([long]);
		try {
			const browser = new Browser();
			const { url } = authorizeUrl(target, long);
			const location = (await browser.get(url)).headers.get("location") ?? "";
			const page = await browser.get(new URL(location, target.origin).href, {
				"user-agent": "U".repeat(8192),
			});
			const html = await page.text();
			expect(/<strong id="client">(N*)<\/strong>/.exec(html)?.[1]).toHaveLength(256);
			expect(target.pushes.at(-1)?.clientName).toHaveLength(256);
			expect(target.pushes.at(-1)?.userAgent).toHaveLength(256);
		} finally {
			await target.close();
		}
	});
});
