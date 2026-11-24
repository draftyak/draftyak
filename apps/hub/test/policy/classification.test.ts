import { describe, expect, it, vi } from "vitest";
import type { EgressPolicy, PinnedAddress } from "../../src/plugins/broker/network/index.ts";
import { withNetworkTestHooks } from "../../src/plugins/broker/network/test-context.ts";
import { classifyEndpoint, EndpointClassificationError } from "../../src/policy/classification.ts";

vi.mock("node:os", async (original) => ({
	...(await original<typeof import("node:os")>()),
	networkInterfaces: () => ({ DYTEST: [{ address: "10.23.45.1" }] }),
}));

const ENDPOINT = "https://model.example.com/v1/chat/completions";
const PUBLIC: PinnedAddress = { address: "8.8.8.8", family: 4 };
const PRIVATE: PinnedAddress = { address: "10.23.45.2", family: 4 };
const policy = (allowLocal = true): EgressPolicy => ({
	deniedAddresses: [],
	deniedPorts: [],
	allowLocal,
});
const signal = (): AbortSignal => new AbortController().signal;
const refused = (result: Promise<unknown>): Promise<void> =>
	expect(result).rejects.toMatchObject({
		name: "EndpointClassificationError",
		code: "ENDPOINT_CLASSIFICATION_REFUSED",
		message: "Endpoint classification refused",
	});
function classify(
	answers: readonly PinnedAddress[],
	endpoint: unknown = ENDPOINT,
	network = policy(),
) {
	return withNetworkTestHooks({ resolve: async () => answers }, () =>
		classifyEndpoint(endpoint, network, signal()),
	);
}
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((finish) => {
		resolve = finish;
	});
	return { promise, resolve };
}

