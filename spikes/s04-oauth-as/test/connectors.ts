// The scripted connector clients: fakes of claude.ai (public CIMD client), ChatGPT (private_key_jwt
// with a jwks_uri), remote Claude Code (a CIMD document whose redirect URIs are all loopback) and a
// CLI that registers in the DCR window. Each is seeded from fixtures/cimd/, discovers the AS the way
// the real client does (401, protected resource metadata, RFC 8414) and checks the metadata it
// relies on. M0.19's tests drive them offline against a FakeVendorHost; M0.20 can drive them
// against the AS behind Funnel; M9 seeds @draftyak/fakes from them.
import { generateKeyPairSync, type KeyObject, randomBytes, randomInt } from "node:crypto";
import { readFileSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { createServer, type Server } from "node:https";
import { type AddressInfo, connect, type Socket } from "node:net";
import path from "node:path";
import {
	CIMD_HOSTS,
	type Cimd,
	type CimdPolicy,
	cimd,
	type GuardOptions,
	type Resolved,
	type Target,
} from "../src/cimd.ts";
import { DcrWindow } from "../src/dcr-window.ts";
import {
	type As,
	type AssertionOverrides,
	Browser,
	clientAssertion,
	pkcePair,
	startAs,
	type TestClient,
} from "./flow.ts";
import { RECORDED_DIR, type Recorded } from "./record-cimd.ts";

export type RecordedName = "claude-ai" | "claude-code" | "chatgpt" | "chatgpt-jwks";

export function recorded(name: RecordedName): Recorded {
	return JSON.parse(readFileSync(path.join(RECORDED_DIR, `${name}.json`), "utf8")) as Recorded;
}

export interface StandIn {
	readonly synthetic: string;
	readonly url?: string;
	readonly document?: Record<string, unknown>;
	readonly registration?: Record<string, unknown>;
}

export type StandInName =
	| "loopback-elsewhere"
	| "mixed-redirects"
	| "private-jwks"
	| "outside-jwks"
	| "codex-dcr";

export function standIn(name: StandInName): StandIn {
	const file = path.join(RECORDED_DIR, "stand-ins", `${name}.json`);
	return JSON.parse(readFileSync(file, "utf8")) as StandIn;
}

const text = (value: unknown, what: string): string => {
	if (typeof value !== "string") throw new Error(`${what} isn't a string`);
	return value;
};

const firstOf = (value: unknown, what: string): string =>
	text(Array.isArray(value) ? value[0] : undefined, what);

// TEST-NET-3: never routed, so a guard that missed its injected dial can't reach a real host.
export const PUBLIC_ADDRESS = "203.0.113.10";

// The hosts these tests allowlist: the vendors', and an owner-added host for the stand-ins.
export const TEST_HOSTS: readonly string[] = [...CIMD_HOSTS, "cimd.example", "keys.cimd.example"];

// Names the fake host has a certificate for, allowlisted or not.
export const VENDOR_NAMES: readonly string[] = [
	...TEST_HOSTS,
	"agent.example",
	"keys.elsewhere.example",
];

export interface Answer {
	readonly status?: number;
	readonly headers?: Readonly<Record<string, string>>;
	readonly body?: string;
	// Sent in pieces, without a Content-Length.
	readonly chunked?: boolean;
	// Never answered.
	readonly hang?: boolean;
}

// @peculiar/x509 2.x loads tsyringe, which needs Reflect metadata readers; its classes record none.
function installReflectMetadata(): void {
	const reflect = Reflect as unknown as Record<string, unknown>;
	reflect.getMetadata ??= () => undefined;
	reflect.getOwnMetadata ??= () => undefined;
}

async function certificateFor(names: readonly string[]): Promise<{ cert: string; key: string }> {
	installReflectMetadata();
	const x509 = await import("@peculiar/x509");
	const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
	const algorithm = { name: "ECDSA", namedCurve: "P-256" };
	const keys = {
		privateKey: privateKey.toCryptoKey(algorithm, false, ["sign"]),
		publicKey: publicKey.toCryptoKey(algorithm, true, ["verify"]),
	};
	const now = Date.now();
	const cert = await x509.X509CertificateGenerator.createSelfSigned({
		name: "CN=DraftYak S4 fake vendor host",
		notBefore: new Date(now - 3_600_000),
		notAfter: new Date(now + 86_400_000),
		keys: keys as unknown as CryptoKeyPair,
		signingAlgorithm: { name: "ECDSA", hash: "SHA-256" },
		extensions: [
			new x509.BasicConstraintsExtension(false, undefined, true),
			new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true),
			new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.serverAuth]),
			new x509.SubjectAlternativeNameExtension(
				names.map((value) => ({ type: "dns" as const, value })),
			),
		],
	});
	return {
		cert: cert.toString("pem"),
		key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
	};
}

