import type { IncomingMessage } from "node:http";
import { request } from "node:http";
import { Hono } from "hono";
import type { Provider } from "oidc-provider";
import { describe, expect, test } from "vitest";
import { cimd } from "../src/cimd.ts";
import { type ConsentRequest, ConsentStub } from "../src/consent.ts";
import { createProvider } from "../src/provider.ts";
import { behindProxy, ProxyTrust, serveBehindProxy } from "../src/proxy.ts";
import { createApp, type Env, METADATA_PATH } from "../src/routes.ts";
import {
	Browser,
	clientAssertion,
	confidentialClient,
	pkcePair,
	REDIRECT_URI,
	type TestClient,
} from "./flow.ts";

const message = (remoteAddress: string, headers: Record<string, string> = {}): IncomingMessage =>
	({ socket: { remoteAddress }, headers }) as unknown as IncomingMessage;

describe("ProxyTrust", () => {
	test("trusts the configured addresses and ranges only, IPv4-mapped forms included", () => {
		const trust = new ProxyTrust(["127.0.0.1", "::1", "172.17.0.0/16"]);
		for (const address of [
			"127.0.0.1",
			"::ffff:127.0.0.1",
			"::1",
			"172.17.0.2",
			"172.17.255.255",
		]) {
			expect(trust.trusts(address), address).toBe(true);
		}
		for (const address of ["127.0.0.2", "172.18.0.1", "::2", "", undefined, "localhost"]) {
			expect(trust.trusts(address), String(address)).toBe(false);
		}
		for (const entry of [
			"localhost",
			"10.0.0.0/33",
			"fe80::/129",
			"10.0.0.1/8/1",
			"10.0.0.0/x",
			"",
		]) {
			expect(() => new ProxyTrust([entry]), entry).toThrow("not an address or CIDR range");
		}
		expect(new ProxyTrust([]).trusts("127.0.0.1")).toBe(false);
	});

	test("clientIp is the connection's address, unless that is a configured proxy", () => {
		const trust = new ProxyTrust(["127.0.0.1", "10.0.0.0/8"]);
		const forwarded = { "x-forwarded-for": "198.51.100.7" };
		expect(trust.clientIp(message("192.0.2.9", forwarded))).toBe("192.0.2.9");
		expect(trust.clientIp(message("::ffff:192.0.2.9", forwarded))).toBe("192.0.2.9");
		expect(trust.clientIp(message("127.0.0.1", forwarded))).toBe("198.51.100.7");
		expect(trust.clientIp(message("127.0.0.1"))).toBe("127.0.0.1");
	});

	test("behind proxies, clientIp is the nearest X-Forwarded-For entry that isn't one", () => {
		const trust = new ProxyTrust(["127.0.0.1", "10.0.0.0/8"]);
		const via = (chain: string) =>
			trust.clientIp(message("127.0.0.1", { "x-forwarded-for": chain }));
		expect(via("203.0.113.66, 198.51.100.7")).toBe("198.51.100.7");
		expect(via("203.0.113.66, 198.51.100.7, 10.1.2.3")).toBe("198.51.100.7");
		expect(via(" 198.51.100.7 ,10.1.2.3 , 10.4.5.6 ")).toBe("198.51.100.7");
		expect(via("10.1.2.3, 10.4.5.6")).toBe("10.1.2.3");
		expect(via("::ffff:198.51.100.7")).toBe("198.51.100.7");
		expect(via("2001:db8::7")).toBe("2001:db8::7");
		expect(via("203.0.113.66, not-an-address, 10.1.2.3")).toBe("127.0.0.1");
		expect(via("198.51.100.7:4711")).toBe("127.0.0.1");
	});
});

