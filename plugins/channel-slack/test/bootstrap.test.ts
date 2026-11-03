import { PassThrough, Writable } from "node:stream";
import {
	HOST_FRAME_TAG,
	HostMessage,
	type HostMethod,
	type HostRequest,
} from "@draftyak/protocol/host-channel";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	bootstrapSlackPlugin,
	type SlackBootstrapOptions,
	type SlackPluginRuntime,
} from "../src/bootstrap.ts";

const meta = {
	"io.modelcontextprotocol/protocolVersion": "2026-07-28",
	"io.modelcontextprotocol/clientCapabilities": {},
};
const SOCKET = "DYTEST-bootstrap-socket";
const frame = (value: unknown): string => `${HOST_FRAME_TAG}${JSON.stringify(value)}\n`;
interface Reply {
	readonly result?: { readonly isError?: boolean; readonly structuredContent?: unknown };
	readonly error?: unknown;
}
interface Peer {
	readonly runtime: SlackPluginRuntime;
	readonly input: PassThrough;
	readonly requests: HostRequest[];
	readonly errors: unknown[];
	call(name: string, args?: Record<string, unknown>): Promise<Reply>;
	request(method: HostMethod): Promise<HostRequest>;
	respond(request: HostRequest, result: unknown): void;
	message(): void;
	close(): Promise<void>;
}
const peers: Peer[] = [];
const network = vi.fn<typeof fetch>();

/** Real SDK server and tagged host frames share these owned memory streams. */
function peer(
	options: {
		holdOpen?: boolean;
		holdClose?: boolean;
		identity?: Pick<SlackBootstrapOptions, "account" | "instance">;
	} = {},
): Peer {
	const input = new PassThrough();
	const requests: HostRequest[] = [];
	const errors: unknown[] = [];
	const held: HostRequest[] = [];
	const pending = new Map<number, { resolve(reply: Reply): void; reject(error: Error): void }>();
	let id = 0;
	let buffer = "";
	const respond = (request: HostRequest, result: unknown): void => {
		if (!input.writableEnded) input.write(frame({ jsonrpc: "2.0", id: request.id, result }));
	};
	const output = new Writable({
		write(chunk: Buffer, _encoding, callback) {
			try {
				buffer += chunk.toString("utf8");
				let end = buffer.indexOf("\n");
				while (end !== -1) {
					const line = buffer.slice(0, end);
					buffer = buffer.slice(end + 1);
					if (line.startsWith(HOST_FRAME_TAG)) {
						const request = HostMessage.parse(JSON.parse(line.slice(1)));
						if (!("method" in request) || !("id" in request))
							throw new Error("DYTEST request expected");
						requests.push(request);
						if (request.method === "host/fetch")
							respond(request, {
								status: 200,
								headers: [["content-type", "application/json"]],
								body: {
									base64: Buffer.from(
										JSON.stringify({
											ok: true,
											url: "wss://wss-primary.slack.com/link/?ticket=DYTEST",
										}),
									).toString("base64url"),
								},
							});
						else if (request.method === "host/ws.open") {
							if (options.holdOpen) held.push(request);
							else respond(request, { socketId: SOCKET });
						} else if (request.method === "host/ws.close" && options.holdClose) held.push(request);
						else if (["host/ws.close", "host/ws.send", "host/changed"].includes(request.method))
							respond(request, null);
						else throw new Error("DYTEST unexpected host method");
					} else {
						const reply = JSON.parse(line) as Reply & { id?: number };
						if (reply.id !== undefined) {
							pending.get(reply.id)?.resolve(reply);
							pending.delete(reply.id);
						}
					}
					end = buffer.indexOf("\n");
				}
				callback();
			} catch (error) {
				errors.push(error);
				callback(new Error("DYTEST output refused"));
			}
		},
	});
	const runtime = bootstrapSlackPlugin({ ...options.identity, input, output });
	const result: Peer = {
		runtime,
		input,
		requests,
		errors,
		respond,
		call(name, args = {}) {
			const requestId = ++id;
			const reply = new Promise<Reply>((resolve, reject) => {
				pending.set(requestId, { resolve, reject });
			});
			input.write(
				`${JSON.stringify({ jsonrpc: "2.0", id: requestId, method: "tools/call", params: { name, arguments: args, _meta: meta } })}\n`,
			);
			void reply.catch(() => {});
			return reply;
		},
		request(method) {
			return vi.waitFor(() => {
				const found = requests.find((request) => request.method === method);
				if (!found) throw new Error("DYTEST host request not received");
				return found;
			});
		},
		message() {
			input.write(
				frame({
					jsonrpc: "2.0",
					method: "host/ws.message",
					params: {
						socketId: SOCKET,
						data: JSON.stringify({
							envelope_id: "DYTEST-envelope",
							type: "events_api",
							payload: { event_id: "DYTEST-event", event: { type: "message" } },
						}),
					},
				}),
			);
		},
		async close() {
			for (const request of held.splice(0))
				respond(request, request.method === "host/ws.open" ? { socketId: SOCKET } : null);
			// Cleanup must also answer a close initiated after a previously held opening.
			options.holdClose = false;
			await runtime.close();
			for (const waiter of pending.values()) waiter.reject(new Error("DYTEST peer closed"));
			pending.clear();
			input.destroy();
			output.destroy();
		},
	};
	peers.push(result);
	return result;
}
beforeEach(() => {
	network.mockReset();
	network.mockRejectedValue(new Error("DYTEST network forbidden"));
	vi.stubGlobal("fetch", network);
});
afterEach(async () => {
	try {
		for (const value of peers.splice(0)) {
			await value.close();
			expect(value.errors).toEqual([]);
		}
		expect(network).not.toHaveBeenCalled();
	} finally {
		vi.unstubAllGlobals();
	}
});

