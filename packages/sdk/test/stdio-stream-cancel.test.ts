import { PassThrough, Writable } from "node:stream";
import { HOST_MAX_ACTIVE_REQUESTS, HOST_MAX_FRAME_BYTES } from "@draftyak/protocol/host-channel";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { hostFetch } from "../src/fetch.ts";
import { stdioHost } from "../src/stdio.ts";

const hosts: ReturnType<typeof stdioHost>[] = [];
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
	for (const host of hosts.splice(0)) host.close();
	vi.useRealTimers();
});
const fetchParams = { method: "GET" as const, url: "https://stream.invalid/", headers: [] };
function fixture(output?: Writable) {
	const input = new PassThrough();
	const frames: Record<string, unknown>[] = [];
	const target =
		output ??
		new Writable({
			write(chunk, _encoding, callback) {
				frames.push(JSON.parse(chunk.toString().slice(1)));
				callback();
			},
		});
	const errors: Error[] = [];
	const host = stdioHost({ input, output: target, onerror: (error) => errors.push(error) });
	hosts.push(host);
	const send = (message: unknown): void => {
		input.write(`\x1e${JSON.stringify(message)}\n`);
	};
	const header = (id: unknown, streamId: string): void =>
		send({ jsonrpc: "2.0", id, result: { status: 200, headers: [], streamId } });
	const chunk = (streamId: string, done = false): void =>
		send({
			jsonrpc: "2.0",
			method: "host/stream.chunk",
			params: { streamId, sequence: 0, base64: "YQ", done },
		});
	return { host, frames, errors, send, header, chunk };
}
it("cancels one dispatched pending request once and ignores its late header", async () => {
	const f = fixture();
	const controller = new AbortController();
	const request = f.host.request("host/fetch", fetchParams, { signal: controller.signal });
	const refused = expect(request).rejects.toMatchObject({ code: "DENIED" });
	const id = f.frames[0]?.id;
	controller.abort();
	controller.abort();
	await refused;
	expect(f.frames.slice(1)).toEqual([
		{ jsonrpc: "2.0", method: "host/cancel", params: { requestId: id } },
	]);
	f.header(id, "late");
	expect(vi.getTimerCount()).toBe(0);
	expect(f.errors).toEqual([]);
});
it("keeps the original signal through a streamed header without fabricating a terminal notification", async () => {
	const f = fixture();
	const controller = new AbortController();
	const notifications: unknown[] = [];
	f.host.subscribe((notification) => notifications.push(notification));
	const request = f.host.request("host/fetch", fetchParams, { signal: controller.signal });
	const id = f.frames[0]?.id;
	f.header(id, "held");
	await request;
	controller.abort();
	expect(f.frames.at(-1)).toEqual({
		jsonrpc: "2.0",
		method: "host/cancel",
		params: { requestId: id },
	});
	expect(notifications).toEqual([]);
	expect(vi.getTimerCount()).toBe(0);
});
it("propagates real Response.body.cancel after a held chunk without aborting the caller controller", async () => {
	const f = fixture();
	const controller = new AbortController();
	const getting = hostFetch(f.host)(fetchParams.url, { signal: controller.signal });
	await vi.advanceTimersByTimeAsync(0);
	const id = f.frames[0]?.id;
	f.header(id, "body");
	const response = await getting;
	f.chunk("body");
	if (!response.body) throw new Error("Expected a streamed body");
	const reader = response.body.getReader();
	const chunk = await reader.read();
	expect(chunk.done).toBe(false);
	expect(Array.from(chunk.value ?? [])).toEqual([97]);
	await reader.cancel();
	expect(controller.signal.aborted).toBe(false);
	expect(f.frames.slice(1)).toEqual([
		{ jsonrpc: "2.0", method: "host/cancel", params: { requestId: id } },
	]);
	expect(vi.getTimerCount()).toBe(0);
});
it("keeps the original deadline instead of restarting it at the streamed header", async () => {
	const f = fixture();
	const request = f.host.request("host/fetch", fetchParams, { timeoutMs: 10 });
	await vi.advanceTimersByTimeAsync(6);
	f.header(f.frames[0]?.id, "deadline");
	await request;
	await vi.advanceTimersByTimeAsync(4);
	expect(f.frames.at(-1)?.method).toBe("host/cancel");
	expect(vi.getTimerCount()).toBe(0);
});
it("times out the response body at the request deadline after a delayed stdio header", async () => {
	const f = fixture();
	const getting = hostFetch(f.host)(fetchParams.url);
	await vi.advanceTimersByTimeAsync(0);
	await vi.advanceTimersByTimeAsync(20_000);
	f.header(f.frames[0]?.id, "delayed");
	const response = await getting;
	const body = expect(response.text()).rejects.toMatchObject({ code: "TIMEOUT" });
	await vi.advanceTimersByTimeAsync(9_999);
	expect(f.frames.filter((frame) => frame.method === "host/cancel")).toHaveLength(0);
	await vi.advanceTimersByTimeAsync(1);
	await body;
	expect(f.frames.filter((frame) => frame.method === "host/cancel")).toHaveLength(1);
	expect(vi.getTimerCount()).toBe(0);
});
it("counts established streams among the sixteen active requests and releases only the cancelled one", async () => {
	const f = fixture();
	const controllers = Array.from({ length: 16 }, () => new AbortController());
	for (const [i, controller] of controllers.entries()) {
		const request = f.host.request("host/fetch", fetchParams, { signal: controller.signal });
		f.header(f.frames.at(-1)?.id, `stream-${i}`);
		await request;
	}
	await expect(f.host.request("host/fetch", fetchParams)).rejects.toMatchObject({
		code: "TOO_LARGE",
	});
	controllers[3]?.abort();
	const next = f.host.request("host/fetch", fetchParams);
	f.header(f.frames.at(-1)?.id, "replacement");
	await next;
	expect(f.frames.filter((frame) => frame.method === "host/cancel")).toHaveLength(1);
	expect(vi.getTimerCount()).toBe(16);
});
it("admits sixteen early terminal IDs, retires their later headers, and emits no cancellation", async () => {
	const f = fixture();
	const requests = Array.from({ length: 16 }, () => f.host.request("host/fetch", fetchParams));
	const ids = f.frames.map((frame) => frame.id);
	for (let i = 0; i < 16; i++) f.chunk(`early-${i}`, true);
	for (let i = 0; i < 16; i++) f.header(ids[i], `early-${i}`);
	await Promise.all(requests);
	expect(vi.getTimerCount()).toBe(0);
	expect(f.frames).toHaveLength(16);
});
it("retires a natural terminal stream without later canceling it", async () => {
	const f = fixture();
	const controller = new AbortController();
	const request = f.host.request("host/fetch", fetchParams, { signal: controller.signal });
	f.header(f.frames[0]?.id, "complete");
	await request;
	f.chunk("complete", true);
	controller.abort();
	expect(f.frames).toHaveLength(1);
	expect(vi.getTimerCount()).toBe(0);
});
it("refuses cancellation in the parent-to-child direction", async () => {
	const f = fixture();
	f.send({ jsonrpc: "2.0", method: "host/cancel", params: { requestId: "unknown" } });
	expect(f.errors).toHaveLength(1);
	await expect(f.host.request("host/fetch", fetchParams)).rejects.toMatchObject({ code: "DENIED" });
});
it("rechecks capacity after a reentrant timeout getter", async () => {
	const f = fixture();
	const nested: Promise<unknown>[] = [];
	const outer = f.host.request("host/fetch", fetchParams, {
		get timeoutMs() {
			for (let i = 0; i < 16; i++)
				nested.push(f.host.request("host/fetch", fetchParams).catch(() => {}));
			return 100;
		},
	});
	await expect(outer).rejects.toMatchObject({ code: "TOO_LARGE" });
	expect(f.frames).toHaveLength(16);
	f.host.close();
	await Promise.all(nested);
});
it("rechecks closure after a params getter without dispatching a request", async () => {
	const f = fixture();
	await expect(
		f.host.request("host/fetch", {
			...fetchParams,
			get url() {
				f.host.close();
				return fetchParams.url;
			},
		}),
	).rejects.toMatchObject({ code: "DENIED" });
	expect(f.frames).toEqual([]);
});
it("refuses an unsent oversized request alone, without a cancellation or channel failure", async () => {
	const f = fixture();
	// The params fit the copy bound exactly; the tagged request envelope does not fit a frame.
	const value = "x".repeat(HOST_MAX_FRAME_BYTES - '{"key":"key","value":""}'.length);
	await expect(f.host.request("host/kv.set", { key: "key", value })).rejects.toMatchObject({
		code: "DENIED",
	});
	expect(f.frames).toEqual([]);
	expect(f.errors).toEqual([]);
	expect(vi.getTimerCount()).toBe(0);
	const next = f.host.request("host/kv.get", { key: "key" });
	f.send({ jsonrpc: "2.0", id: f.frames[0]?.id, result: { value: null } });
	await expect(next).resolves.toEqual({ value: null });
});
it("sends no cancellation when a request refused before writing is aborted in the same tick", async () => {
	const written: string[] = [];
	const output = new Writable();
	// Write callbacks never run, so every ordinary write stays in flight.
	output.write = ((chunk: string) => {
		written.push(chunk);
		return true;
	}) as unknown as Writable["write"];
	const f = fixture(output);
	const value = "x".repeat(HOST_MAX_FRAME_BYTES - '{"key":"key","value":""}'.length);
	const oversized = new AbortController();
	const tooLarge = f.host.request(
		"host/kv.set",
		{ key: "key", value },
		{ signal: oversized.signal },
	);
	oversized.abort();
	await expect(tooLarge).rejects.toMatchObject({ code: "DENIED" });
	expect(written).toEqual([]);
	for (let index = 0; index < HOST_MAX_ACTIVE_REQUESTS * 2; index++)
		void f.host.transport.send({ jsonrpc: "2.0", id: index, method: "ping" });
	const budget = new AbortController();
	const refused = f.host.request("host/kv.get", { key: "key" }, { signal: budget.signal });
	budget.abort();
	await expect(refused).rejects.toMatchObject({ code: "DENIED" });
	expect(written).toHaveLength(HOST_MAX_ACTIVE_REQUESTS * 2);
	expect(f.errors).toEqual([]);
	expect(vi.getTimerCount()).toBe(0);
});
it("fails the channel closed when a second header reuses a live stream ID", async () => {
	const f = fixture();
	const first = f.host.request("host/fetch", fetchParams);
	const second = f.host.request("host/fetch", fetchParams);
	const refused = expect(second).rejects.toMatchObject({ code: "BAD_REQUEST" });
	f.header(f.frames[0]?.id, "shared");
	await first;
	f.header(f.frames[1]?.id, "shared");
	await refused;
	expect(f.errors).toHaveLength(1);
	await expect(f.host.request("host/fetch", fetchParams)).rejects.toMatchObject({ code: "DENIED" });
	expect(f.frames).toHaveLength(2);
	expect(vi.getTimerCount()).toBe(0);
});
it("sends a cancellation while ordinary writes fill the shared write budget", async () => {
	const written: string[] = [];
	const output = new Writable();
	// Write callbacks never run, so every ordinary write stays in flight.
	output.write = ((chunk: string) => {
		written.push(chunk);
		return true;
	}) as unknown as Writable["write"];
	const f = fixture(output);
	const controller = new AbortController();
	const refused = expect(
		f.host.request("host/kv.get", { key: "key" }, { signal: controller.signal }),
	).rejects.toMatchObject({ code: "DENIED" });
	const id = (JSON.parse(written[0]?.slice(1) ?? "") as { id: string }).id;
	for (let index = 1; index < HOST_MAX_ACTIVE_REQUESTS * 2; index++)
		void f.host.transport.send({ jsonrpc: "2.0", id: index, method: "ping" });
	await expect(
		f.host.transport.send({ jsonrpc: "2.0", id: 0, method: "ping" }),
	).rejects.toMatchObject({ code: "DENIED" });
	controller.abort();
	await refused;
	expect(written).toHaveLength(HOST_MAX_ACTIVE_REQUESTS * 2 + 1);
	expect(JSON.parse(written.at(-1)?.slice(1) ?? "")).toEqual({
		jsonrpc: "2.0",
		method: "host/cancel",
		params: { requestId: id },
	});
	expect(f.errors).toEqual([]);
});
it("leaves early terminal exhaustion to the stream router and keeps the channel open", async () => {
	const f = fixture();
	const getting = hostFetch(f.host)(fetchParams.url).catch((error: unknown) => error);
	await vi.advanceTimersByTimeAsync(0);
	const id = f.frames[0]?.id;
	for (let index = 0; index <= HOST_MAX_ACTIVE_REQUESTS; index++) f.chunk(`stale-${index}`, true);
	expect(await getting).toMatchObject({ code: "TOO_LARGE" });
	expect(f.errors).toEqual([]);
	expect(f.frames.slice(1)).toEqual([
		{ jsonrpc: "2.0", method: "host/cancel", params: { requestId: id } },
	]);
	const next = f.host.request("host/kv.get", { key: "key" });
	f.send({ jsonrpc: "2.0", id: f.frames.at(-1)?.id, result: { value: null } });
	await expect(next).resolves.toEqual({ value: null });
});
it("records at most sixteen early terminal IDs, so a later header keeps its stream open", async () => {
	const f = fixture();
	const request = f.host.request("host/fetch", fetchParams);
	for (let index = 0; index <= HOST_MAX_ACTIVE_REQUESTS; index++) f.chunk(`early-${index}`, true);
	f.header(f.frames[0]?.id, `early-${HOST_MAX_ACTIVE_REQUESTS}`);
	await request;
	expect(vi.getTimerCount()).toBe(1);
	expect(f.errors).toEqual([]);
	expect(f.frames).toHaveLength(1);
});
it("does not deliver a positive chunk injected by an earlier original-abort listener", async () => {
	const f = fixture();
	const controller = new AbortController();
	const notifications: unknown[] = [];
	controller.signal.addEventListener("abort", () => f.chunk("raced", true));
	f.host.subscribe((notification) => notifications.push(notification));
	const request = f.host.request("host/fetch", fetchParams, { signal: controller.signal });
	f.header(f.frames[0]?.id, "raced");
	await request;
	controller.abort();
	expect(notifications).toEqual([]);
	expect(f.frames.filter((frame) => frame.method === "host/cancel")).toHaveLength(1);
});
