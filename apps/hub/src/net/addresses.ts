import { Resolver } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { networkInterfaces } from "node:os";
import { isProxy } from "node:util/types";
import { PublicDnsHost } from "@draftyak/protocol/tool-v1";
import { networkTestHooks } from "./test-context.ts";

export interface PinnedAddress {
	readonly address: string;
	readonly family: 4 | 6;
}
/** Native policy only: this does not establish the caller's permission to send. */
export interface EgressPolicy {
	readonly deniedAddresses: readonly string[];
	readonly deniedPorts: readonly number[];
	readonly allowLocal?: boolean;
}
export const networkRefused = (): Error => new Error("Network request refused");
export const HUB_DENIED_PORTS: readonly number[] = Object.freeze([47613, 47614, 47615, 9229]);
const blocked = new BlockList(),
	local = new BlockList();
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
for (const [address, bits] of [
	["2001::", 23],
	["2001:db8::", 32],
	["2002::", 16],
	["3ffe::", 16],
	["3fff::", 20],
] as const)
	blocked.addSubnet(address, bits, "ipv6");
for (const [address, bits] of [
	["10.0.0.0", 8],
	["100.64.0.0", 10],
	["127.0.0.0", 8],
	["169.254.0.0", 16],
	["172.16.0.0", 12],
	["192.168.0.0", 16],
] as const)
	local.addSubnet(address, bits, "ipv4");
local.addAddress("::1", "ipv6");
local.addSubnet("fc00::", 7, "ipv6");
local.addSubnet("fe80::", 10, "ipv6");
const metadata = new Set([
	"169.254.169.254",
	"169.254.170.2",
	"fd00:ec2::254",
	"100.100.100.200",
	"168.63.129.16",
]);
const policies = new WeakSet<object>();
/** Snapshot selected native facts before an await; this is policy data, never a permission. */
export function captureEgressPolicy(raw: EgressPolicy): EgressPolicy {
	try {
		if (raw === null || typeof raw !== "object" || isProxy(raw)) throw networkRefused();
		if (policies.has(raw)) return raw;
		const proto: unknown = Object.getPrototypeOf(raw);
		if (proto !== Object.prototype && proto !== null) throw networkRefused();
		const field = (name: string): unknown => {
			const d = Object.getOwnPropertyDescriptor(raw, name);
			if (!d) return undefined;
			if (!d.enumerable || !Object.hasOwn(d, "value")) throw networkRefused();
			return d.value;
		};
		const vector = (value: unknown, maximum: number): unknown[] => {
			if (
				isProxy(value) ||
				!Array.isArray(value) ||
				Object.getPrototypeOf(value) !== Array.prototype
			)
				throw networkRefused();
			const length = Object.getOwnPropertyDescriptor(value, "length")?.value;
			if (!Number.isSafeInteger(length) || length > maximum) throw networkRefused();
			const values: unknown[] = [];
			for (let i = 0; i < length; i++) {
				const d = Object.getOwnPropertyDescriptor(value, String(i));
				if (!d?.enumerable || !Object.hasOwn(d, "value")) throw networkRefused();
				values.push(d.value);
			}
			return values;
		};
		const allowLocal = field("allowLocal");
		if (allowLocal !== undefined && typeof allowLocal !== "boolean") throw networkRefused();
		const deniedAddresses = vector(field("deniedAddresses"), 4096).map((value) => {
			if (typeof value !== "string" || value.length > 45) throw networkRefused();
			return canonicalAddress(value);
		});
		const deniedPorts = vector(field("deniedPorts"), 65535).map((value) => {
			if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > 65535)
				throw networkRefused();
			return value;
		});
		const checked = Object.freeze({
			deniedAddresses: Object.freeze(deniedAddresses),
			deniedPorts: Object.freeze([...new Set([...HUB_DENIED_PORTS, ...deniedPorts])]),
			allowLocal: allowLocal === true,
		});
		policies.add(checked);
		return checked;
	} catch {
		throw networkRefused();
	}
}