describe("Slack process bootstrap", () => {
	it("keeps the actual lease usable after the SDK ends a successful listen RPC", async () => {
		const value = peer({
			identity: { account: "DYTEST-account", instance: { id: "DYTEST-instance", config: {} } },
		});
		const reply = await value.call("channel_listen", { leaseMs: 10_000 });
		expect(reply.error).toBeUndefined();
		expect(reply.result?.isError).not.toBe(true);
		expect(reply.result?.structuredContent).toEqual({ leaseMs: 10_000 });
		value.message();
		const ack = await value.request("host/ws.send");
		await value.request("host/changed");
		expect(ack.params).toEqual({
			socketId: SOCKET,
			envelopeId: "DYTEST-envelope",
		});
		expect(value.requests.filter((request) => request.method === "host/ws.open")).toHaveLength(1);
		expect(value.runtime.entry.account).toBe("DYTEST-account");
		expect(value.runtime.identity.instance?.id).toBe("DYTEST-instance");
	});
	it("joins normal socket close before closing the shared host and completion", async () => {
		const value = peer({ holdClose: true });
		await value.call("channel_listen", { leaseMs: 10_000 });
		let finished = false;
		const closing = value.runtime.close().then(() => {
			finished = true;
		});
		const request = await value.request("host/ws.close");
		await Promise.resolve();
		expect(finished).toBe(false);
		expect(value.runtime.close()).toBe(value.runtime.close());
		value.respond(request, null);
		await closing;
		await value.runtime.closed;
		expect(finished).toBe(true);
		expect(value.requests.filter((item) => item.method === "host/ws.close")).toHaveLength(1);
	});
	it("joins local EOF cleanup during opening without asserting a remote close", async () => {
		const value = peer({ holdOpen: true });
		void value.call("channel_listen", { leaseMs: 10_000 });
		await value.request("host/ws.open");
		value.input.end();
		await value.runtime.closed;
		expect(value.requests.map((request) => request.method)).toEqual(["host/fetch", "host/ws.open"]);
	});
	it("joins EOF cleanup after a committed lease without another host request", async () => {
		const value = peer();
		await value.call("channel_listen", { leaseMs: 10_000 });
		const count = value.requests.length;
		value.input.end();
		await value.runtime.closed;
		expect(value.requests).toHaveLength(count);
		expect(value.requests.some((request) => request.method === "host/ws.close")).toBe(false);
	});
	it("captures identity once and derives stable scope independently of config property order", async () => {
		const instance = { id: "DYTEST-instance", config: { label: "DYTEST-original" } };
		const first = peer({ identity: { account: "DYTEST-account", instance } });
		instance.id = "DYTEST-mutated";
		instance.config.label = "DYTEST-mutated";
		const same = peer({
			identity: { account: "DYTEST-account", instance: { id: "DYTEST-instance", config: {} } },
		});
		const other = peer({
			identity: { account: "DYTEST-other", instance: { id: "DYTEST-instance", config: {} } },
		});
		expect(first.runtime.identity.instance).toEqual({
			id: "DYTEST-instance",
			config: { label: "DYTEST-original" },
		});
		expect(Object.isFrozen(first.runtime.identity.instance?.config)).toBe(true);
		expect(first.runtime.scope).toBe(same.runtime.scope);
		expect(first.runtime.scope).not.toBe(other.runtime.scope);
		expect(first.requests).toEqual([]);
	});
	it("refuses accessor, proxy and malformed identity options before attaching streams", () => {
		const hook = vi.fn(() => "DYTEST-account");
		const accessor = Object.defineProperty({}, "account", { enumerable: true, get: hook });
		const proxy = new Proxy(
			{},
			{
				ownKeys() {
					hook();
					return [];
				},
			},
		);
		for (const options of [
			accessor,
			proxy,
			{ account: "bad\naccount" },
			{ instance: { id: "DYTEST", config: [] } },
		]) {
			expect(() => bootstrapSlackPlugin(options as SlackBootstrapOptions)).toThrow();
		}
		expect(hook).not.toHaveBeenCalled();
	});
});
