import { HOST_MAX_ACTIVE_REQUESTS } from "@draftyak/protocol/host-channel";
import { afterEach, describe, expect, it, vi } from "vitest";
import { memoryHost } from "../src/host.ts";

afterEach(() => {
	vi.useRealTimers();
});

describe("memory host cancellation admission", () => {
	it("refuses a natively aborted signal even when its aborted property is hidden", async () => {
		const controller = new AbortController();
		controller.abort();
		Object.defineProperty(controller.signal, "aborted", { value: false });
		const handler = vi.fn(() => null);
		const host = memoryHost(handler);
		try {
			await expect(
				host.request("host/kv.set", { key: "key", value: null }, { signal: controller.signal }),
			).rejects.toMatchObject({ code: "DENIED" });
			expect(handler).not.toHaveBeenCalled();
		} finally {
			host.close();
		}
	});

	it.each(["aborted", "addEventListener", "removeEventListener"] as const)(
		"does not invoke a caller's overridden %s property",
		async (property) => {
			const controller = new AbortController();
			const overridden = vi.fn(() => {
				throw new Error("Overridden signal property");
			});
			Object.defineProperty(controller.signal, property, { get: overridden });
			const host = memoryHost(() => null);
			try {
				await expect(
					host.request("host/kv.set", { key: "key", value: null }, { signal: controller.signal }),
				).resolves.toBeNull();
				expect(overridden).not.toHaveBeenCalled();
			} finally {
				host.close();
			}
		},
	);

	it("cancels through native signal state rather than a replaced subscription method", async () => {
		vi.useFakeTimers();
		const controller = new AbortController();
		const overridden = vi.fn();
		Object.defineProperty(controller.signal, "addEventListener", { value: overridden });
		let adapterSignal: AbortSignal | undefined;
		const host = memoryHost((_method, _params, signal) => {
			adapterSignal = signal;
			return new Promise(() => {});
		});
		try {
			const result = host
				.request("host/kv.get", { key: "key" }, { signal: controller.signal, timeoutMs: 100 })
				.catch((error: unknown) => error);
			await Promise.resolve();
			controller.abort();
			await vi.advanceTimersByTimeAsync(100);
			expect(await result).toMatchObject({ code: "DENIED" });
			expect(adapterSignal?.aborted).toBe(true);
			expect(overridden).not.toHaveBeenCalled();
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			host.close();
		}
	});

	it("reads the admitted signal once for registration and cleanup", async () => {
		const controller = new AbortController();
		const readSignal = vi.fn(() => controller.signal);
		const host = memoryHost(() => null);
		try {
			await expect(
				host.request(
					"host/kv.set",
					{ key: "key", value: null },
					{
						get signal() {
							return readSignal();
						},
					},
				),
			).resolves.toBeNull();
			expect(readSignal).toHaveBeenCalledTimes(1);
		} finally {
			host.close();
		}
	});

	it("does not use a replacement options signal when a pending request completes", async () => {
		const original = new AbortController();
		const replacement = new AbortController();
		const overridden = vi.fn(() => {
			throw new Error("Replacement signal cleanup");
		});
		Object.defineProperty(replacement.signal, "removeEventListener", { get: overridden });
		const options = { signal: original.signal };
		let finish: (() => void) | undefined;
		const host = memoryHost(
			() =>
				new Promise<null>((resolve) => {
					finish = () => resolve(null);
				}),
		);
		try {
			const request = host.request("host/kv.set", { key: "key", value: null }, options);
			await Promise.resolve();
			expect(finish).toBeTypeOf("function");
			options.signal = replacement.signal;
			finish?.();
			await expect(request).resolves.toBeNull();
			expect(overridden).not.toHaveBeenCalled();
		} finally {
			host.close();
		}
	});

	it.each([
		["null", null],
		["plain object", Object.prototype],
	] as const)(
		"refuses a re-prototyped signal with a %s prototype before dispatch",
		async (_, proto) => {
			const controller = new AbortController();
			Object.setPrototypeOf(controller.signal, proto);
			const handler = vi.fn(() => null);
			const host = memoryHost(handler);
			try {
				await expect(
					host.request("host/kv.set", { key: "key", value: null }, { signal: controller.signal }),
				).rejects.toMatchObject({ code: "BAD_REQUEST" });
				expect(handler).not.toHaveBeenCalled();
			} finally {
				host.close();
			}
		},
	);

	it("refuses non-signals with typed errors without consuming request capacity", async () => {
		const handler = vi.fn(() => null);
		const host = memoryHost(handler);
		try {
			const errors: unknown[] = [];
			for (let index = 0; index <= HOST_MAX_ACTIVE_REQUESTS; index++) {
				errors.push(
					await host
						.request("host/kv.set", { key: "key", value: null }, { signal: {} as AbortSignal })
						.catch((error: unknown) => error),
				);
			}
			expect(handler).not.toHaveBeenCalled();
			await expect(host.request("host/kv.set", { key: "key", value: null })).resolves.toBeNull();
			for (const error of errors) expect(error).toMatchObject({ code: "BAD_REQUEST" });
			expect(handler).toHaveBeenCalledTimes(1);
		} finally {
			host.close();
		}
	});

	it("cancels before dispatch and leaves capacity available to later requests", async () => {
		const controller = new AbortController();
		const handler = vi.fn(() => null);
		const host = memoryHost(handler);
		try {
			const request = host.request(
				"host/kv.set",
				{ key: "key", value: null },
				{ signal: controller.signal },
			);
			controller.abort();
			await expect(request).rejects.toMatchObject({ code: "DENIED" });
			expect(handler).not.toHaveBeenCalled();
			await expect(host.request("host/kv.set", { key: "key", value: null })).resolves.toBeNull();
			expect(handler).toHaveBeenCalledTimes(1);
		} finally {
			host.close();
		}
	});
});
