import { isIP } from "node:net";
import { types } from "node:util";

export const MAX_PEER_CIDRS = 32;

export class PeerPolicyError extends Error {
	readonly code = "INVALID_PEER_POLICY";
	constructor() {
		super("Invalid peer policy");
	}
}

export interface PeerPolicy {
	readonly mode: "unrestricted" | "allowlist";
	readonly cidrs: readonly string[];
	/** Only a native socket's remoteAddress belongs here. Forwarded headers are not evidence. */
	allows(socketAddress: unknown): boolean;
}

interface Address {
	readonly family: 4 | 6;
	readonly bits: bigint;
	readonly mapped: boolean;
	readonly canonical: string;
}
interface Network {
	readonly family: 4 | 6;
	readonly bits: bigint;
	readonly prefix: number;
	readonly name: string;
}

function address(raw: unknown): Address | undefined {
	if (typeof raw !== "string" || raw.length > 45 || raw.includes("%")) return undefined;
	const family = isIP(raw);
	if (family === 4) {
		const octets = raw.split(".").map(Number);
		const bits = octets.reduce((value, octet) => (value << 8n) | BigInt(octet), 0n);
		return { family, bits, mapped: false, canonical: raw };
	}
	if (family !== 6) return undefined;
	let hex = raw;
	if (hex.includes(".")) {
		const colon = hex.lastIndexOf(":");
		const v4 = address(hex.slice(colon + 1));
		if (v4?.family !== 4) return undefined;
		hex = `${hex.slice(0, colon + 1)}${(v4.bits >> 16n).toString(16)}:${(v4.bits & 0xffffn).toString(16)}`;
	}
	const halves = hex.split("::");
	const left = halves[0] ? halves[0].split(":") : [];
	const right = halves[1] ? halves[1].split(":") : [];
	const groups =
		halves.length === 2
			? [...left, ...Array<string>(8 - left.length - right.length).fill("0"), ...right]
			: left;
	const bits = groups.reduce((value, group) => (value << 16n) | BigInt(`0x${group}`), 0n);
	const mapped = bits >> 32n === 0xffffn;
	return {
		family,
		bits,
		mapped,
		canonical: new URL(`https://[${raw}]/`).hostname.slice(1, -1),
	};
}

function network(raw: unknown): Network {
	if (typeof raw !== "string" || raw.length > 49) throw new PeerPolicyError();
	const slash = raw.indexOf("/");
	if (slash < 1) throw new PeerPolicyError();
	const ip = address(raw.slice(0, slash));
	const suffix = raw.slice(slash + 1);
	if (!ip || ip.mapped || !/^(0|[1-9][0-9]{0,2})$/.test(suffix)) throw new PeerPolicyError();
	const prefix = Number(suffix);
	const width = ip.family === 4 ? 32 : 128;
	if (prefix > width) throw new PeerPolicyError();
	const hostBits = BigInt(width - prefix);
	if ((ip.bits >> hostBits) << hostBits !== ip.bits) throw new PeerPolicyError();
	return { family: ip.family, bits: ip.bits, prefix, name: `${ip.canonical}/${prefix}` };
}

function entries(raw: unknown): Network[] {
	if (types.isProxy(raw) || !Array.isArray(raw) || Object.getPrototypeOf(raw) !== Array.prototype)
		throw new PeerPolicyError();
	const length = Object.getOwnPropertyDescriptor(raw, "length")?.value as unknown;
	if (
		typeof length !== "number" ||
		length > MAX_PEER_CIDRS ||
		Reflect.ownKeys(raw).length !== length + 1
	)
		throw new PeerPolicyError();
	const values: Network[] = [];
	const seen = new Set<string>();
	for (let at = 0; at < length; at++) {
		const descriptor = Object.getOwnPropertyDescriptor(raw, String(at));
		if (!descriptor || !("value" in descriptor) || !descriptor.enumerable)
			throw new PeerPolicyError();
		const value = network(descriptor.value);
		if (seen.has(value.name)) throw new PeerPolicyError();
		seen.add(value.name);
		values.push(value);
	}
	return values;
}

/** Pure additional filter. It neither authenticates a principal nor changes any native policy. */
export function createPeerPolicy(rawCidrs?: unknown): PeerPolicy {
	const networks = rawCidrs === undefined ? undefined : entries(rawCidrs);
	const cidrs = Object.freeze(networks?.map((value) => value.name).sort() ?? []);
	return Object.freeze({
		mode: networks === undefined ? "unrestricted" : "allowlist",
		cidrs,
		allows(raw: unknown): boolean {
			const ip = address(raw);
			if (!ip) return false;
			if (networks === undefined) return true;
			const family = ip.mapped ? 4 : ip.family;
			const bits = ip.mapped ? ip.bits & 0xffff_ffffn : ip.bits;
			return networks.some((range) => {
				if (range.family !== family) return false;
				const hostBits = BigInt((family === 4 ? 32 : 128) - range.prefix);
				return (bits >> hostBits) << hostBits === range.bits;
			});
		},
	});
}
