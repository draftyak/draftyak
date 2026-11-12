import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	addressFacts,
	canonicalAddress,
	captureEgressPolicy,
	egressHost,
	egressPort,
	publicAddress,
	resolveEgress,
	resolveEgressAnswers,
	validateEgressAnswers,
} from "../../../src/plugins/broker/network/index.ts";
import { withNetworkTestHooks } from "../../../src/plugins/broker/network/test-context.ts";
import { BLOCKED_LOOPBACK_PORTS } from "../../../src/plugins/broker/ports.ts";

const dns = vi.hoisted(() => ({
	four: vi.fn(),
	six: vi.fn(),
	cancel: vi.fn(),
	construct: vi.fn(),
}));
vi.mock("node:dns/promises", () => ({
	Resolver: class {
		constructor(options: unknown) {
			dns.construct(options);
		}
		resolve4(host: string) {
			return dns.four(host);
		}
		resolve6(host: string) {
			return dns.six(host);
		}
		cancel() {
			dns.cancel();
		}
	},
}));
vi.mock("node:os", () => ({
	networkInterfaces: () => ({
		fixture: [{ address: "10.0.0.10" }, { address: "127.0.0.1" }, { address: "::1" }],
	}),
}));
const policy = { deniedAddresses: [] as string[], deniedPorts: [] as number[] };
const signal = () => new AbortController().signal;
const pin = { address: "8.8.8.8", family: 4 as const };
beforeEach(() => {
	vi.clearAllMocks();
	dns.four.mockResolvedValue(["8.8.8.8"]);
	dns.six.mockRejectedValue(Object.assign(new Error("No AAAA"), { code: "ENODATA" }));
});

describe("shared address facts", () => {
	it.each([
		["127.0.0.1", "loopback"],
		["::1", "loopback"],
		["10.1.2.3", "private"],
		["172.16.0.1", "private"],
		["192.168.2.3", "private"],
		["fd12::1", "private"],
		["100.64.1.2", "carrier-grade-nat"],
		["169.254.1.2", "link-local"],
		["fe80::1", "link-local"],
		["8.8.8.8", "public"],
		["2606:4700:4700::1111", "public"],
	])("reports %s as %s without granting a connection", (address, locality) => {
		expect(addressFacts(address).locality).toBe(locality);
		if (locality !== "public")
			expect(() =>
				validateEgressAnswers([{ address, family: address.includes(":") ? 6 : 4 }], policy),
			).toThrow("Network request refused");
	});
	it.each(["::ffff:8.8.8.8", "::ffff:808:808", "::8.8.8.8", "::808:808"])(
		"folds %s for native deny comparisons but refuses mapped DNS answers",
		(address) => {
			expect(canonicalAddress(address)).toBe("8.8.8.8");
			expect(addressFacts(address)).toEqual({ ...pin, locality: "public" });
			expect(() =>
				validateEgressAnswers([pin], { ...policy, deniedAddresses: [address] }),
			).toThrow();
			expect(() => validateEgressAnswers([{ address, family: 6 }], policy)).toThrow();
		},
	);
	it.each(["fe80::1%eth0", "fe80::1%1", "127.1", "0177.0.0.1", "2130706433", "0x7f000001", "bad"])(
		"refuses scoped or noncanonical address %s",
		(address) => {
			expect(() => canonicalAddress(address)).toThrow();
			expect(publicAddress(address)).toBe(false);
		},
	);
	it.each([
		"192.31.196.1",
		"192.175.48.1",
		"192.52.193.1",
		"2620:4f:8000::1",
		"3ffe::1",
		"3fff::1",
		"2001:db8::1",
		"2002::1",
		"2001::1",
		"192.0.0.1",
		"192.0.2.1",
		"192.88.99.1",
		"198.18.0.1",
		"198.51.100.1",
		"203.0.113.1",
		"0.0.0.0",
		"224.0.0.1",
		"255.255.255.255",
		"4000::1",
		"::",
	])("refuses special-use %s even under a local rule", (address) => {
		expect(addressFacts(address).locality).toBe("special-use");
		expect(publicAddress(address)).toBe(false);
		expect(() =>
			validateEgressAnswers([{ address, family: address.includes(":") ? 6 : 4 }], {
				...policy,
				allowLocal: true,
			}),
		).toThrow();
	});
	it.each([
		"169.254.169.254",
		"169.254.170.2",
		"fd00:ec2::254",
		"100.100.100.200",
		"168.63.129.16",
	])("classifies metadata %s before local admission", (address) => {
		expect(addressFacts(address).locality).toBe("metadata");
		expect(() =>
			validateEgressAnswers([{ address, family: address.includes(":") ? 6 : 4 }], {
				...policy,
				allowLocal: true,
			}),
		).toThrow();
	});
});

