import { lookup } from "node:dns/promises";
import { request } from "node:http";
import { BlockList, connect as connectTcp, isIP, type Socket } from "node:net";
import { connect as connectTls } from "node:tls";
import {
	type Client,
	type Configuration,
	errors,
	type KoaContext,
	type OIDCContext,
	type Provider,
} from "oidc-provider";

// §6: client ID metadata documents and jwks_uri are fetched only from these hosts, and from the
// hosts the owner adds. Entries are URL.host values: a port other than 443 must be named.
export const CIMD_HOSTS: readonly string[] = ["claude.ai", "chatgpt.com"];
// §4: the hub's own ports and the Node inspector's are never fetched, whatever the host.
export const BLOCKED_PORTS: ReadonlySet<number> = new Set([47613, 47614, 47615, 9229]);

// §4: private, loopback, link-local, CGNAT and ULA addresses, plus those no server is reached at
// (unspecified, multicast, reserved), the IPv6 forms that carry an IPv4 address, and the rest of
// the special-use list oidc-provider 9.12.2 checks itself, a check this guard replaces, apart from
// the IPv4 documentation ranges. BlockList checks IPv4-mapped IPv6 addresses against the IPv4
// ranges itself; NAT64 is decoded below.
const RANGES: readonly (readonly [reason: string, cidr: string])[] = [
	["unspecified", "0.0.0.0/8"],
	["private", "10.0.0.0/8"],
	["cgnat", "100.64.0.0/10"],
	["loopback", "127.0.0.0/8"],
	["link-local", "169.254.0.0/16"],
	["private", "172.16.0.0/12"],
	["special-use", "192.0.0.0/24"],
	["special-use", "192.31.196.0/24"],
	["special-use", "192.52.193.0/24"],
	["special-use", "192.88.99.0/24"],
	["private", "192.168.0.0/16"],
	["special-use", "192.175.48.0/24"],
	["special-use", "198.18.0.0/15"],
	["multicast", "224.0.0.0/4"],
	["reserved", "240.0.0.0/4"],
	["unspecified", "::/128"],
	["loopback", "::1/128"],
	["ipv4-compatible", "::/96"],
	["ipv4-translated", "::ffff:0:0:0/96"],
	["nat64-local", "64:ff9b:1::/48"],
	["special-use", "100::/64"],
	["special-use", "100:0:0:1::/64"],
	["teredo", "2001::/32"],
	["special-use", "2001::/23"],
	["documentation", "2001:db8::/32"],
	["6to4", "2002::/16"],
	["special-use", "2620:4f:8000::/48"],
	["documentation", "3fff::/20"],
	["special-use", "5f00::/16"],
	["ula", "fc00::/7"],
	["link-local", "fe80::/10"],
	["site-local", "fec0::/10"],
	["multicast", "ff00::/8"],
];
const LISTS = RANGES.map(([reason, cidr]) => {
	const [network = "", prefix = ""] = cidr.split("/");
	const list = new BlockList();
	list.addSubnet(network, Number(prefix), isIP(network) === 4 ? "ipv4" : "ipv6");
	return [reason, list] as const;
});

// The eight 16-bit words of a valid IPv6 address, which may end in a dotted IPv4 address.
function ipv6Words(address: string): number[] {
	const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(address);
	const text = dotted
		? `${address.slice(0, dotted.index)}${(Number(dotted[1]) * 256 + Number(dotted[2])).toString(16)}:${(Number(dotted[3]) * 256 + Number(dotted[4])).toString(16)}`
		: address;
	const [head = "", tail] = text.split("::");
	const left = head === "" ? [] : head.split(":");
	const right = tail === undefined || tail === "" ? [] : tail.split(":");
	const zeros = tail === undefined ? [] : Array<string>(8 - left.length - right.length).fill("0");
	return [...left, ...zeros, ...right].map((word) => Number.parseInt(word, 16));
}

