import { PassThrough } from "node:stream";
import { HostCancel, type HostMethod } from "@draftyak/protocol/host-channel";
import { hostFetch } from "@draftyak/sdk/fetch";
import { stdioHost } from "@draftyak/sdk/stdio";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Endpoint, type PluginHostRequestContext } from "../../src/plugins/supervisor/channel.ts";
import {
	decodeLine,
	encodeFrame,
	type Frame,
	FrameDecoder,
} from "../../src/plugins/supervisor/frames.ts";
import type { ViolationKind } from "../../src/plugins/supervisor/policy.ts";
import type { PluginProcess } from "../../src/plugins/supervisor/process.ts";
import { FakeClock } from "../kernel/fake-clock.ts";

const fetchParams = { method: "GET" as const, url: "https://dytest.invalid/", headers: [] };
const fetched = { status: 200, headers: [], body: { base64: "" } };
const fixtures: { dispose(): void }[] = [];
const outcome = (promise: Promise<unknown>): Promise<unknown> =>
	promise.catch((error: unknown) => error);
const flush = async (): Promise<void> => {
	await vi.advanceTimersByTimeAsync(0);
};

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
	for (const fixture of fixtures.splice(0)) fixture.dispose();
	vi.clearAllTimers();
	vi.useRealTimers();
});

interface Call {
	readonly method: HostMethod;
	readonly params: unknown;
	readonly context: PluginHostRequestContext;
	readonly result: PromiseWithResolvers<unknown>;
}
interface Write {
	readonly line: string;
	complete(): void;
	fail(): void;
}

/** Endpoint-only IO controls; native pipe backpressure and process cleanup have separate tests. */
function fixture() {
	const input = new PassThrough();
	const output = new PassThrough();
	const errors: Error[] = [];
	const sdk = stdioHost({ input, output, onerror: (error) => errors.push(error) });
	const calls: Call[] = [];
	const writes: Write[] = [];
	const violations: ViolationKind[] = [];
	const received: Frame[] = [];
	const clock = new FakeClock();
	const authority = new AbortController();
	let invocation: unknown = Object.freeze({ tag: "original" });
	let holding = false;
	let ending = false;
	const write = (line: string, signal: AbortSignal): Promise<void> => {
		if (ending || signal.aborted) return Promise.reject(new Error("Write ended"));
		const completion = Promise.withResolvers<void>();
		let settled = false;
		const entry: Write = {
			line,
			complete() {
				if (settled) return;
				settled = true;
				input.write(line);
				completion.resolve();
			},
			fail() {
				if (settled) return;
				settled = true;
				completion.reject(new Error("Write ended"));
			},
		};
		writes.push(entry);
		if (!holding) entry.complete();
		return completion.promise;
	};
	const process = {
		get ending() {
			return ending;
		},
		tryWrite: (line: string) => write(line, authority.signal),
		writeWhenFree: write,
		violate(kind: ViolationKind) {
			violations.push(kind);
			ending = true;
		},
	};
	const binding = vi.fn(() => ({ invocation, signal: authority.signal }));
	const dispatch = vi.fn(
		(method: HostMethod, params: unknown, context: PluginHostRequestContext) => {
			const result = Promise.withResolvers<unknown>();
			calls.push({ method, params, context, result });
			return result.promise;
		},
	);
	const endpoint = new Endpoint(process as unknown as PluginProcess, {
		pluginId: "dytest-plugin",
		instanceId: "instance",
		generation: "generation",
		kind: "channel",
		clock,
		binding,
		dispatch,
	});
	const decoder = new FrameDecoder();
	const receive = (bytes: Uint8Array): void => {
		const violation = decoder.push(bytes, (frame) => {
			received.push(frame);
			return endpoint.frame(frame);
		});
		if (violation !== undefined) process.violate(violation);
	};
	output.on("data", receive);
	const send = (value: unknown): void => receive(Buffer.from(encodeFrame(value, true)));
	const request = (id: string, stream = false): void =>
		send({ jsonrpc: "2.0", id, method: "host/fetch", params: { ...fetchParams, stream } });
	const cancel = (id: string): void =>
		send({ jsonrpc: "2.0", method: "host/cancel", params: { requestId: id } });
	const result = {
		sdk,
		endpoint,
		decoder,
		calls,
		writes,
		violations,
		received,
		errors,
		clock,
		authority,
		binding,
		send,
		request,
		cancel,
		holdWrites() {
			holding = true;
		},
		setInvocation(value: unknown) {
			invocation = value;
		},
		dispose() {
			endpoint.close();
			ending = true;
			for (const entry of writes) entry.fail();
			sdk.close();
			input.destroy();
			output.destroy();
		},
	};
	fixtures.push(result);
	return result;
}

