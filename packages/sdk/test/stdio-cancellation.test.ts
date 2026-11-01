import { PassThrough } from "node:stream";
import { HOST_MAX_ACTIVE_REQUESTS } from "@draftyak/protocol/host-channel";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostError } from "../src/host.ts";
import { stdioHost } from "../src/stdio.ts";

function emittedRequest(output: PassThrough): { id: string; method: string } {
	const frame = output.read() as Buffer | null;
	expect(frame).not.toBeNull();
	expect(frame?.[0]).toBe(0x1e);
	return JSON.parse(frame?.subarray(1).toString("utf8") ?? "") as {
		id: string;
		method: string;
	};
}

afterEach(() => {
	if (vi.isFakeTimers()) vi.clearAllTimers();
	vi.useRealTimers();
});

function fixture() {
	const input = new PassThrough();
	const output = new PassThrough();
	const host = stdioHost({ input, output });
	return { input, output, host };
}

async function withStdio(
	run: (channel: ReturnType<typeof fixture>) => Promise<void>,
): Promise<void> {
	const channel = fixture();
	try {
		await run(channel);
	} finally {
		try {
			channel.host.close();
		} finally {
			channel.input.destroy();
			channel.output.destroy();
		}
	}
}

function succeed(input: PassThrough, output: PassThrough): void {
	const { id } = emittedRequest(output);
	input.write(`\x1e${JSON.stringify({ jsonrpc: "2.0", id, result: null })}\n`);
}

describe("stdio request cancellation", () => {
	it("refuses native cancellation hidden by an own aborted property before writing", async () => {
		vi.useFakeTimers();
		await withStdio(async ({ host, output }) => {
			const controller = new AbortController();
			controller.abort();
			Object.defineProperty(controller.signal, "aborted", { value: false });
			const result = host
				.request("host/kv.set", { key: "key", value: null }, { signal: controller.signal })
				.catch((error: unknown) => error);
			expect(output.read()).toBeNull();
			expect(await result).toMatchObject({ code: "DENIED" });
		});
	});

	it.each(["aborted", "addEventListener", "removeEventListener"] as const)(
		"never invokes a caller's overridden %s property",
		async (property) => {
			vi.useFakeTimers();
			await withStdio(async ({ host, input, output }) => {
				const controller = new AbortController();
				const overridden = vi.fn(() => {
					throw new Error("Overridden signal property");
				});
				Object.defineProperty(controller.signal, property, { get: overridden });
				const request = host
					.request("host/kv.set", { key: "key", value: null }, { signal: controller.signal })
					.catch((error: unknown) => error);
				succeed(input, output);
				expect(await request).toBeNull();
				expect(overridden).not.toHaveBeenCalled();
			});
		},
	);

	it("cancels through native signal state when the caller replaces subscription", async () => {
		vi.useFakeTimers();
		await withStdio(async ({ host, input, output }) => {
			const controller = new AbortController();
			const overridden = vi.fn();
			Object.defineProperty(controller.signal, "addEventListener", { value: overridden });
			const result = host
				.request("host/kv.set", { key: "key", value: null }, { signal: controller.signal })
				.catch((error: unknown) => error);
			const { id } = emittedRequest(output);
			controller.abort();
			input.write(`\x1e${JSON.stringify({ jsonrpc: "2.0", id, result: null })}\n`);
			expect(await result).toMatchObject({ code: "DENIED" });
			expect(overridden).not.toHaveBeenCalled();
			expect(vi.getTimerCount()).toBe(0);
		});
	});

	it("reads the options signal once for registration and cleanup", async () => {
		await withStdio(async ({ host, input, output }) => {
			const controller = new AbortController();
			const readSignal = vi.fn(() => controller.signal);
			const request = host.request(
				"host/kv.set",
				{ key: "key", value: null },
				{
					get signal() {
						return readSignal();
					},
				},
			);
			succeed(input, output);
			await expect(request).resolves.toBeNull();
			expect(readSignal).toHaveBeenCalledTimes(1);
		});
	});

	it("keeps the admitted signal when the options signal is replaced before completion", async () => {
		await withStdio(async ({ host, input, output }) => {
			const original = new AbortController();
			const replacement = new AbortController();
			const overridden = vi.fn(() => {
				throw new Error("Replacement signal cleanup");
			});
			Object.defineProperty(replacement.signal, "removeEventListener", { get: overridden });
			const options = { signal: original.signal };
			const request = host.request("host/kv.set", { key: "key", value: null }, options);
			options.signal = replacement.signal;
			succeed(input, output);
			await expect(request).resolves.toBeNull();
			expect(overridden).not.toHaveBeenCalled();
		});
	});

	it.each(["non-signal", "null prototype", "plain object prototype"] as const)(
		"refuses repeated %s requests without frames, timers or capacity loss",
		async (kind) => {
			vi.useFakeTimers();
			await withStdio(async ({ host, input, output }) => {
				const errors: Promise<unknown>[] = [];
				for (let index = 0; index <= HOST_MAX_ACTIVE_REQUESTS; index++) {
					const signal = kind === "non-signal" ? ({} as AbortSignal) : new AbortController().signal;
					if (kind !== "non-signal")
						Object.setPrototypeOf(signal, kind === "null prototype" ? null : Object.prototype);
					errors.push(
						host
							.request("host/kv.set", { key: "key", value: null }, { signal })
							.catch((error: unknown) => error),
					);
				}
				expect(output.read()).toBeNull();
				expect(vi.getTimerCount()).toBe(0);
				const valid = host.request("host/kv.set", { key: "key", value: null });
				succeed(input, output);
				await expect(valid).resolves.toBeNull();
				for (const error of await Promise.all(errors))
					expect(error).toMatchObject({ code: "BAD_REQUEST" });
				expect(vi.getTimerCount()).toBe(0);
			});
		},
	);

	it("keeps a cancelled request denied after late success without closing another request", async () => {
		const input = new PassThrough();
		const output = new PassThrough();
		const host = stdioHost({ input, output });
		try {
			const controller = new AbortController();
			const cancelled = host
				.request("host/kv.get", { key: "cancelled" }, { signal: controller.signal })
				.then(
					() => "ACCEPTED",
					(error: HostError) => error.code,
				);
			const first = emittedRequest(output);
			const independent = host.request("host/kv.get", { key: "independent" });
			const second = emittedRequest(output);
			expect(first.method).toBe("host/kv.get");
			expect(second.method).toBe("host/kv.get");
			expect(second.id).not.toBe(first.id);

			controller.abort();
			input.write(
				`\x1e${JSON.stringify({ jsonrpc: "2.0", id: first.id, result: { value: "late" } })}\n` +
					`\x1e${JSON.stringify({ jsonrpc: "2.0", id: second.id, result: { value: "working" } })}\n`,
			);
			await expect(independent).resolves.toEqual({ value: "working" });
			await expect(cancelled).resolves.toBe("DENIED");
		} finally {
			host.close();
			input.destroy();
			output.destroy();
		}
	});
});