describe("forwarding headers on a server behind a proxy", () => {
	// What a request handler sees after serveBehindProxy sanitized the request.
	async function seen(trust: ProxyTrust) {
		const running = await serveBehindProxy(
			() =>
				new Hono<Env>().all("*", (c) =>
					c.json({
						fetchHeaders: [...c.req.raw.headers.keys()].sort(),
						nodeHeaders: Object.keys(c.env.incoming.headers).sort(),
						distinct: Object.keys(c.env.incoming.headersDistinct).sort(),
						raw: c.env.incoming.rawHeaders
							.filter((_, at) => at % 2 === 0)
							.map((name) => name.toLowerCase())
							.sort(),
						ip: trust.clientIp(c.env.incoming),
					}),
				),
			{ trust },
		);
		try {
			const response = await fetch(`${running.origin}/x`, {
				headers: {
					"x-forwarded-for": "198.51.100.7",
					"x-forwarded-host": "as.example",
					"x-forwarded-proto": "https",
					"x-forwarded-port": "443",
					forwarded: "for=203.0.113.67",
					"x-real-ip": "203.0.113.68",
					"x-other": "kept",
				},
			});
			return (await response.json()) as Record<string, string[] | string>;
		} finally {
			await running.close();
		}
	}

	const FORWARDING = [
		"forwarded",
		"x-forwarded-for",
		"x-forwarded-host",
		"x-forwarded-port",
		"x-forwarded-proto",
		"x-real-ip",
	];

	test("from the configured proxy: X-Forwarded-* kept, Forwarded and X-Real-IP dropped", async () => {
		const views = await seen(new ProxyTrust(["127.0.0.1"]));
		for (const view of ["fetchHeaders", "nodeHeaders", "distinct", "raw"]) {
			const names = views[view] as string[];
			expect(
				names.filter((name) => FORWARDING.includes(name)),
				view,
			).toStrictEqual([
				"x-forwarded-for",
				"x-forwarded-host",
				"x-forwarded-port",
				"x-forwarded-proto",
			]);
			expect(names, view).toContain("x-other");
		}
		expect(views.ip).toBe("198.51.100.7");
	});

	test("from any other peer: every forwarding header dropped, the connection's address used", async () => {
		const views = await seen(new ProxyTrust(["192.0.2.1"]));
		for (const view of ["fetchHeaders", "nodeHeaders", "distinct", "raw"]) {
			const names = views[view] as string[];
			expect(
				names.filter((name) => FORWARDING.includes(name)),
				view,
			).toStrictEqual([]);
			expect(names, view).toContain("x-other");
		}
		expect(views.ip).toBe("127.0.0.1");
	});
});

