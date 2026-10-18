import { Resolver } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { networkInterfaces } from "node:os";
import { refused } from "./policy.ts";

export interface PinnedAddress {
	readonly address: string;
	readonly family: 4 | 6;
}
const blocked = new BlockList();
// Conservative special-use exclusions; even public exceptions inside these blocks stay denied.
for (const [address, bits] of [
	["0.0.0.0", 8],
	["10.0.0.0", 8],
	["100.64.0.0", 10],
	["127.0.0.0", 8],
	["169.254.0.0", 16],
	["172.16.0.0", 12],
	["192.0.0.0", 24],
	["192.0.2.0", 24],
	["192.88.99.0", 24],
	["192.168.0.0", 16],
	["198.18.0.0", 15],
	["198.51.100.0", 24],
	["203.0.113.0", 24],
	["224.0.0.0", 4],
	["240.0.0.0", 4],
] as const)
	blocked.addSubnet(address, bits, "ipv4");
blocked.addAddress("168.63.129.16", "ipv4"); // Azure host-platform endpoint, not ordinary public egress.
for (const [address, bits] of [
	["2001::", 23],
	["2001:db8::", 32],
	["2002::", 16],
	["3ffe::", 16],
	["3fff::", 20],
] as const)
	blocked.addSubnet(address, bits, "ipv6");
export function canonicalAddress(raw: string): string {
	if (isIP(raw) === 4) return raw;
	if (isIP(raw) !== 6 || raw.includes("%")) throw refused();
	return new URL(`https://[${raw}]/`).hostname.slice(1, -1);
}
export function publicAddress(raw: string): boolean {
	try {
		const address = canonicalAddress(raw);
		if (isIP(address) === 4) return !blocked.check(address, "ipv4");
		// Only ordinary global-unicast IPv6. This also denies mapped/compatible IPv4 and NAT64.
		const first = Number.parseInt(address.split(":")[0] ?? "", 16);
		return first >= 0x2000 && first <= 0x3fff && !blocked.check(address, "ipv6");
	} catch {
		return false;
	}
}
export function validateAnswers(
	answers: readonly PinnedAddress[],
	denied: readonly string[],
): PinnedAddress {
	if (answers.length < 1 || answers.length > 32) throw refused();
	const own = new Set(denied.map(canonicalAddress));
	if (
		answers.some(
			(answer) =>
				isIP(answer.address) !== answer.family ||
				!publicAddress(answer.address) ||
				own.has(canonicalAddress(answer.address)),
		)
	)
		throw refused();
	const first = answers[0];
	if (!first) throw refused();
	return Object.freeze({ address: canonicalAddress(first.address), family: first.family });
}
/** One cancellable resolver per fetch. The pinned HTTPS lookup never performs DNS again. */
export async function resolvePublic(
	host: string,
	denied: readonly string[],
	signal: AbortSignal,
): Promise<PinnedAddress> {
	const resolver = new Resolver({ tries: 1, timeout: 2000 });
	const cancel = () => resolver.cancel();
	signal.addEventListener("abort", cancel, { once: true });
	try {
		signal.throwIfAborted();
		const answers = await Promise.allSettled([resolver.resolve4(host), resolver.resolve6(host)]);
		signal.throwIfAborted();
		const values = answers.flatMap((answer, index) =>
			answer.status === "fulfilled"
				? answer.value.map((address) => ({ address, family: (index === 0 ? 4 : 6) as 4 | 6 }))
				: [],
		);
		const interfaces = Object.values(networkInterfaces()).flatMap(
			(rows) => rows?.map((row) => row.address) ?? [],
		);
		return validateAnswers(values, [...denied, ...interfaces]);
	} catch {
		throw refused();
	} finally {
		signal.removeEventListener("abort", cancel);
		resolver.cancel();
	}
}
