import { createServer, type IncomingHttpHeaders, type IncomingMessage } from "node:http";
import { type AddressInfo, BlockList, isIP } from "node:net";
import { getRequestListener, type HttpBindings } from "@hono/node-server";
import type { Hono } from "hono";
import type { Provider } from "oidc-provider";
import type { AppOptions, Env, Running } from "./routes.ts";

// §6 L3: X-Forwarded-* count only on connections from a configured proxy. Forwarded and X-Real-IP
// never count: Caddy passes a client's own values for them through unchanged.
const FORWARDING = /^(?:x-forwarded-[\w-]+|forwarded|x-real-ip)$/i;
const NEVER_TRUSTED = /^(?:forwarded|x-real-ip)$/i;

const unmapped = (address: string): string =>
	address.replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, "");

export class ProxyTrust {
	readonly proxies: readonly string[];
	readonly #list = new BlockList();

	// Addresses or CIDR ranges, such as 127.0.0.1 for a proxy on this machine (Funnel, Caddy). Any
	// local process, and on Docker Desktop any container, then connects from a trusted address and
	// can name the requester's: an address to show, never one to grant access by.
	constructor(proxies: readonly string[]) {
		for (const entry of proxies) {
			const [address = "", prefix, extra] = entry.split("/");
			const family = isIP(address);
			const bits = prefix === undefined ? (family === 4 ? 32 : 128) : Number(prefix);
			const max = family === 4 ? 32 : 128;
			if (
				family === 0 ||
				extra !== undefined ||
				!Number.isInteger(bits) ||
				bits < 0 ||
				bits > max
			) {
				throw new Error(`not an address or CIDR range: ${entry}`);
			}
			this.#list.addSubnet(address, bits, family === 4 ? "ipv4" : "ipv6");
		}
		this.proxies = [...proxies];
	}

	trusts(address: string | undefined): boolean {
		const bare = unmapped(address ?? "");
		const family = isIP(bare);
		return family !== 0 && this.#list.check(bare, family === 4 ? "ipv4" : "ipv6");
	}

	// The requester's address: the connection's, or behind a configured proxy the nearest
	// X-Forwarded-For entry that isn't a configured proxy itself. A malformed entry ends the walk.
	clientIp(incoming: IncomingMessage): string | undefined {
		const peer = incoming.socket.remoteAddress && unmapped(incoming.socket.remoteAddress);
		if (!this.trusts(peer)) return peer;
		const forwarded = [incoming.headers["x-forwarded-for"] ?? ""].flat().join(",");
		const hops = forwarded
			.split(",")
			.map((hop) => unmapped(hop.trim()))
			.filter((hop) => hop !== "");
		for (const hop of hops.toReversed()) {
			if (isIP(hop) === 0) return peer;
			if (!this.trusts(hop)) return hop;
		}
		return hops[0] ?? peer;
	}

	// Drops the forwarding headers this connection can't be trusted with before Hono or Koa reads
	// any header: every one from other peers, Forwarded and X-Real-IP from the proxy too.
	sanitize(incoming: IncomingMessage): void {
		const trusted = this.trusts(incoming.socket.remoteAddress);
		const dropped = (name: string): boolean =>
			trusted ? NEVER_TRUSTED.test(name) : FORWARDING.test(name);
		const raw = incoming.rawHeaders;
		if (!raw.some((name, at) => at % 2 === 0 && dropped(name))) return;
		const distinct = incoming.headersDistinct;
		const kept = (record: object) =>
			Object.fromEntries(Object.entries(record).filter(([name]) => !dropped(name)));
		incoming.headers = kept(incoming.headers) as IncomingHttpHeaders;
		incoming.headersDistinct = kept(distinct) as NodeJS.Dict<string[]>;
		incoming.rawHeaders = raw.filter((_, at) => !dropped(raw[at - (at % 2)] ?? ""));
	}
}

// With a proxy configured, Koa builds URLs from its X-Forwarded-Proto and -Host, and the consent
// request shows the requester address clientIp finds. Serve the app only with serveBehindProxy:
// without its sanitize, Koa would take any peer's X-Forwarded-*.
export function behindProxy(provider: Provider, trust: ProxyTrust): Pick<AppOptions, "clientIp"> {
	provider.proxy = trust.proxies.length > 0;
	return { clientIp: (incoming) => trust.clientIp(incoming) };
}

export interface ServeOptions {
	readonly trust: ProxyTrust;
	// 127.0.0.1 unless a proxy can only reach another address (a Linux engine's bridge gateway).
	readonly host?: string;
	readonly port?: number;
	// Each request as it arrived, before sanitize: to record which headers a proxy sends.
	readonly observe?: (incoming: IncomingMessage) => void;
}

// routes.ts's listen, with the forwarding headers sanitized first; `build` gets the bound origin.
export async function serveBehindProxy(
	build: (origin: string) => Hono<Env>,
	options: ServeOptions,
): Promise<Running> {
	const { trust, host = "127.0.0.1", port = 0, observe } = options;
	let app: Hono<Env> | undefined;
	const listener = getRequestListener(
		(request, env) =>
			app ? app.fetch(request, env as HttpBindings) : new Response(null, { status: 503 }),
		{ overrideGlobalObjects: false },
	);
	const server = createServer((incoming, outgoing) => {
		observe?.(incoming);
		trust.sanitize(incoming);
		void listener(incoming, outgoing);
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject).listen(port, host, () => resolve());
	});
	const origin = `http://${host}:${(server.address() as AddressInfo).port}`;
	app = build(origin);
	return {
		origin,
		close: () =>
			new Promise<void>((done) => {
				server.close(() => done());
				server.closeAllConnections();
			}),
	};
}
