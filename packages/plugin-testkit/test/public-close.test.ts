import { beforeEach, expect, it, vi } from "vitest";
import { createMockHub, MockHubError } from "../src/index.ts";
import { channelFixture } from "./fixtures/channel/plugin.ts";

const backend = vi.hoisted(() => ({
	close: vi.fn<() => Promise<void>>(),
	request: vi.fn(async () => ({})),
}));
vi.mock("../src/process.ts", async (original) => ({
	...(await original<typeof import("../src/process.ts")>()),
	createProcess: vi.fn(() => backend),
}));

beforeEach(() => {
	backend.close.mockReset();
	backend.request.mockClear();
});
const hubFor = () => createMockHub({ mode: "process", plugin: channelFixture(), upstreams: [] });
const outcome = (promise: Promise<void>) =>
	promise.then(
		() => ({ fulfilled: true as const }),
		(error: unknown) => ({ fulfilled: false as const, error }),
	);

it("keeps concurrent public closes pending until the single backend cleanup settles", async () => {
	const release = Promise.withResolvers<void>();
	backend.close.mockReturnValue(release.promise);
	const hub = hubFor();
	const first = hub.close();
	const second = hub.close();
	let firstSettled = false;
	let secondSettled = false;
	const observedFirst = first.then(() => {
		firstSettled = true;
	});
	const observedSecond = second.then(() => {
		secondSettled = true;
	});
	try {
		await expect(hub.discover()).rejects.toMatchObject({ code: "HOST_CLOSED" });
		await Promise.resolve();
		expect(firstSettled).toBe(false);
		expect(secondSettled).toBe(false);
		expect(backend.close).toHaveBeenCalledTimes(1);
	} finally {
		release.resolve();
		await Promise.all([observedFirst, observedSecond]);
	}
	expect(firstSettled).toBe(true);
	expect(secondSettled).toBe(true);
});

it("retains the same failed cleanup for concurrent, later and reentrant public closes", async () => {
	for (const mode of ["reject", "throw", "host-reentrant", "backend-reentrant"] as const) {
		backend.close.mockReset();
		const release = Promise.withResolvers<void>();
		const failure = new MockHubError("PROCESS_CLEANUP_FAILED");
		let reentrant: Promise<void> | undefined;
		const hub = hubFor();
		if (mode === "host-reentrant")
			hub.host.subscribe(
				() => {},
				() => {
					reentrant = hub.close();
				},
			);
		backend.close.mockImplementation(() => {
			if (mode === "backend-reentrant") reentrant = hub.close();
			if (mode === "throw") throw failure;
			return release.promise;
		});
		const first = outcome(hub.close());
		const second = outcome(hub.close());
		if (mode === "host-reentrant" || mode === "backend-reentrant") expect(reentrant).toBeDefined();
		const nested = reentrant === undefined ? undefined : outcome(reentrant);
		if (mode !== "throw") release.reject(failure);
		try {
			const firstResult = await first;
			expect(firstResult).toEqual({ fulfilled: false, error: failure });
			const results = await Promise.all([
				second,
				outcome(hub.close()),
				...(nested === undefined ? [] : [nested]),
			]);
			for (const result of results) {
				expect(result).toEqual({ fulfilled: false, error: failure });
				if (!result.fulfilled) expect(result.error).toBe(failure);
			}
			expect(backend.close).toHaveBeenCalledTimes(1);
		} finally {
			release.resolve();
			await first;
			await second;
			await nested;
		}
	}
});

it("closes the host immediately and preserves successful idempotent cleanup", async () => {
	const release = Promise.withResolvers<void>();
	backend.close.mockReturnValue(release.promise);
	const hub = hubFor();
	let hostClosed = false;
	hub.host.subscribe(
		() => {},
		() => {
			hostClosed = true;
		},
	);
	const first = hub.close();
	expect(hostClosed).toBe(true);
	await expect(hub.discover()).rejects.toMatchObject({ code: "HOST_CLOSED" });
	await expect(hub.listTools()).rejects.toMatchObject({ code: "HOST_CLOSED" });
	await expect(hub.call("channel_fetch", {})).rejects.toMatchObject({ code: "HOST_CLOSED" });
	expect(backend.request).not.toHaveBeenCalled();
	release.resolve();
	await first;
	await hub.close();
	await hub.close();
	expect(backend.close).toHaveBeenCalledTimes(1);
});
