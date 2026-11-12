import { BlockList, isIP } from "node:net";

export type AddressLocality =
	| "public"
	| "loopback"
	| "private"
	| "carrier-grade-nat"
	| "link-local"
	| "special-use"
	| "metadata";
export interface AddressFacts {
	readonly address: string;
	readonly family: 4 | 6;
	readonly locality: AddressLocality;
}
export const networkRefused = (): Error => new Error("Network request refused");
const special = new BlockList();
for (const [address, bits] of [
	["0.0.0.0", 8],
	["192.0.0.0", 24],
	["192.0.2.0", 24],
	["192.31.196.0", 24],
	["192.52.193.0", 24],
	["192.88.99.0", 24],
	["192.175.48.0", 24],
	["198.18.0.0", 15],
	["198.51.100.0", 24],
	["203.0.113.0", 24],
	["224.0.0.0", 4],
	["240.0.0.0", 4],
] as const)
	special.addSubnet(address, bits, "ipv4");
for (const [address, bits] of [
	["2001::", 23],
	["2001:db8::", 32],
	["2002::", 16],
	["2620:4f:8000::", 48],
	["3ffe::", 16],
	["3fff::", 20],
] as const)
	special.addSubnet(address, bits, "ipv6");
const metadata = new Set([
	"169.254.169.254",
	"169.254.170.2",
	"fd00:ec2::254",
	"100.100.100.200",
	"168.63.129.16",
]);

/** Address equivalence only. A canonical address is not permission to connect. */
export function canonicalAddress(raw: string): string {
	if (typeof raw !== "string" || raw.length > 45) throw networkRefused();
	if (isIP(raw) === 4) return raw;
	if (isIP(raw) !== 6 || raw.includes("%")) throw networkRefused();
	const canonical = new URL(`https://[${raw}]/`).hostname.slice(1, -1);
	const embedded = /^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(canonical);
	if (!embedded) return canonical;
	const high = Number.parseInt(embedded[1] as string, 16);
	const low = Number.parseInt(embedded[2] as string, 16);
	return `${high >>> 8}.${high & 255}.${low >>> 8}.${low & 255}`;
}

/** Pure facts for native routing adapters; no policy, DNS or caller authority is consulted. */
export function addressFacts(raw: string): AddressFacts {
	const address = canonicalAddress(raw);
	const family = isIP(address) as 4 | 6;
	let locality: AddressLocality;
	if (metadata.has(address)) locality = "metadata";
	else if (family === 4) {
		const parts = address.split(".").map(Number);
		const first = parts[0] as number;
		const second = parts[1] as number;
		if (first === 127) locality = "loopback";
		else if (
			first === 10 ||
			(first === 172 && second >= 16 && second <= 31) ||
			(first === 192 && second === 168)
		)
			locality = "private";
		else if (first === 100 && second >= 64 && second <= 127) locality = "carrier-grade-nat";
		else if (first === 169 && second === 254) locality = "link-local";
		else locality = special.check(address, "ipv4") ? "special-use" : "public";
	} else {
		const first = Number.parseInt(address.split(":")[0] ?? "", 16);
		if (address === "::1") locality = "loopback";
		else if (first >= 0xfc00 && first <= 0xfdff) locality = "private";
		else if (first >= 0xfe80 && first <= 0xfebf) locality = "link-local";
		else
			locality =
				first >= 0x2000 && first <= 0x3fff && !special.check(address, "ipv6")
					? "public"
					: "special-use";
	}
	return Object.freeze({ address, family, locality });
}

/** Conservative permission-neutral public-address predicate, including mapped-address refusal. */
export function publicAddress(raw: string): boolean {
	try {
		const facts = addressFacts(raw);
		return facts.locality === "public" && isIP(raw) === facts.family;
	} catch {
		return false;
	}
}
