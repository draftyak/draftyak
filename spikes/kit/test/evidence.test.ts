import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os, { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
	assertContentFree,
	fingerprint,
	hashId,
	newSessionKey,
	redact,
	redactHeaders,
	redactUrl,
	writeEvidence,
} from "../evidence.ts";
import { repoRoot } from "../repo.ts";

// Built at runtime, so the repo holds no token- or address-shaped literal.
const j = (...parts: string[]): string => parts.join("");
const shaped: Record<string, string> = {
	token: j("xo", "xb-", "1".repeat(4), "-abcdEFGHijkl"),
	email: j("someone", "@", "example", ".com"),
	tailnet: j("box.tail1234", ".ts", ".net"),
	uuid: randomUUID(),
	ipv6: j("2001:db8", "::8a2e:370:7334"),
	ipv4: j("192.0", ".2.10"),
	phone: j("+1 202", " 555 0143"),
	digits: "1".repeat(12),
};

describe("content-free evidence", () => {
	it("accepts measurements, ISO times, names, versions, hashes and hashed ids", () => {
		const fine = {
			p50Ms: 812.5,
			at: new Date(0).toISOString(),
			headers: ["content-type", "x-ratelimit-remaining"],
			v8Version: "14.6.202.33-node.20",
			commit: "1234567890abcdef1234567890abcdef12345678",
			id: hashId(newSessionKey(), "1712345678.123456"),
			path: "std::fs at 12:34:56",
		};
		expect(() => assertContentFree(fine)).not.toThrow();
	});

	it.each(Object.entries(shaped))(
		"refuses a %s by JSON path and rule, never by value",
		(rule, value) => {
			const attempt = () => assertContentFree({ data: { list: ["ok", `seen ${value} here`] } });
			expect(attempt).toThrow(`$.data.list[1] (${rule}`);
			expect(attempt).not.toThrow(value);
			expect(redact(`seen ${value} here`)).toBe(`seen [redacted:${rule}] here`);
		},
	);

	it("checks keys, IPv4 outside *Version keys, long strings and numbers", () => {
		expect(() => assertContentFree({ [shaped.email ?? ""]: 1 })).toThrow("$.<key> (email)");
		expect(() => assertContentFree({ version: "1.2.3.4" })).toThrow("$.version (ipv4)");
		expect(() => assertContentFree({ body: "x".repeat(300) })).toThrow("longer than 256");
		expect(() => assertContentFree({ p95: Number.NaN })).toThrow("p95 (not finite)");
	});

	it("refuses long strings before any pattern runs; redact() bounds its input", () => {
		const begun = performance.now();
		expect(() => assertContentFree({ body: "a-".repeat(50_000) })).toThrow(
			"$.body (longer than 256)",
		);
		expect(redact("a".repeat(5_000))).toBe("[redacted:long]");
		expect(redact("a".repeat(4_096))).toHaveLength(4_096);
		expect(performance.now() - begun).toBeLessThan(1_000);
	});

	it("accepts pinned image references, checking only their names", () => {
		const digest = "sha256:7c7b2c966bc9ee8cedfeef67e0e279108992c77681fa595db4a9d65c06ccc587";
		const image = `debian:bookworm-slim@${digest}`;
		expect(() => assertContentFree({ image, base: `node:26.12.0-alpine@${digest}` })).not.toThrow();
		expect(redact(image)).toBe(image);
		expect(() => assertContentFree({ image: `${shaped.ipv4}/x@${digest}` })).toThrow(
			"$.image (ipv4)",
		);
	});

	it("refuses this machine's home folder, user name as a path segment and host name", () => {
		const user = os.userInfo().username;
		const home = path.join(os.homedir(), "spike", "evidence");
		expect(() => assertContentFree({ value: `at ${home}` })).toThrow("$.value (home");
		expect(redact(`at ${home}`)).toBe(`at [redacted:home]${path.sep}spike${path.sep}evidence`);
		// In a root container the home folder, /root, matches as well.
		expect(() => assertContentFree({ value: `/srv/${user}/x` })).toThrow(/ \((?:home, )?user\)$/);
		expect(() => assertContentFree({ value: `x-${user}-y and ${user}name` })).not.toThrow();
		const host = os.hostname();
		if (host.length > 2 && host !== "localhost") {
			expect(() => assertContentFree({ value: `built on ${host}` })).toThrow("(host)");
		}
	});

	it("keeps header values only for rate limits, retry-after and content-type; URLs as host and hash", () => {
		const headers = new Headers({
			"Content-Type": "text/plain",
			"Retry-After": "30",
			"Request-Id": "r1",
		});
		headers.set("X-RateLimit-Remaining", "41");
		expect(redactHeaders(headers)).toEqual({
			names: ["content-type", "request-id", "retry-after", "x-ratelimit-remaining"],
			values: { "content-type": "text/plain", "retry-after": "30", "x-ratelimit-remaining": "41" },
		});
		expect(redactHeaders({ "Set-Cookie": ["a", "b"] })).toEqual({
			names: ["set-cookie"],
			values: {},
		});
		expect(redactUrl(`https://${shaped.tailnet}/mcp?x=1`, "{}")).toEqual({
			host: "[redacted:tailnet]",
			sha256: "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
		});
	});

	it("hashes vendor ids per session key", () => {
		const [one, two] = [newSessionKey(), newSessionKey()];
		expect(hashId(one, "C123")).toBe(hashId(one, "C123"));
		expect(hashId(one, "C123")).not.toBe(hashId(two, "C123"));
		expect(hashId(one, "C123")).toMatch(/^hmac:[\w-]{22}$/);
		expect(() => hashId(new Uint8Array(8), "C123")).toThrow("32-byte");
	});
});

describe("writeEvidence", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "draftyak-kit-evidence-"));
	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	it("writes { recordedAt, fingerprint, data } as 2-space JSON into an evidence/ folder", async () => {
		const print = await fingerprint({ cwd: repoRoot, sampleMs: 200 });
		expect(print).toMatchObject({
			os: { platform: process.platform },
			commit: expect.stringMatching(/^[0-9a-f]{40}$/),
		});
		expect(print.load.cpuPercent).toBeGreaterThanOrEqual(0);
		expect(print.load.concurrentBuilds).toBeGreaterThanOrEqual(0);
		const file = path.join(dir, "spike", "evidence", "run.json");
		await writeEvidence(file, { p50Ms: 12.5, when: new Date(0) }, { fingerprint: print });
		const text = readFileSync(file, "utf8");
		expect(text).toMatch(/^\{\n {2}"recordedAt": "[^"]+Z",\n {2}"fingerprint": \{\n[^\r]*\}\n$/);
		expect(JSON.parse(text)).toMatchObject({
			fingerprint: print,
			data: { p50Ms: 12.5, when: new Date(0).toISOString() },
		});
		await expect(
			writeEvidence(path.join(dir, "x.json"), {}, { fingerprint: print }),
		).rejects.toThrow("evidence/");
		await expect(
			writeEvidence(file, { who: shaped.email }, { fingerprint: print }),
		).rejects.toThrow("$.data.who (email)");
	});
});