describe("host cancellation decoding", () => {
	it("accepts only the strict child cancellation envelope at every byte split", () => {
		const message = { jsonrpc: "2.0", method: "host/cancel", params: { requestId: "original" } };
		expect(HostCancel.safeParse(message).success).toBe(true);
		const bytes = Buffer.from(encodeFrame(message, true));
		for (let offset = 0; offset <= bytes.length; offset++) {
			const decoder = new FrameDecoder();
			const seen: Frame[] = [];
			const accept = (frame: Frame): boolean => {
				seen.push(frame);
				return true;
			};
			expect(decoder.push(bytes.subarray(0, offset), accept)).toBeUndefined();
			expect(decoder.push(bytes.subarray(offset), accept)).toBeUndefined();
			expect(decoder.finish()).toBeUndefined();
			expect(seen).toEqual([{ channel: "host-cancel", requestId: "original" }]);
		}
	});

	it.each([
		{ jsonrpc: "2.0", id: "rpc", method: "host/cancel", params: { requestId: "original" } },
		{ jsonrpc: "2.0", method: "host/cancel", params: { requestId: "original", reason: "abort" } },
		{ jsonrpc: "2.0", method: "host/cancel", params: { requestId: "" } },
		{ jsonrpc: "2.0", method: "host/cancel", params: { requestId: 1 } },
		{ jsonrpc: "2.0", method: "host/cancel", params: { requestId: "x".repeat(129) } },
	])("refuses a malformed cancellation without broadening the host envelope", (message) => {
		expect(HostCancel.safeParse(message).success).toBe(false);
		expect(decodeLine(Buffer.from(encodeFrame(message, true).trimEnd()))).toBe("bad-host-frame");
	});

	it("still rejects child host replies and parent-to-child stream notifications", () => {
		for (const message of [
			{ jsonrpc: "2.0", id: "original", result: null },
			{
				jsonrpc: "2.0",
				method: "host/stream.chunk",
				params: { streamId: "s", sequence: 0, base64: "", done: true },
			},
		])
			expect(decodeLine(Buffer.from(encodeFrame(message, true).trimEnd()))).toBe(
				"unexpected-frame",
			);
	});
});

