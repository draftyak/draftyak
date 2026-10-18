import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	METADATA_CACHE_MAX_BYTES,
	METADATA_CACHE_MAX_ENTRIES,
	METADATA_CACHE_MAX_TTL_MS,
	MetadataCache,
	metadataCacheTtl,
} from "../../src/mcp/client-metadata/cache.ts";

const wall = Date.UTC(2026, 9, 18, 12);
const date = new Date(wall).toUTCString();
const headers = (control = "public, max-age=60", extra: string[] = []): string[] => [
	"Content-Type",
	"application/json",
	"Date",
	date,
	"Cache-Control",
	control,
	...extra,
];
const key = (name: string): string => createHash("sha256").update(name).digest("hex");
const bytes = (text = '{"self_declared":true}', contentType = "application/json") => ({
	body: Buffer.from(text),
	contentType,
});

describe("conservative metadata freshness", () => {
	it("deducts age and response time and obeys an earlier Expires and the hard ceiling", () => {
		expect(metadataCacheTtl(headers(), wall + 2000, 100)).toBe(57_900);
		expect(metadataCacheTtl(headers(undefined, ["Age", "10"]), wall, 100)).toBe(49_900);
		expect(
			metadataCacheTtl(
				headers(undefined, ["Expires", new Date(wall + 5000).toUTCString()]),
				wall,
				100,
			),
		).toBe(4900);
		expect(metadataCacheTtl(headers("public,max-age=9999999999,immutable"), wall, 0)).toBe(
			METADATA_CACHE_MAX_TTL_MS,
		);
	});
	it.each([
		"",
		"max-age=60",
		"private,max-age=60",
		"public,no-store,max-age=60",
		"public,no-cache,max-age=60",
		"public,max-age=0",
		"public,max-age=-1",
		'public,max-age="60"',
		"public,max-age=60,max-age=120",
		"public,public,max-age=60",
		"public,max-age=60,s-maxage=120",
		"public,max-age=60,stale-if-error=60",
	])("does not reuse unsupported or ambiguous directives %j", (control) => {
		expect(metadataCacheTtl(headers(control), wall, 0)).toBe(0);
	});
	it.each([
		["Set-Cookie", "SECRET_CANARY=value"],
		["Authorization", "Bearer SECRET_CANARY"],
		["WWW-Authenticate", "SECRET_CANARY"],
		["Authentication-Info", "SECRET_CANARY"],
		["Proxy-Authenticate", "SECRET_CANARY"],
		["X-Private-Token", "SECRET_CANARY"],
		["Vary", "Accept-Encoding"],
		["Date", date],
		["Cache-Control", "public,max-age=60"],
		["Age", "60"],
		["Age", "-1"],
		["Age", "01"],
		["Age", "invalid"],
		["Expires", "invalid"],
		["Expires", new Date(wall - 1000).toUTCString()],
	])("does not reuse secret-bearing, varying, duplicate or stale header %j", (...extra) => {
		expect(metadataCacheTtl(headers(undefined, extra), wall, 0)).toBe(0);
	});
	it("refuses missing/future/noncanonical dates and unusable clocks", () => {
		expect(metadataCacheTtl(["Cache-Control", "public,max-age=60"], wall, 0)).toBe(0);
		expect(metadataCacheTtl(headers(), wall - 1, 0)).toBe(0);
		expect(metadataCacheTtl(headers(), wall, -1)).toBe(0);
		expect(metadataCacheTtl(headers(), NaN, 0)).toBe(0);
		expect(metadataCacheTtl(headers(), wall, Infinity)).toBe(0);
		expect(
			metadataCacheTtl(["Date", "2026-10-18", "Cache-Control", "public,max-age=60"], wall, 0),
		).toBe(0);
	});
});

describe("instance-local bounded metadata bytes", () => {
	it("copies on insertion and every hit, rechecks purpose/size, and expires without sliding", () => {
		const cache = new MetadataCache();
		const source = bytes();
		cache.put(key("one"), "cimd", source, 1000, 1024, 100);
		source.body.fill(0);
		const hit = cache.get(key("one"), "cimd", 1024, 101);
		expect(hit?.expiresAt).toBe(1100);
		expect(Buffer.from(hit?.value.body ?? []).toString()).toBe('{"self_declared":true}');
		hit?.value.body.fill(0);
		expect(
			Buffer.from(cache.get(key("one"), "cimd", 1024, 1099)?.value.body ?? []).toString(),
		).toBe('{"self_declared":true}');
		expect(cache.get(key("one"), "jwks", 1024, 1099)).toBeUndefined();
		expect(cache.get(key("one"), "cimd", 1024, 1100)).toBeUndefined();
	});
	it("revalidates strict JSON, UTF-8, media type and byte caps before reuse", () => {
		const cache = new MetadataCache();
		for (const value of [
			bytes("invalid"),
			bytes("[]"),
			bytes("null"),
			bytes('{"x":1,"x":2}'),
			bytes('{"x":true}', "text/html"),
			bytes('{"keys":[]}', "application/jwk-set+json"),
			{ body: new Uint8Array([0xff]), contentType: "application/json" },
		]) {
			cache.put(key("one"), "cimd", value, 1000, 1024, 100);
			expect(cache.get(key("one"), "cimd", 1024, 100)).toBeUndefined();
		}
		cache.put(
			key("one"),
			"jwks",
			bytes('{"keys":[]}', "application/jwk-set+json"),
			1000,
			1024,
			100,
		);
		expect(cache.get(key("one"), "jwks", 1024, 100)).toBeDefined();
		expect(cache.get(key("one"), "jwks", 1, 100)).toBeUndefined();
	});
	it("bounds entry count with LRU eviction and stores no enumerable URLs or bodies", () => {
		const cache = new MetadataCache();
		for (let index = 0; index < METADATA_CACHE_MAX_ENTRIES; index++)
			cache.put(key(String(index)), "cimd", bytes(), 1000, 1024, 100);
		expect(cache.get(key("0"), "cimd", 1024, 100)).toBeDefined();
		cache.put(key("extra"), "cimd", bytes(), 1000, 1024, 100);
		expect(cache.get(key("1"), "cimd", 1024, 100)).toBeUndefined();
		expect(cache.get(key("0"), "cimd", 1024, 100)).toBeDefined();
		expect(JSON.stringify(cache)).toBe("{}");
		cache.clear();
		expect(cache.get(key("0"), "cimd", 1024, 100)).toBeUndefined();
	});
	it("bounds aggregate body bytes independently of entry count", () => {
		const cache = new MetadataCache();
		const count = METADATA_CACHE_MAX_BYTES / 1_048_576;
		const source = bytes(`{"text":"${"x".repeat(1_048_576 - 11)}"}`);
		expect(source.body.byteLength).toBe(1_048_576);
		for (let index = 0; index <= count; index++)
			cache.put(key(String(index)), "cimd", source, 1000, 1_048_576, 100);
		expect(cache.get(key("0"), "cimd", 1_048_576, 100)).toBeUndefined();
		expect(cache.get(key(String(count)), "cimd", 1_048_576, 100)).toBeDefined();
	});
});
