import { expect, it } from "vitest";
import {
	canonicalAddress,
	publicAddress,
	validateAnswers,
} from "../../src/mcp/client-metadata/addresses.ts";
import {
	ClientMetadataFetcher,
	type ClientMetadataOptions,
} from "../../src/mcp/client-metadata/index.ts";
import {
	type MetadataDestinationRule,
	MetadataDestinations,
	metadataUrl,
} from "../../src/mcp/client-metadata/policy.ts";

const rules: readonly MetadataDestinationRule[] = [
	{
		kind: "cimd",
		host: "client.example",
		paths: [{ exact: "/client.json" }, { prefix: "/clients/" }],
	},
	{ kind: "jwks", host: "keys.example", paths: [{ exact: "/keys.json" }] },
];
const options: ClientMetadataOptions = {
	destinations: rules,
	deniedAddresses: [],
	maxBytes: 65536,
	timeoutMs: 2000,
};

it("requires explicit owner configuration and exact host/path permissions for each purpose", () => {
	const policy = new MetadataDestinations(rules);
	expect(policy.check("https://client.example/client.json", "cimd")).toEqual({
		kind: "cimd",
		url: "https://client.example/client.json",
		host: "client.example",
		path: "/client.json",
	});
	expect(policy.check("https://client.example/clients/one.json", "cimd").path).toBe(
		"/clients/one.json",
	);
	for (const [url, kind] of [
		["https://client.example/client.json", "jwks"],
		["https://keys.example/keys.json", "cimd"],
		["https://client.example/clients-other/client.json", "cimd"],
		["https://sub.client.example/client.json", "cimd"],
		["https://client.example.evil.example/client.json", "cimd"],
		["https://other.example/client.json", "cimd"],
		["https://client.example/client.json/", "cimd"],
	] as const)
		expect(() => policy.check(url, kind)).toThrow(/^Client metadata refused$/);
	expect(() =>
		new MetadataDestinations([]).check("https://client.example/client.json", "cimd"),
	).toThrow();
	for (const changed of [
		{ destinations: undefined },
		{ deniedAddresses: undefined },
		{ maxBytes: 0 },
		{ maxBytes: 1048577 },
		{ timeoutMs: 0 },
		{ timeoutMs: 10001 },
		{ extra: true },
	])
		expect(
			() => new ClientMetadataFetcher({ ...options, ...changed } as ClientMetadataOptions),
		).toThrow(/^Client metadata refused$/);
});

it("rejects URL parser normalization, credentials, alternate ports and ambiguous paths", () => {
	for (const url of [
		"http://client.example/client.json",
		"HTTPS://client.example/client.json",
		"https://Client.example/client.json",
		"https://client.example",
		"https://client.example./client.json",
		"https://client.example:443/client.json",
		"https://client.example:47615/client.json",
		"https://user:SECRET_CANARY@client.example/client.json",
		"https://client.example/client.json?token=SECRET_CANARY",
		"https://client.example/client.json#fragment",
		" https://client.example/client.json",
		"https://client.example/client.json\n",
		"https://client.example\\@evil.example/client.json",
		"https://client.example/a/../client.json",
		"https://client.example/./client.json",
		"https://client.example//client.json",
		"https://client.example/%2e%2e/client.json",
		"https://client.example/%252e/client.json",
		"https://client.example/a%2fb",
		"https://client.example/a%5cb",
		"https://client.example/client.json%00",
		"https://client.example/client.json%0d%0a",
		"https://client.example/client.json;param",
		"https://127.0.0.1/client.json",
		"https://127.1/client.json",
		"https://2130706433/client.json",
		"https://0x7f000001/client.json",
		"https://[::1]/client.json",
		"https://[::ffff:127.0.0.1]/client.json",
		"https://localhost/client.json",
		"https://a.1/client.json",
		"https://*.example/client.json",
		"https://a_b.example/client.json",
		"https://-bad.example/client.json",
		"https://bad-.example/client.json",
		"https://exämple.com/client.json",
		`https://${"x".repeat(64)}.example/client.json`,
		`https://client.example/${"a".repeat(2048)}`,
	])
		expect(() => metadataUrl(url, "cimd")).toThrow(/^Client metadata refused$/);
});

