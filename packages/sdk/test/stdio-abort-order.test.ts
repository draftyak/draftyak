import { PassThrough } from "node:stream";
import { HOST_MAX_ACTIVE_REQUESTS } from "@draftyak/protocol/host-channel";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stdioHost } from "../src/stdio.ts";

afterEach(() => {
	vi.clearAllTimers();
	vi.useRealTimers();
});

function fixture() {
	vi.useFakeTimers();
	const input = new PassThrough();
	const output = new PassThrough();
	return { input, output, host: stdioHost({ input, output }) };
}

async function withChannel(run: (channel: ReturnType<typeof fixture>) => Promise<void>) {
	const channel = fixture();
	try {
		await run(channel);
	} finally {
		channel.host.close();
		channel.input.destroy();
		channel.output.destroy();
	}
}

function requestId(output: PassThrough): string {
	const frame = output.read() as Buffer | null;
	expect(frame?.[0]).toBe(0x1e);
	return (JSON.parse(frame?.subarray(1).toString("utf8") ?? "") as { id: string }).id;
}

function reply(input: PassThrough, id: string, outcome: "success" | "error" = "success") {
	const body =
		outcome === "success"
			? { result: null }
			: { error: { code: -32000, message: "Refused", data: { code: "TIMEOUT" } } };
	input.write(`\x1e${JSON.stringify({ jsonrpc: "2.0", id, ...body })}\n`);
}

async function useCapacity({ input, output, host }: ReturnType<typeof fixture>) {
	const requests: Promise<unknown>[] = [];
	const ids: string[] = [];
	for (let index = 0; index < HOST_MAX_ACTIVE_REQUESTS; index++) {
		requests.push(host.request("host/kv.set", { key: `key-${index}`, value: null }));
		ids.push(requestId(output));
	}
	for (const id of ids) reply(input, id);
	expect(await Promise.all(requests)).toEqual(Array(HOST_MAX_ACTIVE_REQUESTS).fill(null));
	expect(vi.getTimerCount()).toBe(0);
}

describe("stdio native cancellation order", () => {
	describe.each(["ordinary", "hidden", "throwing"] as const)("%s aborted property", (property) => {
		it.each(["success", "error"] as const)(
			"refuses the %s reply injected during source abort dispatch",
			async (outcome) => {
				await withChannel(async (channel) => {
					const { input, output, host } = channel;
					const controller = new AbortController();
					const overridden = vi.fn(() => {
						throw new Error("DYTEST-OVERRIDDEN-ABORTED");
					});
					if (property === "hidden")
						Object.defineProperty(controller.signal, "aborted", { value: false });
					else if (property === "throwing")
						Object.defineProperty(controller.signal, "aborted", { get: overridden });
					const options = { signal: controller.signal };
					let settlements = 0;
					const result = host.request("host/kv.set", { key: "key", value: null }, options).then(
						(value) => {
							settlements++;
							return value;
						},
						(error: unknown) => {
							settlements++;
							return error;
						},
					);
					const id = requestId(output);
					options.signal = new AbortController().signal;
					controller.signal.addEventListener("abort", () => reply(input, id, outcome), {
						once: true,
					});
					controller.abort();
					expect(await result).toMatchObject({ code: "DENIED" });
					reply(input, id);
					expect(settlements).toBe(1);
					expect(overridden).not.toHaveBeenCalled();
					expect(vi.getTimerCount()).toBe(0);
					await useCapacity(channel);
				});
			},
		);
	});

	it.each(["timeout", "params"] as const)(
		"refuses cancellation from a %s getter before allocating or writing",
		async (source) => {
			await withChannel(async (channel) => {
				const { output, host } = channel;
				for (let index = 0; index <= HOST_MAX_ACTIVE_REQUESTS; index++) {
					const controller = new AbortController();
					const options = {
						signal: controller.signal,
						get timeoutMs() {
							if (source === "timeout") controller.abort();
							return 100;
						},
					};
					const params = {
						get key() {
							if (source === "params") controller.abort();
							return "key";
						},
						value: null,
					};
					const result = host
						.request("host/kv.set", params, options)
						.catch((error: unknown) => error);
					expect(output.read()).toBeNull();
					expect(vi.getTimerCount()).toBe(0);
					expect(await result).toMatchObject({ code: "DENIED" });
				}
				await useCapacity(channel);
			});
		},
	);

	it("normalizes a throwing timeout getter before allocating or writing", async () => {
		await withChannel(async (channel) => {
			const { output, host } = channel;
			const result = host
				.request(
					"host/kv.set",
					{ key: "key", value: null },
					{
						get timeoutMs(): number {
							throw new Error("DYTEST-PRIVATE-TIMEOUT-GETTER");
						},
					},
				)
				.catch((error: unknown) => error);
			expect(await result).toMatchObject({ code: "BAD_REQUEST" });
			expect(String(await result)).not.toContain("DYTEST-PRIVATE-TIMEOUT-GETTER");
			expect(output.read()).toBeNull();
			expect(vi.getTimerCount()).toBe(0);
			await useCapacity(channel);
		});
	});

	it.each(["success", "error"] as const)(
		"keeps the %s reply that arrives before native cancellation",
		async (outcome) => {
			await withChannel(async (channel) => {
				const { input, output, host } = channel;
				const controller = new AbortController();
				const result = host
					.request("host/kv.set", { key: "key", value: null }, { signal: controller.signal })
					.catch((error: unknown) => error);
				reply(input, requestId(output), outcome);
				controller.abort();
				if (outcome === "success") expect(await result).toBeNull();
				else expect(await result).toMatchObject({ code: "TIMEOUT" });
				expect(vi.getTimerCount()).toBe(0);
				await useCapacity(channel);
			});
		},
	);

	it("retains the timeout outcome and ignores its late reply", async () => {
		await withChannel(async (channel) => {
			const { input, output, host } = channel;
			const result = host
				.request("host/kv.set", { key: "key", value: null }, { timeoutMs: 100 })
				.catch((error: unknown) => error);
			const id = requestId(output);
			await vi.advanceTimersByTimeAsync(100);
			expect(await result).toMatchObject({ code: "TIMEOUT" });
			reply(input, id);
			expect(vi.getTimerCount()).toBe(0);
			await useCapacity(channel);
		});
	});
});
