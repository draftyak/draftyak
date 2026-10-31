import { HOST_MAX_ACTIVE_REQUESTS } from "@draftyak/protocol/host-channel";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type MemoryHost, memoryHost } from "../src/host.ts";

afterEach(() => {
	vi.clearAllTimers();
	vi.useRealTimers();
});

async function useCapacity(host: MemoryHost): Promise<void> {
	// A settled handler releases its capacity in a later promise reaction.
	for (let turn = 0; turn < 10; turn++) await Promise.resolve();
	const requests: Promise<unknown>[] = [];
	for (let index = 0; index < HOST_MAX_ACTIVE_REQUESTS; index++) {
		requests.push(
			host
				.request("host/kv.set", { key: `key-${index}`, value: null })
				.catch((error: unknown) => error),
		);
	}
	expect(await Promise.all(requests)).toEqual(Array(HOST_MAX_ACTIVE_REQUESTS).fill(null));
	expect(vi.getTimerCount()).toBe(0);
}

type Delivery = "own" | "inherited" | "late prototype";

function breakDelivery(signal: AbortSignal, delivery: Delivery): () => void {
	const marker = new Error("DYTEST-SUPPRESSED-ABORT-EVENT");
	const dispatch = vi.fn(() => {
		throw marker;
	});
	if (delivery === "own") Object.defineProperty(signal, "dispatchEvent", { value: dispatch });
	else {
		const prototype = delivery === "inherited" ? Object.create(AbortSignal.prototype) : {};
		Object.defineProperty(prototype, "dispatchEvent", { value: dispatch });
		Object.setPrototypeOf(signal, prototype);
	}
	return () => expect(dispatch).toHaveBeenCalledTimes(1);
}

function abortWithBrokenDelivery(controller: AbortController, checkDelivery: () => void): void {
	expect(() => controller.abort()).toThrow("DYTEST-SUPPRESSED-ABORT-EVENT");
	checkDelivery();
}

