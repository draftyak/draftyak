import { isIP } from "node:net";
import { describe, expect, it } from "vitest";
import {
	createPublicRequestFactsPolicy,
	MAX_PUBLIC_HEADER_BYTES,
	MAX_PUBLIC_HEADER_FIELDS,
	PublicRequestFactsError,
} from "../src/listeners/l3/proxy-facts.ts";

const origin = "https://hub.example:8443";
const host = "hub.example:8443";
const config = () => ({ publicOrigin: origin, trustedProxyCidrs: ["127.0.0.1/32", "::1/128"] });
const direct = () => ({
	url: "/mcp",
	remoteAddress: "198.51.100.8",
	encrypted: true,
	rawHeaders: ["Host", host],
});
const forwarded = () => ({
	url: "/mcp",
	remoteAddress: "127.0.0.1",
	encrypted: false,
	rawHeaders: ["Host", host, "X-Forwarded-For", "198.51.100.8", "X-Forwarded-Proto", "https"],
});

describe("public native request observations", () => {
	it.each([
		"",
		"*",
		"hub.example:8443",
		"https://other.example/oauth/token",
		"//other.example/oauth/token",
		"/\\other.example/oauth/token",
		"https://hub.example:8443/oauth/token",
		undefined,
		null,
		42,
	])(
		"refuses non-origin-form or authority-looking native targets before matching Host (%s)",
		(url) => {
			const policy = createPublicRequestFactsPolicy(config());
			for (const native of [direct(), forwarded()])
				expect(() => policy.inspect({ ...native, url })).toThrow(new PublicRequestFactsError());
		},
	);
	it("keeps origin-form query text opaque and never executes a native target accessor", () => {
		const policy = createPublicRequestFactsPolicy(config());
		for (const native of [direct(), forwarded()]) {
			for (const url of [
				"/oauth/token?aud=https%3A%2F%2Fother.example",
				"/%5cother.example/oauth/token",
			])
				expect(policy.inspect({ ...native, url }).publicOrigin).toBe(origin);
			let reads = 0;
			expect(() =>
				policy.inspect(
					Object.defineProperty(native, "url", {
						enumerable: true,
						get() {
							reads++;
							throw new Error("PRIVATE_REQUEST_TARGET_CANARY");
						},
					}),
				),
			).toThrow(new PublicRequestFactsError());
			expect(reads).toBe(0);
		}
	});
	it("uses actual TLS socket facts directly, detached from caller configuration and headers", () => {
		const input = config(),
			policy = createPublicRequestFactsPolicy(input),
			native = direct(),
			facts = policy.inspect(native);
		expect(facts).toEqual({
			publicOrigin: origin,
			socketIP: "198.51.100.8",
			clientIP: "198.51.100.8",
			via: "direct",
		});
		input.publicOrigin = "https://other.example";
		input.trustedProxyCidrs[0] = "0.0.0.0/0";
		native.rawHeaders[1] = "other.example";
		expect(facts.publicOrigin).toBe(origin);
		expect(Object.isFrozen(facts)).toBe(true);
		expect(Object.isFrozen(policy)).toBe(true);
		expect(Object.isFrozen(policy.trustedProxyCidrs)).toBe(true);
		expect(policy.inspect(direct()).via).toBe("direct");
	});
	it("does not turn missing or empty proxy configuration into unrestricted header trust", () => {
		for (const invalid of [
			{ publicOrigin: origin },
			{ publicOrigin: origin, trustedProxyCidrs: undefined },
		])
			expect(() => createPublicRequestFactsPolicy(invalid)).toThrow(new PublicRequestFactsError());
		const policy = createPublicRequestFactsPolicy({ publicOrigin: origin, trustedProxyCidrs: [] });
		expect(policy.inspect(direct()).via).toBe("direct");
		expect(() => policy.inspect(forwarded())).toThrow(new PublicRequestFactsError());
	});
	it("accepts a single explicitly trusted TLS-terminating proxy with exact public Host", () => {
		const policy = createPublicRequestFactsPolicy(config()),
			native = forwarded();
		for (const encrypted of [false, true])
			expect(policy.inspect({ ...native, encrypted })).toEqual({
				publicOrigin: origin,
				socketIP: "127.0.0.1",
				clientIP: "198.51.100.8",
				via: "trusted-proxy",
			});
		native.rawHeaders.push("X-Forwarded-Host", host);
		expect(policy.inspect(native).via).toBe("trusted-proxy");
	});
	it("normalizes native IPv6 and mapped IPv4 without confusing proxy and client networks", () => {
		const policy = createPublicRequestFactsPolicy(config()),
			native = forwarded();
		native.remoteAddress = "0:0:0:0:0:ffff:7f00:1";
		native.rawHeaders[3] = "::ffff:c633:6408";
		expect(policy.inspect(native)).toMatchObject({
			socketIP: "127.0.0.1",
			clientIP: "198.51.100.8",
		});
		native.remoteAddress = "0:0:0:0:0:0:0:1";
		native.rawHeaders[3] = "2001:DB8:0:0:0:0:0:AB";
		expect(policy.inspect(native)).toMatchObject({ socketIP: "::1", clientIP: "2001:db8::ab" });
		native.rawHeaders[3] = "::ffff:198.51.100.8";
		const facts = policy.inspect(native);
		expect(facts.clientIP).toBe("198.51.100.8");
		expect(isIP(facts.clientIP)).toBe(4);
		expect(isIP(facts.socketIP)).toBe(6);
	});
	it("does not infer TLS or forwarding authority from arbitrary request claims", () => {
		const policy = createPublicRequestFactsPolicy(config());
		for (const native of [
			{ ...direct(), encrypted: false },
			{ ...direct(), encrypted: "true" },
			{ ...forwarded(), remoteAddress: "198.51.100.8", encrypted: true },
			{ ...forwarded(), rawHeaders: ["Host", host] },
			{ ...direct(), rawHeaders: ["Host", host, "X-Forwarded-Proto", "https"] },
		])
			expect(() => policy.inspect(native)).toThrow(new PublicRequestFactsError());
	});
	it.each([
		["X-Forwarded-For", "198.51.100.8, 127.0.0.1"],
		["X-Forwarded-For", "[2001:db8::1]"],
		["X-Forwarded-For", "198.51.100.8:1234"],
		["X-Forwarded-For", "2001:db8::1%eth0"],
		["X-Forwarded-For", "unknown"],
		["X-Forwarded-For", "2130706433"],
		["X-Forwarded-For", " 198.51.100.8"],
		["X-Forwarded-Proto", "http"],
		["X-Forwarded-Proto", "https, https"],
		["X-Forwarded-Proto", "HTTPS"],
		["Host", "HUB.example:8443"],
		["Host", "hub.example"],
	])("refuses ambiguous or mismatched %s=%s", (name, value) => {
		const native = forwarded(),
			at = native.rawHeaders.indexOf(name);
		native.rawHeaders[at + 1] = value;
		expect(() => createPublicRequestFactsPolicy(config()).inspect(native)).toThrow(
			new PublicRequestFactsError(),
		);
	});
	it.each([
		["Host", host],
		["HOST", host],
		["x-forwarded-for", "198.51.100.8"],
		["X-Forwarded-Proto", "https"],
		["X-Forwarded-Host", "other.example:8443"],
		["Forwarded", "for=198.51.100.8;proto=https"],
		["X-Forwarded-Port", "8443"],
		["X-Forwarded-By", "127.0.0.1"],
	])("refuses duplicate, conflicting or unsupported forwarding field %s", (name, value) => {
		const native = forwarded();
		native.rawHeaders.push(name, value);
		expect(() => createPublicRequestFactsPolicy(config()).inspect(native)).toThrow(
			new PublicRequestFactsError(),
		);
	});
	it.each([
		"http://hub.example",
		"https://HUB.example",
		"https://hub.example:443",
		"https://hub.example/",
		"https://hub.example.",
		"https://user@hub.example",
		"https://hub.example?",
		"https://hub.example#",
		"https://hub.example:0",
		"https://hub.example:65536",
		"https://2130706433",
		"https://hub.example\n",
	])("requires an exact canonical configured HTTPS origin: %s", (publicOrigin) => {
		expect(() => createPublicRequestFactsPolicy({ ...config(), publicOrigin })).toThrow(
			new PublicRequestFactsError(),
		);
	});
	it("keeps explicit private/tailnet/IPv6 origins possible without introducing DNS resolution", () => {
		for (const publicOrigin of [
			"https://100.64.0.1",
			"https://[fd00::1]",
			"https://node.tailnet.example",
		])
			expect(createPublicRequestFactsPolicy({ ...config(), publicOrigin }).publicOrigin).toBe(
				publicOrigin,
			);
	});
	it("bounds field count and aggregate bytes without banning repeated irrelevant fields", () => {
		const policy = createPublicRequestFactsPolicy(config()),
			native = direct();
		while (native.rawHeaders.length / 2 < MAX_PUBLIC_HEADER_FIELDS)
			native.rawHeaders.push("Accept", "text/plain");
		expect(policy.inspect(native).via).toBe("direct");
		native.rawHeaders.push("Accept", "text/plain");
		expect(() => policy.inspect(native)).toThrow(new PublicRequestFactsError());
		const exact = direct(),
			overhead =
				Buffer.byteLength("Host") +
				Buffer.byteLength(host) +
				4 +
				Buffer.byteLength("X-Padding") +
				4;
		exact.rawHeaders.push("X-Padding", "x".repeat(MAX_PUBLIC_HEADER_BYTES - overhead));
		expect(policy.inspect(exact).via).toBe("direct");
		exact.rawHeaders[3] += "x";
		expect(() => policy.inspect(exact)).toThrow(new PublicRequestFactsError());
	});
	it("contains raw native data errors without invoking getters, proxies or array hooks", () => {
		let hooks = 0;
		const hook = (): never => {
			hooks++;
			throw new Error("PRIVATE_PROXY_CANARY");
		};
		const policy = createPublicRequestFactsPolicy(config());
		const badHeaders = Object.defineProperty(["Host", host], "1", { enumerable: true, get: hook });
		class Headers extends Array<string> {}
		for (const rawHeaders of [
			badHeaders,
			new Headers("Host", host),
			new Array(2),
			Object.assign(["Host", host], { map: hook }),
		])
			expect(() => policy.inspect({ ...direct(), rawHeaders })).toThrow(
				new PublicRequestFactsError(),
			);
		for (const native of [
			new Proxy(direct(), { get: hook, ownKeys: hook, getPrototypeOf: hook }),
			Object.defineProperty(direct(), "encrypted", { enumerable: true, get: hook }),
			{ ...direct(), remoteAddress: { toString: hook } },
			{ ...direct(), rawHeaders: new Proxy([], { ownKeys: hook, get: hook }) },
		])
			expect(() => policy.inspect(native)).toThrow(new PublicRequestFactsError());
		for (const input of [
			new Proxy(config(), { ownKeys: hook, getPrototypeOf: hook }),
			Object.defineProperty(config(), "publicOrigin", { get: hook }),
		])
			expect(() => createPublicRequestFactsPolicy(input)).toThrow(new PublicRequestFactsError());
		expect(hooks).toBe(0);
	});
	it.each(["\r\nInjected: x", "\0", "\x7f", "\ud800"])(
		"refuses invalid raw header characters %#",
		(bad) => {
			const native = direct();
			native.rawHeaders.push("X-Input", bad);
			expect(() => createPublicRequestFactsPolicy(config()).inspect(native)).toThrow(
				new PublicRequestFactsError(),
			);
		},
	);
});