// Why the guard refuses to connect to an address; undefined for a public unicast one.
export function blockedAddress(address: string): string | undefined {
	const bare = address.replace(/%.*$/, "");
	const family = isIP(bare);
	if (family === 0) return "not an IP address";
	for (const [reason, list] of LISTS) {
		if (list.check(bare, family === 4 ? "ipv4" : "ipv6")) return reason;
	}
	if (family === 4) return undefined;
	// 64:ff9b::/96 reaches the IPv4 address in its last 32 bits through a NAT64 gateway.
	const [a, b, c, d, e, f, high = 0, low = 0] = ipv6Words(bare);
	if (a !== 0x64 || b !== 0xff9b || c || d || e || f) return undefined;
	const embedded = blockedAddress([high >> 8, high & 255, low >> 8, low & 255].join("."));
	return embedded === undefined ? undefined : `nat64 ${embedded}`;
}

export interface Resolved {
	readonly address: string;
	readonly family: number;
}

export interface Target extends Resolved {
	readonly port: number;
}

// What oidc-provider passes configuration.fetch: a GET with headers and an abort signal.
export interface GuardedInit {
	readonly method?: string;
	readonly headers?: unknown;
	readonly body?: unknown;
	readonly signal?: AbortSignal | null;
}

export type GuardedFetch = (input: string | URL, init?: GuardedInit) => Promise<Response>;

export type Refusal =
	| "url"
	| "host"
	| "port"
	| "method"
	| "dns"
	| "address"
	| "connect"
	| "tls"
	| "redirect"
	| "size"
	| "timeout";

export class FetchRefused extends Error {
	override name = "FetchRefused";
	readonly reason: Refusal;

	constructor(reason: Refusal, message: string) {
		super(message);
		this.reason = reason;
	}
}

export interface GuardOptions {
	readonly hosts: Iterable<string>;
	readonly resolve?: (hostname: string) => Promise<readonly Resolved[]>;
	// The TCP connection to an address the guard has checked; TLS runs over it here.
	readonly dial?: (target: Target) => Socket;
	// Trust anchors in place of Node's bundled roots (tests).
	readonly ca?: string | readonly string[];
	readonly timeoutMs?: number;
	readonly maxBytes?: number;
}

const HOST = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?::\d{1,5})?$/;

function hostSet(hosts: Iterable<string>): Set<string> {
	const set = new Set<string>();
	for (const host of hosts) {
		const lower = host.toLowerCase();
		if (!HOST.test(lower) || lower.endsWith(":443")) throw new Error(`not a host: ${host}`);
		set.add(lower);
	}
	return set;
}

const lookupAll = (hostname: string): Promise<readonly Resolved[]> =>
	lookup(hostname, { all: true, order: "verbatim" });

const dialTcp = (target: Target): Socket =>
	connectTcp({ host: target.address, port: target.port, family: target.family, noDelay: true });

function beforeDeadline<T>(work: Promise<T>, deadline: AbortSignal, host: string): Promise<T> {
	const late = (): FetchRefused => new FetchRefused("timeout", `no answer from ${host} in time`);
	if (deadline.aborted) return Promise.reject(late());
	return new Promise<T>((resolve, reject) => {
		const abort = (): void => reject(late());
		deadline.addEventListener("abort", abort, { once: true });
		work.then(resolve, reject).finally(() => deadline.removeEventListener("abort", abort));
	});
}

