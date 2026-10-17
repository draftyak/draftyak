import { describe, expect, it } from "vitest";
import { brokerDecision, canonicalAddress } from "../src/broker-stub.ts";

// Every spelling that reaches this machine's inspector or hub ports must be refused, whatever URL
// form a plugin picks; WHATWG URL folds IPv4 forms, and the stub reads embedded IPv4 itself.
const REFUSED: readonly (readonly [string, string])[] = [
	["http://127.0.0.1:9229/json/version", "inspector-port"],
	["https://127.0.0.1:9229/", "inspector-port"],
	["http://127.255.255.254:9229/", "inspector-port"],
	["http://127.1:9229/", "inspector-port"],
	["http://2130706433:9229/", "inspector-port"],
	["http://0x7f.0.0.1:9229/", "inspector-port"],
	["http://0177.0.0.1:9229/", "inspector-port"],
	["http://localhost:9229/", "inspector-port"],
	["http://LOCALHOST:9229/", "inspector-port"],
	["http://ｌｏｃａｌｈｏｓｔ:9229/", "inspector-port"],
	["http://localhost.:9229/", "inspector-port"],
	["http://localhost..:9229/", "inspector-port"],
	["http://foo.localhost:9229/", "inspector-port"],
	["http://[::1]:9229/", "inspector-port"],
	["http://[0:0:0:0:0:0:0:1]:9229/", "inspector-port"],
	["http://[::ffff:127.0.0.1]:9229/json/version", "inspector-port"],
	["http://[0:0:0:0:0:ffff:7f00:1]:9229/", "inspector-port"],
	["http://[::127.0.0.1]:9229/", "inspector-port"],
	["http://0.0.0.0:9229/", "inspector-port"],
	["http://0:9229/", "inspector-port"],
	["http://[::]:9229/", "inspector-port"],
	["http://127.0.0.1:47613/", "hub-port"],
	["http://127.0.0.1:47614/", "hub-port"],
	["http://127.0.0.1:47615/", "hub-port"],
	["http://[::ffff:127.0.0.1]:47613/", "hub-port"],
	["http://0.0.0.0:47614/", "hub-port"],
	["http://[::ffff:0.0.0.0]:47615/", "hub-port"],
	["http://foo.localhost:47613/", "hub-port"],
	["not a url", "bad-url"],
	["ftp://127.0.0.1/", "scheme"],
	["file:///etc/passwd", "scheme"],
	["http://user:secret@example.com/", "userinfo"],
];

describe("brokerDecision", () => {
	it.for(REFUSED)("refuses %s (%s)", ([url, reason]) => {
		expect(brokerDecision(url)).toMatchObject({ allow: false, reason });
	});

	it("allows an ordinary destination and loopback on other ports (M9's local rules)", () => {
		expect(brokerDecision("https://example.com/robots.txt")).toEqual({
			allow: true,
			reason: "allowed",
			port: 443,
		});
		expect(brokerDecision("http://127.0.0.1:11434/").allow).toBe(true);
	});

	it("matches configured hub addresses in any spelling", () => {
		const v6 = { hubAddresses: ["fd7a:115c:a1e0:0::0001"] };
		expect(brokerDecision("http://[fd7a:115c:a1e0::1]:47613/", v6).reason).toBe("hub-port");
		expect(brokerDecision("http://[FD7A:115C:A1E0:0:0:0:0:1]:9229/", v6).reason).toBe(
			"inspector-port",
		);
		expect(brokerDecision("http://[fd7a:115c:a1e0::1]:8080/", v6).reason).toBe("hub-address");
		const v4 = { hubAddresses: ["192.168.1.20"] };
		expect(brokerDecision("http://192.168.1.20/", v4).reason).toBe("hub-address");
		expect(brokerDecision("http://[::ffff:192.168.1.20]:80/", v4).reason).toBe("hub-address");
		expect(brokerDecision("http://[::ffff:c0a8:114]:9229/", v4).reason).toBe("inspector-port");
		expect(brokerDecision("http://192.168.1.21:9229/", v4).allow).toBe(true);
		const mapped = { hubAddresses: ["::ffff:192.168.1.20"] };
		expect(brokerDecision("http://192.168.1.20:47615/", mapped).reason).toBe("hub-port");
		const named = { hubAddresses: ["HUB.Example."] };
		expect(brokerDecision("http://hub.example/", named).reason).toBe("hub-address");
	});

	it("canonicalizes configured addresses the way URL hosts are", () => {
		expect(canonicalAddress("fd7a:115c:a1e0:0::0001")).toBe("fd7a:115c:a1e0::1");
		expect(canonicalAddress("::ffff:192.168.1.20")).toBe("::ffff:c0a8:114");
		expect(canonicalAddress("192.168.1.20")).toBe("192.168.1.20");
		expect(canonicalAddress("HUB.Example.")).toBe("hub.example");
		expect(canonicalAddress("not a host!")).toBeNull();
	});
});
