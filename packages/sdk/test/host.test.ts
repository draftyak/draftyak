import { PassThrough } from "node:stream";
import {
	HOST_FRAME_TAG,
	HOST_MAX_FRAME_BYTES,
	type HostMethod,
	type HostMethods,
	type HostNotification,
} from "@draftyak/protocol/host-channel";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createPluginContext } from "../src/context.ts";
import { memoryHost } from "../src/host.ts";
import { stdioHost } from "../src/stdio.ts";

function listenerChannel(kind: "memory" | "stdio") {
	const input = new PassThrough();
	const output = new PassThrough();
	const memory = kind === "memory" ? memoryHost(() => null) : undefined;
	const host = memory ?? stdioHost({ input, output });
	return {
		host,
		notify() {
			const notification: HostNotification = {
				jsonrpc: "2.0",
				method: "host/ws.message",
				params: { socketId: "s1", data: "message" },
			};
			if (memory) memory.notify(notification);
			else input.write(`${HOST_FRAME_TAG}${JSON.stringify(notification)}\n`);
		},
		dispose() {
			try {
				host.close();
			} finally {
				input.destroy();
				output.destroy();
			}
		},
	};
}

const methods: {
	[M in HostMethod]: { params: HostMethods[M]["params"]; result: HostMethods[M]["result"] };
} = {
	"host/fetch": {
		params: { method: "GET", url: "https://example.invalid/", headers: [] },
		result: { status: 200, headers: [], body: { base64: "aGk" } },
	},
	"host/ws.open": { params: { url: "wss://example.invalid/" }, result: { socketId: "s1" } },
	"host/ws.send": { params: { socketId: "s1", envelopeId: "e1" }, result: null },
	"host/ws.close": { params: { socketId: "s1" }, result: null },
	"host/kv.get": { params: { key: "key" }, result: { value: ["value", 1] } },
	"host/kv.set": { params: { key: "key", value: ["value", 1] }, result: null },
	"host/kv.delete": { params: { key: "key" }, result: null },
	"host/changed": { params: { cursor: "c1" }, result: null },
	"host/log": { params: { level: "info", message: "safe" }, result: null },
	"host/progress": { params: { token: "p1", progress: 1, total: 2 }, result: null },
};
describe("host channel boundaries", () => {
	it("round trips every typed host method over split tagged lines and leaves MCP untagged", async () => {
		const input = new PassThrough();
		const output = new PassThrough();
		const host = stdioHost({ input, output });
		const received: unknown[] = [];
		host.transport.onmessage = (value) => received.push(value);
		await host.transport.start();
		output.on("data", (bytes: Buffer) => {
			const text = bytes.toString();
			if (!text.startsWith(HOST_FRAME_TAG)) return;
			const request = JSON.parse(text.slice(1));
			const result = methods[request.method as HostMethod].result;
			const line = `${HOST_FRAME_TAG}${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`;
			input.write(line.slice(0, 11));
			input.write(line.slice(11));
		});
		for (const method of Object.keys(methods) as HostMethod[])
			expect(await host.request(method, methods[method].params)).toEqual(methods[method].result);
		input.write('{"jsonrpc":"2.0","id":9,"method":"ping"}\n');
		expect(received).toEqual([{ jsonrpc: "2.0", id: 9, method: "ping" }]);
		host.close();
	});
	it.each([
		'\u001e{"cmd":"NODE_HANDLE","handle":{}}\n',
		'\u001e{"jsonrpc":"2.0","id":"a","result":{},"result":null}\n',
		'\u001e{"jsonrpc":"2.0","id":"a","method":"host/nope","params":{}}\n',
		'\u001e{"jsonrpc":"2.0","method":"host/stream.chunk","params":{}}\n',
		"not json\n",
	])("closes on malformed, internal or duplicate-key frames", async (line) => {
		const input = new PassThrough();
		const output = new PassThrough();
		let forwarded = 0;
		let closed = 0;
		const host = stdioHost({ input, output });
		host.transport.onmessage = () => forwarded++;
		host.transport.onclose = () => closed++;
		input.write(line);
		expect(forwarded).toBe(0);
		expect(closed).toBe(1);
		await expect(host.request("host/kv.get", { key: "key" })).rejects.toMatchObject({
			code: "DENIED",
		});
	});
	it("rejects an oversized unfinished line before forwarding and rejects truncated EOF", () => {
		for (const oversized of [true, false]) {
			const input = new PassThrough();
			const output = new PassThrough();
			let closed = false;
			const host = stdioHost({ input, output });
			host.transport.onclose = () => {
				closed = true;
			};
			if (oversized) input.write(Buffer.alloc(HOST_MAX_FRAME_BYTES + 2, 120));
			else {
				input.write('{"jsonrpc":');
				input.emit("end");
			}
			expect(closed).toBe(true);
			host.close();
		}
	});
	it("fuzzes malformed JSON-RPC frames without delivery or crashes (500 runs)", () => {
		fc.assert(
			fc.property(fc.jsonValue(), (value) => {
				const input = new PassThrough();
				const output = new PassThrough();
				let forwarded = 0;
				const host = stdioHost({ input, output });
				host.transport.onmessage = () => forwarded++;
				input.write(`${HOST_FRAME_TAG}${JSON.stringify({ invalid: value })}\n`);
				expect(forwarded).toBe(0);
				host.close();
			}),
			{ numRuns: 500, seed: 112 },
		);
	});
	it("rejects non-JSON values, handle objects and newline headers before invoking memory handlers", async () => {
		let invoked = 0;
		const host = memoryHost(() => {
			invoked++;
			return null;
		});
		for (const value of [
			undefined,
			() => {},
			1n,
			Symbol("x"),
			new PassThrough(),
			{ nested: undefined },
		]) {
			await expect(host.request("host/kv.set", { key: "key", value })).rejects.toMatchObject({
				code: "BAD_REQUEST",
			});
		}
		await expect(
			host.request("host/fetch", {
				...methods["host/fetch"].params,
				headers: [["accept", "ok\n"]],
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(invoked).toBe(0);
		host.close();
	});
	it("caps pending calls and propagates cancellation/timeouts to the adapter", async () => {
		const signals: AbortSignal[] = [];
		const host = memoryHost((_method, _params, signal) => {
			signals.push(signal);
			return new Promise(() => {});
		});
		const controller = new AbortController();
		const request = host.request("host/kv.get", { key: "key" }, { signal: controller.signal });
		await Promise.resolve();
		controller.abort();
		await expect(request).rejects.toMatchObject({ code: "DENIED" });
		expect(signals[0]?.aborted).toBe(true);
		await expect(
			host.request("host/kv.get", { key: "key" }, { timeoutMs: 1 }),
		).rejects.toMatchObject({ code: "TIMEOUT" });
		const calls = Array.from({ length: 16 }, () =>
			host.request("host/kv.get", { key: "key" }).catch((error) => error),
		);
		await expect(host.request("host/kv.get", { key: "key" })).rejects.toMatchObject({
			code: "TOO_LARGE",
		});
		host.close();
		await Promise.all(calls);
	});
	it("closes malformed channels even when both error reporters throw", async () => {
		const input = new PassThrough();
		const output = new PassThrough();
		let closed = false;
		const host = stdioHost({
			input,
			output,
			onerror() {
				throw new Error("Reporter failed");
			},
		});
		host.transport.onerror = () => {
			throw new Error("Transport reporter failed");
		};
		host.transport.onclose = () => {
			closed = true;
		};
		const pending = expect(host.request("host/kv.get", { key: "key" })).rejects.toMatchObject({
			code: "DENIED",
		});
		expect(() => input.write("invalid\n")).not.toThrow();
		await pending;
		expect(closed).toBe(true);
	});
	it("context wraps ws acknowledgements, notifications, kv, changes, logs and progress", async () => {
		const calls: string[] = [];
		const host = memoryHost((method) => {
			calls.push(method);
			return methods[method].result;
		});
		const ctx = createPluginContext({ plugin: "fixture", account: "account" }, host);
		const socket = await ctx.ws.open("wss://example.invalid/");
		const messages: string[] = [];
		const stop = socket.subscribe((value) => messages.push(value));
		host.notify({
			jsonrpc: "2.0",
			method: "host/ws.message",
			params: { socketId: "s1", data: "envelope" },
		});
		await socket.sendAck("e1");
		await socket.close();
		stop();
		expect(await ctx.kv.get("key")).toEqual(["value", 1]);
		await ctx.kv.set("key", 1);
		await ctx.kv.delete("key");
		await ctx.changed("c1");
		await ctx.log("info", "safe");
		await ctx.progress("p1", 1, 2);
		expect(messages).toEqual(["envelope"]);
		expect(calls).toHaveLength(9);
		host.close();
	});
});

describe.each(["memory", "stdio"] as const)("%s listener lifecycle", (kind) => {
	it("isolates throwing close listeners", () => {
		const channel = listenerChannel(kind);
		const calls: string[] = [];
		channel.host.subscribe(
			() => {},
			() => {
				calls.push("first");
				throw new Error("Close listener failed");
			},
		);
		channel.host.subscribe(
			() => {},
			() => calls.push("second"),
		);
		try {
			expect(() => channel.host.close()).not.toThrow();
			expect(calls).toEqual(["first", "second"]);
			channel.host.close();
			expect(calls).toEqual(["first", "second"]);
		} finally {
			channel.dispose();
		}
	});
	it("keeps the captured close listeners when an earlier one unsubscribes them", () => {
		const channel = listenerChannel(kind);
		const calls: string[] = [];
		let unsubscribe = () => {};
		channel.host.subscribe(
			() => {},
			() => {
				calls.push("first");
				unsubscribe();
			},
		);
		unsubscribe = channel.host.subscribe(
			() => {},
			() => calls.push("second"),
		);
		try {
			channel.host.close();
			expect(calls).toEqual(["first", "second"]);
		} finally {
			channel.dispose();
		}
	});
	it("refuses listener registration after close and during a close callback", () => {
		const channel = listenerChannel(kind);
		let refusal: unknown;
		let added = 0;
		channel.host.subscribe(
			() => {},
			() => {
				try {
					channel.host.subscribe(
						() => {},
						() => added++,
					);
				} catch (error) {
					refusal = error;
				}
			},
		);
		try {
			channel.host.close();
			expect(refusal).toMatchObject({ code: "DENIED" });
			expect(added).toBe(0);
			expect(() => channel.host.subscribe(() => {})).toThrow("DENIED");
		} finally {
			channel.dispose();
		}
	});
	it("keeps duplicate notification listener registrations independent", () => {
		const channel = listenerChannel(kind);
		let calls = 0;
		const listener = () => calls++;
		const unsubscribe = channel.host.subscribe(listener);
		const keep = channel.host.subscribe(listener);
		try {
			unsubscribe();
			unsubscribe();
			channel.notify();
			expect(calls).toBe(1);
			keep();
			channel.notify();
			expect(calls).toBe(1);
		} finally {
			channel.dispose();
		}
	});
	it("keeps shared close listener registrations independent", () => {
		const channel = listenerChannel(kind);
		let calls = 0;
		const listener = () => calls++;
		const unsubscribe = channel.host.subscribe(() => {}, listener);
		channel.host.subscribe(() => {}, listener);
		try {
			unsubscribe();
			unsubscribe();
			channel.host.close();
			expect(calls).toBe(1);
		} finally {
			channel.dispose();
		}
	});
	it("defers added notification listeners until the next notification", () => {
		const channel = listenerChannel(kind);
		const calls: string[] = [];
		let added = false;
		channel.host.subscribe(() => {
			calls.push("first");
			if (!added) {
				added = true;
				channel.host.subscribe(() => calls.push("added"));
			}
		});
		try {
			channel.notify();
			expect(calls).toEqual(["first"]);
			channel.notify();
			expect(calls).toEqual(["first", "first", "added"]);
		} finally {
			channel.dispose();
		}
	});
	it("continues notification listeners after one throws", () => {
		const channel = listenerChannel(kind);
		let calls = 0;
		channel.host.subscribe(() => {
			throw new Error("Notification listener failed");
		});
		channel.host.subscribe(() => calls++);
		try {
			expect(() => channel.notify()).not.toThrow();
			expect(calls).toBe(1);
		} finally {
			channel.dispose();
		}
	});
	it("stops notification listeners when an earlier listener closes the channel", () => {
		const channel = listenerChannel(kind);
		let messages = 0;
		let closes = 0;
		channel.host.subscribe(
			() => channel.host.close(),
			() => closes++,
		);
		channel.host.subscribe(
			() => messages++,
			() => closes++,
		);
		try {
			channel.notify();
			expect(messages).toBe(0);
			expect(closes).toBe(2);
		} finally {
			channel.dispose();
		}
	});
});