describe("the AS behind a proxy", () => {
	const confidential = confidentialClient();

	async function proxiedAs(
		trust: ProxyTrust,
		options: { issuer?: string; install?: boolean } = {},
	) {
		const pushes: ConsentRequest[] = [];
		const consent = new ConsentStub({
			limits: { perMinute: 1000, perDay: 1000, denialsToPause: 1000 },
			onPush: (pushed) => pushes.push(pushed),
		});
		let provider: Provider | undefined;
		const running = await serveBehindProxy(
			(origin) => {
				provider = createProvider({
					issuer: options.issuer ?? origin,
					clients: [confidential.metadata],
				});
				if (options.install !== false) cimd({ hosts: [] }).install(provider);
				return createApp({ provider, consent, ...behindProxy(provider, trust) });
			},
			{ trust },
		);
		if (!provider) throw new Error("the AS did not start");
		return { ...running, provider, consent, pushes };
	}

	// The browser leg with the headers a proxy adds; returns the code and verifier.
	async function authorize(
		as: Awaited<ReturnType<typeof proxiedAs>>,
		client: TestClient,
		headers: Record<string, string>,
	): Promise<{ code: string; verifier: string }> {
		const browser = new Browser();
		const { verifier, challenge } = pkcePair();
		const query = new URLSearchParams({
			client_id: client.id,
			response_type: "code",
			redirect_uri: REDIRECT_URI,
			scope: "inbox:read",
			state: "state-1",
			code_challenge: challenge,
			code_challenge_method: "S256",
			resource: `${as.provider.issuer}/mcp`,
		});
		const start = await browser.get(`${as.origin}/oauth/authorize?${query}`, headers);
		const interaction = start.headers.get("location") ?? "";
		expect(start.status).toBe(303);
		const page = await (await browser.get(`${as.origin}${interaction}`, headers)).text();
		as.consent.approve(
			interaction.split("/").at(-1) ?? "",
			/<strong id="code">(\d\d)</.exec(page)?.[1] ?? "",
		);
		const finished = await browser.get(`${as.origin}${interaction}/finish`, headers);
		const resumed = await browser.get(`${as.origin}${finished.headers.get("location")}`, headers);
		const callback = new URL(resumed.headers.get("location") ?? "");
		expect(callback.searchParams.get("iss")).toBe(as.provider.issuer);
		return { code: callback.searchParams.get("code") ?? "", verifier };
	}

	test("the consent shows the address the proxy forwarded, and only the proxy's", async () => {
		for (const [trusted, expected] of [
			[["127.0.0.1"], "198.51.100.7"],
			[["192.0.2.1"], "127.0.0.1"],
		] as const) {
			const as = await proxiedAs(new ProxyTrust(trusted));
			try {
				await authorize(as, confidential, { "x-forwarded-for": "198.51.100.7" });
				expect(as.pushes.map((pushed) => pushed.ip)).toStrictEqual([expected]);
			} finally {
				await as.close();
			}
		}
	});

	test("X-Forwarded-Host stands in for Host only on the proxy's connections", async () => {
		const status = async (trusted: string) => {
			const as = await proxiedAs(new ProxyTrust([trusted]), { issuer: "https://as.example" });
			try {
				return await raw(as.origin, METADATA_PATH, {
					"x-forwarded-host": "as.example",
					"x-forwarded-proto": "https",
				});
			} finally {
				await as.close();
			}
		};
		expect(await status("127.0.0.1")).toBe(200);
		expect(await status("192.0.2.1")).toBe(421);
	});

	test("an https issuer whose proxy sends no X-Forwarded-Proto still takes assertions for its token endpoint", async () => {
		const issuer = "https://as.example";
		const exchange = async (install: boolean, audience: string) => {
			const as = await proxiedAs(new ProxyTrust(["127.0.0.1"]), { issuer, install });
			try {
				const proxyHeaders = { "x-forwarded-host": "as.example", "x-forwarded-proto": "https" };
				const { code, verifier } = await authorize(as, confidential, proxyHeaders);
				const form = new URLSearchParams({
					grant_type: "authorization_code",
					code,
					redirect_uri: REDIRECT_URI,
					code_verifier: verifier,
					client_id: confidential.id,
					client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
					client_assertion: clientAssertion(confidential, audience),
				});
				const response = await fetch(`${as.origin}/oauth/token`, {
					method: "POST",
					headers: { "x-forwarded-host": "as.example" },
					body: form,
				});
				return response.status;
			} finally {
				await as.close();
			}
		};
		expect(await exchange(true, `${issuer}/oauth/token`)).toBe(200);
		expect(await exchange(true, "http://as.example/oauth/token")).toBe(401);
		// oidc-provider alone takes the audience from the request, which a proxy can leave as http.
		expect(await exchange(false, `${issuer}/oauth/token`)).toBe(401);
		expect(await exchange(false, "http://as.example/oauth/token")).toBe(200);
	});
});

function raw(origin: string, path: string, headers: Record<string, string>): Promise<number> {
	const { hostname, port, host } = new URL(origin);
	return new Promise((resolve, reject) => {
		request({ host: hostname, port, path, headers: { host, ...headers } })
			.once("response", (response) => {
				response.resume();
				resolve(response.statusCode ?? 0);
			})
			.once("error", reject)
			.end();
	});
}
