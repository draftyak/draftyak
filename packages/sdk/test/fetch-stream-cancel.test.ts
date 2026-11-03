import { afterEach, expect, it, vi } from "vitest";
import { hostFetch } from "../src/fetch.ts";
import { memoryHost } from "../src/host.ts";

afterEach(() => {
	vi.clearAllTimers();
	vi.useRealTimers();
});

it.each(["default", "request"] as const)(
	"body cancellation aborts the owned request, releases its router and preserves the %s caller signal",
	async (source) => {
		vi.useFakeTimers();
		const caller = new AbortController();
		const streamId = "DYTEST-held-stream";
		const signals: AbortSignal[] = [];
		let subscriptions = 0;
		let unsubscribeCalls = 0;
		let notifications = 0;
		let abortEvents = 0;
		const host = memoryHost((method, params) => {
			expect(method).toBe("host/fetch");
			expect(params).toMatchObject({ url: "https://example.invalid/held", stream: true });
			return {
				status: 200,
				headers: [["content-type", "text/plain"]],
				streamId,
			};
		});
		const request = host.request;
		host.request = (method, params, options) => {
			if (!options?.signal) throw new Error("Expected an owned host request signal");
			signals.push(options.signal);
			options.signal.addEventListener("abort", () => abortEvents++);
			return request(method, params, options);
		};
		const subscribe = host.subscribe;
		host.subscribe = (listener, onclose) => {
			subscriptions++;
			const unsubscribe = subscribe((notification) => {
				notifications++;
				listener(notification);
			}, onclose);
			return () => {
				subscriptions--;
				unsubscribeCalls++;
				unsubscribe();
			};
		};
		try {
			const fetch = hostFetch(host, source === "default" ? caller.signal : undefined);
			const response = await fetch("https://example.invalid/held", {
				stream: true,
				...(source === "request" ? { signal: caller.signal } : {}),
			});
			expect(response.headers.get("content-type")).toBe("text/plain");
			expect(signals).toHaveLength(1);
			const signal = signals[0];
			if (!signal || !response.body) throw new Error("Expected a streaming host response");
			expect(signal.aborted).toBe(false);
			expect(subscriptions).toBe(1);
			expect(vi.getTimerCount()).toBe(1);
			const reader = response.body.getReader();
			host.notify({
				jsonrpc: "2.0",
				method: "host/stream.chunk",
				params: { streamId, sequence: 0, base64: "aGVsZA", done: false },
			});
			const first = await reader.read();
			expect(first.done).toBe(false);
			expect(new TextDecoder().decode(first.value)).toBe("held");
			reader.releaseLock();
			expect(signal.aborted).toBe(false);
			expect(notifications).toBe(1);
			await response.body.cancel();
			expect(signal.aborted, "body.cancel must abort the owned host request signal").toBe(true);
			expect(signal.reason).toMatchObject({ code: "DENIED" });
			expect(caller.signal.aborted).toBe(false);
			expect(abortEvents).toBe(1);
			expect(subscriptions).toBe(0);
			expect(unsubscribeCalls).toBe(1);
			expect(vi.getTimerCount()).toBe(0);
			host.notify({
				jsonrpc: "2.0",
				method: "host/stream.chunk",
				params: { streamId, sequence: 1, base64: "bGF0ZQ", done: true },
			});
			await response.body.cancel();
			expect(notifications).toBe(1);
			expect(abortEvents).toBe(1);
			expect(unsubscribeCalls).toBe(1);
		} finally {
			host.close();
		}
	},
);
