import { lookup } from "node:dns/promises";
import { connect } from "node:net";
import { freePort } from "@draftyak/spike-kit";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import {
	BLOCKED_PORTS,
	blockedAddress,
	FetchRefused,
	type GuardedFetch,
	guardedFetch,
	type Refusal,
} from "../src/cimd.ts";
import { FakeVendorHost, PUBLIC_ADDRESS, TEST_HOSTS } from "./connectors.ts";

const DOC = "https://cimd.example/client.json";
let vendor: FakeVendorHost;
let guarded: GuardedFetch;

beforeAll(async () => {
	vendor = await FakeVendorHost.start();
	guarded = guardedFetch(vendor.guard());
	vendor.serve(DOC, { body: '{"client_id":"x"}', headers: { "cache-control": "max-age=60" } });
});
afterAll(async () => {
	await vendor?.close();
});

async function refusal(work: Promise<unknown>): Promise<Refusal> {
	try {
		await work;
	} catch (error) {
		if (error instanceof FetchRefused) return error.reason;
		throw error;
	}
	throw new Error("the fetch wasn't refused");
}

describe("blockedAddress: §4's ranges, and the forms that hide them", () => {
	test.each([
		["127.0.0.1", "loopback"],
		["127.255.0.9", "loopback"],
		["::1", "loopback"],
		["10.0.0.5", "private"],
		["172.16.0.1", "private"],
		["172.31.255.255", "private"],
		["192.168.1.10", "private"],
		["169.254.169.254", "link-local"],
		["fe80::1", "link-local"],
		["fe80::1%2", "link-local"],
		["100.64.0.1", "cgnat"],
		["100.100.100.100", "cgnat"],
		["fc00::1", "ula"],
		["fd7a:115c:a1e0::1", "ula"],
		["0.0.0.0", "unspecified"],
		["::", "unspecified"],
		["224.0.0.251", "multicast"],
		["ff02::1", "multicast"],
		["255.255.255.255", "reserved"],
		["fec0::1", "site-local"],
		["::ffff:10.0.0.1", "private"],
		["::ffff:7f00:1", "loopback"],
		["::ffff:169.254.169.254", "link-local"],
		["::7f00:1", "ipv4-compatible"],
		["64:ff9b::7f00:1", "nat64 loopback"],
		["64:ff9b::10.0.0.1", "nat64 private"],
		["64:ff9b:1::a00:1", "nat64-local"],
		["2002:7f00:1::1", "6to4"],
		["2001:0:4136:e378::1", "teredo"],
		["::ffff:0:a00:1", "ipv4-translated"],
		["cimd.example", "not an IP address"],
		["", "not an IP address"],
	])("%s: %s", (address, reason) => {
		expect(blockedAddress(address)).toBe(reason);
	});

	// oidc-provider 9.12.2 refuses these itself, but configuration.fetch replaces its check.
	test.each([
		["192.0.0.1", "special-use"],
		["192.31.196.1", "special-use"],
		["192.52.193.1", "special-use"],
		["192.88.99.1", "special-use"],
		["192.175.48.1", "special-use"],
		["198.18.0.1", "special-use"],
		["198.19.255.255", "special-use"],
		["100::1", "special-use"],
		["100:0:0:1::1", "special-use"],
		["2001:1::1", "special-use"],
		["2001:1ff::1", "special-use"],
		["2001:db8::1", "documentation"],
		["2620:4f:8000::1", "special-use"],
		["3fff::1", "documentation"],
		["5f00::1", "special-use"],
	])("%s: %s, as in oidc-provider's own list", (address, reason) => {
		expect(blockedAddress(address)).toBe(reason);
	});

	test.each([
		PUBLIC_ADDRESS,
		"8.8.8.8",
		"100.63.255.255",
		"100.128.0.1",
		"172.15.255.255",
		"172.32.0.1",
		"192.167.1.1",
		"198.17.255.255",
		"198.20.0.1",
		"2606:4700::6810:84e5",
		"2001:4860:4860::8888",
		"2001:200::1",
		"::ffff:8.8.8.8",
		"64:ff9b::808:808",
	])("%s is a public unicast address", (address) => {
		expect(blockedAddress(address)).toBeUndefined();
	});
});

