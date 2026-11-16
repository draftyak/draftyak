import { HOST_MAX_ACTIVE_REQUESTS } from "@draftyak/protocol/host-channel";
import { afterEach, expect, it, vi } from "vitest";
import { memoryHost } from "../src/host.ts";

afterEach(() => {
	vi.useRealTimers();
});

const params = { key: "key" };

/** Every handler ignores its cancellation signal until the test settles it. */
function ignoringHost() {
	const signals: AbortSignal[] = [];
	const settles: ((outcome: "resolve" | "reject") => void)[] = [];
	const host = memoryHost((_method, _params, signal) => {
		signals.push(signal);
		const held = Promise.withResolvers<null>();
		settles.push((outcome) =>
			outcome === "resolve" ? held.resolve(null) : held.reject(new Error("Synthetic failure")),
		);
		return held.promise;
	});
	return { host, signals, settles };
}

/** Records a request's outcome without waiting for a handler that may never settle. */
function attempt(host: ReturnType<typeof memoryHost>): { outcome: unknown } {
	const state: { outcome: unknown } = { outcome: "pending" };
	void host.request("host/kv.get", params).then(
		(value) => {
			state.outcome = value;
		},
		(error: unknown) => {
			state.outcome = error;
		},
	);
	return state;
}

async function drain(): Promise<void> {
	for (let turn = 0; turn < 20; turn++) await Promise.resolve();
}

it("keeps a cancelled request's capacity until a handler that ignores its signal settles", async () => {
	const { host, signals, settles } = ignoringHost();
	try {
		const controllers = Array.from(
			{ length: HOST_MAX_ACTIVE_REQUESTS },
			() => new AbortController(),
		);
		const requests = controllers.map((controller) =>
			host.request("host/kv.get", params, { signal: controller.signal }).catch((error) => error),
		);
		await drain();
		expect(signals).toHaveLength(HOST_MAX_ACTIVE_REQUESTS);
		for (const controller of controllers) controller.abort();
		for (const refused of await Promise.all(requests))
			expect(refused).toMatchObject({ code: "DENIED" });
		expect(signals.every((signal) => signal.aborted)).toBe(true);
		const over = attempt(host);
		await drain();
		expect(over.outcome).toMatchObject({ code: "TOO_LARGE" });
		expect(signals).toHaveLength(HOST_MAX_ACTIVE_REQUESTS);
		settles[0]?.("resolve");
		settles[1]?.("reject");
		await drain();
		const admitted = [attempt(host), attempt(host)];
		const refused = attempt(host);
		await drain();
		expect(signals).toHaveLength(HOST_MAX_ACTIVE_REQUESTS + 2);
		expect(admitted.map((state) => state.outcome)).toEqual(["pending", "pending"]);
		expect(refused.outcome).toMatchObject({ code: "TOO_LARGE" });
	} finally {
		host.close();
		for (const settle of settles) settle("resolve");
	}
});

it("keeps a timed-out request's capacity until its handler settles", async () => {
	vi.useFakeTimers();
	const { host, signals, settles } = ignoringHost();
	try {
		const requests = Array.from({ length: HOST_MAX_ACTIVE_REQUESTS }, () =>
			host.request("host/kv.get", params, { timeoutMs: 10 }).catch((error) => error),
		);
		await vi.advanceTimersByTimeAsync(10);
		for (const refused of await Promise.all(requests))
			expect(refused).toMatchObject({ code: "TIMEOUT" });
		expect(signals.every((signal) => signal.aborted)).toBe(true);
		expect(vi.getTimerCount()).toBe(0);
		const over = attempt(host);
		await drain();
		expect(over.outcome).toMatchObject({ code: "TOO_LARGE" });
		settles[15]?.("resolve");
		await drain();
		const admitted = attempt(host);
		await drain();
		expect(admitted.outcome).toBe("pending");
		expect(signals).toHaveLength(HOST_MAX_ACTIVE_REQUESTS + 1);
	} finally {
		host.close();
		for (const settle of settles) settle("resolve");
	}
});
