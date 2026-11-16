// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { createUnavailableSpaPlatform } from "../../src/platform/spa-platform.ts";

afterEach(() => vi.restoreAllMocks());

describe("unavailable browser platform", () => {
	it("refuses a read without forwarding it to browser fetch", async () => {
		const fetch = vi
			.spyOn(globalThis, "fetch")
			.mockRejectedValue(new Error("DYTEST unexpected network"));
		const platform = createUnavailableSpaPlatform();
		await expect(
			platform.fetch(new Request("https://hub.example.test/device/v1/accounts")),
		).rejects.toThrow("HUB_UNAVAILABLE");
		expect(fetch).not.toHaveBeenCalled();
		expect(Object.isFrozen(platform)).toBe(true);
		await platform.close();
	});

	it.each(["POST", "PUT", "PATCH", "DELETE"])(
		"refuses forged %s calls without a network effect",
		async (method) => {
			const fetch = vi
				.spyOn(globalThis, "fetch")
				.mockRejectedValue(new Error("DYTEST unexpected network"));
			const platform = createUnavailableSpaPlatform();
			await expect(
				platform.fetch(
					new Request("https://hub.example.test/device/v1/approve", {
						method,
						body: "DYTEST synthetic untrusted request",
					}),
				),
			).rejects.toThrow("HUB_UNAVAILABLE");
			expect(fetch).not.toHaveBeenCalled();
			await platform.close();
		},
	);

	it("refuses event subscriptions without callbacks or network effects", async () => {
		const fetch = vi
			.spyOn(globalThis, "fetch")
			.mockRejectedValue(new Error("DYTEST unexpected network"));
		const receive = vi.fn();
		const platform = createUnavailableSpaPlatform();
		await expect(
			platform.events({ after: null }, new AbortController().signal, receive),
		).rejects.toThrow("HUB_UNAVAILABLE");
		expect(receive).not.toHaveBeenCalled();
		expect(fetch).not.toHaveBeenCalled();
		await platform.close();
	});

	it("keeps one completed close and refuses later requests", async () => {
		const platform = createUnavailableSpaPlatform();
		const closing = platform.close();
		expect(platform.close()).toBe(closing);
		await closing;
		await expect(
			platform.fetch(new Request("https://hub.example.test/device/v1/accounts")),
		).rejects.toThrow("HUB_UNAVAILABLE");
		await expect(
			platform.events({ after: "DYTEST-cursor" }, new AbortController().signal, vi.fn()),
		).rejects.toThrow("HUB_UNAVAILABLE");
		expect(platform.close()).toBe(closing);
	});
});
