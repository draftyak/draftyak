// S4: what a reverse proxy in front of the AS passes on. A digest-pinned Caddy in Docker shows which
// client-IP header arrives and what becomes of forwarding headers a client sends itself, and the AS
// trusts X-Forwarded-* only on connections from the proxy it is configured with. Evidence is written
// only when asked (DRAFTYAK_RECORD_EVIDENCE=1, or CI) after every check passed, and holds header
// names and outcomes, never an address.
import { request } from "node:http";
import path from "node:path";
import { docker, needDocker, skipOrFail, writeEvidence } from "@draftyak/spike-kit";
import { Hono } from "hono";
import { expect, it } from "vitest";
import { cimd } from "../src/cimd.ts";
import { type ConsentRequest, ConsentStub } from "../src/consent.ts";
import { createProvider } from "../src/provider.ts";
import { behindProxy, ProxyTrust, serveBehindProxy } from "../src/proxy.ts";
import { createApp, type Env, METADATA_PATH } from "../src/routes.ts";
import { ScriptedClient, typesCode } from "./connectors.ts";
import { pkcePair, publicClient, REDIRECT_URI } from "./flow.ts";

// Pinned at first use (2026-10-17): the multi-arch index of Caddy 2.11.7 on Alpine 3.23.
const CADDY =
	"caddy:2.11.7-alpine@sha256:d8542f48d34a9cf4e4c11a478865229840e87e4c96ea3f439101f31a5d35f75f";
// The image gives /usr/bin/caddy a file capability (cap_net_bind_service). Under the kit's
// --cap-drop=ALL, exec then fails with EPERM, so the test runs a build without it.
const DOCKERFILE = `FROM ${CADDY}\nRUN setcap -r /usr/bin/caddy\n`;

// What a client might send to pose as another address, host or scheme.
const SPOOFED: Readonly<Record<string, string>> = {
	"x-forwarded-for": "198.51.100.66",
	"x-forwarded-host": "evil.example",
	"x-forwarded-proto": "https",
	forwarded: "for=198.51.100.67;host=evil.example;proto=https",
	"x-real-ip": "198.51.100.68",
};
const FORWARDING = /^(?:x-forwarded-[\w-]+|forwarded|x-real-ip|via)$/;

// Windows (Docker Desktop) and Linux (any engine). macOS's loopback has no 127.0.0.3 for the direct
// peer, and an engine in a VM there reaches the host only through Docker Desktop's forwarding.
const HOST = process.platform === "win32" ? "requires:windows" : "requires:linux";

function recording(env: NodeJS.ProcessEnv = process.env): boolean {
	const value = env.DRAFTYAK_RECORD_EVIDENCE ?? "";
	if (value !== "" && value !== "0" && value !== "1") {
		throw new Error(`DRAFTYAK_RECORD_EVIDENCE is 1 or 0, not "${value}"`);
	}
	return value === "1" || (value === "" && !!env.CI);
}

// The AS listens before Caddy starts, so Caddy gets the port the AS really has; the address Caddy's
// connections come from is known only once Caddy runs.
class LateTrust extends ProxyTrust {
	configured = new ProxyTrust([]);

	override trusts(address: string | undefined): boolean {
		return this.configured.trusts(address);
	}
}

interface Arrival {
	readonly peer: string | undefined;
	readonly path: string;
	readonly headers: Readonly<Record<string, string>>;
}

interface Answer {
	readonly status: number;
	readonly location: string;
	readonly cookies: readonly string[];
}

const forwardingOf = (arrival: Arrival): string[] =>
	Object.keys(arrival.headers)
		.filter((name) => FORWARDING.test(name))
		.sort();