/** Fold embedded IPv4 for own-address comparison, including dual-stack socket addresses. */
export function canonicalAddress(raw: string): string {
	if (isIP(raw) === 4) return raw;
	if (isIP(raw) !== 6 || raw.includes("%")) throw networkRefused();
	const canonical = new URL(`https://[${raw}]/`).hostname.slice(1, -1);
	const embedded = /^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(canonical);
	if (!embedded) return canonical;
	const high = Number.parseInt(embedded[1] as string, 16),
		low = Number.parseInt(embedded[2] as string, 16);
	return `${high >>> 8}.${high & 255}.${low >>> 8}.${low & 255}`;
}
export function publicAddress(raw: string): boolean {
	try {
		const address = canonicalAddress(raw);
		if (metadata.has(address) || isIP(raw) !== isIP(address)) return false;
		if (isIP(address) === 4) return !blocked.check(address, "ipv4");
		const first = Number.parseInt(address.split(":")[0] ?? "", 16);
		return first >= 0x2000 && first <= 0x3fff && !blocked.check(address, "ipv6");
	} catch {
		return false;
	}
}
export function egressHost(host: string, allowLocal = false): void {
	if (PublicDnsHost.safeParse(host).success) return;
	if (allowLocal && isIP(host) !== 0) return;
	if (
		allowLocal &&
		host.length <= 253 &&
		/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/.test(
			host,
		)
	) {
		try {
			if (new URL(`https://${host}/`).hostname === host) return;
		} catch {
			/* Refuse aliases. */
		}
	}
	throw networkRefused();
}
export function egressPort(port: number, policy: EgressPolicy): void {
	if (
		!Number.isSafeInteger(port) ||
		port < 1 ||
		port > 65535 ||
		captureEgressPolicy(policy).deniedPorts.includes(port)
	)
		throw networkRefused();
}
function capturedAnswers(raw: readonly PinnedAddress[]): readonly PinnedAddress[] {
	if (isProxy(raw) || !Array.isArray(raw) || Object.getPrototypeOf(raw) !== Array.prototype)
		throw networkRefused();
	const length = Object.getOwnPropertyDescriptor(raw, "length")?.value;
	if (!Number.isSafeInteger(length) || length < 1 || length > 32) throw networkRefused();
	const answers: PinnedAddress[] = [];
	for (let i = 0; i < length; i++) {
		const entry = Object.getOwnPropertyDescriptor(raw, String(i));
		if (!entry?.enumerable || !Object.hasOwn(entry, "value")) throw networkRefused();
		const value: unknown = entry.value;
		if (value === null || typeof value !== "object" || isProxy(value)) throw networkRefused();
		const proto: unknown = Object.getPrototypeOf(value);
		if (proto !== Object.prototype && proto !== null) throw networkRefused();
		const address = Object.getOwnPropertyDescriptor(value, "address"),
			family = Object.getOwnPropertyDescriptor(value, "family");
		if (
			!address?.enumerable ||
			!Object.hasOwn(address, "value") ||
			typeof address.value !== "string" ||
			address.value.length > 45 ||
			!family?.enumerable ||
			!Object.hasOwn(family, "value") ||
			(family.value !== 4 && family.value !== 6)
		)
			throw networkRefused();
		answers.push(Object.freeze({ address: address.value, family: family.value }));
	}
	return Object.freeze(answers);
}
export function validateEgressAnswers(
	answers: readonly PinnedAddress[],
	policy: EgressPolicy,
): PinnedAddress {
	answers = capturedAnswers(answers);
	policy = captureEgressPolicy(policy);
	if (answers.length < 1 || answers.length > 32) throw networkRefused();
	const interfaces = Object.values(networkInterfaces()).flatMap(
		(rows) => rows?.map((row) => row.address) ?? [],
	);
	const own = new Set([...policy.deniedAddresses, ...interfaces].map(canonicalAddress));
	for (const answer of answers) {
		const address = canonicalAddress(answer.address),
			family = isIP(address);
		if (
			isIP(answer.address) !== answer.family ||
			family !== answer.family ||
			own.has(address) ||
			metadata.has(address) ||
			(!publicAddress(address) &&
				!(policy.allowLocal === true && local.check(address, family === 4 ? "ipv4" : "ipv6")))
		)
			throw networkRefused();
	}
	const first = answers[0] as PinnedAddress;
	return Object.freeze({ address: canonicalAddress(first.address), family: first.family });
}
/** c-ares only; one cancellable resolver, and every returned family must pass the same policy. */
export async function resolveEgress(
	host: string,
	port: number,
	policy: EgressPolicy,
	signal: AbortSignal,
): Promise<PinnedAddress> {
	let resolver: Resolver | undefined;
	const cancel = () => resolver?.cancel();
	signal.addEventListener("abort", cancel, { once: true });
	try {
		policy = captureEgressPolicy(policy);
		egressHost(host, policy.allowLocal);
		egressPort(port, policy);
		signal.throwIfAborted();
		const hook = networkTestHooks()?.resolve;
		let values: readonly PinnedAddress[];
		if (hook) values = await hook(host, signal);
		else if (isIP(host)) values = [{ address: host, family: isIP(host) as 4 | 6 }];
		else {
			resolver = new Resolver({ tries: 1, timeout: 2000 });
			const answers = await Promise.allSettled([resolver.resolve4(host), resolver.resolve6(host)]);
			values = answers.flatMap((answer, index) =>
				answer.status === "fulfilled"
					? answer.value.map((address) => ({ address, family: (index === 0 ? 4 : 6) as 4 | 6 }))
					: [],
			);
		}
		signal.throwIfAborted();
		return validateEgressAnswers(values, policy);
	} catch {
		throw networkRefused();
	} finally {
		signal.removeEventListener("abort", cancel);
		resolver?.cancel();
	}
}
