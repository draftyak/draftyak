import { describe, expect, it, vi } from "vitest";
import {
	classifyEndpoint,
	type EgressPolicy,
	type EndpointClassification,
	type PinnedAddress,
} from "../../../src/plugins/broker/network/index.ts";
import {
	takeNetworkAttempt,
	withNetworkTestHooks,
} from "../../../src/plugins/broker/network/test-context.ts";

vi.mock("node:os", () => ({
	networkInterfaces: () => ({ fixture: [{ address: "10.0.0.10" }] }),
}));

const policy: EgressPolicy = { deniedAddresses: [], deniedPorts: [] };
const localPolicy: EgressPolicy = { ...policy, allowLocal: true };
const publicPins: readonly PinnedAddress[] = [
	{ address: "8.8.8.8", family: 4 },
	{ address: "2606:4700:4700::1111", family: 6 },
];

async function classify(
	endpoint: string,
	answers: readonly PinnedAddress[] = publicPins,
	native: EgressPolicy = policy,
): Promise<EndpointClassification> {
	const controller = new AbortController();
	try {
		return await withNetworkTestHooks({ resolve: async () => answers }, () =>
			classifyEndpoint(endpoint, native, controller.signal),
		);
	} finally {
		controller.abort();
	}
}

describe("endpoint classification", () => {
	it.each([
		["https://model.example", "https://model.example"],
		["https://model.example/", "https://model.example"],
		["http://model.example", "http://model.example"],
		["https://model.example:8443/", "https://model.example:8443"],
	])(
		"binds the canonical origin for %s and preserves all public answers",
		async (endpoint, origin) => {
			const result = await classify(endpoint);
			expect(result).toEqual({
				origin,
				hostname: "model.example",
				destination: "cloud",
				addresses: publicPins,
			});
			expect(Object.isFrozen(result)).toBe(true);
			expect(Object.isFrozen(result.addresses)).toBe(true);
			expect(result.addresses.every(Object.isFrozen)).toBe(true);
			expect(Reflect.set(result, "destination", "local")).toBe(false);
			expect(Reflect.set(result.addresses[0] as PinnedAddress, "address", "127.0.0.1")).toBe(false);
		},
	);

	it.each([
		["127.0.0.1", 4, "local"],
		["::1", 6, "local"],
		["10.1.2.3", 4, "local-network"],
		["100.64.1.2", 4, "local-network"],
		["169.254.1.2", 4, "local-network"],
		["fd12::1", 6, "local-network"],
		["fe80::1", 6, "local-network"],
	] as const)(
		"maps admitted %s through the shared address facts",
		async (address, family, destination) => {
			const result = await classify(
				"http://model.example:11434",
				[{ address, family }],
				localPolicy,
			);
			expect(result.destination).toBe(destination);
			expect(result.addresses).toEqual([{ address, family }]);
		},
	);

	it("resolves bare IPv6 while retaining the bracketed hostname and origin", async () => {
		const seen: string[] = [];
		const controller = new AbortController();
		try {
			const result = await withNetworkTestHooks(
				{
					resolve: async (host) => {
						seen.push(host);
						return [{ address: "::1", family: 6 }];
					},
				},
				() => classifyEndpoint("http://[::1]:11434/", localPolicy, controller.signal),
			);
			expect(seen).toEqual(["::1"]);
			expect(result).toEqual({
				origin: "http://[::1]:11434",
				hostname: "[::1]",
				destination: "local",
				addresses: [{ address: "::1", family: 6 }],
			});
		} finally {
			controller.abort();
		}
	});

	it("groups all admitted private and link-local answers as local-network", async () => {
		const answers: readonly PinnedAddress[] = [
			{ address: "10.1.2.3", family: 4 },
			{ address: "fe80::1", family: 6 },
		];
		const result = await classify("https://model.example", answers, localPolicy);
		expect(result.destination).toBe("local-network");
		expect(result.addresses).toEqual(answers);
	});

	it.each([
		["http://localhost:11434", "8.8.8.8", "cloud"],
		["https://model.example", "127.0.0.1", "local"],
	] as const)(
		"classifies %s from answers rather than its hostname label",
		async (endpoint, address, destination) => {
			expect((await classify(endpoint, [{ address, family: 4 }], localPolicy)).destination).toBe(
				destination,
			);
		},
	);

	it("resolves again on every invocation when DNS changes", async () => {
		let calls = 0;
		const controller = new AbortController();
		try {
			const results = await withNetworkTestHooks(
				{
					resolve: async () => [{ address: ++calls === 1 ? "8.8.8.8" : "127.0.0.1", family: 4 }],
				},
				async () => [
					await classifyEndpoint("https://model.example", localPolicy, controller.signal),
					await classifyEndpoint("https://model.example", localPolicy, controller.signal),
				],
			);
			expect(calls).toBe(2);
			expect(results.map((result) => result.destination)).toEqual(["cloud", "local"]);
		} finally {
			controller.abort();
		}
	});

	it.each([
		[
			"mixed classes",
			[
				{ address: "8.8.8.8", family: 4 },
				{ address: "127.0.0.1", family: 4 },
			],
		],
		[
			"one denied address",
			[
				{ address: "8.8.8.8", family: 4 },
				{ address: "8.8.4.4", family: 4 },
			],
		],
		["own interface", [{ address: "10.0.0.10", family: 4 }]],
	] as const)("retains the original all-answer refusal for %s", async (_label, answers) => {
		await expect(
			classify("https://model.example", answers, {
				...localPolicy,
				deniedAddresses: ["8.8.4.4"],
			}),
		).rejects.toThrow(/^Network request refused$/);
	});

	it("does not add local admission to the caller's policy", async () => {
		await expect(
			classify("http://model.example:11434", [{ address: "127.0.0.1", family: 4 }]),
		).rejects.toThrow(/^Network request refused$/);
		expect(policy).toEqual({ deniedAddresses: [], deniedPorts: [] });
	});

	it.each([
		["fixed reserved port", "http://model.example:9229", []],
		["current bind port", "http://model.example:11434", [11434]],
	] as const)("refuses a %s before DNS", async (_label, endpoint, deniedPorts) => {
		const resolve = vi.fn(async () => publicPins);
		const controller = new AbortController();
		try {
			await expect(
				withNetworkTestHooks({ resolve }, () =>
					classifyEndpoint(
						endpoint,
						{
							...policy,
							deniedPorts,
						},
						controller.signal,
					),
				),
			).rejects.toThrow(/^Network request refused$/);
			expect(resolve).not.toHaveBeenCalled();
		} finally {
			controller.abort();
		}
	});

	it.each([
		["request path", "https://model.example/v1/models"],
		["query", "https://model.example/?x=1"],
		["fragment", "https://model.example/#x"],
		["userinfo", "https://user@model.example/"],
		["host alias", "https://MODEL.example/"],
		["default port alias", "https://model.example:443/"],
		["address alias", "http://127.1/"],
		["second root slash", "https://model.example//"],
		["other protocol", "ftp://model.example/"],
		["surrounding whitespace", " https://model.example/"],
		["unparseable URI", "https://["],
		["oversized input", `https://${"a".repeat(2049)}`],
	])("refuses %s before DNS", async (_label, endpoint) => {
		const resolve = vi.fn(async () => publicPins);
		const controller = new AbortController();
		try {
			await expect(
				withNetworkTestHooks({ resolve }, () =>
					classifyEndpoint(endpoint, localPolicy, controller.signal),
				),
			).rejects.toThrow(/^Network request refused$/);
			expect(resolve).not.toHaveBeenCalled();
		} finally {
			controller.abort();
		}
	});

	it("refuses nonprimitive endpoints without invoking coercion or proxy hooks", async () => {
		const trap = vi.fn(() => {
			throw new Error("DYTEST-coercion");
		});
		const coercible = { [Symbol.toPrimitive]: trap, toString: trap };
		for (const endpoint of [
			undefined,
			null,
			0,
			true,
			coercible,
			new Proxy(coercible, { get: trap }),
		])
			await expect(classify(endpoint as unknown as string)).rejects.toThrow(
				/^Network request refused$/,
			);
		expect(trap).not.toHaveBeenCalled();
	});

	it("refuses oversized input before constructing a URL", async () => {
		const original = Object.getOwnPropertyDescriptor(globalThis, "URL");
		if (!original?.configurable) throw new Error("DYTEST-URL-fixture");
		let constructions = 0;
		try {
			Object.defineProperty(globalThis, "URL", {
				configurable: true,
				enumerable: original.enumerable,
				writable: true,
				value: class {
					constructor() {
						constructions++;
						throw new Error("DYTEST-URL-construction");
					}
				},
			});
			await expect(classify("x".repeat(2049))).rejects.toThrow(/^Network request refused$/);
			expect(constructions).toBe(0);
		} finally {
			Object.defineProperty(globalThis, "URL", original);
		}
	});

	it("uses captured policy data without invoking an accessor", async () => {
		const trap = vi.fn(() => {
			throw new Error("DYTEST-policy-accessor");
		});
		const native = Object.defineProperty({ ...policy }, "allowLocal", { get: trap });
		await expect(classify("https://model.example", publicPins, native)).rejects.toThrow(
			/^Network request refused$/,
		);
		expect(trap).not.toHaveBeenCalled();
	});

	it("keeps the restrictive policy snapshot across resolution", async () => {
		const pending = Promise.withResolvers<readonly PinnedAddress[]>();
		const controller = new AbortController();
		const native = { deniedAddresses: ["8.8.4.4"], deniedPorts: [], allowLocal: false };
		const result = withNetworkTestHooks({ resolve: () => pending.promise }, () =>
			classifyEndpoint("https://model.example", native, controller.signal),
		);
		try {
			native.deniedAddresses.length = 0;
			native.allowLocal = true;
			pending.resolve([{ address: "8.8.4.4", family: 4 }]);
			await expect(result).rejects.toThrow(/^Network request refused$/);
		} finally {
			controller.abort();
			pending.resolve(publicPins);
			await result.catch(() => {});
		}
	});

	it("refuses an already aborted operation without resolving", async () => {
		const controller = new AbortController();
		controller.abort(new Error("DYTEST-abort-reason"));
		const resolve = vi.fn(async () => publicPins);
		await expect(
			withNetworkTestHooks({ resolve }, () =>
				classifyEndpoint("https://model.example", policy, controller.signal),
			),
		).rejects.toThrow(/^Network request refused$/);
		expect(resolve).not.toHaveBeenCalled();
	});

	it("uses the original already-aborted check before resolution despite an instance shadow", async () => {
		const controller = new AbortController();
		controller.abort();
		const original = Object.getOwnPropertyDescriptor(controller.signal, "throwIfAborted");
		const resolve = vi.fn(async () => publicPins);
		try {
			Object.defineProperty(controller.signal, "throwIfAborted", {
				configurable: true,
				value: () => {},
			});
			await expect(
				withNetworkTestHooks({ resolve }, () =>
					classifyEndpoint("https://model.example", policy, controller.signal),
				),
			).rejects.toThrow(/^Network request refused$/);
			expect(resolve).not.toHaveBeenCalled();
		} finally {
			if (original) Object.defineProperty(controller.signal, "throwIfAborted", original);
			else Reflect.deleteProperty(controller.signal, "throwIfAborted");
			controller.abort();
		}
	});

	it("never returns late answers after the operation is aborted", async () => {
		const pending = Promise.withResolvers<readonly PinnedAddress[]>();
		const controller = new AbortController();
		const result = withNetworkTestHooks({ resolve: () => pending.promise }, () =>
			classifyEndpoint("https://model.example", policy, controller.signal),
		);
		try {
			controller.abort();
			pending.resolve(publicPins);
			await expect(result).rejects.toThrow(/^Network request refused$/);
		} finally {
			controller.abort();
			pending.resolve(publicPins);
			await result.catch(() => {});
		}
	});

	it("refuses cancellation after shared resolution and before returning endpoint facts", async () => {
		const pending = Promise.withResolvers<readonly PinnedAddress[]>();
		const ended = Promise.withResolvers<void>();
		const controller = new AbortController();
		const events: string[] = [];
		let resolvedBeforeAbort = false;
		let completedResolution = false;
		controller.signal.addEventListener("abort", () => ended.resolve(), { once: true });
		const attempt = {
			signal: controller.signal,
			settled: ended.promise,
			policyAllowed: () => {},
			policyRefused: () => {
				ended.resolve();
			},
			resolved: () => {
				completedResolution = true;
				events.push("resolved");
			},
			succeeded: () => {
				ended.resolve();
			},
			failed: () => {
				events.push("failed");
				ended.resolve();
			},
		};
		const result = withNetworkTestHooks(
			{
				resolve: () => pending.promise,
				observer: { beginAttempt: () => attempt, fail: () => {} },
			},
			() => classifyEndpoint("https://model.example", policy, controller.signal),
		);
		try {
			pending.resolve(publicPins);
			queueMicrotask(() => {
				resolvedBeforeAbort = completedResolution;
				events.push("abort");
				controller.abort();
			});
			const refused = await result.then(
				() => false,
				(error: unknown) => error instanceof Error && error.message === "Network request refused",
			);
			expect(resolvedBeforeAbort).toBe(true);
			expect(events).toEqual(["resolved", "abort", "failed"]);
			expect(refused).toBe(true);
		} finally {
			controller.abort();
			pending.resolve(publicPins);
			await result.catch(() => {});
			await ended.promise;
		}
	});

	it("replaces resolver errors with the fixed content-free refusal", async () => {
		const controller = new AbortController();
		try {
			await expect(
				withNetworkTestHooks(
					{
						resolve: async () => {
							throw new Error("DYTEST-resolver-detail");
						},
					},
					() => classifyEndpoint("https://model.example", policy, controller.signal),
				),
			).rejects.toThrow(/^Network request refused$/);
		} finally {
			controller.abort();
		}
	});

	it("preserves original pin observation identity and settles an abandoned preview by caller cancellation", async () => {
		const controller = new AbortController();
		const ended = Promise.withResolvers<void>();
		const events: string[] = [];
		let starts = 0;
		controller.signal.addEventListener("abort", () => ended.resolve(), { once: true });
		const attempt = {
			signal: controller.signal,
			settled: ended.promise,
			policyAllowed: () => {
				events.push("allowed");
			},
			policyRefused: () => {
				events.push("refused");
				ended.resolve();
			},
			resolved: () => {
				events.push("resolved");
			},
			succeeded: () => {
				events.push("succeeded");
				ended.resolve();
			},
			failed: () => {
				events.push("failed");
				ended.resolve();
			},
		};
		await withNetworkTestHooks(
			{
				resolve: async () => publicPins,
				observer: {
					beginAttempt: () => {
						starts++;
						return attempt;
					},
					fail: () => {
						events.push("binding-refused");
					},
				},
			},
			async () => {
				try {
					const result = await classifyEndpoint("https://model.example", policy, controller.signal);
					const retained = takeNetworkAttempt(
						"model.example",
						443,
						result.addresses[0] as PinnedAddress,
					);
					expect(retained?.resolved).toBe(true);
					expect(retained?.attempt).toBe(attempt);
					expect(starts).toBe(1);
					expect(events).toEqual(["allowed", "resolved"]);
				} finally {
					controller.abort();
					await ended.promise;
				}
			},
		);
		expect(events).toEqual(["allowed", "resolved", "failed"]);
	});
});