// The one way out for CIMD documents and jwks_uri: an https GET to an allowlisted host, resolved
// once, every address checked, then connected to the checked address itself, so a second DNS
// answer can't move the connection. No redirects; size and time are capped.
export function guardedFetch(options: GuardOptions): GuardedFetch {
	const hosts = hostSet(options.hosts);
	const { resolve = lookupAll, dial = dialTcp, timeoutMs = 5_000, maxBytes = 64 * 1024 } = options;
	const ca = options.ca === undefined ? undefined : [options.ca].flat();
	return async (input, init = {}) => {
		const url = URL.parse(String(input));
		if (url?.protocol !== "https:" || url.username !== "" || url.password !== "") {
			throw new FetchRefused("url", "only https URLs without credentials are fetched");
		}
		if (!hosts.has(url.host)) throw new FetchRefused("host", `${url.host} isn't allowlisted`);
		const port = Number(url.port || 443);
		if (BLOCKED_PORTS.has(port)) throw new FetchRefused("port", `port ${port} is never fetched`);
		if ((init.method ?? "GET").toUpperCase() !== "GET" || init.body != null) {
			throw new FetchRefused("method", "only GET requests are made");
		}
		const deadline = AbortSignal.any([
			AbortSignal.timeout(timeoutMs),
			...(init.signal ? [init.signal] : []),
		]);
		const hostname = url.hostname.replace(/^\[(.*)\]$/, "$1");
		let addresses: readonly Resolved[];
		try {
			addresses = await beforeDeadline(resolve(hostname), deadline, url.host);
		} catch (error) {
			if (error instanceof FetchRefused) throw error;
			throw new FetchRefused("dns", `${url.host} didn't resolve`);
		}
		const [first] = addresses;
		if (first === undefined) throw new FetchRefused("dns", `${url.host} has no address`);
		for (const { address } of addresses) {
			const reason = blockedAddress(address);
			if (reason !== undefined) {
				throw new FetchRefused("address", `${url.host} resolves to a ${reason} address`);
			}
		}
		const target = { address: first.address, family: first.family, port };
		return exchange(url, target, { dial, ca, maxBytes, deadline });
	};
}

interface Exchange {
	readonly dial: (target: Target) => Socket;
	readonly ca: string[] | undefined;
	readonly maxBytes: number;
	readonly deadline: AbortSignal;
}

// HTTP/1.1 over TLS to the checked address; the certificate must name the URL's host (SNI).
function exchange(url: URL, target: Target, options: Exchange): Promise<Response> {
	const { dial, ca, maxBytes, deadline } = options;
	return new Promise((resolve, reject) => {
		const tcp = dial(target);
		const servername = isIP(url.hostname.replace(/^\[(.*)\]$/, "$1")) ? undefined : url.hostname;
		const tls = connectTls({
			socket: tcp,
			servername,
			ALPNProtocols: ["http/1.1"],
			...(ca && { ca }),
		});
		const req = request({
			method: "GET",
			path: `${url.pathname}${url.search}`,
			headers: {
				host: url.host,
				accept: "application/json",
				"accept-encoding": "identity",
				connection: "close",
			},
			createConnection: () => tls,
		});
		let connected = !tcp.connecting;
		let secured = false;
		let settled = false;
		const finish = (outcome: () => void): void => {
			if (settled) return;
			settled = true;
			deadline.removeEventListener("abort", late);
			req.destroy();
			tls.destroy();
			tcp.destroy();
			outcome();
		};
		const fail = (reason: Refusal, message: string): void =>
			finish(() => reject(new FetchRefused(reason, message)));
		const late = (): void => fail("timeout", `no answer from ${url.host} in time`);
		const broken = (error: Error): void => {
			const reason = connected && !secured ? "tls" : "connect";
			fail(reason, `${url.host}: ${error.message}`);
		};
		tcp.once("connect", () => {
			connected = true;
		});
		tls.once("secureConnect", () => {
			secured = true;
		});
		tcp.on("error", broken);
		tls.on("error", broken);
		req.on("error", broken);
		req.once("response", (res) => {
			const status = res.statusCode ?? 0;
			if (status >= 300 && status < 400) {
				fail("redirect", `${url.host} answered ${status}: redirects are never followed`);
				return;
			}
			if (status < 200 || status > 599) {
				fail("connect", `${url.host} answered ${status}`);
				return;
			}
			const tooLarge = (): void => fail("size", `${url.host} sent more than ${maxBytes} bytes`);
			if (Number(res.headers["content-length"] ?? 0) > maxBytes) {
				tooLarge();
				return;
			}
			const chunks: Buffer[] = [];
			let size = 0;
			res.on("data", (chunk: Buffer) => {
				size += chunk.length;
				if (size > maxBytes) tooLarge();
				else chunks.push(chunk);
			});
			res.on("error", broken);
			res.once("end", () => {
				const headers = new Headers();
				for (let at = 0; at + 1 < res.rawHeaders.length; at += 2) {
					try {
						headers.append(res.rawHeaders[at] ?? "", res.rawHeaders[at + 1] ?? "");
					} catch {
						// A header Fetch can't hold is left out.
					}
				}
				const empty = status === 204 || status === 205 || status === 304;
				const body = empty ? null : new Uint8Array(Buffer.concat(chunks));
				finish(() => resolve(new Response(body, { status, headers })));
			});
		});
		if (deadline.aborted) late();
		else deadline.addEventListener("abort", late, { once: true });
		req.end();
	});
}

