import { isProxy } from "node:util/types";
import { PublicDnsHost } from "@draftyak/protocol/tool-v1";

export type MetadataKind = "cimd" | "jwks";
export interface MetadataDestinationRule {
	readonly kind: MetadataKind;
	readonly host: string;
	readonly paths: readonly ({ readonly exact: string } | { readonly prefix: string })[];
}
export interface MetadataDestination {
	readonly kind: MetadataKind;
	readonly url: string;
	readonly host: string;
	readonly path: string;
}
export class ClientMetadataError extends Error {
	constructor() {
		super("Client metadata refused");
		this.name = "ClientMetadataError";
	}
}
export const refused = (): ClientMetadataError => new ClientMetadataError();

// Smallest whole-MiB envelope above all current valid configuration maxima (8,495,307 bytes).
export const MAX_METADATA_CONFIG_BYTES: number = 9 * 1024 * 1024;
/** Detached immutable JSON data; bound strings/keys before scans or escaped serialization. */
export function configData(raw: unknown): unknown {
	let nodes = 20000,
		remaining = MAX_METADATA_CONFIG_BYTES;
	const spend = (bytes: number): void => {
		remaining -= bytes;
		if (remaining < 0) throw refused();
	};
	const text = (value: string): void => {
		if (value.length > remaining || !value.isWellFormed()) throw refused();
		spend(2);
		for (let at = 0; at < value.length; at++) {
			const unit = value.charCodeAt(at);
			if (unit < 32) spend([8, 9, 10, 12, 13].includes(unit) ? 2 : 6);
			else if (unit === 34 || unit === 92) spend(2);
			else if (unit < 128) spend(1);
			else if (unit < 2048) spend(2);
			else if (unit >= 0xd800 && unit <= 0xdbff) {
				spend(4);
				at++;
			} else spend(3);
		}
	};
	const copy = (value: unknown, depth: number): unknown => {
		if (--nodes < 0 || depth > 16 || isProxy(value)) throw refused();
		if (typeof value === "string") {
			text(value);
			return value;
		}
		if (value === null || typeof value === "boolean" || typeof value === "number") {
			if (typeof value === "number" && !Number.isFinite(value)) throw refused();
			spend(JSON.stringify(value).length);
			return value;
		}
		if (typeof value !== "object") throw refused();
		const array = Array.isArray(value),
			proto: unknown = Object.getPrototypeOf(value);
		if (proto !== (array ? Array.prototype : Object.prototype) && (array || proto !== null))
			throw refused();
		const length = array ? Object.getOwnPropertyDescriptor(value, "length")?.value : 0;
		if (array && (!Number.isSafeInteger(length) || length > 256)) throw refused();
		const keys = Reflect.ownKeys(value);
		if (array ? keys.length !== length + 1 : keys.length > 256) throw refused();
		spend(2 + Math.max(0, (array ? length : keys.length) - 1));
		const target: unknown[] | Record<string, unknown> = array ? [] : Object.create(null);
		for (const key of keys) {
			if (array && key === "length") continue;
			if (
				typeof key !== "string" ||
				(array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= length))
			)
				throw refused();
			if (!array) {
				text(key);
				spend(1);
			}
			const descriptor = Object.getOwnPropertyDescriptor(value, key);
			if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) throw refused();
			Object.defineProperty(target, key, {
				enumerable: true,
				value: copy(descriptor.value, depth + 1),
			});
		}
		if (array && (target as unknown[]).length !== length) throw refused();
		return Object.freeze(target);
	};
	try {
		return copy(raw, 0);
	} catch {
		throw refused();
	}
}
export function record(raw: unknown, keys: readonly string[]): raw is Record<string, unknown> {
	return (
		raw !== null &&
		typeof raw === "object" &&
		!Array.isArray(raw) &&
		Object.keys(raw).sort().join("\n") === [...keys].sort().join("\n")
	);
}
function hostName(raw: unknown): raw is string {
	return PublicDnsHost.safeParse(raw).success;
}
function pathName(raw: unknown): raw is string {
	return (
		typeof raw === "string" &&
		raw.length <= 2048 &&
		/^\/[A-Za-z0-9._~/-]*$/.test(raw) &&
		!raw.includes("//") &&
		!raw.split("/").some((part) => part === "." || part === "..")
	);
}
export function metadataUrl(raw: unknown, kind: MetadataKind): MetadataDestination {
	try {
		if ((kind !== "cimd" && kind !== "jwks") || typeof raw !== "string" || raw.length > 2308)
			throw refused();
		const match = /^https:\/\/([^/]+)(\/.*)$/.exec(raw);
		if (!match || !hostName(match[1]) || !pathName(match[2])) throw refused();
		const url = new URL(raw);
		if (
			url.href !== raw ||
			url.hostname !== match[1] ||
			url.port ||
			url.username ||
			url.password ||
			url.search ||
			url.hash
		)
			throw refused();
		return Object.freeze({ kind, url: raw, host: url.hostname, path: url.pathname });
	} catch {
		throw refused();
	}
}

/** Owner-approved rules only. No built-in vendor, suffix, wildcard or whole-host permission. */
export class MetadataDestinations {
	readonly #rules: readonly MetadataDestinationRule[];
	constructor(input: readonly MetadataDestinationRule[]) {
		const raw = configData(input);
		if (!Array.isArray(raw) || raw.length > 128) throw refused();
		this.#rules = Object.freeze(
			raw.map((rule: unknown) => {
				if (
					!record(rule, ["kind", "host", "paths"]) ||
					(rule.kind !== "cimd" && rule.kind !== "jwks") ||
					!hostName(rule.host) ||
					!Array.isArray(rule.paths) ||
					rule.paths.length < 1 ||
					rule.paths.length > 32
				)
					throw refused();
				const kind = rule.kind,
					host = rule.host;
				const paths = Object.freeze(
					rule.paths.map((value: unknown) => {
						if (record(value, ["exact"]) && pathName(value.exact))
							return Object.freeze({ exact: value.exact });
						if (
							record(value, ["prefix"]) &&
							pathName(value.prefix) &&
							value.prefix.length > 1 &&
							value.prefix.endsWith("/")
						)
							return Object.freeze({ prefix: value.prefix });
						throw refused();
					}),
				);
				return Object.freeze({ kind, host, paths });
			}),
		);
	}
	check(raw: unknown, kind: MetadataKind): MetadataDestination {
		const destination = metadataUrl(raw, kind);
		if (
			!this.#rules.some(
				(rule) =>
					rule.kind === kind &&
					rule.host === destination.host &&
					rule.paths.some((path) =>
						"exact" in path
							? path.exact === destination.path
							: destination.path.startsWith(path.prefix),
					),
			)
		)
			throw refused();
		return destination;
	}
}
