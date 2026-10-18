import { types } from "node:util";
import { parseStrict } from "@draftyak/protocol/jcs";
import type { MetadataBytes } from "./https.ts";
import { metadataMaxBytes } from "./limits.ts";
import type { MetadataKind } from "./policy.ts";

export const METADATA_CACHE_MAX_ENTRIES = 128;
export const METADATA_CACHE_MAX_BYTES: number = 8 * 1024 * 1024;
export const METADATA_CACHE_MAX_TTL_MS = 300_000;
const safeHeaders = new Set([
	"age",
	"cache-control",
	"connection",
	"content-length",
	"content-type",
	"date",
	"etag",
	"expires",
	"last-modified",
	"server",
	"strict-transport-security",
	"transfer-encoding",
	"x-content-type-options",
]);
const byteLength = Object.getOwnPropertyDescriptor(
	Object.getPrototypeOf(Uint8Array.prototype),
	"byteLength",
)?.get as (this: Uint8Array) => number;
function bodyLength(body: Uint8Array): number {
	if (!types.isUint8Array(body)) throw new TypeError();
	return byteLength.call(body);
}
function instant(value: string | undefined): number | undefined {
	if (value === undefined) return undefined;
	const date = Date.parse(value);
	return Number.isFinite(date) && new Date(date).toUTCString() === value ? date : undefined;
}
/** Conservative reuse hints only; unrecognized/ambiguous headers never enable caching. */
export function metadataCacheTtl(
	raw: readonly string[],
	nowWall: number,
	elapsedMs: number,
): number {
	if (
		!Number.isSafeInteger(nowWall) ||
		nowWall < 0 ||
		!Number.isFinite(elapsedMs) ||
		elapsedMs < 0 ||
		raw.length % 2 !== 0
	)
		return 0;
	const headers = new Map<string, string>();
	for (let index = 0; index < raw.length; index += 2) {
		const name = raw[index]?.toLowerCase(),
			value = raw[index + 1];
		if (name === undefined || value === undefined || !safeHeaders.has(name) || headers.has(name))
			return 0;
		headers.set(name, value);
	}
	const directives = new Set<string>();
	let maxAge: number | undefined;
	for (const part of (headers.get("cache-control") ?? "").split(",")) {
		const directive = part.trim().toLowerCase();
		const name = directive.split("=", 1)[0] ?? "";
		if (directives.has(name)) return 0;
		directives.add(name);
		if (["public", "must-revalidate", "immutable"].includes(directive)) continue;
		const age = /^max-age=(0|[1-9][0-9]{0,9})$/.exec(directive);
		if (!age) return 0;
		maxAge = Number(age[1]) * 1000;
	}
	if (!directives.has("public") || maxAge === undefined) return 0;
	const date = instant(headers.get("date"));
	if (date === undefined || date > nowWall) return 0;
	const rawAge = headers.get("age");
	if (rawAge !== undefined && !/^(0|[1-9][0-9]{0,9})$/.test(rawAge)) return 0;
	const age = Math.max(nowWall - date, Number(rawAge ?? 0) * 1000);
	let ttl = Math.min(METADATA_CACHE_MAX_TTL_MS, maxAge - age - elapsedMs);
	if (headers.has("expires")) {
		const expires = instant(headers.get("expires"));
		if (expires === undefined || expires < date) return 0;
		ttl = Math.min(ttl, expires - nowWall - elapsedMs);
	}
	return Number.isFinite(ttl) && ttl > 0 ? ttl : 0;
}
export function validMetadataBytes(
	value: MetadataBytes,
	kind: MetadataKind,
	maxBytes: number,
): boolean {
	try {
		const limit = metadataMaxBytes(kind, maxBytes);
		if (
			bodyLength(value.body) > limit ||
			!/^application\/(?:json|jwk-set\+json)(?:;[ \t]*charset=(?:utf-8|"utf-8"))?$/i.test(
				value.contentType,
			) ||
			(kind !== "jwks" && value.contentType.split(";", 1)[0]?.toLowerCase() !== "application/json")
		)
			return false;
		const parsed = parseStrict(copyMetadataBytes(value).body);
		return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed);
	} catch {
		return false;
	}
}
export function copyMetadataBytes(value: MetadataBytes): MetadataBytes {
	const body = new Uint8Array(bodyLength(value.body));
	Uint8Array.prototype.set.call(body, value.body);
	return Object.freeze({ body, contentType: value.contentType });
}
interface Entry {
	readonly kind: MetadataKind;
	readonly value: MetadataBytes;
	readonly expiresAt: number;
}
export interface CachedMetadata {
	readonly value: MetadataBytes;
	readonly expiresAt: number;
}
/** Per-fetcher storage only. Current policy, lifecycle and monotonic checks belong to the owner. */
export class MetadataCache {
	readonly #entries = new Map<string, Entry>();
	#bytes = 0;
	#delete(key: string): void {
		const entry = this.#entries.get(key);
		if (entry) this.#bytes -= entry.value.body.byteLength;
		this.#entries.delete(key);
	}
	#prune(now: number): void {
		for (const [key, entry] of this.#entries) if (entry.expiresAt <= now) this.#delete(key);
	}
	get(key: string, kind: MetadataKind, maxBytes: number, now: number): CachedMetadata | undefined {
		this.#prune(now);
		const entry = this.#entries.get(key);
		if (!entry || entry.kind !== kind) return undefined;
		if (!validMetadataBytes(entry.value, kind, maxBytes)) {
			this.#delete(key);
			return undefined;
		}
		this.#entries.delete(key);
		this.#entries.set(key, entry);
		return Object.freeze({ value: copyMetadataBytes(entry.value), expiresAt: entry.expiresAt });
	}
	put(
		key: string,
		kind: MetadataKind,
		value: MetadataBytes,
		ttlMs: number,
		maxBytes: number,
		now: number,
	): void {
		this.#prune(now);
		this.#delete(key);
		if (
			!/^[0-9a-f]{64}$/.test(key) ||
			!Number.isFinite(ttlMs) ||
			ttlMs <= 0 ||
			!validMetadataBytes(value, kind, maxBytes)
		)
			return;
		const size = bodyLength(value.body);
		while (
			this.#entries.size >= METADATA_CACHE_MAX_ENTRIES ||
			this.#bytes + size > METADATA_CACHE_MAX_BYTES
		) {
			const oldest = this.#entries.keys().next().value;
			if (oldest === undefined) return;
			this.#delete(oldest);
		}
		const copied = copyMetadataBytes(value);
		this.#entries.set(key, {
			kind,
			value: copied,
			expiresAt: now + Math.min(ttlMs, METADATA_CACHE_MAX_TTL_MS),
		});
		this.#bytes += copied.body.byteLength;
	}
	clear(): void {
		this.#entries.clear();
		this.#bytes = 0;
	}
}