// Which private_key_jwt audience a client assertion named, once oidc-provider accepted it.
export type AudienceForm = "issuer" | "token endpoint" | "endpoint" | "list";

export interface CimdPolicy extends Omit<GuardOptions, "hosts"> {
	// Defaults to CIMD_HOSTS; the owner's additions go here too.
	readonly hosts?: Iterable<string>;
	// Seconds a fetched document is reused, bounding its own cache headers (default 30 s to 1 day).
	readonly cacheDuration?: { readonly min: number; readonly max: number };
	// How long a client ID whose lookup failed is refused without a new fetch (default 30 s).
	readonly retryMs?: number;
	// "issuer" accepts only the issuer, as one string (draft-ietf-oauth-rfc7523bis). The spike's
	// default, "endpoints", until M0.20 records what ChatGPT sends: also the token endpoint's URL or
	// this endpoint's, or a list holding one of them.
	readonly audience?: "issuer" | "endpoints";
	// Each verified client assertion's audience, as a category.
	readonly onAssertion?: (form: AudienceForm) => void;
}

// At most this many failed client IDs are remembered.
const REFUSED_IDS = 1024;

// What an assertion's aud named, among the audiences oidc-provider accepted.
function audienceForm(aud: unknown, provider: Provider): AudienceForm {
	if (Array.isArray(aud)) return "list";
	if (aud === provider.issuer) return "issuer";
	return aud === provider.urlFor("token") ? "token endpoint" : "endpoint";
}

export interface Cimd {
	readonly hosts: ReadonlySet<string>;
	readonly fetch: GuardedFetch;
	// For AsOptions.configure.
	configure(configuration: Configuration): void;
	// After createProvider: the redirect and assertion-audience rules, and the failed lookups.
	install(provider: Provider): Provider;
}

const LOOPBACK = /^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::(\d{1,5}))?(?=[/?]|$)/;

// An http loopback redirect URI without its port, else undefined. Only the port may differ from a
// registered URI (RFC 8252 §7.3); everything else is compared as the exact registered string.
export function withoutLoopbackPort(uri: string): string | undefined {
	const match = LOOPBACK.exec(uri);
	if (match === null || uri.includes("#")) return undefined;
	const port = match[1];
	if (port === undefined) return uri;
	if (port.startsWith("0") || Number(port) > 65_535) return undefined;
	return `${uri.slice(0, match[0].length - port.length - 1)}${uri.slice(match[0].length)}`;
}