describe("current native endpoint classification", () => {
	it("retains all current public answers as isolated immutable facts", async () => {
		const first = { address: PUBLIC.address, family: 4 as const };
		const answers: PinnedAddress[] = [first, { address: "2606:4700:4700::1111", family: 6 }];
		const result = await classify(answers);
		expect(result).toEqual({
			endpoint: ENDPOINT,
			resolution: { hostname: "model.example.com", destination: "cloud" },
			answers,
		});
		expect(Object.keys(result)).toEqual(["endpoint", "resolution", "answers"]);
		for (const value of [result, result.resolution, result.answers, ...result.answers])
			expect(Object.isFrozen(value)).toBe(true);
		first.address = PRIVATE.address;
		answers[0] = PRIVATE;
		answers.push(PRIVATE);
		expect(result.answers).toEqual([PUBLIC, { address: "2606:4700:4700::1111", family: 6 }]);
	});

	it.each([
		["http://127.0.0.1:11434/v1/chat/completions", "127.0.0.1", "local", "127.0.0.1", 4],
		["http://[::1]:11434/v1/chat/completions", "::1", "local", "[::1]", 6],
		[
			"https://model.example.com/api/chat",
			PRIVATE.address,
			"local-network",
			"model.example.com",
			4,
		],
	] as const)(
		"uses the shared address facts for %s",
		async (endpoint, address, destination, hostname, family) => {
			let resolvedHost: string | undefined;
			const result = await withNetworkTestHooks(
				{
					resolve: async (host) => {
						resolvedHost = host;
						return [{ address, family }];
					},
				},
				() => classifyEndpoint(endpoint, policy(), signal()),
			);
			expect(resolvedHost).toBe(hostname === "[::1]" ? "::1" : hostname);
			expect(result.resolution).toEqual({ hostname, destination });
		},
	);

	it("resolves the same endpoint again and observes changed DNS under the current policy", async () => {
		for (const allowLocal of [false, true]) {
			let calls = 0;
			await withNetworkTestHooks(
				{ resolve: async () => (++calls === 1 ? [PUBLIC] : [PRIVATE]) },
				async () => {
					expect(
						(await classifyEndpoint(ENDPOINT, policy(allowLocal), signal())).resolution.destination,
					).toBe("cloud");
					const changed = classifyEndpoint(ENDPOINT, policy(allowLocal), signal());
					if (allowLocal) expect((await changed).resolution.destination).toBe("local-network");
					else await refused(changed);
				},
			);
			expect(calls).toBe(2);
		}
	});

	it("refuses mixed public and private answers regardless of their order", async () => {
		await refused(classify([PUBLIC, PRIVATE]));
		await refused(classify([PRIVATE, PUBLIC]));
	});

	it("retains the shared metadata, special-use, native-address and port refusals", async () => {
		const cases: readonly [string, PinnedAddress, EgressPolicy][] = [
			[ENDPOINT, { address: "169.254.169.254", family: 4 }, policy()],
			[ENDPOINT, { address: "192.0.2.1", family: 4 }, policy()],
			[ENDPOINT, PUBLIC, { ...policy(), deniedAddresses: [PUBLIC.address] }],
			[ENDPOINT, { address: "10.23.45.1", family: 4 }, policy()],
			["https://model.example.com:47613/v1/chat/completions", PUBLIC, policy()],
			[
				"https://model.example.com:11434/v1/chat/completions",
				PUBLIC,
				{ ...policy(), deniedPorts: [11434] },
			],
		];
		for (const [endpoint, answer, network] of cases)
			await refused(classify([answer], endpoint, network));
	});

	it("captures native network facts before awaiting DNS", async () => {
		const network = { deniedAddresses: [], deniedPorts: [], allowLocal: false };
		const answer = deferred<readonly PinnedAddress[]>();
		const pending = withNetworkTestHooks({ resolve: () => answer.promise }, () =>
			classifyEndpoint(ENDPOINT, network, signal()),
		);
		network.allowLocal = true;
		answer.resolve([PRIVATE]);
		await refused(pending);
	});

	it("refuses before DNS when aborted and after a pending resolution is cancelled", async () => {
		const controller = new AbortController();
		controller.abort(new Error("DYTEST-PRIVATE-REASON"));
		let calls = 0;
		await withNetworkTestHooks(
			{
				resolve: async () => {
					calls++;
					return [PUBLIC];
				},
			},
			() => refused(classifyEndpoint(ENDPOINT, policy(), controller.signal)),
		);
		expect(calls).toBe(0);
		const current = new AbortController();
		const answer = deferred<readonly PinnedAddress[]>();
		const pending = withNetworkTestHooks({ resolve: () => answer.promise }, () =>
			classifyEndpoint(ENDPOINT, policy(), current.signal),
		);
		current.abort(new Error("DYTEST-PRIVATE-REASON"));
		answer.resolve([PUBLIC]);
		await refused(pending);
	});

	it("refuses cancellation between the shared resolver and this consumer's continuation", async () => {
		const controller = new AbortController();
		const pending = withNetworkTestHooks(
			{
				resolve: async () => {
					queueMicrotask(() => queueMicrotask(() => controller.abort()));
					return [PUBLIC];
				},
			},
			() => classifyEndpoint(ENDPOINT, policy(), controller.signal),
		);
		await refused(pending);
		expect(controller.signal.aborted).toBe(true);
	});

	it("keeps concurrent endpoint snapshots and cancellation separate", async () => {
		const first = deferred<readonly PinnedAddress[]>();
		const second = deferred<readonly PinnedAddress[]>();
		const controller = new AbortController();
		await withNetworkTestHooks(
			{ resolve: (host) => (host === "first.example.com" ? first.promise : second.promise) },
			async () => {
				const a = classifyEndpoint(
					"https://first.example.com/api/chat",
					policy(),
					controller.signal,
				);
				const b = classifyEndpoint("https://second.example.com/api/chat", policy(), signal());
				controller.abort();
				second.resolve([PRIVATE]);
				expect((await b).resolution).toEqual({
					hostname: "second.example.com",
					destination: "local-network",
				});
				first.resolve([PUBLIC]);
				await refused(a);
			},
		);
	});

	it("requires bounded canonical HTTP(S) spelling without userinfo, query or fragment", async () => {
		let calls = 0;
		const invalid: unknown[] = [
			null,
			{},
			"",
			" https://model.example.com/api/chat",
			"ftp://model.example.com/api/chat",
			"https://MODEL.example.com/api/chat",
			"https://model.example.com:443/api/chat",
			"https://DYTEST-USER:DYTEST-SECRET@model.example.com/api/chat",
			"https://model.example.com/api/chat?DYTEST-SECRET",
			"https://model.example.com/api/chat?",
			"https://model.example.com/api/chat#DYTEST-SECRET",
			"https://model.example.com/api/chat#",
			`https://model.example.com/${"x".repeat(2048)}`,
		];
		await withNetworkTestHooks(
			{
				resolve: async () => {
					calls++;
					return [PUBLIC];
				},
			},
			async () => {
				for (const endpoint of invalid)
					await refused(classifyEndpoint(endpoint, policy(), signal()));
			},
		);
		expect(calls).toBe(0);
		const prefix = "https://model.example.com/";
		const maximum = prefix + "x".repeat(2048 - prefix.length);
		expect((await classify([PUBLIC], maximum)).endpoint).toBe(maximum);
	});

	it("returns facts about canonical HTTP and other paths without granting provider admission", async () => {
		const result = await classify([PUBLIC], "http://model.example.com/another-path");
		expect(result.resolution.destination).toBe("cloud");
		expect(Object.keys(result.resolution)).toEqual(["hostname", "destination"]);
		expect(new EndpointClassificationError().message).toBe("Endpoint classification refused");
	});
});
