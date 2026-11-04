import { PassThrough } from "node:stream";
import {
	HOST_FRAME_TAG,
	HOST_MAX_FRAME_BYTES,
	HOST_REQUEST_TIMEOUT_MS,
	HostMessage,
	PLUGIN_BOOTSTRAP_MAX_BYTES,
	PluginBootstrap,
} from "@draftyak/protocol/host-channel";
import { canonicalize } from "@draftyak/protocol/jcs";
import type { StdioServerHandle } from "@modelcontextprotocol/server/stdio";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginInstance } from "../src/context.ts";
import { type PluginEntry, serve, serveBootstrapped } from "../src/serve.ts";
import { encodePluginBootstrap, type StdioHost, stdioHost } from "../src/stdio.ts";

interface Reply {
	readonly id: number;
	readonly result?: Record<string, unknown>;
	readonly error?: unknown;
}
const channels: StdioHost[] = [];
const handles: StdioServerHandle[] = [];
const streams: PassThrough[] = [];
const instance = () => ({
	id: "logical-instance",
	config: { model: "synthetic", nested: { value: 1 } },
});
const meta = {
	"io.modelcontextprotocol/protocolVersion": "2026-07-28",
	"io.modelcontextprotocol/clientCapabilities": {},
};

function frame(id: number, method: string, params: Record<string, unknown> = {}): string {
	return `${JSON.stringify({ jsonrpc: "2.0", id, method, params: { ...params, _meta: meta } })}\n`;
}
function entry(handler?: (value: PluginInstance | undefined) => void): PluginEntry {
	return {
		name: "bootstrap-fixture",
		version: "1.0.0",
		plugin: "bootstrap-fixture",
		extensions: { "io.github.draftyak/tool": {} },
		tools: handler
			? [
					{
						name: "echo",
						handler: (_args, context) => {
							handler?.(context.instance);
							return { ok: true };
						},
					},
				]
			: [],
	};
}
function io() {
	const input = new PassThrough(),
		output = new PassThrough();
	streams.push(input, output);
	let bytes = "";
	const replies = new Map<number, Reply>();
	const pending = new Map<number, (reply: Reply) => void>();
	output.on("data", (chunk: Buffer) => {
		bytes += chunk.toString("utf8");
		for (let index = bytes.indexOf("\n"); index !== -1; index = bytes.indexOf("\n")) {
			const row = bytes.slice(0, index);
			bytes = bytes.slice(index + 1);
			if (row.startsWith(HOST_FRAME_TAG)) continue;
			const reply = JSON.parse(row) as Reply;
			const resolve = pending.get(reply.id);
			if (resolve) {
				pending.delete(reply.id);
				resolve(reply);
			} else replies.set(reply.id, reply);
		}
	});
	return {
		input,
		output,
		reply(id: number): Promise<Reply> {
			const ready = replies.get(id);
			if (ready) {
				replies.delete(id);
				return Promise.resolve(ready);
			}
			return new Promise((resolve) => pending.set(id, resolve));
		},
	};
}
function host(ports: ReturnType<typeof io>, bootstrap = true): StdioHost {
	const channel = stdioHost({ input: ports.input, output: ports.output, bootstrap });
	channels.push(channel);
	return channel;
}
function clean(ports: ReturnType<typeof io>): void {
	expect(ports.input.listenerCount("data")).toBe(0);
	expect(ports.input.listenerCount("end")).toBe(0);
	expect(ports.input.listenerCount("error")).toBe(0);
	expect(ports.output.listenerCount("error")).toBe(0);
}
function start(factory: Parameters<typeof serveBootstrapped>[0], ports: ReturnType<typeof io>) {
	return serveBootstrapped(factory, { input: ports.input, output: ports.output });
}
afterEach(async () => {
	for (const handle of handles.splice(0)) await handle.close();
	for (const channel of channels.splice(0)) channel.close();
	for (const stream of streams.splice(0)) stream.destroy();
	if (vi.isFakeTimers()) vi.clearAllTimers();
	vi.useRealTimers();
});