export function cimd(policy: CimdPolicy = {}): Cimd {
	const hosts = hostSet(policy.hosts ?? CIMD_HOSTS);
	const fetch = guardedFetch({ ...policy, hosts });
	const allowed = (value: string | undefined): boolean => {
		const url = URL.parse(value ?? "");
		return url?.protocol === "https:" && hosts.has(url.host);
	};
	// oidc-provider caches only documents it could use, and its authorization error page looks a
	// failed client up again, so each request naming an unknown client ID would cost the vendor two
	// GETs. A client ID whose lookup failed isn't fetched again for retryMs.
	const retryMs = policy.retryMs ?? 30_000;
	const refusedUntil = new Map<string, number>();
	const refused = (clientId: string): boolean => (refusedUntil.get(clientId) ?? 0) > Date.now();
	const failed = (clientId: string): void => {
		if (!allowed(clientId) || refused(clientId)) return;
		refusedUntil.delete(clientId);
		refusedUntil.set(clientId, Date.now() + retryMs);
		const [oldest] = refusedUntil.keys();
		if (refusedUntil.size > REFUSED_IDS && oldest !== undefined) refusedUntil.delete(oldest);
	};
	const strictAudience = policy.audience === "issuer";
	// Checked whenever a CIMD client is used, cached documents included.
	const allowedClient = (client: Client): boolean =>
		allowed(client.clientId) &&
		["none", "private_key_jwt"].includes(client.clientAuthMethod) &&
		(client.jwksUri === undefined || allowed(client.jwksUri));
	// Remote Claude Code: a CIMD client on an allowlisted host whose redirect URIs are all loopback.
	const loopbackOnly = (client: Client): boolean =>
		client.clientIdMetadataDocument === true &&
		allowedClient(client) &&
		client.redirectUris.length > 0 &&
		client.redirectUris.every((uri) => withoutLoopbackPort(uri) !== undefined);

	return {
		hosts,
		fetch,
		configure(configuration) {
			const features = (configuration.features ?? {}) as Record<string, unknown>;
			configuration.features = features;
			features.clientIdMetadataDocument = {
				enabled: true,
				// The implemented draft, acknowledged: a release that moves it fails to start.
				ack: "draft-02",
				allowFetch: async (_ctx: unknown, clientId: string) =>
					allowed(clientId) && !refused(clientId),
				allowClient: async (_ctx: unknown, client: Client) => allowedClient(client),
				...(policy.cacheDuration && { cacheDuration: { ...policy.cacheDuration } }),
			};
			configuration.fetch = fetch;
			configuration.fetchResponseBodyLimits = {
				"client_id metadata document": 5 * 1024,
				jwks_uri: 64 * 1024,
			};
			configuration.clientAuthMethods = ["none", "private_key_jwt"];
			configuration.enabledJWA = {
				...(configuration.enabledJWA as object),
				clientAuthSigningAlgValues: ["RS256"],
			};
			// After the signature checks: an array holding the issuer gets past oidc-provider's own.
			configuration.assertJwtClientAuthClaimsAndHeader = async (
				ctx: KoaContext,
				claims: { readonly aud?: unknown },
			) => {
				const form = audienceForm(claims.aud, ctx.oidc.provider);
				policy.onAssertion?.(form);
				if (strictAudience && form !== "issuer") {
					throw new errors.InvalidClientAuth("audience (aud) must be the issuer identifier alone");
				}
			};
		},
		install(provider) {
			const find = provider.Client.find.bind(provider.Client);
			provider.Client.find = async (id, options) => {
				try {
					return await find(id, options);
				} catch (error) {
					failed(id);
					throw error;
				}
			};
			// Exact matching for every client; any loopback port only for remote Claude Code. This also
			// replaces 9.12.2's own any-port match for every application_type native client.
			provider.Client.prototype.redirectUriAllowed = function (this: Client, value: string) {
				if (this.redirectUris.includes(value)) return true;
				const portless = loopbackOnly(this) ? withoutLoopbackPort(value) : undefined;
				return (
					portless !== undefined &&
					this.redirectUris.some((uri) => withoutLoopbackPort(uri) === portless)
				);
			};
			// private_key_jwt audiences come from the issuer, never from the request's Host or
			// X-Forwarded-* (which a proxy may leave out or a client may send).
			provider.OIDCContext.prototype.clientJwtAuthExpectedAudience = function (this: OIDCContext) {
				if (strictAudience) return new Set([provider.issuer]);
				const audiences = new Set([provider.issuer, provider.urlFor("token")]);
				try {
					audiences.add(provider.urlFor(this.route));
				} catch {
					// A route whose URL takes parameters authenticates no client.
				}
				return audiences;
			};
			return provider;
		},
	};
}