describe("guardedFetch", () => {
	test("GETs an allowlisted https URL over TLS, connecting to the address it checked", async () => {
		const before = vendor.dialed.length;
		const response = await guarded(DOC, { headers: { accept: "application/json" } });
		expect(response.status).toBe(200);
		expect(await response.json()).toStrictEqual({ client_id: "x" });
		expect(response.headers.get("cache-control")).toBe("max-age=60");
		expect(vendor.dialed.slice(before)).toStrictEqual([
			{ address: PUBLIC_ADDRESS, family: 4, port: 443 },
		]);
	});

	test("refuses before resolving: other schemes, credentials, unlisted hosts and ports, other methods", async () => {
		const resolve = vi.fn(vendor.resolve);
		const blockedPorts = [...BLOCKED_PORTS].map((port) => `cimd.example:${port}`);
		const listed = [...TEST_HOSTS, "cimd.example:8443", ...blockedPorts];
		const fetch = guardedFetch({ ...vendor.guard(listed), resolve });
		type Case = [string, Parameters<GuardedFetch>[1], Refusal];
		const refused: Case[] = [
			["http://cimd.example/client.json", {}, "url"],
			["https://user:pass@cimd.example/client.json", {}, "url"],
			["https://evil.example/client.json", {}, "host"],
			["https://cimd.example:8444/client.json", {}, "host"],
			["https://cimd.example./client.json", {}, "host"],
			["https://10.0.0.5/client.json", {}, "host"],
			["https://[::1]/client.json", {}, "host"],
			[DOC, { method: "POST" }, "method"],
			[DOC, { body: "x" }, "method"],
			...blockedPorts.map((host): Case => [`https://${host}/x`, {}, "port"]),
		];
		for (const [url, init, reason] of refused) {
			expect(await refusal(fetch(url, init)), url).toBe(reason);
		}
		expect(resolve).not.toHaveBeenCalled();
		expect(() => guardedFetch({ hosts: ["https://cimd.example"] })).toThrow("not a host");
		expect(() => guardedFetch({ hosts: ["cimd.example:443"] })).toThrow("not a host");
	});

	test("refuses a host that resolves to any blocked address, before connecting", async () => {
		const host = "keys.cimd.example";
		const url = `https://${host}/jwks.json`;
		vendor.serve(url, '{"keys":[]}');
		const before = vendor.dialed.length;
		for (const answer of [
			["10.0.0.5"],
			["127.0.0.1"],
			["169.254.169.254"],
			["100.100.100.100"],
			["fd7a:115c:a1e0::1"],
			["::ffff:192.168.0.1"],
			[PUBLIC_ADDRESS, "10.0.0.5"],
		]) {
			vendor.resolveTo(host, ...answer);
			expect(await refusal(guarded(url)), answer.join()).toBe("address");
		}
		vendor.resolveTo(host);
		expect(await refusal(guarded(url))).toBe("dns");
		const failing = guardedFetch({
			...vendor.guard(),
			resolve: () => Promise.reject(new Error("ENOTFOUND")),
		});
		expect(await refusal(failing(url))).toBe("dns");
		expect(vendor.dialed.length).toBe(before);
		expect(vendor.count(url)).toBe(0);
	});

	test("connects to the address it checked, so a second DNS answer can't move it (rebinding)", async () => {
		let lookups = 0;
		const rebinding = async () => [
			{ address: lookups++ === 0 ? PUBLIC_ADDRESS : "127.0.0.1", family: 4 },
		];
		const fetch = guardedFetch({ ...vendor.guard(), resolve: rebinding });
		const before = vendor.dialed.length;
		expect((await fetch(DOC)).status).toBe(200);
		expect(await refusal(fetch(DOC))).toBe("address");
		expect(lookups).toBe(2);
		expect(vendor.dialed.slice(before)).toStrictEqual([
			{ address: PUBLIC_ADDRESS, family: 4, port: 443 },
		]);
	});

	test("never follows a redirect", async () => {
		for (const status of [301, 302, 303, 307, 308]) {
			const url = `https://cimd.example/moved-${status}.json`;
			vendor.serve(url, { status, headers: { location: DOC } });
			const fetched = vendor.count(DOC);
			expect(await refusal(guarded(url))).toBe("redirect");
			expect(vendor.count(DOC)).toBe(fetched);
		}
	});

	test("caps the body, declared or streamed", async () => {
		const small = guardedFetch({ ...vendor.guard(), maxBytes: 1024 });
		vendor.serve("https://cimd.example/exact.json", "x".repeat(1024));
		vendor.serve("https://cimd.example/large.json", "x".repeat(1025));
		vendor.serve("https://cimd.example/streamed.json", { body: "x".repeat(8192), chunked: true });
		expect(await (await small("https://cimd.example/exact.json")).text()).toHaveLength(1024);
		expect(await refusal(small("https://cimd.example/large.json"))).toBe("size");
		expect(await refusal(small("https://cimd.example/streamed.json"))).toBe("size");
	});

	test("caps the time: its own limit, the caller's signal and a resolver that never answers", async () => {
		const slow = "https://cimd.example/slow.json";
		vendor.serve(slow, { hang: true });
		const started = performance.now();
		expect(await refusal(guardedFetch({ ...vendor.guard(), timeoutMs: 300 })(slow))).toBe(
			"timeout",
		);
		expect(await refusal(guarded(slow, { signal: AbortSignal.timeout(300) }))).toBe("timeout");
		expect(performance.now() - started).toBeLessThan(5_000);
		expect(await refusal(guarded(DOC, { signal: AbortSignal.abort() }))).toBe("timeout");
		const stuck = {
			...vendor.guard(),
			resolve: () => new Promise<never>(() => {}),
			timeoutMs: 300,
		};
		expect(await refusal(guardedFetch(stuck)(DOC))).toBe("timeout");
	});

	test("needs a certificate naming the host it asked for, from its own trust anchors", async () => {
		vendor.serve("https://nocert.example/client.json", "{}");
		const fetch = guardedFetch(vendor.guard([...TEST_HOSTS, "nocert.example"]));
		expect(await refusal(fetch("https://nocert.example/client.json"))).toBe("tls");
		const nodeRoots = guardedFetch({ ...vendor.guard(), ca: undefined });
		expect(await refusal(nodeRoots(DOC))).toBe("tls");
	});

	test("a connection that fails is refused as such", async () => {
		const port = await freePort();
		const closed = { ...vendor.guard(), dial: () => connect({ host: "127.0.0.1", port }) };
		expect(await refusal(guardedFetch(closed)(DOC))).toBe("connect");
	});

	test("hands other statuses to oidc-provider, which refuses them itself", async () => {
		vendor.serve("https://cimd.example/gone.json", { status: 404, body: "{}" });
		vendor.serve("https://cimd.example/broken.json", { status: 500, body: "" });
		expect((await guarded("https://cimd.example/gone.json")).status).toBe(404);
		expect((await guarded("https://cimd.example/broken.json")).status).toBe(500);
	});
});

describe("the unit tier's offline net (test/offline.ts)", () => {
	test("leaves the guard's own resolver and dial, which the provider uses, nothing to reach", async () => {
		await expect(lookup("cimd.example")).rejects.toThrow("the unit tier is offline");
		expect(await refusal(guardedFetch({ hosts: ["cimd.example"] })(DOC))).toBe("dns");
		const realDial = guardedFetch({ hosts: ["cimd.example"], resolve: vendor.resolve });
		const refused = await realDial(DOC).catch((error: unknown) => error);
		expect(refused).toBeInstanceOf(FetchRefused);
		expect(refused).toMatchObject({
			reason: "connect",
			message: `cimd.example: the unit tier is offline: a connection to ${PUBLIC_ADDRESS} refused`,
		});
	});
});
