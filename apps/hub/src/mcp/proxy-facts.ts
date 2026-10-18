import { isIP } from "node:net";
import { isProxy } from "node:util/types";
import { createPeerPolicy } from "./peer-policy.ts";

export const MAX_PUBLIC_HEADER_FIELDS = 64;
export const MAX_PUBLIC_HEADER_BYTES = 16_384;
export class PublicRequestFactsError extends Error {
	readonly code = "PUBLIC_REQUEST_FACTS_REFUSED";
	constructor() {
		super("Public request facts refused");
	}
}
function refuse(): never {
	throw new PublicRequestFactsError();
}
function fields(raw: unknown, names: readonly string[]): Record<string, unknown> {
	if (
		!raw ||
		typeof raw !== "object" ||
		isProxy(raw) ||
		Array.isArray(raw) ||
		![Object.prototype, null].includes(Object.getPrototypeOf(raw)) ||
		Reflect.ownKeys(raw).length !== names.length
	)
		refuse();
	const result: Record<string, unknown> = Object.create(null);
	for (const name of names) {
		const descriptor = Object.getOwnPropertyDescriptor(raw, name);
		if (!descriptor?.enumerable || !("value" in descriptor)) refuse();
		result[name] = descriptor.value;
	}
	return result;
}
function publicOrigin(raw: unknown): { origin: string; host: string } {
	if (typeof raw !== "string" || raw.length > 512) refuse();
	const match = /^https:\/\/([a-z0-9.-]+|\[[0-9a-f:]+\])(?::([1-9][0-9]{0,4}))?$/.exec(raw);
	if (!match || (match[2] !== undefined && Number(match[2]) > 65_535)) refuse();
	const host = match[1];
	if (
		!host ||
		(!host.startsWith("[") &&
			(host.length > 253 ||
				host.split(".").some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))))
	)
		refuse();
	const url = new URL(raw);
	if (url.origin !== raw || url.href !== `${raw}/`) refuse();
	return { origin: raw, host: url.host };
}
function ip(raw: unknown): string {
	if (typeof raw !== "string" || raw.length > 45 || raw.includes("%")) refuse();
	const family = isIP(raw);
	if (family === 4) return raw;
	if (family !== 6) refuse();
	const canonical = new URL(`https://[${raw}]/`).hostname.slice(1, -1);
	const mapped = /^::ffff:([a-f0-9]{1,4}):([a-f0-9]{1,4})$/.exec(canonical);
	if (!mapped) return canonical;
	const high = Number.parseInt(mapped[1] as string, 16),
		low = Number.parseInt(mapped[2] as string, 16);
	return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
}
const selected = new Set(["host", "x-forwarded-for", "x-forwarded-proto", "x-forwarded-host"]);
function validHeaderValue(text: string): boolean {
	for (let at = 0; at < text.length; at++) {
		const unit = text.charCodeAt(at);
		if ((unit < 32 && unit !== 9) || unit === 127) return false;
	}
	return true;
}
function headers(raw: unknown): ReadonlyMap<string, string> {
	if (isProxy(raw) || !Array.isArray(raw) || Object.getPrototypeOf(raw) !== Array.prototype)
		refuse();
	const length = Object.getOwnPropertyDescriptor(raw, "length")?.value as number;
	if (
		length % 2 ||
		length > MAX_PUBLIC_HEADER_FIELDS * 2 ||
		Reflect.ownKeys(raw).length !== length + 1
	)
		refuse();
	const result = new Map<string, string>();
	let bytes = 0;
	const value = (at: number): string => {
		const descriptor = Object.getOwnPropertyDescriptor(raw, String(at));
		if (
			!descriptor?.enumerable ||
			!("value" in descriptor) ||
			typeof descriptor.value !== "string" ||
			descriptor.value.length > MAX_PUBLIC_HEADER_BYTES ||
			!descriptor.value.isWellFormed()
		)
			refuse();
		return descriptor.value;
	};
	for (let at = 0; at < length; at += 2) {
		const original = value(at),
			text = value(at + 1);
		bytes += Buffer.byteLength(original) + Buffer.byteLength(text) + 4;
		if (
			bytes > MAX_PUBLIC_HEADER_BYTES ||
			!/^[-!#$%&'*+.^_`|~0-9A-Za-z]+$/.test(original) ||
			!validHeaderValue(text)
		)
			refuse();
		const name = original.toLowerCase();
		if (name === "forwarded" || (name.startsWith("x-forwarded-") && !selected.has(name))) refuse();
		if (selected.has(name)) {
			if (result.has(name)) refuse();
			result.set(name, text);
		}
	}
	return result;
}

export interface PublicRequestFacts {
	readonly publicOrigin: string;
	readonly socketIP: string;
	readonly clientIP: string;
	readonly via: "direct" | "trusted-proxy";
}
export interface PublicRequestFactsPolicy {
	readonly publicOrigin: string;
	readonly trustedProxyCidrs: readonly string[];
	/** Native socket facts plus IncomingMessage.url/rawHeaders; never request-supplied facts. */
	inspect(native: unknown): PublicRequestFacts;
}

/** Single-hop observational policy only. No listener, configuration approval or access grant. */
export function createPublicRequestFactsPolicy(rawConfig: unknown): PublicRequestFactsPolicy {
	try {
		const config = fields(rawConfig, ["publicOrigin", "trustedProxyCidrs"]),
			base = publicOrigin(config.publicOrigin);
		// An absent proxy allowlist must never select the peer filter's unrestricted mode.
		if (config.trustedProxyCidrs === undefined) refuse();
		const proxies = createPeerPolicy(config.trustedProxyCidrs);
		return Object.freeze({
			publicOrigin: base.origin,
			trustedProxyCidrs: proxies.cidrs,
			inspect(raw: unknown): PublicRequestFacts {
				try {
					const native = fields(raw, ["url", "remoteAddress", "encrypted", "rawHeaders"]);
					// Absolute-form authority overrides Host in HTTP/1.1. Check the unparsed native
					// target before deriving any Host/proxy observations; do not normalize it as a URL.
					// Network-path references and literal backslashes can also become authority separators.
					if (
						typeof native.url !== "string" ||
						!native.url.startsWith("/") ||
						native.url.startsWith("//") ||
						native.url.includes("\\")
					)
						refuse();
					if (typeof native.encrypted !== "boolean") refuse();
					const socketIP = ip(native.remoteAddress),
						values = headers(native.rawHeaders);
					if (values.get("host") !== base.host) refuse();
					if (!proxies.allows(socketIP)) {
						if (!native.encrypted || [...values.keys()].some((key) => key !== "host")) refuse();
						return Object.freeze({
							publicOrigin: base.origin,
							socketIP,
							clientIP: socketIP,
							via: "direct",
						});
					}
					if (
						values.get("x-forwarded-proto") !== "https" ||
						(values.has("x-forwarded-host") && values.get("x-forwarded-host") !== base.host)
					)
						refuse();
					return Object.freeze({
						publicOrigin: base.origin,
						socketIP,
						clientIP: ip(values.get("x-forwarded-for")),
						via: "trusted-proxy",
					});
				} catch {
					return refuse();
				}
			},
		});
	} catch {
		return refuse();
	}
}
