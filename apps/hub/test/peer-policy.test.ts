import { BlockList } from "node:net";
import { describe, expect, it } from "vitest";
import { createPeerPolicy, MAX_PEER_CIDRS, PeerPolicyError } from "../src/mcp/peer-policy.ts";

describe("native socket CIDR filter", () => {
	it("distinguishes an omitted filter from an explicitly empty allowlist", () => {
		const open = createPeerPolicy();
		const closed = createPeerPolicy([]);
		expect(open.mode).toBe("unrestricted");
		expect(closed.mode).toBe("allowlist");
		for (const ip of ["127.0.0.1", "100.64.0.1", "::1", "2001:db8::1"])
			expect([open.allows(ip), closed.allows(ip)]).toEqual([true, false]);
	});
	it("matches exact IPv4 subnet edges and disjoint networks", () => {
		const policy = createPeerPolicy(["100.64.0.0/10", "192.0.2.7/32"]);
		for (const ip of ["100.64.0.0", "100.127.255.255", "192.0.2.7"])
			expect(policy.allows(ip)).toBe(true);
		for (const ip of ["100.63.255.255", "100.128.0.0", "192.0.2.8", "::1"])
			expect(policy.allows(ip)).toBe(false);
	});
	it("matches compressed and expanded IPv6 at prefix boundaries", () => {
		const policy = createPeerPolicy(["2001:DB8:8000::/33", "::1/128"]);
		expect(policy.cidrs).toEqual(["2001:db8:8000::/33", "::1/128"]);
		for (const ip of [
			"2001:db8:8000::",
			"2001:db8:ffff:ffff:ffff:ffff:ffff:ffff",
			"0:0:0:0:0:0:0:1",
		])
			expect(policy.allows(ip)).toBe(true);
		for (const ip of ["2001:db8:7fff:ffff:ffff:ffff:ffff:ffff", "2001:db9::", "::2"])
			expect(policy.allows(ip)).toBe(false);
	});
	it("treats mapped socket addresses as IPv4 and never widens a v6-only rule", () => {
		const v4 = createPeerPolicy(["192.0.2.0/24"]);
		const v6 = createPeerPolicy(["::/0"]);
		for (const ip of ["::ffff:192.0.2.7", "::ffff:c000:207", "0:0:0:0:0:FFFF:C000:0207"])
			expect([v4.allows(ip), v6.allows(ip)]).toEqual([true, false]);
		expect(v4.allows("::192.0.2.7")).toBe(false);
		expect(v6.allows("::192.0.2.7")).toBe(true);
	});
	it("supports both full-family networks without cross-family confusion", () => {
		const policy = createPeerPolicy(["0.0.0.0/0", "::/0"]);
		for (const ip of [
			"0.0.0.0",
			"255.255.255.255",
			"::",
			"ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
		])
			expect(policy.allows(ip)).toBe(true);
	});
	it.each([
		null,
		{},
		"192.0.2.0/24",
		["192.0.2.1/24"],
		["2001:db8::1/64"],
		["::ffff:192.0.2.0/120"],
		["192.0.2.0/024"],
		["192.0.2.0/+24"],
		["192.0.2.0/33"],
		["::/129"],
		["::/-1"],
		["192.0.2.0"],
		["example.test/24"],
		["192.000.2.0/24"],
		["[::]/0"],
		["::%eth0/0"],
		["192.0.2.0/24\n"],
		["192.0.2.0/24", "192.0.2.0/24"],
		["2001:DB8::/32", "2001:db8::/32"],
		Array(MAX_PEER_CIDRS + 1).fill("192.0.2.0/24"),
		Array(1),
	])("refuses malformed, ambiguous or excessive native configuration %#", (input) => {
		expect(() => createPeerPolicy(input)).toThrow(new PeerPolicyError());
	});
	it("never coerces addresses, resolves names or accepts forwarded evidence", () => {
		const policy = createPeerPolicy(["0.0.0.0/0", "::/0"]);
		for (const input of [
			undefined,
			null,
			123,
			{},
			"localhost",
			"127.1",
			"2130706433",
			"0x7f000001",
			"127.0.0.1:80",
			"[::1]",
			"::1%lo",
			" 127.0.0.1",
			"127.0.0.1\n",
			"192.0.2.1, 127.0.0.1",
		])
			expect(policy.allows(input)).toBe(false);
		let hooks = 0;
		expect(
			policy.allows({
				toString() {
					hooks++;
					return "127.0.0.1";
				},
			}),
		).toBe(false);
		expect(hooks).toBe(0);
	});
	it("captures data once without executing getters, proxies or array subclasses", () => {
		let hooks = 0;
		const accessor = ["192.0.2.0/24"];
		Object.defineProperty(accessor, "0", {
			enumerable: true,
			get() {
				hooks++;
				return "192.0.2.0/24";
			},
		});
		const proxy = new Proxy([], {
			getPrototypeOf() {
				hooks++;
				throw new Error("PRIVATE_CANARY");
			},
		});
		class Entries extends Array<string> {}
		for (const input of [
			accessor,
			proxy,
			new Entries("192.0.2.0/24"),
			Object.assign([], { extra: "x" }),
		])
			expect(() => createPeerPolicy(input)).toThrow(PeerPolicyError);
		const input = ["192.0.2.0/24"];
		const policy = createPeerPolicy(input);
		input[0] = "0.0.0.0/0";
		expect(policy.allows("198.51.100.1")).toBe(false);
		expect(Object.isFrozen(policy)).toBe(true);
		expect(Object.isFrozen(policy.cidrs)).toBe(true);
		expect(hooks).toBe(0);
	});
	it("agrees with the independent native subnet matcher over seeded v4/v6 vectors", () => {
		let seed = 0x7591;
		const next = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
		for (const [base, prefix, family] of [
			["172.16.0.0", 12, "ipv4"],
			["2001:db8:8000::", 33, "ipv6"],
		] as const) {
			const reference = new BlockList();
			reference.addSubnet(base, prefix, family);
			const policy = createPeerPolicy([`${base}/${prefix}`]);
			for (let at = 0; at < 200; at++) {
				const ip =
					family === "ipv4"
						? `${next() & 255}.${next() & 255}.${next() & 255}.${next() & 255}`
						: `2001:db8:${(next() & 65535).toString(16)}:${(next() & 65535).toString(16)}::1`;
				expect(policy.allows(ip)).toBe(reference.check(ip, family));
			}
		}
	});
});