describe("memory host native cancellation", () => {
	describe.each(["before handler", "after handler"] as const)("%s", (phase) => {
		it.each(["own", "inherited", "late prototype"] as const)(
			"refuses native cancellation with broken %s event delivery",
			async (delivery) => {
				vi.useFakeTimers();
				const controller = new AbortController();
				const finish = Promise.withResolvers<null>();
				let checkDelivery = () => {};
				if (delivery !== "late prototype")
					checkDelivery = breakDelivery(controller.signal, delivery);
				const handler = vi.fn(() => (phase === "before handler" ? null : finish.promise));
				const host = memoryHost(handler);
				try {
					const result = host
						.request("host/kv.set", { key: "key", value: null }, { signal: controller.signal })
						.catch((error: unknown) => error);
					if (phase === "after handler") {
						await Promise.resolve();
						expect(handler).toHaveBeenCalledTimes(1);
					}
					if (delivery === "late prototype")
						checkDelivery = breakDelivery(controller.signal, delivery);
					abortWithBrokenDelivery(controller, checkDelivery);
					finish.resolve(null);
					expect(await result).toMatchObject({ code: "DENIED" });
					expect(handler).toHaveBeenCalledTimes(phase === "before handler" ? 0 : 1);
					expect(vi.getTimerCount()).toBe(0);
					await useCapacity(host);
				} finally {
					host.close();
				}
			},
		);
	});

	it.each(["hidden", "throwing"] as const)(
		"uses native source state instead of its %s aborted property",
		async (property) => {
			vi.useFakeTimers();
			const controller = new AbortController();
			const overridden = vi.fn(() => {
				throw new Error("DYTEST-OVERRIDDEN-ABORTED");
			});
			if (property === "hidden")
				Object.defineProperty(controller.signal, "aborted", { value: false });
			else Object.defineProperty(controller.signal, "aborted", { get: overridden });
			const checkDelivery = breakDelivery(controller.signal, "own");
			const finish = Promise.withResolvers<null>();
			const host = memoryHost(() => finish.promise);
			try {
				const options = { signal: controller.signal };
				const result = host
					.request("host/kv.set", { key: "key", value: null }, options)
					.catch((error: unknown) => error);
				await Promise.resolve();
				options.signal = new AbortController().signal;
				abortWithBrokenDelivery(controller, checkDelivery);
				finish.resolve(null);
				expect(await result).toMatchObject({ code: "DENIED" });
				expect(overridden).not.toHaveBeenCalled();
				await useCapacity(host);
			} finally {
				host.close();
			}
		},
	);

	it("refuses throwing timeout getters without leaking request capacity", async () => {
		vi.useFakeTimers();
		const handler = vi.fn(() => null);
		const host = memoryHost(handler);
		try {
			const errors: unknown[] = [];
			for (let index = 0; index <= HOST_MAX_ACTIVE_REQUESTS; index++) {
				errors.push(
					await host
						.request(
							"host/kv.set",
							{ key: "key", value: null },
							{
								get timeoutMs(): number {
									throw new Error("DYTEST-PRIVATE-TIMEOUT-GETTER");
								},
							},
						)
						.catch((error: unknown) => error),
				);
			}
			expect(handler).not.toHaveBeenCalled();
			for (const error of errors) {
				expect(error).toMatchObject({ code: "BAD_REQUEST" });
				expect(String(error)).not.toContain("DYTEST-PRIVATE-TIMEOUT-GETTER");
			}
			await useCapacity(host);
		} finally {
			host.close();
		}
	});

	it("refuses a timeout getter's cancellation before allocating a timer or calling the handler", async () => {
		vi.useFakeTimers();
		const handler = vi.fn(() => null);
		const host = memoryHost(handler);
		try {
			for (let index = 0; index <= HOST_MAX_ACTIVE_REQUESTS; index++) {
				const controller = new AbortController();
				const result = host
					.request(
						"host/kv.set",
						{ key: "key", value: null },
						{
							signal: controller.signal,
							get timeoutMs() {
								controller.abort();
								return 100;
							},
						},
					)
					.catch((error: unknown) => error);
				expect(vi.getTimerCount()).toBe(0);
				expect(await result).toMatchObject({ code: "DENIED" });
			}
			expect(handler).not.toHaveBeenCalled();
			await useCapacity(host);
		} finally {
			host.close();
		}
	});

	it.each(["timeout", "params"] as const)(
		"refuses a %s getter's close before allocating a timer or calling the handler",
		async (source) => {
			vi.useFakeTimers();
			const handler = vi.fn(() => null);
			const host = memoryHost(handler);
			try {
				const result = host
					.request(
						"host/kv.set",
						{
							get key() {
								if (source === "params") host.close();
								return "key";
							},
							value: null,
						},
						{
							get timeoutMs() {
								if (source === "timeout") host.close();
								return 100;
							},
						},
					)
					.catch((error: unknown) => error);
				expect(vi.getTimerCount()).toBe(0);
				expect(await result).toMatchObject({ code: "DENIED" });
				expect(handler).not.toHaveBeenCalled();
				await expect(
					host.request("host/kv.set", { key: "key", value: null }),
				).rejects.toMatchObject({
					code: "DENIED",
				});
			} finally {
				host.close();
			}
		},
	);

	it("rechecks cancellation when a resolved handler result has not resumed the request yet", async () => {
		vi.useFakeTimers();
		const controller = new AbortController();
		const checkDelivery = breakDelivery(controller.signal, "own");
		const finish = Promise.withResolvers<null>();
		const host = memoryHost(() => finish.promise);
		try {
			const result = host
				.request("host/kv.set", { key: "key", value: null }, { signal: controller.signal })
				.catch((error: unknown) => error);
			await Promise.resolve();
			finish.resolve(null);
			abortWithBrokenDelivery(controller, checkDelivery);
			expect(await result).toMatchObject({ code: "DENIED" });
		} finally {
			host.close();
		}
	});

	it("keeps an already awaited successful result after later cancellation", async () => {
		vi.useFakeTimers();
		const controller = new AbortController();
		const host = memoryHost(() => null);
		try {
			const result = await host.request(
				"host/kv.set",
				{ key: "key", value: null },
				{ signal: controller.signal },
			);
			controller.abort();
			expect(result).toBeNull();
			await useCapacity(host);
		} finally {
			host.close();
		}
	});

	it("retains the timeout bound for a pending handler when event delivery is broken", async () => {
		vi.useFakeTimers();
		const controller = new AbortController();
		const checkDelivery = breakDelivery(controller.signal, "own");
		const finish = Promise.withResolvers<null>();
		const host = memoryHost(() => finish.promise);
		try {
			let settled = false;
			const result = host
				.request(
					"host/kv.set",
					{ key: "key", value: null },
					{ signal: controller.signal, timeoutMs: 100 },
				)
				.catch((error: unknown) => {
					settled = true;
					return error;
				});
			await Promise.resolve();
			abortWithBrokenDelivery(controller, checkDelivery);
			await vi.advanceTimersByTimeAsync(99);
			expect(settled).toBe(false);
			await vi.advanceTimersByTimeAsync(1);
			expect(await result).toMatchObject({ code: "TIMEOUT" });
			expect(vi.getTimerCount()).toBe(0);
			finish.resolve(null);
			await useCapacity(host);
		} finally {
			host.close();
		}
	});

	it("retains a handler rejection that wins the race", async () => {
		vi.useFakeTimers();
		const controller = new AbortController();
		const checkDelivery = breakDelivery(controller.signal, "own");
		const failure = new Error("DYTEST-HANDLER-FAILURE");
		const finish = Promise.withResolvers<null>();
		const host = memoryHost(() => finish.promise);
		try {
			const result = host
				.request("host/kv.set", { key: "key", value: null }, { signal: controller.signal })
				.catch((error: unknown) => error);
			await Promise.resolve();
			abortWithBrokenDelivery(controller, checkDelivery);
			finish.reject(failure);
			expect(await result).toBe(failure);
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			host.close();
		}
	});

	it("keeps native close cancellation ahead of a result despite handler signal overrides", async () => {
		vi.useFakeTimers();
		const overridden = vi.fn(() => new Error("DYTEST-OVERRIDDEN-INTERNAL-REASON"));
		const host = memoryHost((_method, _params, signal) => {
			Object.defineProperty(signal, "aborted", { value: false });
			Object.defineProperty(signal, "reason", { get: overridden });
			void Promise.resolve().then(() => host.close());
			return null;
		});
		try {
			const result = host
				.request("host/kv.set", { key: "key", value: null })
				.catch((error: unknown) => error);
			expect(await result).toMatchObject({ code: "DENIED" });
			expect(overridden).not.toHaveBeenCalled();
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			host.close();
		}
	});

	it.each(["abort", "close"] as const)(
		"refuses a result getter's %s during result validation",
		async (action) => {
			vi.useFakeTimers();
			const controller = new AbortController();
			let reads = 0;
			const host = memoryHost((method) =>
				method === "host/kv.get"
					? {
							get value() {
								reads++;
								if (action === "abort") controller.abort();
								else host.close();
								return "synthetic";
							},
						}
					: null,
			);
			try {
				const result = host
					.request("host/kv.get", { key: "key" }, { signal: controller.signal })
					.catch((error: unknown) => error);
				expect(await result).toMatchObject({ code: "DENIED" });
				expect(reads).toBe(1);
				expect(vi.getTimerCount()).toBe(0);
				if (action === "abort") await useCapacity(host);
				else
					await expect(
						host.request("host/kv.set", { key: "key", value: null }),
					).rejects.toMatchObject({
						code: "DENIED",
					});
			} finally {
				host.close();
			}
		},
	);

	it.each([false, true])(
		"preserves cancellation before invalid handler-result validation (cancelled: %s)",
		async (cancelled) => {
			vi.useFakeTimers();
			const controller = new AbortController();
			const checkDelivery = breakDelivery(controller.signal, "own");
			const finish = Promise.withResolvers<unknown>();
			const host = memoryHost(() => finish.promise);
			try {
				const result = host
					.request("host/kv.set", { key: "key", value: null }, { signal: controller.signal })
					.catch((error: unknown) => error);
				await Promise.resolve();
				if (cancelled) abortWithBrokenDelivery(controller, checkDelivery);
				finish.resolve({ invalid: true });
				expect(await result).toMatchObject({ code: cancelled ? "DENIED" : "BAD_REQUEST" });
				expect(vi.getTimerCount()).toBe(0);
			} finally {
				host.close();
			}
		},
	);

	it.each(["invalid", "throwing"] as const)(
		"retains BAD_REQUEST when the %s result getter also cancels",
		async (outcome) => {
			vi.useFakeTimers();
			const controller = new AbortController();
			const host = memoryHost(() => ({
				get value() {
					controller.abort();
					if (outcome === "throwing") throw new Error("DYTEST-RESULT-GETTER-FAILURE");
					return Symbol("DYTEST-INVALID-RESULT");
				},
			}));
			try {
				const result = host
					.request("host/kv.get", { key: "key" }, { signal: controller.signal })
					.catch((error: unknown) => error);
				expect(await result).toMatchObject({ code: "BAD_REQUEST" });
				expect(String(await result)).not.toContain("DYTEST-RESULT-GETTER-FAILURE");
				expect(vi.getTimerCount()).toBe(0);
			} finally {
				host.close();
			}
		},
	);

	it.each([
		["timeout", HOST_MAX_ACTIVE_REQUESTS - 1, false],
		["timeout", HOST_MAX_ACTIVE_REQUESTS, false],
		["params", HOST_MAX_ACTIVE_REQUESTS - 1, false],
		["params", HOST_MAX_ACTIVE_REQUESTS, false],
		["timeout", HOST_MAX_ACTIVE_REQUESTS, true],
	] as const)(
		"bounds reentrancy from %s with %i inner requests (outer cancellation: %s)",
		async (source, innerCount, cancelOuter) => {
			vi.useFakeTimers();
			const finish = Promise.withResolvers<null>();
			const controller = new AbortController();
			const handler = vi.fn(() => finish.promise);
			const host = memoryHost(handler);
			const inner: Promise<unknown>[] = [];
			const all: Promise<unknown>[] = [];
			let entered = false;
			const reenter = (): void => {
				if (entered) return;
				entered = true;
				for (let index = 0; index < innerCount; index++) {
					const request = host
						.request("host/kv.set", { key: `inner-${index}`, value: null })
						.catch((error: unknown) => error);
					inner.push(request);
					all.push(request);
				}
				if (cancelOuter) controller.abort();
			};
			try {
				const outer = host
					.request(
						"host/kv.set",
						{
							get key() {
								if (source === "params") reenter();
								return "outer";
							},
							value: null,
						},
						{
							signal: controller.signal,
							get timeoutMs() {
								if (source === "timeout") reenter();
								return 100;
							},
						},
					)
					.catch((error: unknown) => error);
				all.push(outer);
				expect(entered).toBe(true);
				expect(vi.getTimerCount()).toBe(HOST_MAX_ACTIVE_REQUESTS);
				await Promise.resolve();
				expect(handler).toHaveBeenCalledTimes(HOST_MAX_ACTIVE_REQUESTS);
				const refusal = cancelOuter
					? "DENIED"
					: innerCount === HOST_MAX_ACTIVE_REQUESTS
						? "TOO_LARGE"
						: undefined;
				if (refusal !== undefined) await expect(outer).resolves.toMatchObject({ code: refusal });
				finish.resolve(null);
				expect(await Promise.all(inner)).toEqual(Array(innerCount).fill(null));
				if (refusal === undefined) expect(await outer).toBeNull();
				expect(vi.getTimerCount()).toBe(0);
				await useCapacity(host);
			} finally {
				host.close();
				finish.resolve(null);
				await Promise.all(all);
			}
		},
	);
});