it("Caddy passes the client IP in X-Forwarded-For, and the AS trusts X-Forwarded-* only from Caddy", {
	tags: ["requires:docker", HOST],
	timeout: 300_000,
}, async (ctx) => {
	await needDocker(ctx);
	// Docker Desktop forwards host.docker.internal to the host's loopback, so the AS listens there
	// and Caddy's connections arrive from 127.0.0.1. Another engine reaches the host at the bridge
	// gateway, so the AS listens on every address and Caddy's arrive from its container's.
	const desktop = await docker.dockerDesktop();
	if (process.platform === "win32" && !desktop) {
		skipOrFail(ctx, "Linux containers on Windows run only in Docker Desktop here");
	}
	const started = performance.now();
	await using image = await docker.buildImage({
		dockerfile: DOCKERFILE,
		network: "none",
		signal: ctx.signal,
	});

	const arrivals: Arrival[] = [];
	const trust = new LateTrust([]);
	let app: Hono<Env> | undefined;
	const as = await serveBehindProxy(
		() => new Hono<Env>().all("*", (c) => (app ? app.fetch(c.req.raw, c.env) : c.body(null, 503))),
		{
			trust,
			host: desktop ? "127.0.0.1" : "0.0.0.0",
			observe: (incoming) => {
				const headers = Object.fromEntries(
					Object.entries(incoming.headers).map(([name, value]) => [
						name,
						[value].flat().join(", "),
					]),
				);
				arrivals.push({ peer: incoming.socket.remoteAddress, path: incoming.url ?? "", headers });
			},
		},
	);
	ctx.onTestFinished(() => as.close());
	const port = Number(new URL(as.origin).port);
	await using caddy = await docker.startInDocker({
		image: image.id,
		network: "bridge",
		publish: [8080],
		hostGateway: true,
		env: { XDG_CONFIG_HOME: "/tmp/config", XDG_DATA_HOME: "/tmp/data" },
		cmd: ["caddy", "reverse-proxy", "--from", ":8080", "--to", `host.docker.internal:${port}`],
		signal: ctx.signal,
	});
	const proxyAddress = desktop
		? "127.0.0.1"
		: await caddy.inspect("{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}");
	trust.configured = new ProxyTrust([proxyAddress]);
	// The direct peer the test plays: an address that isn't the proxy's.
	const directAddress = desktop ? "127.0.0.3" : "127.0.0.1";
	const issuer = `http://127.0.0.1:${caddy.port(8080)}`;

	const pushes: ConsentRequest[] = [];
	const consent = new ConsentStub({
		limits: { perMinute: 1000, perDay: 1000, denialsToPause: 1000 },
		onPush: (pushed) => pushes.push(pushed),
	});
	const client = publicClient();
	const provider = createProvider({ issuer, clients: [client.metadata] });
	cimd({ hosts: [] }).install(provider);
	app = createApp({ provider, consent, ...behindProxy(provider, trust.configured) });

	let status = 0;
	for (let tries = 0; tries < 150 && status !== 200; tries++) {
		status = await fetch(`${issuer}${METADATA_PATH}`).then(
			async (response) => {
				await response.body?.cancel();
				return response.status;
			},
			() => new Promise<number>((done) => setTimeout(() => done(0), 100)),
		);
	}
	expect(status, await caddy.logs()).toBe(200);
	const readyMs = Math.round(performance.now() - started);

	// 1. A request that sends no forwarding header: what Caddy adds by itself.
	const plainMark = arrivals.length;
	const plainStatus = await fetch(`${issuer}${METADATA_PATH}`).then(async (response) => {
		await response.body?.cancel();
		return response.status;
	});
	expect(plainStatus).toBe(200);
	const plain = arrivals[plainMark];
	if (!plain) throw new Error("the plain request didn't arrive through Caddy");
	const forwardingHeaders = forwardingOf(plain);
	expect(forwardingHeaders).toEqual(
		expect.arrayContaining(["x-forwarded-for", "x-forwarded-host", "x-forwarded-proto"]),
	);
	expect(forwardingHeaders).not.toContain("forwarded");
	expect(forwardingHeaders).not.toContain("x-real-ip");
	const forwardedFor = (plain.headers["x-forwarded-for"] ?? "").split(",").map((hop) => hop.trim());
	expect(forwardedFor).toHaveLength(1);
	expect(plain.headers["x-forwarded-host"]).toBe(new URL(issuer).host);
	expect(plain.headers["x-forwarded-proto"]).toBe("http");

	// 2. A whole connection through Caddy, discovery to MCP call, sending the spoofed headers.
	const connector = {
		name: "spike-public",
		clientId: client.id,
		redirectUri: REDIRECT_URI,
		auth: "none",
		documents: new Map(),
		requires: ["s256", "iss"],
	} as const;
	const viaCaddy = new ScriptedClient(connector, {
		origin: issuer,
		approve: typesCode({ consent }),
		headers: SPOOFED,
	});
	const mark = arrivals.length;
	const tokens = await viaCaddy.connect();
	expect(await viaCaddy.callMcp(tokens.accessToken)).toBe(200);
	const fromCaddy = arrivals.filter(({ peer }) => peer?.replace(/^::ffff:/, "") === proxyAddress);
	expect(fromCaddy.length).toBe(arrivals.length);
	const [first, ...rest] = arrivals.slice(mark);
	if (!first) throw new Error("nothing arrived through Caddy");
	for (const arrival of rest) {
		expect(forwardingOf(arrival), arrival.path).toStrictEqual(forwardingOf(first));
	}
	const fate = (name: string): string => {
		const arrived = first.headers[name];
		if (arrived === undefined) return "dropped";
		return arrived === SPOOFED[name] ? "passed through" : "replaced";
	};
	const clientSent = Object.fromEntries(Object.keys(SPOOFED).map((name) => [name, fate(name)]));
	expect(clientSent).toStrictEqual({
		"x-forwarded-for": "replaced",
		"x-forwarded-host": "replaced",
		"x-forwarded-proto": "replaced",
		forwarded: "passed through",
		"x-real-ip": "passed through",
	});
	// The consent shows the address Caddy forwarded: no spoofed value, not Caddy's own.
	const viaProxy = pushes.at(-1)?.ip;
	expect(viaProxy).toBe((first.headers["x-forwarded-for"] ?? "").trim());
	expect(viaProxy).not.toBe(proxyAddress);
	expect(Object.values(SPOOFED).some((value) => value.includes(String(viaProxy)))).toBe(false);

	// 3. Straight to the AS from another address, with the same headers: none of them counts.
	const direct = (target: string, headers: Record<string, string>): Promise<Answer> =>
		new Promise((resolve, reject) => {
			const local = desktop ? { localAddress: directAddress } : {};
			request({ host: "127.0.0.1", port, path: target, headers, ...local })
				.once("response", (response) => {
					response.resume();
					const location = response.headers.location ?? "";
					const cookies = (response.headers["set-cookie"] ?? []).map(
						(line) => line.split(";")[0] ?? "",
					);
					resolve({ status: response.statusCode ?? 0, location, cookies });
				})
				.once("error", reject)
				.end();
		});
	const issuerHost = new URL(issuer).host;
	const { challenge } = pkcePair();
	const query = new URLSearchParams({
		client_id: client.id,
		response_type: "code",
		redirect_uri: REDIRECT_URI,
		scope: "inbox:read",
		state: "direct",
		code_challenge: challenge,
		code_challenge_method: "S256",
		resource: `${issuer}/mcp`,
	});
	const start = await direct(`/oauth/authorize?${query}`, { ...SPOOFED, host: issuerHost });
	expect(start.status).toBe(303);
	const page = await direct(start.location, {
		...SPOOFED,
		host: issuerHost,
		cookie: start.cookies.join("; "),
	});
	expect(page.status).toBe(200);
	expect(pushes.at(-1)?.ip).toBe(directAddress);
	// X-Forwarded-Host from that peer can't stand in for a Host that doesn't name the issuer.
	const posing = await direct(METADATA_PATH, {
		host: `127.0.0.1:${port}`,
		"x-forwarded-host": issuerHost,
		"x-forwarded-proto": "http",
	});
	expect(posing.status).toBe(421);

	const engine = desktop ? "Docker Desktop" : "another engine";
	const summary = `Caddy adds ${forwardingHeaders.join(", ")}; client IP in x-forwarded-for`;
	console.log(`proxy: ${engine}, proxy peer ${desktop ? "loopback" : "its container"}: ${summary}`);
	if (!recording()) return;
	const file = path.join(
		import.meta.dirname,
		"..",
		"evidence",
		`proxy-caddy-${process.platform}-${process.arch}.json`,
	);
	const written = await writeEvidence(file, {
		proxy: {
			image: CADDY,
			command: "caddy reverse-proxy",
			trustedProxies: "none",
			engine: desktop ? "docker-desktop" : "linux-engine",
		},
		arrives: {
			forwardingHeaders,
			clientIpHeader: "x-forwarded-for",
			forwardedForEntries: forwardedFor.length,
			forwardedHostIsRequestHost: true,
			forwardedProtoIsListenerScheme: true,
		},
		clientSent,
		as: {
			trustedPeer: "configured proxy only",
			proxyPeer: desktop ? "loopback" : "container address",
			consentIpThroughProxy: "x-forwarded-for",
			consentIpDirect: "connection",
			directForwardedHostStatus: posing.status,
			connectionThroughProxy: "ok",
		},
		readyMs,
	});
	console.log(`evidence: ${written}`);
});