it("refuses broad or malformed rules, accessors, proxies, holes and unknown configuration fields", () => {
	for (const rule of [
		{ kind: "cimd", host: "client.example", paths: [] },
		{ kind: "cimd", host: "client.example", paths: [{ prefix: "/" }] },
		{ kind: "cimd", host: "client.example", paths: [{ prefix: "/clients" }] },
		{ kind: "cimd", host: "client.example", paths: [{ exact: "/a/../b" }] },
		{ kind: "cimd", host: "client.example", paths: [{ exact: "/client.json", extra: true }] },
		{ kind: "cimd", host: "client.example", paths: [{ exact: "/client.json" }], extra: true },
		{ kind: "other", host: "client.example", paths: [{ exact: "/client.json" }] },
		{ kind: "cimd", host: "*.example", paths: [{ exact: "/client.json" }] },
	])
		expect(() => new MetadataDestinations([rule] as readonly MetadataDestinationRule[])).toThrow(
			/^Client metadata refused$/,
		);
	let calls = 0;
	const trap = () => {
		calls++;
		throw new Error("CONFIG_SECRET_CANARY");
	};
	const proxy = new Proxy(options, {
		get: trap,
		getPrototypeOf: trap,
		ownKeys: trap,
		getOwnPropertyDescriptor: trap,
	});
	const sparse: unknown[] = Array(2);
	sparse[1] = rules[0];
	for (const input of [
		proxy,
		Object.defineProperty({ ...options }, "destinations", { enumerable: true, get: trap }),
		{ ...options, toJSON: trap },
		{ ...options, destinations: sparse },
	]) {
		expect(() => new ClientMetadataFetcher(input as ClientMetadataOptions)).toThrow(
			/^Client metadata refused$/,
		);
		expect(calls).toBe(0);
	}
});

it("detaches approved rules from later mutation", () => {
	const paths = [{ exact: "/client.json" }],
		input = [{ kind: "cimd" as const, host: "client.example", paths }];
	const policy = new MetadataDestinations(input);
	paths.push({ exact: "/new.json" });
	const first = input[0];
	if (first) first.host = "other.example";
	expect(() => policy.check("https://client.example/client.json", "cimd")).not.toThrow();
	expect(() => policy.check("https://client.example/new.json", "cimd")).toThrow();
});

it("blocks private, shared, link-local, metadata, special-use and mapped IP destinations", () => {
	for (const address of [
		"0.0.0.0",
		"0.0.0.1",
		"10.1.2.3",
		"100.64.0.1",
		"100.100.100.200",
		"100.127.255.254",
		"127.0.0.1",
		"127.255.255.254",
		"169.254.169.254",
		"169.254.170.2",
		"172.16.0.1",
		"172.31.255.254",
		"192.0.0.9",
		"192.0.2.1",
		"192.88.99.1",
		"192.168.1.1",
		"168.63.129.16",
		"198.18.0.1",
		"198.19.255.254",
		"198.51.100.1",
		"203.0.113.1",
		"224.0.0.1",
		"239.255.255.254",
		"240.0.0.1",
		"255.255.255.255",
		"::",
		"::1",
		"::127.0.0.1",
		"::ffff:127.0.0.1",
		"::ffff:8.8.8.8",
		"::ffff:7f00:1",
		"64:ff9b::7f00:1",
		"64:ff9b:1::1",
		"100::1",
		"100:0:0:1::1",
		"2001::1",
		"2001:2::1",
		"2001:20::1",
		"2001:db8::1",
		"2002:7f00:1::1",
		"3ffe::1",
		"3fff::1",
		"5f00::1",
		"fc00::1",
		"fd00:ec2::254",
		"fe80::1",
		"fe80::1%eth0",
		"fec0::1",
		"ff02::1",
		"not-an-ip",
		"127.1",
		"0127.0.0.1",
	])
		expect(publicAddress(address), address).toBe(false);
	for (const address of [
		"8.8.8.8",
		"1.1.1.1",
		"100.63.255.254",
		"100.128.0.1",
		"172.15.255.254",
		"172.32.0.1",
		"2606:4700:4700::1111",
		"2001:4860:4860::8888",
	])
		expect(publicAddress(address), address).toBe(true);
});

it("checks every DNS answer, family and hub-owned address before selecting one immutable pin", () => {
	const publicV4 = { address: "8.8.8.8", family: 4 as const },
		publicV6 = { address: "2606:4700:4700::1111", family: 6 as const };
	const pin = validateAnswers([publicV4, publicV6], []);
	expect(pin).toEqual(publicV4);
	expect(Object.isFrozen(pin)).toBe(true);
	for (const answers of [
		[],
		[publicV4, { address: "127.0.0.1", family: 4 as const }],
		[publicV4, { address: "::ffff:8.8.8.8", family: 6 as const }],
		[{ address: "8.8.8.8", family: 6 as const }],
		Array.from({ length: 33 }, () => publicV4),
	])
		expect(() => validateAnswers(answers, [])).toThrow(/^Client metadata refused$/);
	expect(() => validateAnswers([publicV4], ["8.8.8.8"])).toThrow();
	expect(() => validateAnswers([publicV6], ["2606:4700:4700:0:0:0:0:1111"])).toThrow();
	expect(canonicalAddress("2606:4700:4700:0:0:0:0:1111")).toBe(publicV6.address);
});