describe("one-shot process bootstrap", () => {
	it("constructs only after capture and gives the factory and handler the same immutable instance", async () => {
		const ports = io();
		let constructed: PluginInstance | undefined;
		let called: PluginInstance | undefined;
		const factory = vi.fn((value: PluginInstance) => {
			constructed = value;
			return entry((value) => {
				called = value;
			});
		});
		const job = start(factory, ports);
		expect(factory).not.toHaveBeenCalled();
		expect(ports.input.listenerCount("data")).toBe(1);
		const original = instance();
		const wire = encodePluginBootstrap(original);
		original.config.nested.value = 99;
		ports.input.write(wire);
		handles.push(await job);
		const reply = ports.reply(1);
		ports.input.write(frame(1, "tools/call", { name: "echo", arguments: {} }));
		expect((await reply).error).toBeUndefined();
		expect(factory).toHaveBeenCalledTimes(1);
		expect(called).toBe(constructed);
		expect(constructed?.config).toEqual({ model: "synthetic", nested: { value: 1 } });
		expect(Object.isFrozen(constructed)).toBe(true);
		expect(Object.isFrozen(constructed?.config.nested)).toBe(true);
	});

	it("retains a coalesced modern MCP request until the original transport starts", async () => {
		const ports = io(),
			channel = host(ports);
		const messages: unknown[] = [];
		ports.input.write(encodePluginBootstrap(instance()) + frame(7, "tools/list"));
		await channel.bootstrap;
		expect(messages).toEqual([]);
		channel.transport.onmessage = (message) => {
			messages.push(message);
		};
		await channel.transport.start();
		expect(messages).toHaveLength(1);
		expect(messages[0]).toMatchObject({ id: 7, method: "tools/list" });
		expect(ports.input.listenerCount("data")).toBe(1);
	});

	it("serves a coalesced discovery request through the real serving entry point", async () => {
		const ports = io();
		const factory = vi.fn(() => entry());
		const job = start(factory, ports);
		const reply = ports.reply(8);
		ports.input.write(encodePluginBootstrap(instance()) + frame(8, "tools/list"));
		handles.push(await job);
		expect((await reply).result?.tools).toEqual([]);
		expect(factory).toHaveBeenCalledTimes(1);
	});

	it("handles a UTF8 code point and LF split across input chunks", async () => {
		const ports = io(),
			factory = vi.fn(() => entry());
		const job = start(factory, ports);
		const value = { id: "one", config: { text: "é" } };
		const wire = Buffer.from(encodePluginBootstrap(value));
		const split = wire.indexOf(Buffer.from("é")) + 1;
		ports.input.write(wire.subarray(0, split));
		expect(factory).not.toHaveBeenCalled();
		ports.input.write(wire.subarray(split, wire.length - 1));
		expect(factory).not.toHaveBeenCalled();
		ports.input.write(wire.subarray(wire.length - 1));
		handles.push(await job);
		expect(factory).toHaveBeenCalledTimes(1);
	});

	it.each([
		["untagged MCP", frame(1, "tools/list")],
		["ordinary host reply", `${HOST_FRAME_TAG}{"jsonrpc":"2.0","id":"x","result":null}\n`],
		[
			"extra envelope key",
			HOST_FRAME_TAG +
				'{"jsonrpc":"2.0","method":"host/bootstrap","params":{"instance":{"id":"x","config":{}}},"extra":true}\n',
		],
		[
			"duplicate key",
			HOST_FRAME_TAG +
				'{"jsonrpc":"2.0","method":"host/bootstrap","params":{"instance":{"id":"x","id":"y","config":{}}}}\n',
		],
		["trailing JSON", `${encodePluginBootstrap(instance()).trimEnd()}{}\n`],
		[
			"oversized instance",
			HOST_FRAME_TAG +
				JSON.stringify({
					jsonrpc: "2.0",
					method: "host/bootstrap",
					params: {
						instance: { id: "x", config: { text: "x".repeat(PLUGIN_BOOTSTRAP_MAX_BYTES) } },
					},
				}) +
				"\n",
		],
	] as const)("refuses %s before invoking a factory", async (_name, wire) => {
		const ports = io(),
			factory = vi.fn(() => entry());
		const job = start(factory, ports);
		const rejection = expect(job).rejects.toThrow();
		ports.input.write(wire);
		await rejection;
		expect(factory).not.toHaveBeenCalled();
		clean(ports);
	});

	it("refuses duplicate bootstrap after transport start", async () => {
		const ports = io(),
			channel = host(ports);
		let closed = 0;
		channel.subscribe(
			() => {},
			() => {
				closed++;
			},
		);
		ports.input.write(encodePluginBootstrap(instance()));
		await channel.bootstrap;
		await channel.transport.start();
		ports.input.write(encodePluginBootstrap(instance()));
		expect(closed).toBe(1);
		clean(ports);
	});

	it("bounds the queued pre-start tail rather than retaining arbitrary input", async () => {
		const ports = io(),
			channel = host(ports);
		ports.input.write(encodePluginBootstrap(instance()));
		await channel.bootstrap;
		ports.input.write(Buffer.alloc(HOST_MAX_FRAME_BYTES + 2, 32));
		await expect(channel.transport.start()).rejects.toThrow();
		clean(ports);
	});

	it("denies child application requests before bootstrap transport startup", async () => {
		const ports = io(),
			channel = host(ports);
		await expect(channel.request("host/kv.get", { key: "synthetic" })).rejects.toThrow();
		expect(ports.output.read()).toBeNull();
		channel.close();
		await expect(channel.bootstrap).rejects.toThrow();
	});

	it.each(["partial EOF", "input error", "output error", "close"] as const)(
		"cleans a startup %s",
		async (failure) => {
			const ports = io(),
				channel = host(ports);
			const rejection = expect(channel.bootstrap).rejects.toThrow();
			if (failure === "partial EOF")
				ports.input.end(encodePluginBootstrap(instance()).slice(0, -1));
			else if (failure === "input error")
				ports.input.emit("error", new Error("Synthetic input failure"));
			else if (failure === "output error")
				ports.output.emit("error", new Error("Synthetic output failure"));
			else channel.close();
			await rejection;
			clean(ports);
		},
	);

	it("uses the fixed first-frame deadline and never constructs after timeout", async () => {
		vi.useFakeTimers();
		const ports = io(),
			factory = vi.fn(() => entry());
		const job = start(factory, ports);
		const rejection = expect(job).rejects.toThrow();
		await vi.advanceTimersByTimeAsync(HOST_REQUEST_TIMEOUT_MS);
		await rejection;
		ports.input.write(encodePluginBootstrap(instance()));
		expect(factory).not.toHaveBeenCalled();
		clean(ports);
	});

	it("does not invoke the factory if cancelled between bootstrap delivery and its continuation", async () => {
		const ports = io(),
			factory = vi.fn(() => entry()),
			controller = new AbortController();
		const job = serveBootstrapped(factory, {
			input: ports.input,
			output: ports.output,
			signal: controller.signal,
		});
		const rejection = expect(job).rejects.toThrow();
		ports.input.write(encodePluginBootstrap(instance()));
		controller.abort();
		await rejection;
		expect(factory).not.toHaveBeenCalled();
		clean(ports);
	});

	it("closes the original reader if construction throws", async () => {
		const ports = io(),
			factory = vi.fn(() => {
				throw new Error("Synthetic constructor failure");
			});
		const job = start(factory, ports);
		const rejection = expect(job).rejects.toThrow("Synthetic constructor failure");
		ports.input.write(encodePluginBootstrap(instance()));
		await rejection;
		expect(factory).toHaveBeenCalledTimes(1);
		clean(ports);
	});

	it("accepts exactly the existing UTF8 instance cap and refuses one extra byte", () => {
		const value = { id: "x", config: { text: "" } };
		const room = PLUGIN_BOOTSTRAP_MAX_BYTES - Buffer.byteLength(canonicalize(value));
		value.config.text = "é".repeat(Math.floor(room / 2)) + (room % 2 ? "x" : "");
		expect(() => encodePluginBootstrap(value)).not.toThrow();
		value.config.text += "x";
		expect(() => encodePluginBootstrap(value)).toThrow();
	});

	it("captures object inputs without invoking getters, toJSON or proxy hooks", () => {
		let hooks = 0;
		const getter = Object.defineProperty({}, "id", {
			enumerable: true,
			get: () => {
				hooks++;
				return "x";
			},
		});
		const serializer = {
			id: "x",
			config: {
				toJSON: () => {
					hooks++;
					return {};
				},
			},
		};
		const proxy = new Proxy(instance(), {
			ownKeys: () => {
				hooks++;
				return [];
			},
		});
		for (const value of [getter, serializer, proxy])
			expect(() => encodePluginBootstrap(value)).toThrow();
		expect(hooks).toBe(0);
	});

	it("keeps bootstrap out of normal host frames", () => {
		const parsed = PluginBootstrap.parse(JSON.parse(encodePluginBootstrap(instance()).slice(1)));
		expect(HostMessage.safeParse(parsed).success).toBe(false);
	});

	it("preserves legacy serving with an explicitly supplied local instance", async () => {
		const ports = io(),
			channel = host(ports, false),
			original = instance();
		let observed: PluginInstance | undefined;
		handles.push(
			serve(
				entry((value) => {
					observed = value;
				}),
				{ host: channel, instance: original },
			),
		);
		original.config.nested.value = 99;
		const reply = ports.reply(20);
		ports.input.write(frame(20, "tools/call", { name: "echo", arguments: {} }));
		expect((await reply).error).toBeUndefined();
		expect(observed?.config.nested).toEqual({ value: 1 });
	});
});
