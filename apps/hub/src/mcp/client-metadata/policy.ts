import { isIP } from "node:net";
import { isProxy } from "node:util/types";

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

/** Copy configuration data without invoking getters, proxy traps or serialization hooks. */
export function configData(raw: unknown, depth = 0, budget = { left: 20000 }): unknown {
	if (--budget.left < 0 || depth > 16) throw refused();
	if (
		raw === null ||
		typeof raw === "string" ||
		typeof raw === "boolean" ||
		typeof raw === "number"
	)
		return raw;
	if (typeof raw !== "object" || isProxy(raw)) throw refused();
	const array = Array.isArray(raw),
		proto: unknown = Object.getPrototypeOf(raw);
	if (proto !== (array ? Array.prototype : Object.prototype) && (array || proto !== null))
		throw refused();
	if (Object.getOwnPropertySymbols(raw).length) throw refused();
	const target: unknown[] | Record<string, unknown> = array ? [] : Object.create(null);
	let members = 0;
	for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(raw))) {
		if (array && key === "length") continue;
		if (
			!descriptor.enumerable ||
			!Object.hasOwn(descriptor, "value") ||
			(array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= (raw as unknown[]).length))
		)
			throw refused();
		Object.defineProperty(target, key, {
			enumerable: true,
			value: configData(descriptor.value, depth + 1, budget),
		});
		members++;
	}
	if (array && (members !== (raw as unknown[]).length || (target as unknown[]).length !== members))
		throw refused();
	return target;
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
	if (typeof raw !== "string" || raw.length > 253 || isIP(raw) !== 0) return false;
	const labels = raw.split(".");
	return (
		labels.length >= 2 &&
		!/^\d+$/.test(labels.at(-1) ?? "") &&
		labels.every((label) => label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))
	);
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
