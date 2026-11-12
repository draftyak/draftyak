import { Resolver } from "node:dns/promises";
import { isIP } from "node:net";
import { networkInterfaces } from "node:os";
import { isProxy } from "node:util/types";
import { PublicDnsHost } from "@draftyak/protocol/tool-v1";
import { BLOCKED_LOOPBACK_PORTS as HUB_DENIED_PORTS } from "../ports.ts";

export { BLOCKED_LOOPBACK_PORTS as HUB_DENIED_PORTS } from "../ports.ts";

import { addressFacts, canonicalAddress, networkRefused } from "./address-facts.ts";

export { canonicalAddress, networkRefused, publicAddress } from "./address-facts.ts";

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

export function egressHost(host: string, allowLocal = false): void {
	if (typeof host !== "string" || host.length > 253) throw networkRefused();
	if (allowLocal && isIP(host) !== 0) {
		canonicalAddress(host);
		return;
	}
	try {
		if (new URL(`https://${host}/`).hostname !== host) throw networkRefused();
	} catch {
		throw networkRefused();
	}
	if (PublicDnsHost.safeParse(host).success) return;
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
function checkedEgressAnswers(
	answers: readonly PinnedAddress[],
	policy: EgressPolicy,
): readonly PinnedAddress[] {
	answers = capturedAnswers(answers);
	policy = captureEgressPolicy(policy);
	if (answers.length < 1 || answers.length > 32) throw networkRefused();
	const interfaces = Object.values(networkInterfaces())
		.flatMap((rows) => rows?.map((row) => row.address) ?? [])
		.filter((address) => addressFacts(address).locality !== "loopback");
	const own = new Set([...policy.deniedAddresses, ...interfaces].map(canonicalAddress));
	const classes = new Set<string>();
	for (const answer of answers) {
		const address = canonicalAddress(answer.address),
			family = isIP(address);
		const locality = addressFacts(address).locality;
		if (
			isIP(answer.address) !== answer.family ||
			family !== answer.family ||
			own.has(address) ||
			(locality !== "public" &&
				!(
					policy.allowLocal === true &&
					["loopback", "private", "carrier-grade-nat", "link-local"].includes(locality)
				))
		)
			throw networkRefused();
		classes.add(locality === "public" || locality === "loopback" ? locality : "local-network");
	}
	if (classes.size !== 1) throw networkRefused();
	return Object.freeze(
		answers.map(({ address, family }) =>
			Object.freeze({ address: canonicalAddress(address), family }),
		),
	);
}
export function validateEgressAnswers(
	answers: readonly PinnedAddress[],
	policy: EgressPolicy,
): PinnedAddress {
	return checkedEgressAnswers(answers, policy)[0] as PinnedAddress;
}
/** c-ares only; one cancellable resolver, and every returned family must pass the same policy. */
export async function resolveEgressAnswers(
	host: string,
	port: number,
	policy: EgressPolicy,
	signal: AbortSignal,
): Promise<readonly PinnedAddress[]> {
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
			for (const answer of answers)
				if (answer.status === "rejected" && !["ENODATA", "ENOTFOUND"].includes(answer.reason?.code))
					throw networkRefused();
			values = answers.flatMap((answer, index) =>
				answer.status === "fulfilled"
					? answer.value.map((address) => ({ address, family: (index === 0 ? 4 : 6) as 4 | 6 }))
					: [],
			);
		}
		signal.throwIfAborted();
		return checkedEgressAnswers(values, policy);
	} catch {
		throw networkRefused();
	} finally {
		signal.removeEventListener("abort", cancel);
		resolver?.cancel();
	}
}

export async function resolveEgress(
	host: string,
	port: number,
	policy: EgressPolicy,
	signal: AbortSignal,
): Promise<PinnedAddress> {
	return (await resolveEgressAnswers(host, port, policy, signal))[0] as PinnedAddress;
}