describe("native egress boundary", () => {
	it("allows intended loopback presets only for an explicit local rule", async () => {
		for (const host of ["127.0.0.1", "::1"]) {
			await expect(resolveEgress(host, 11434, policy, signal())).rejects.toThrow();
			expect(
				(await resolveEgress(host, 11434, { ...policy, allowLocal: true }, signal())).address,
			).toBe(host);
			await expect(
				resolveEgress(
					host,
					11434,
					{
						...policy,
						allowLocal: true,
						deniedAddresses: [host],
					},
					signal(),
				),
			).rejects.toThrow();
		}
		expect(() =>
			validateEgressAnswers([{ address: "10.0.0.10", family: 4 }], {
				...policy,
				allowLocal: true,
			}),
		).toThrow();
	});
	it("keeps fixed and current-bind ports denied without caller additions", async () => {
		expect([...BLOCKED_LOOPBACK_PORTS].sort((a, b) => a - b)).toEqual([
			1455, 9229, 47613, 47614, 47615,
		]);
		for (const port of [1455, 9229, 47613, 47614, 47615, 11434]) {
			const native = { ...policy, allowLocal: true, deniedPorts: [11434] };
			expect(() => egressPort(port, native)).toThrow();
			await expect(resolveEgress("127.0.0.1", port, native, signal())).rejects.toThrow();
		}
		expect(() => egressPort(443, policy)).not.toThrow();
		expect(dns.four).not.toHaveBeenCalled();
	});
	it.each([
		"model.example\n",
		"MODEL.example",
		"user@model.example",
		"model.example:443",
		"model.example.",
		"127.1",
		"0x7f000001",
	])("refuses noncanonical hostname %s before DNS", async (host) => {
		expect(() => egressHost(host, true)).toThrow();
		await expect(
			resolveEgress(host, 443, { ...policy, allowLocal: true }, signal()),
		).rejects.toThrow();
		expect(dns.four).not.toHaveBeenCalled();
	});
	it.each(["localhost", "device.local", "a.internal", "a.home.arpa", "a.onion"])(
		"requires local policy for %s",
		(host) => {
			expect(() => egressHost(host)).toThrow();
			expect(() => egressHost(host, true)).not.toThrow();
		},
	);
	it("checks every DNS answer, refusing mixed scope or one forbidden member", () => {
		for (const bad of [
			{ address: "127.0.0.1", family: 4 as const },
			{ address: "10.1.2.3", family: 4 as const },
			{ address: "169.254.169.254", family: 4 as const },
			{ address: "192.31.196.1", family: 4 as const },
			{ address: "8.8.4.4", family: 4 as const },
		])
			expect(() =>
				validateEgressAnswers([pin, bad], {
					deniedAddresses: ["8.8.4.4"],
					deniedPorts: [],
					allowLocal: true,
				}),
			).toThrow();
		expect(() => validateEgressAnswers([pin, { ...pin, family: 6 }], policy)).toThrow();
	});
	it("bounds and snapshots native records without invoking hooks", () => {
		const trap = vi.fn(() => {
			throw Error("DYTEST-native-record-hook");
		});
		for (const answers of [
			[],
			Array(33).fill(pin),
			new Proxy([pin], { get: trap }),
			[Object.defineProperty({ ...pin }, "address", { get: trap })],
			Object.defineProperty([], "0", { get: trap }),
		])
			expect(() => validateEgressAnswers(answers, policy)).toThrow();
		expect(() => captureEgressPolicy(new Proxy(policy, { get: trap }))).toThrow();
		expect(() =>
			captureEgressPolicy(Object.defineProperty({ ...policy }, "allowLocal", { get: trap })),
		).toThrow();
		expect(trap).not.toHaveBeenCalled();
		expect(validateEgressAnswers(Array(32).fill(pin), policy)).toEqual(pin);
	});
	it("captures restrictive native policy before resolution awaits", async () => {
		const pending = Promise.withResolvers<readonly (typeof pin)[]>();
		const native = { ...policy, allowLocal: false };
		const result = withNetworkTestHooks({ resolve: () => pending.promise }, () =>
			resolveEgress("model.example", 443, native, signal()),
		);
		native.allowLocal = true;
		pending.resolve([{ address: "10.1.2.3", family: 4 }]);
		await expect(result).rejects.toThrow();
	});
	it("uses c-ares for both families and returns all captured accepted facts", async () => {
		dns.six.mockResolvedValue(["2606:4700:4700::1111"]);
		const answers = await resolveEgressAnswers("model.example", 443, policy, signal());
		expect(answers).toEqual([pin, { address: "2606:4700:4700::1111", family: 6 }]);
		expect(dns.construct).toHaveBeenCalledWith({ tries: 1, timeout: 2000 });
		expect(dns.four).toHaveBeenCalledExactlyOnceWith("model.example");
		expect(dns.six).toHaveBeenCalledExactlyOnceWith("model.example");
		expect(dns.cancel).toHaveBeenCalledOnce();
		expect(Object.isFrozen(answers)).toBe(true);
		expect(Object.isFrozen(answers[0])).toBe(true);
	});
	it("refuses a failed family rather than using partial DNS success", async () => {
		dns.six.mockRejectedValue(Object.assign(new Error("DNS failure"), { code: "ESERVFAIL" }));
		await expect(resolveEgress("model.example", 443, policy, signal())).rejects.toThrow();
	});
	it("cancels its resolver and never returns a late answer after abort", async () => {
		const pending = Promise.withResolvers<string[]>();
		dns.four.mockReturnValue(pending.promise);
		const controller = new AbortController();
		const result = resolveEgress("model.example", 443, policy, controller.signal);
		controller.abort();
		pending.resolve(["8.8.8.8"]);
		await expect(result).rejects.toThrow();
		expect(dns.cancel).toHaveBeenCalled();
	});
	it.each([
		{ NODE_ENV: "production", VITEST: "true" },
		{ NODE_ENV: "test", VITEST: "false" },
		{ NODE_ENV: "test", VITEST: undefined },
	])("does not expose or enable fixture hooks outside both test flags: %j", (environment) => {
		const module = fileURLToPath(
			new URL("../../../src/plugins/broker/network/test-context.ts", import.meta.url),
		);
		const child = spawnSync(
			process.execPath,
			[
				"--input-type=module",
				"-e",
				`
		 const {withNetworkTestHooks,networkTestHooks}=await import(${JSON.stringify(pathToFileURL(module).href)});
		 let blocked=false; try{withNetworkTestHooks({},()=>{});}catch{blocked=true;}
		 console.log(JSON.stringify({blocked,hooks:networkTestHooks()!==undefined}));
		`,
			],
			{
				env: environment,
				encoding: "utf8",
				timeout: 3000,
				windowsHide: true,
			},
		);
		expect(child.error).toBeUndefined();
		expect(child.status).toBe(0);
		expect(JSON.parse(child.stdout)).toEqual({ blocked: true, hooks: false });
	});
});