// One TLS server standing in for every vendor host the tests name. The guard's resolver maps each
// name to PUBLIC_ADDRESS (or what a test sets), and its dial reaches this server instead, which
// presents a run-time certificate for those names: the guard's only trust anchor in the tests.
export class FakeVendorHost {
	readonly ca: string;
	// Every URL fetched, in order.
	readonly fetched: string[] = [];
	// Every name the guard resolved, and every connection it made, to the address it checked.
	readonly resolved: string[] = [];
	readonly dialed: Target[] = [];
	readonly #answers = new Map<string, Answer | (() => Answer)>();
	readonly #addresses = new Map<string, readonly Resolved[]>();
	readonly #server: Server;
	readonly #port: number;

	private constructor(ca: string, server: Server) {
		this.ca = ca;
		this.#server = server;
		this.#port = (server.address() as AddressInfo).port;
	}

	static async start(names: readonly string[] = VENDOR_NAMES): Promise<FakeVendorHost> {
		const { cert, key } = await certificateFor(names);
		let host: FakeVendorHost | undefined;
		const server = createServer({ cert, key }, (req, res) =>
			host?.respond(req.headers.host, req.url, res),
		);
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject).listen(0, "127.0.0.1", () => resolve());
		});
		host = new FakeVendorHost(cert, server);
		return host;
	}

	respond(authority: string | undefined, target: string | undefined, res: ServerResponse): void {
		const url = `https://${authority}${target}`;
		this.fetched.push(url);
		const found = this.#answers.get(url);
		const answer = typeof found === "function" ? found() : (found ?? { status: 404, body: "{}" });
		if (answer.hang) return;
		res.statusCode = answer.status ?? 200;
		const headers = { "content-type": "application/json", ...answer.headers };
		for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
		const body = answer.body ?? "";
		if (!answer.chunked) {
			res.end(body);
			return;
		}
		for (let at = 0; at < body.length; at += 1024) res.write(body.slice(at, at + 1024));
		res.end();
	}

	serve(url: string, answer: Answer | string | (() => Answer)): void {
		this.#answers.set(url, typeof answer === "string" ? { body: answer } : answer);
	}

	serveAll(documents: ReadonlyMap<string, string>): void {
		for (const [url, body] of documents)
			this.serve(url, { body, headers: { "cache-control": "public, max-age=300" } });
	}

	resolveTo(hostname: string, ...addresses: string[]): void {
		this.#addresses.set(
			hostname,
			addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 })),
		);
	}

	readonly resolve = async (hostname: string): Promise<readonly Resolved[]> => {
		this.resolved.push(hostname);
		return this.#addresses.get(hostname) ?? [{ address: PUBLIC_ADDRESS, family: 4 }];
	};

	readonly dial = (target: Target): Socket => {
		this.dialed.push(target);
		return connect({ host: "127.0.0.1", port: this.#port });
	};

	guard(hosts: Iterable<string> = TEST_HOSTS): GuardOptions {
		return { hosts, resolve: this.resolve, dial: this.dial, ca: this.ca };
	}

	count(url: string): number {
		return this.fetched.filter((fetched) => fetched === url).length;
	}

	close(): Promise<void> {
		return new Promise((done) => {
			this.#server.close(() => done());
			this.#server.closeAllConnections();
		});
	}
}

export interface CimdAs extends As {
	readonly cimd: Cimd;
	readonly window: DcrWindow;
}

// The spike AS with CIMD (through the fake vendor host) and a DCR window, closed until opened.
export async function startCimdAs(
	vendor: FakeVendorHost,
	options: {
		readonly hosts?: Iterable<string>;
		readonly clients?: readonly TestClient[];
		readonly window?: DcrWindow;
		readonly policy?: Omit<CimdPolicy, "hosts">;
	} = {},
): Promise<CimdAs> {
	const policy = cimd({ ...vendor.guard(options.hosts), ...options.policy });
	const window = options.window ?? new DcrWindow();
	const as = await startAs([...(options.clients ?? [])], {
		provider: {
			configure: (configuration) => {
				policy.configure(configuration);
				window.configure(configuration);
			},
		},
		app: { routes: [window.route] },
	});
	policy.install(as.provider);
	window.install(as.provider);
	return { ...as, cimd: policy, window };
}

// What each real client checks in the AS metadata before it uses it (vendor docs, 2026-10).
export const REQUIREMENTS: Readonly<
	Record<string, (metadata: Record<string, unknown>) => boolean>
> = {
	s256: (m) => [m.code_challenge_methods_supported].flat().includes("S256"),
	cimd: (m) => m.client_id_metadata_document_supported === true,
	none: (m) => [m.token_endpoint_auth_methods_supported].flat().includes("none"),
	private_key_jwt: (m) =>
		[m.token_endpoint_auth_methods_supported].flat().includes("private_key_jwt"),
	iss: (m) => m.authorization_response_iss_parameter_supported === true,
	registration: (m) => typeof m.registration_endpoint === "string",
};

export type ConnectorName = "claude-ai" | "chatgpt" | "claude-code" | "codex";

export interface Connector {
	readonly name: ConnectorName | (string & {});
	// The CIMD URL; a client that registers (DCR) gets its id from the AS.
	readonly clientId?: string;
	readonly redirectUri: string;
	readonly auth: "none" | "private_key_jwt";
	readonly key?: KeyObject;
	readonly kid?: string;
	// What the fake vendor host serves for this client, by URL: its document and JWKS.
	readonly documents: ReadonlyMap<string, string>;
	readonly registration?: Readonly<Record<string, unknown>>;
	readonly requires: readonly (keyof typeof REQUIREMENTS)[];
}

// claude.ai's connector client: public, the recorded document as served.
export function claudeAi(): Connector {
	const { document } = recorded("claude-ai");
	const clientId = text(document.client_id, "client_id");
	return {
		name: "claude-ai",
		clientId,
		redirectUri: firstOf(document.redirect_uris, "redirect_uris"),
		auth: "none",
		documents: new Map([[clientId, JSON.stringify(document)]]),
		requires: ["s256", "cimd", "none"],
	};
}

// ChatGPT's client: the recorded document as served, with a key made at run time behind its
// jwks_uri, since only ChatGPT holds the published one's private half.
export function chatgpt(): Connector {
	const { document } = recorded("chatgpt");
	const clientId = text(document.client_id, "client_id");
	const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
	const kid = `stand-in-${randomBytes(4).toString("hex")}`;
	const jwk = { ...publicKey.export({ format: "jwk" }), kid, alg: "RS256", use: "sig" };
	return {
		name: "chatgpt",
		clientId,
		redirectUri: firstOf(document.redirect_uris, "redirect_uris"),
		auth: "private_key_jwt",
		key: privateKey,
		kid,
		documents: new Map([
			[clientId, JSON.stringify(document)],
			[text(document.jwks_uri, "jwks_uri"), JSON.stringify({ keys: [jwk] })],
		]),
		requires: ["s256", "cimd", "iss", "private_key_jwt"],
	};
}

// Remote Claude Code: the recorded document, redirected to an ephemeral loopback port.
export function claudeCode(port: number = randomInt(49_152, 65_536)): Connector {
	const { document } = recorded("claude-code");
	const clientId = text(document.client_id, "client_id");
	const redirect = new URL(firstOf(document.redirect_uris, "redirect_uris"));
	redirect.port = String(port);
	return {
		name: "claude-code",
		clientId,
		redirectUri: redirect.href,
		auth: "none",
		documents: new Map([[clientId, JSON.stringify(document)]]),
		requires: ["s256", "cimd", "none"],
	};
}

// A CLI that registers in the DCR window, with its loopback port in the registration.
export function codex(port: number = randomInt(49_152, 65_536)): Connector {
	const registration = standIn("codex-dcr").registration ?? {};
	const uris = [registration.redirect_uris]
		.flat()
		.map((uri) => text(uri, "redirect_uris").replace("{port}", String(port)));
	return {
		name: "codex",
		redirectUri: firstOf(uris, "redirect_uris"),
		auth: "none",
		documents: new Map(),
		registration: { ...registration, redirect_uris: uris },
		requires: ["s256", "registration"],
	};
}

export interface Consent {
	readonly uid: string;
	readonly code: string;
	readonly page: string;
}

export interface ScriptedOptions {
	// The MCP server's public origin, where discovery starts.
	readonly origin: string;
	// The paired desktop's answer to the consent the AS pushed: types the code, or not.
	readonly approve: (consent: Consent) => void | Promise<void>;
	// Sent with every request: the Origin a hosted client sends, or what a proxy adds.
	readonly headers?: Readonly<Record<string, string>>;
}

export interface Discovered {
	readonly resource: string;
	readonly issuer: string;
	readonly metadata: Record<string, unknown>;
	readonly unmet: readonly string[];
}

export interface Authorized {
	readonly code: string;
	readonly verifier: string;
	readonly state: string;
	readonly callback: URL;
}

export interface Reply {
	readonly status: number;
	readonly body: Record<string, unknown>;
	readonly headers: Headers;
}

export interface Tokens {
	readonly accessToken: string;
	readonly refreshToken: string;
	readonly scope: string;
}

export class ConnectorError extends Error {
	override name = "ConnectorError";
	readonly status: number;
	readonly detail: string;

	constructor(message: string, status: number, detail: string) {
		super(`${message} (${status}): ${detail.slice(0, 300)}`);
		this.status = status;
		this.detail = detail;
	}
}

const SCOPES = "inbox:read inbox:organize drafts:write outbox:propose";

export class ScriptedClient {
	readonly connector: Connector;
	readonly options: ScriptedOptions;
	readonly browser: Browser = new Browser();
	clientId: string | undefined;
	#discovered: Discovered | undefined;

	constructor(connector: Connector, options: ScriptedOptions) {
		this.connector = connector;
		this.options = options;
		this.clientId = connector.clientId;
	}

	get #headers(): Record<string, string> {
		return { ...this.options.headers };
	}

	// As the real clients do: the MCP endpoint's 401 names the resource metadata, whose one
	// authorization server publishes RFC 8414 metadata.
	async discover(): Promise<Discovered> {
		if (this.#discovered) return this.#discovered;
		const resource = `${this.options.origin}/mcp`;
		const challenge = await fetch(resource, { method: "POST", headers: this.#headers });
		await challenge.body?.cancel();
		const prmUrl = /resource_metadata="([^"]+)"/.exec(
			challenge.headers.get("www-authenticate") ?? "",
		)?.[1];
		if (challenge.status !== 401 || !prmUrl) {
			throw new ConnectorError("no resource_metadata challenge", challenge.status, "");
		}
		const prm = (await (await fetch(prmUrl, { headers: this.#headers })).json()) as Record<
			string,
			unknown
		>;
		const issuer = firstOf(prm.authorization_servers, "authorization_servers");
		const metadataUrl = `${issuer}/.well-known/oauth-authorization-server`;
		const metadata = (await (
			await fetch(metadataUrl, { headers: this.#headers })
		).json()) as Record<string, unknown>;
		if (metadata.issuer !== issuer) throw new ConnectorError("issuer mismatch", 200, metadataUrl);
		const unmet = this.connector.requires.filter((name) => !REQUIREMENTS[name]?.(metadata));
		this.#discovered = { resource: text(prm.resource, "resource"), issuer, metadata, unmet };
		return this.#discovered;
	}

	// Discovery again, as a client does after a failure (the metadata changes as the DCR window opens).
	rediscover(): Promise<Discovered> {
		this.#discovered = undefined;
		return this.discover();
	}

	async register(): Promise<Reply> {
		const { metadata } = await this.discover();
		const endpoint = text(metadata.registration_endpoint, "registration_endpoint");
		const response = await fetch(endpoint, {
			method: "POST",
			headers: { ...this.#headers, "content-type": "application/json" },
			body: JSON.stringify(this.connector.registration ?? {}),
		});
		const reply = await asReply(response);
		if (reply.status === 201) this.clientId = text(reply.body.client_id, "client_id");
		return reply;
	}

	// The browser leg up to the redirect back to the client, which must carry code, state and iss.
	async authorize(params: Record<string, string | undefined> = {}): Promise<Authorized> {
		const { issuer, resource, metadata } = await this.discover();
		const { verifier, challenge } = pkcePair();
		const state = randomBytes(8).toString("hex");
		const query = new URLSearchParams();
		const all: Record<string, string | undefined> = {
			client_id: this.clientId,
			response_type: "code",
			redirect_uri: this.connector.redirectUri,
			scope: SCOPES,
			state,
			code_challenge: challenge,
			code_challenge_method: "S256",
			resource,
			...params,
		};
		for (const [name, value] of Object.entries(all))
			if (value !== undefined) query.set(name, value);
		const endpoint = text(metadata.authorization_endpoint, "authorization_endpoint");
		const started = await this.browser.get(`${endpoint}?${query}`, this.#headers);
		const location = started.headers.get("location") ?? "";
		if (started.status !== 303 || !/^\/oauth\/interaction\/[^/?#]+$/.test(location)) {
			throw new ConnectorError("authorization refused", started.status, await started.text());
		}
		const pageUrl = new URL(location, issuer).href;
		const page = await (await this.browser.get(pageUrl, this.#headers)).text();
		const code = /<strong id="code">(\d\d)<\/strong>/.exec(page)?.[1] ?? "";
		await this.options.approve({ uid: location.split("/").at(-1) ?? "", code, page });
		const finished = await this.browser.get(`${pageUrl}/finish`, this.#headers);
		const resume = finished.headers.get("location");
		if (finished.status !== 303 || !resume) {
			throw new ConnectorError("finish refused", finished.status, await finished.text());
		}
		const back = await this.browser.get(new URL(resume, issuer).href, this.#headers);
		const callback = URL.parse(back.headers.get("location") ?? "");
		if (back.status !== 303 || !callback) {
			throw new ConnectorError("no redirect back", back.status, await back.text());
		}
		const { searchParams } = callback;
		if (`${callback.origin}${callback.pathname}` !== this.connector.redirectUri.split("?")[0]) {
			throw new ConnectorError("redirected elsewhere", back.status, callback.href);
		}
		if (searchParams.get("iss") !== issuer || searchParams.get("state") !== state) {
			throw new ConnectorError("iss or state mismatch", back.status, callback.search);
		}
		const granted = searchParams.get("code");
		if (!granted) throw new ConnectorError("no code", back.status, callback.search);
		return { code: granted, verifier, state, callback };
	}

	// An RS256 client assertion for the token endpoint the metadata names, unless told otherwise.
	async assertion(overrides: AssertionOverrides = {}, audience?: string): Promise<string> {
		const { key, kid } = this.connector;
		if (!key) throw new Error(`${this.connector.name} has no key`);
		const client: TestClient = {
			id: this.clientId ?? "",
			kind: "confidential",
			metadata: {},
			key,
			kid,
		};
		const { metadata } = await this.discover();
		return clientAssertion(
			client,
			audience ?? text(metadata.token_endpoint, "token_endpoint"),
			overrides,
		);
	}

	// A form POST to the token or revocation endpoint with the client's own authentication.
	async post(
		endpoint: "token_endpoint" | "revocation_endpoint",
		params: Record<string, string | undefined>,
		options: { readonly assertion?: string } = {},
	): Promise<Reply> {
		const { metadata } = await this.discover();
		const form = new URLSearchParams({ client_id: this.clientId ?? "" });
		for (const [name, value] of Object.entries(params))
			if (value !== undefined) form.set(name, value);
		if (this.connector.auth === "private_key_jwt") {
			form.set("client_assertion_type", "urn:ietf:params:oauth:client-assertion-type:jwt-bearer");
			form.set("client_assertion", options.assertion ?? (await this.assertion()));
		}
		const url = text(metadata[endpoint], endpoint);
		return asReply(await fetch(url, { method: "POST", body: form, headers: this.#headers }));
	}

	exchange(authorized: Authorized, extra: Record<string, string | undefined> = {}): Promise<Reply> {
		return this.post("token_endpoint", {
			grant_type: "authorization_code",
			code: authorized.code,
			redirect_uri: this.connector.redirectUri,
			code_verifier: authorized.verifier,
			...extra,
		});
	}

	refresh(refreshToken: string): Promise<Reply> {
		return this.post("token_endpoint", {
			grant_type: "refresh_token",
			refresh_token: refreshToken,
		});
	}

	revoke(token: string): Promise<Reply> {
		return this.post("revocation_endpoint", { token });
	}

	async callMcp(accessToken: string): Promise<number> {
		const { resource } = await this.discover();
		const response = await fetch(resource, {
			method: "POST",
			headers: { ...this.#headers, authorization: `Bearer ${accessToken}` },
		});
		await response.body?.cancel();
		return response.status;
	}

	// What adding the connector does: discovery, registration if it needs one, authorization, the
	// code exchange and a first MCP call.
	async connect(): Promise<Tokens> {
		const { unmet } = await this.discover();
		if (unmet.length > 0) throw new ConnectorError("the AS lacks", 0, unmet.join(", "));
		if (this.clientId === undefined) {
			const registered = await this.register();
			if (registered.status !== 201) {
				throw new ConnectorError(
					"registration refused",
					registered.status,
					JSON.stringify(registered.body),
				);
			}
		}
		const exchanged = await this.exchange(await this.authorize());
		if (exchanged.status !== 200) {
			throw new ConnectorError(
				"code exchange refused",
				exchanged.status,
				JSON.stringify(exchanged.body),
			);
		}
		const tokens = {
			accessToken: text(exchanged.body.access_token, "access_token"),
			refreshToken: text(exchanged.body.refresh_token, "refresh_token"),
			scope: text(exchanged.body.scope, "scope"),
		};
		const status = await this.callMcp(tokens.accessToken);
		if (status !== 200) throw new ConnectorError("MCP call refused", status, "");
		return tokens;
	}
}

async function asReply(response: Response): Promise<Reply> {
	const body = await response.text();
	return {
		status: response.status,
		body: body ? (JSON.parse(body) as Record<string, unknown>) : {},
		headers: response.headers,
	};
}

// The in-process paired desktop: types the code the consent page shows.
export function typesCode(as: {
	readonly consent: { approve(uid: string, code: string): unknown };
}): (consent: Consent) => void {
	return ({ uid, code }) => {
		as.consent.approve(uid, code);
	};
}