describe("original host work cancellation", () => {
	it("accepts the actual SDK pending-fetch abort without dispatching or rebinding cancellation", async () => {
		const f = fixture();
		const controller = new AbortController();
		const first = outcome(f.sdk.request("host/fetch", fetchParams, { signal: controller.signal }));
		void outcome(f.sdk.request("host/fetch", fetchParams));
		await flush();
		const original = f.calls[0] as Call;
		const sibling = f.calls[1] as Call;
		const invocation = original.context.invocation;
		controller.abort();
		expect(await first).toMatchObject({ code: "DENIED" });
		await flush();
		expect(original.context.signal.aborted).toBe(true);
		expect(sibling.context.signal.aborted).toBe(false);
		expect(f.authority.signal.aborted).toBe(false);
		expect(original.context.invocation).toBe(invocation);
		expect(f.binding).toHaveBeenCalledTimes(2);
		expect(f.calls).toHaveLength(2);
		expect(f.writes).toHaveLength(0);
		expect(f.violations).toEqual([]);
		expect(f.decoder.stopped).toBe(false);
		original.result.resolve(fetched);
		await flush();
		expect(f.writes).toHaveLength(0);
		expect(f.errors).toEqual([]);
	});

	it("accepts the actual SDK timeout cancellation and removes the original parent timer", async () => {
		const f = fixture();
		const pending = outcome(f.sdk.request("host/fetch", fetchParams, { timeoutMs: 10 }));
		await flush();
		await vi.advanceTimersByTimeAsync(10);
		expect(await pending).toMatchObject({ code: "TIMEOUT" });
		expect(f.calls[0]?.context.signal.aborted).toBe(true);
		expect(f.clock.pending()).toHaveLength(0);
		expect(f.binding).toHaveBeenCalledTimes(1);
		expect(f.writes).toHaveLength(0);
		expect(f.violations).toEqual([]);
	});

	it("ends only the original stream when an actual SDK Response body is cancelled after headers", async () => {
		const f = fixture();
		const getting = hostFetch(f.sdk)(fetchParams.url, { stream: true });
		await flush();
		const original = f.calls[0] as Call;
		original.result.resolve({ status: 200, headers: [], streamId: "stream" });
		const response = await getting;
		await original.context.replyWritten;
		expect(original.context.signal.aborted).toBe(false);
		if (!response.body) throw new Error("Expected streamed response");
		await response.body.cancel();
		await flush();
		expect(original.context.signal.aborted).toBe(true);
		expect(f.authority.signal.aborted).toBe(false);
		expect(f.binding).toHaveBeenCalledTimes(1);
		expect(f.writes).toHaveLength(1);
		expect(f.violations).toEqual([]);
		await expect(
			original.context.notify({
				jsonrpc: "2.0",
				method: "host/stream.chunk",
				params: { streamId: "stream", sequence: 0, base64: "", done: true },
			}),
		).rejects.toMatchObject({ code: "HOST_CONTEXT_ENDED" });
	});

	it("cancels a same-read request before its queued handler starts, with no acknowledgement", async () => {
		const f = fixture();
		f.request("before-dispatch");
		f.cancel("before-dispatch");
		await flush();
		expect(f.calls).toHaveLength(0);
		expect(f.binding).toHaveBeenCalledTimes(1);
		expect(f.clock.pending()).toHaveLength(0);
		expect(f.writes).toHaveLength(0);
		expect(f.violations).toEqual([]);
	});

	it("ends a silent child's stream at the original parent deadline after delayed headers", async () => {
		const f = fixture();
		f.request("silent", true);
		await flush();
		const original = f.calls[0] as Call;
		f.clock.advance(20_000);
		await flush();
		original.result.resolve({ status: 200, headers: [], streamId: "stream" });
		await flush();
		f.clock.advance(9_999);
		await flush();
		expect(original.context.signal.aborted).toBe(false);
		f.clock.advance(1);
		await flush();
		expect(original.context.signal.aborted).toBe(true);
		expect(f.received).toHaveLength(1);
		expect(f.writes).toHaveLength(1);
		expect(f.clock.pending()).toHaveLength(0);
		expect(f.violations).toEqual([]);
	});

	it("keeps the captured binding abort connected after headers without a second reply", async () => {
		const f = fixture();
		f.request("bound", true);
		await flush();
		const original = f.calls[0] as Call;
		original.result.resolve({ status: 200, headers: [], streamId: "stream" });
		await flush();
		expect(original.context.signal.aborted).toBe(false);
		f.authority.abort();
		await flush();
		expect(original.context.signal.aborted).toBe(true);
		expect(f.clock.pending()).toHaveLength(0);
		expect(f.binding).toHaveBeenCalledTimes(1);
		expect(f.writes).toHaveLength(1);
		expect(f.violations).toEqual([]);
	});

	it("retires the original parent timer when a stream terminates normally", async () => {
		const f = fixture();
		f.request("finished-stream", true);
		await flush();
		const original = f.calls[0] as Call;
		original.result.resolve({ status: 200, headers: [], streamId: "stream" });
		await flush();
		await original.context.notify({
			jsonrpc: "2.0",
			method: "host/stream.chunk",
			params: { streamId: "stream", sequence: 0, base64: "", done: true },
		});
		await flush();
		expect(original.context.signal.aborted).toBe(true);
		expect(f.clock.pending()).toHaveLength(0);
		f.clock.advance(30_000);
		await flush();
		expect(f.writes).toHaveLength(2);
		expect(f.violations).toEqual([]);
	});

	it("keeps unknown, ended and duplicate cancellations inert toward other live work", async () => {
		const f = fixture();
		f.request("live");
		f.request("finished");
		await flush();
		(f.calls[1] as Call).result.resolve(fetched);
		await flush();
		for (const id of ["unknown", "finished", "finished"]) f.cancel(id);
		await flush();
		expect(f.calls[0]?.context.signal.aborted).toBe(false);
		f.cancel("live");
		f.cancel("live");
		await flush();
		expect(f.calls[0]?.context.signal.aborted).toBe(true);
		expect(f.binding).toHaveBeenCalledTimes(2);
		expect(f.writes).toHaveLength(1);
		expect(f.clock.pending()).toHaveLength(0);
		expect(f.violations).toEqual([]);
	});

	it("ignores a retired request's late outcome after terminal ID reuse", async () => {
		const f = fixture();
		f.request("reused");
		await flush();
		const old = f.calls[0] as Call;
		f.cancel("reused");
		f.setInvocation(Object.freeze({ tag: "replacement" }));
		f.request("reused");
		await flush();
		const replacement = f.calls[1] as Call;
		expect(replacement.context.invocation).not.toBe(old.context.invocation);
		old.result.resolve(fetched);
		await flush();
		expect(f.writes).toHaveLength(0);
		expect(replacement.context.signal.aborted).toBe(false);
		for (let index = 0; index < 15; index++) f.request(`sibling-${index}`);
		await flush();
		f.request("over-limit");
		expect(f.violations).toEqual(["host-limit"]);
		expect(f.calls).toHaveLength(17);
	});

	it("rejects an ID collision with a live stream after its header was written", async () => {
		const f = fixture();
		f.request("stream-request", true);
		await flush();
		(f.calls[0] as Call).result.resolve({ status: 200, headers: [], streamId: "stream" });
		await flush();
		f.request("stream-request");
		expect(f.violations).toEqual(["host-limit"]);
		expect(f.binding).toHaveBeenCalledTimes(1);
		expect(f.calls).toHaveLength(1);
	});

	it("counts established stream bodies toward the sixteen-live-request limit", async () => {
		const f = fixture();
		for (let index = 0; index < 16; index++) {
			f.request(`stream-${index}`, true);
			await flush();
			(f.calls[index] as Call).result.resolve({
				status: 200,
				headers: [],
				streamId: `body-${index}`,
			});
			await flush();
		}
		expect(f.calls.every((call) => !call.context.signal.aborted)).toBe(true);
		f.request("seventeenth");
		expect(f.violations).toEqual(["host-limit"]);
		expect(f.binding).toHaveBeenCalledTimes(16);
	});

	it("releases only the cancelled stream and admits its replacement", async () => {
		const f = fixture();
		for (let index = 0; index < 16; index++) {
			f.request(`stream-${index}`, true);
			await flush();
			(f.calls[index] as Call).result.resolve({
				status: 200,
				headers: [],
				streamId: `body-${index}`,
			});
			await flush();
		}
		f.cancel("stream-3");
		f.cancel("stream-3");
		f.request("replacement", true);
		await flush();
		expect(f.calls).toHaveLength(17);
		expect(f.calls[3]?.context.signal.aborted).toBe(true);
		expect(f.calls.filter((call) => call.context.signal.aborted)).toHaveLength(1);
		expect(f.violations).toEqual([]);
	});

	it("retains already queued replies and softly refuses new work until their native callback", async () => {
		const f = fixture();
		f.holdWrites();
		for (let index = 0; index < 16; index++) f.request(`request-${index}`);
		await flush();
		for (const call of f.calls) call.result.resolve(fetched);
		await flush();
		expect(f.writes).toHaveLength(16);
		f.cancel("request-0");
		f.request("waiting");
		await flush();
		expect(f.calls).toHaveLength(16);
		expect(f.binding).toHaveBeenCalledTimes(16);
		expect(f.violations).toEqual([]);
		expect(JSON.parse((f.writes[16] as Write).line.slice(1))).toMatchObject({
			id: "waiting",
			error: { data: { code: "TOO_LARGE" } },
		});
		expect(f.calls[0]?.context.signal.aborted).toBe(true);
		expect(f.calls[1]?.context.signal.aborted).toBe(false);
		(f.writes[0] as Write).complete();
		await flush();
		f.request("waiting");
		await flush();
		expect(f.calls).toHaveLength(17);
		expect(f.calls[16]?.context.signal.aborted).toBe(false);
		expect(f.violations).toEqual([]);
	});

	it("softly refuses new work while timed-out contexts still owe native refusal writes", async () => {
		const f = fixture();
		f.holdWrites();
		for (let index = 0; index < 16; index++) f.request(`request-${index}`);
		await flush();
		f.clock.advance(30_000);
		await flush();
		expect(f.calls.every((call) => call.context.signal.aborted)).toBe(true);
		expect(f.writes).toHaveLength(16);
		f.request("waiting");
		await flush();
		expect(f.calls).toHaveLength(16);
		expect(f.binding).toHaveBeenCalledTimes(16);
		expect(f.violations).toEqual([]);
		expect(JSON.parse((f.writes[16] as Write).line.slice(1))).toMatchObject({
			id: "waiting",
			error: { data: { code: "TOO_LARGE" } },
		});
	});

	it("keeps sixteen established sockets, refuses only another open, and permits SDK close and reopen", async () => {
		const f = fixture();
		const url = "wss://dytest.invalid/socket";
		for (let index = 0; index < 16; index++) {
			const opening = f.sdk.request("host/ws.open", { url });
			await flush();
			(f.calls[index] as Call).result.resolve({ socketId: `socket-${index}` });
			await expect(opening).resolves.toEqual({ socketId: `socket-${index}` });
			await flush();
		}
		expect(f.clock.pending()).toHaveLength(0);
		f.clock.advance(30_000);
		await flush();
		expect(f.calls.every((call) => !call.context.signal.aborted)).toBe(true);
		const seventeenth = outcome(f.sdk.request("host/ws.open", { url }));
		await flush();
		expect(f.violations).toEqual([]);
		expect(await seventeenth).toMatchObject({ code: "DENIED" });
		expect(f.calls).toHaveLength(16);
		const closing = f.sdk.request("host/ws.close", { socketId: "socket-0" });
		await flush();
		expect(f.calls[16]?.method).toBe("host/ws.close");
		(f.calls[16] as Call).result.resolve(null);
		await expect(closing).resolves.toBeNull();
		await flush();
		expect(f.calls[0]?.context.signal.aborted).toBe(true);
		expect(f.calls.slice(1, 16).every((call) => !call.context.signal.aborted)).toBe(true);
		const replacement = f.sdk.request("host/ws.open", { url });
		await flush();
		expect(f.calls).toHaveLength(18);
		(f.calls[17] as Call).result.resolve({ socketId: "replacement" });
		await expect(replacement).resolves.toEqual({ socketId: "replacement" });
		expect(f.violations).toEqual([]);
		expect(f.errors).toEqual([]);
	});

	it("permits terminal socket-open ID reuse and cancels the replacement RPC instead of the socket", async () => {
		const f = fixture();
		f.send({
			jsonrpc: "2.0",
			id: "shared",
			method: "host/ws.open",
			params: { url: "wss://dytest.invalid/socket" },
		});
		await flush();
		const socket = f.calls[0] as Call;
		socket.result.resolve({ socketId: "socket" });
		await flush();
		f.cancel("shared");
		await flush();
		expect(socket.context.signal.aborted).toBe(false);
		expect(f.writes).toHaveLength(1);
		f.request("shared");
		await flush();
		expect(f.calls).toHaveLength(2);
		expect(f.violations).toEqual([]);
		const replacement = f.calls[1] as Call;
		f.cancel("shared");
		f.cancel("shared");
		await flush();
		expect(replacement.context.signal.aborted).toBe(true);
		expect(socket.context.signal.aborted).toBe(false);
		expect(f.binding).toHaveBeenCalledTimes(2);
		expect(f.writes).toHaveLength(1);
		await socket.context.notify({
			jsonrpc: "2.0",
			method: "host/ws.message",
			params: { socketId: "socket", data: "still owned" },
		});
		expect(f.violations).toEqual([]);
	});

	it("counts a socket-open header as a live RPC until its native write completes", async () => {
		const f = fixture();
		f.holdWrites();
		f.send({
			jsonrpc: "2.0",
			id: "pending-socket",
			method: "host/ws.open",
			params: { url: "wss://dytest.invalid/socket" },
		});
		await flush();
		(f.calls[0] as Call).result.resolve({ socketId: "socket" });
		await flush();
		for (let index = 0; index < 15; index++) f.request(`pending-${index}`);
		await flush();
		f.request("seventeenth");
		expect(f.calls).toHaveLength(16);
		expect(f.violations).toEqual(["host-limit"]);
	});
});
