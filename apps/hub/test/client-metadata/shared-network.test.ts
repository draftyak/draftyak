import { expect, it, vi } from "vitest";
import { canonicalAddress, validateAnswers } from "../../src/mcp/client-metadata/addresses.ts";
import { getPinnedMetadata } from "../../src/mcp/client-metadata/https.ts";
import { MetadataDestinations, metadataUrl } from "../../src/mcp/client-metadata/policy.ts";
import {
	captureEgressPolicy,
	type EgressPolicy,
	egressHost,
	egressPort,
	resolveEgress,
	validateEgressAnswers,
} from "../../src/net/addresses.ts";
import { createPinnedHttpsConnection } from "../../src/net/pinned-https.ts";
import { withNetworkTestHooks } from "../../src/net/test-context.ts";

vi.mock("node:os", () => ({
	networkInterfaces: () => ({
		fixture: [{ address: "10.0.0.10" }, { address: "127.0.0.1" }, { address: "::1" }],
	}),
}));
const policy: EgressPolicy = Object.freeze({
	deniedAddresses: Object.freeze(["8.8.4.4"]),
	deniedPorts: Object.freeze([47613, 47614, 47615, 9229]),
});
it.each(["::ffff:8.8.8.8", "::ffff:808:808", "::8.8.8.8", "::808:808"])(
	"folds deny entry %s against its A answer",
	(address) => {
		expect(canonicalAddress(address)).toBe("8.8.8.8");
		expect(() => validateAnswers([{ address: "8.8.8.8", family: 4 }], [address])).toThrow(
			/^Client metadata refused$/,
		);
	},
);
it("retains ordinary public IPv6 while rejecting mapped DNS answers", () => {
	expect(validateAnswers([{ address: "2606:4700:4700::1111", family: 6 }], [])).toEqual({
		address: "2606:4700:4700::1111",
		family: 6,
	});
	expect(() => validateAnswers([{ address: "::ffff:8.8.8.8", family: 6 }], [])).toThrow();
});
it.each(["device.local", "a.internal", "a.home.arpa", "a.onion", "a.localhost"])(
	"uses PublicDnsHost to refuse %s for metadata",
	(host) => {
		expect(() => metadataUrl(`https://${host}/client.json`, "cimd")).toThrow(
			/^Client metadata refused$/,
		);
		expect(
			() => new MetadataDestinations([{ kind: "cimd", host, paths: [{ exact: "/client.json" }] }]),
		).toThrow();
		expect(() => egressHost(host)).toThrow();
		expect(() => egressHost(host, true)).not.toThrow();
	},
);
it("requires explicit native local policy and still denies own and metadata addresses", () => {
	for (const address of ["10.254.253.252", "127.0.0.2", "100.64.2.3", "169.254.1.2", "fd12::1"]) {
		const family = address.includes(":") ? 6 : 4;
		expect(() => validateEgressAnswers([{ address, family }], policy)).toThrow();
		expect(
			validateEgressAnswers([{ address, family }], { ...policy, allowLocal: true }).address,
		).toBe(address);
	}
	for (const address of [
		"10.0.0.10",
		"127.0.0.1",
		"8.8.4.4",
		"169.254.169.254",
		"100.100.100.200",
		"168.63.129.16",
		"0.0.0.0",
		"224.0.0.1",
	])
		expect(() =>
			validateEgressAnswers([{ address, family: 4 }], { ...policy, allowLocal: true }),
		).toThrow(/^Network request refused$/);
	expect(() =>
		validateEgressAnswers([{ address: "fd00:ec2::254", family: 6 }], {
			...policy,
			allowLocal: true,
		}),
	).toThrow();
	expect(() =>
		validateEgressAnswers([{ address: "169.254.170.2", family: 4 }], {
			...policy,
			allowLocal: true,
		}),
	).toThrow();
});
it("keeps native denied ports mandatory even for an approved local rule", () => {
	for (const port of policy.deniedPorts)
		expect(() => egressPort(port, { ...policy, allowLocal: true })).toThrow();
	for (const port of policy.deniedPorts)
		expect(() =>
			egressPort(port, { deniedAddresses: [], deniedPorts: [], allowLocal: true }),
		).toThrow();
	expect(() => egressPort(443, policy)).not.toThrow();
	expect(() => egressPort(1455, { deniedAddresses: [], deniedPorts: [1455] })).toThrow();
	expect(() => egressPort(8443, policy)).not.toThrow();
});
it("refuses numeric host aliases under a local rule while retaining exact localhost and IPs", () => {
	for (const host of ["127.1", "2130706433", "0x7f000001", "0177.0.0.1", "a.1"])
		expect(() => egressHost(host, true)).toThrow(/^Network request refused$/);
	for (const host of ["localhost", "device.local", "127.0.0.2", "::1"])
		expect(() => egressHost(host, true)).not.toThrow();
});
it("captures bounded native policy without invoking getters or proxies", () => {
	let hooks = 0;
	const trap = () => {
		hooks++;
		throw new Error("PRIVATE_POLICY_CANARY");
	};
	for (const input of [
		new Proxy(policy, { get: trap, getPrototypeOf: trap }),
		Object.defineProperty({ ...policy }, "allowLocal", { get: trap }),
		{ ...policy, deniedPorts: [443.5] },
		{ ...policy, deniedPorts: undefined },
	])
		expect(() => captureEgressPolicy(input as EgressPolicy)).toThrow(/^Network request refused$/);
	expect(hooks).toBe(0);
	const checked = captureEgressPolicy(policy);
	expect(Object.isFrozen(checked)).toBe(true);
	expect(Object.isFrozen(checked.deniedPorts)).toBe(true);
});
it("does not widen the native local rule while DNS is pending", async () => {
	const input = { deniedAddresses: [] as string[], deniedPorts: [9229], allowLocal: false };
	const pending = Promise.withResolvers<readonly { address: string; family: 4 }[]>();
	const result = withNetworkTestHooks({ resolve: () => pending.promise }, () =>
		resolveEgress("model.example", 443, input, new AbortController().signal),
	);
	input.allowLocal = true;
	input.deniedPorts.length = 0;
	pending.resolve([{ address: "10.254.253.252", family: 4 }]);
	await expect(result).rejects.toThrow(/^Network request refused$/);
});
it("refuses changing DNS/pin accessors before any read or connection setup", async () => {
	let reads = 0;
	const changing = {
		get address() {
			return ++reads <= 2 ? "8.8.8.8" : "127.0.0.2";
		},
		family: 4 as const,
	};
	expect(() => validateEgressAnswers([changing], policy)).toThrow(/^Network request refused$/);
	expect(() => createPinnedHttpsConnection("metadata.example", 443, changing, policy)).toThrow(
		/^Network request refused$/,
	);
	await expect(
		getPinnedMetadata({
			destination: metadataUrl("https://metadata.example/document.json", "cimd"),
			address: changing,
			maxBytes: 128,
			signal: new AbortController().signal,
		}),
	).rejects.toThrow(/^Client metadata refused$/);
	expect(reads).toBe(0);
});
it("copies only bounded own address/family data and invokes no array/record hooks", () => {
	let hooks = 0;
	const trap = () => {
		hooks++;
		throw new Error("PRIVATE_PIN_CANARY");
	};
	const answer = { address: "8.8.8.8", family: 4 as const };
	const accessor = Object.defineProperty({ ...answer }, "address", { enumerable: true, get: trap });
	const proxy = new Proxy(answer, {
		get: trap,
		getPrototypeOf: trap,
		getOwnPropertyDescriptor: trap,
	});
	const index = Object.defineProperty([], "0", { enumerable: true, get: trap });
	for (const value of [
		[accessor],
		[proxy],
		index,
		new Proxy([answer], { get: trap, getPrototypeOf: trap }),
	])
		expect(() => validateEgressAnswers(value as readonly (typeof answer)[], policy)).toThrow(
			/^Network request refused$/,
		);
	expect(hooks).toBe(0);
	const accepted = Object.assign(Object.create(null), answer);
	Object.defineProperty(accepted, "unused", { get: trap });
	const checked = validateEgressAnswers([accepted], policy);
	accepted.address = "127.0.0.2";
	expect(checked).toEqual(answer);
	expect(Object.isFrozen(checked)).toBe(true);
	expect(hooks).toBe(0);
});
