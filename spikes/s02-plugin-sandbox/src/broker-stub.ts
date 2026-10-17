import net from "node:net";

// The egress broker's loopback and hub-port guard (plan §4 Egress broker step 6), standing in for
// M9's broker on every host/fetch: the inspector port 9229 and the hub ports 47613-47615 are refused
// on loopback, unspecified and hub addresses, and any request to a hub address is refused. It reads
// the literal URL only; M9 must apply the same check to the IP it resolves and connects to.

export const INSPECTOR_PORT = 9229;
export const HUB_PORTS: readonly number[] = Object.freeze([47613, 47614, 47615]);

const DEFAULT_PORT: Readonly<Record<string, number>> = { "http:": 80, "https:": 443 };

export type BrokerReason =
	| "allowed"
	| "bad-url"
	| "scheme"
	| "userinfo"
	| "inspector-port"
	| "hub-port"
	| "hub-address";

export interface BrokerDecision {
	readonly allow: boolean;
	readonly reason: BrokerReason;
	readonly port: number | null;
}

export interface BrokerOptions {
	// The hub's own bind addresses besides loopback (LAN, tailnet), in any IP or name spelling.
	readonly hubAddresses?: readonly string[];
}

// WHATWG URL already folds IPv4 spellings (127.1, 0x7f.0.0.1, 2130706433, 0) to dotted quads and
// IPv6 to its compressed lowercase hex form; this strips the brackets and any trailing dots.
function hostOf(hostname: string): string {
	const bare =
		hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
	return bare.replace(/\.+$/, "");
}

// A configured address in the same canonical form as a URL's host, or null if it isn't one.
export function canonicalAddress(value: string): string | null {
	const literal = net.isIPv6(value) ? `[${value}]` : value;
	try {
		const { hostname } = new URL(`http://${literal}/`);
		return hostOf(hostname) || null;
	} catch {
		return null;
	}
}

function ipv6Groups(host: string): number[] | null {
	if (!net.isIPv6(host)) return null;
	const [head = "", tail] = host.split("::");
	const part = (text: string): number[] =>
		text === "" ? [] : text.split(":").map((group) => Number.parseInt(group, 16));
	const left = part(head);
	const right = tail === undefined ? [] : part(tail);
	const zeros = tail === undefined ? 0 : 8 - left.length - right.length;
	const groups = [...left, ...new Array<number>(zeros).fill(0), ...right];
	return groups.length === 8 ? groups : null;
}

// The IPv4 address an IPv4-mapped (::ffff:a.b.c.d) or IPv4-compatible (::a.b.c.d) literal carries.
function embeddedIPv4(host: string): string | null {
	const groups = ipv6Groups(host);
	if (groups === null || groups.slice(0, 5).some((group) => group !== 0)) return null;
	if (groups[5] !== 0 && groups[5] !== 0xffff) return null;
	const [high = 0, low = 0] = groups.slice(6);
	return [high >> 8, high & 0xff, low >> 8, low & 0xff].join(".");
}

// Loopback (127/8, ::1, localhost and *.localhost) and unspecified (0/8, ::) addresses: a
// connection to any of them reaches this machine. ::1 and :: read as IPv4-compatible 0.0.0.1 and
// 0.0.0.0.
function isLocal(host: string): boolean {
	if (host === "localhost" || host.endsWith(".localhost")) return true;
	const v4 = net.isIPv4(host) ? host : embeddedIPv4(host);
	return v4 !== null && (v4.startsWith("127.") || v4.startsWith("0."));
}

function sameAddress(host: string, hubAddresses: readonly string[]): boolean {
	const forms = new Set([host, embeddedIPv4(host)].filter((form) => form !== null));
	return hubAddresses.some((address) => {
		const canonical = canonicalAddress(address);
		if (canonical === null) return false;
		return forms.has(canonical) || forms.has(embeddedIPv4(canonical) ?? "");
	});
}

// Fail closed: an unparsable URL, a scheme other than http(s), userinfo, the inspector or a hub
// port on a local or hub address, or any hub address is refused. Both verdicts are returned so the
// caller can audit either.
export function brokerDecision(rawUrl: string, options: BrokerOptions = {}): BrokerDecision {
	let url: URL;
	try {
		url = new URL(rawUrl);
	} catch {
		return { allow: false, reason: "bad-url", port: null };
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		return { allow: false, reason: "scheme", port: null };
	}
	const port = url.port === "" ? (DEFAULT_PORT[url.protocol] ?? 0) : Number(url.port);
	if (url.username !== "" || url.password !== "") {
		return { allow: false, reason: "userinfo", port };
	}
	const host = hostOf(url.hostname);
	const onHub = sameAddress(host, options.hubAddresses ?? []);
	if (isLocal(host) || onHub) {
		if (port === INSPECTOR_PORT) return { allow: false, reason: "inspector-port", port };
		if (HUB_PORTS.includes(port)) return { allow: false, reason: "hub-port", port };
	}
	if (onHub) return { allow: false, reason: "hub-address", port };
	return { allow: true, reason: "allowed", port };
}
