import { PassThrough, Writable } from "node:stream";
import {
	HOST_FRAME_TAG,
	HostMessage,
	type HostMethod,
	type HostRequest,
} from "@draftyak/protocol/host-channel";
import { type StdioHost, stdioHost } from "@draftyak/sdk/stdio";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSlackSocketLease, type SlackSocketLease } from "../src/socket-lease.ts";

const SOCKET_ID = "DYTEST-owned-socket";
const FOREIGN_ID = "DYTEST-foreign-socket";
const ENVELOPE_ID = "00000000-0000-4000-8000-000000000001";
const FOREIGN_ENVELOPE_ID = "00000000-0000-4000-8000-000000000002";
const frame = (value: unknown): string => `${HOST_FRAME_TAG}${JSON.stringify(value)}\n`;
const turn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const event = (socketId = SOCKET_ID, envelopeId = ENVELOPE_ID): string =>
	frame({
		jsonrpc: "2.0",
		method: "host/ws.message",
		params: {
			socketId,
			data: JSON.stringify({
				type: "events_api",
				envelope_id: envelopeId,
				payload: {
					event_id: `DYTEST-event-${envelopeId}`,
					event: { type: "message", text: "DYTEST private message is not forwarded" },
				},
			}),
		},
	});

interface FixtureOptions {
	readonly opening?: (request: HostRequest, reply: string) => string | undefined;
	readonly holdAck?: boolean;
}
interface StdioFixture {
	readonly input: PassThrough;
	readonly output: Writable;
	readonly host: StdioHost;
	readonly process: AbortController;
	readonly lease: SlackSocketLease;
	readonly requests: HostRequest[];
	readonly errors: unknown[];
	readonly operations: Promise<unknown>[];
	listen(caller?: AbortController): Promise<Readonly<{ leaseMs: number }>>;
	request(method: HostMethod, ordinal?: number): Promise<HostRequest>;
	respond(request: HostRequest, result: unknown): void;
	close(): Promise<void>;
}
const fixtures: StdioFixture[] = [];
const network = vi.fn<typeof fetch>();

/** Real SDK framing over owned memory streams, without child processes or sockets. */
function fixture(options: FixtureOptions = {}): StdioFixture {
	const input = new PassThrough();
	const requests: HostRequest[] = [];
	const errors: unknown[] = [];
	const operations: Promise<unknown>[] = [];
	const process = new AbortController();
	let pending = "";
	const respond = (request: HostRequest, result: unknown): void => {
		input.write(frame({ jsonrpc: "2.0", id: request.id, result }));
	};
	const output = new Writable({
		write(chunk: Buffer, _encoding, callback) {
			try {
				pending += chunk.toString("utf8");
				let end = pending.indexOf("\n");
				while (end !== -1) {
					const line = pending.slice(0, end);
					pending = pending.slice(end + 1);
					if (!line.startsWith(HOST_FRAME_TAG)) throw new Error("DYTEST untagged request");
					const request = HostMessage.parse(JSON.parse(line.slice(1)));
					if (!("method" in request) || !("id" in request))
						throw new Error("DYTEST expected host request");
					requests.push(request);
					switch (request.method) {
						case "host/fetch":
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
							break;
						case "host/ws.open": {
							const reply = frame({
								jsonrpc: "2.0",
								id: request.id,
								result: { socketId: SOCKET_ID },
							});
							const combined = options.opening ? options.opening(request, reply) : reply;
							if (combined !== undefined) input.write(combined);
							break;
						}
						case "host/ws.send":
							if (!options.holdAck) respond(request, null);
							break;
						case "host/changed":
						case "host/ws.close":
							respond(request, null);
							break;
						default:
							throw new Error("DYTEST unexpected host request");
					}
					end = pending.indexOf("\n");
				}
				callback();
			} catch (error) {
				errors.push(error);
				callback(error instanceof Error ? error : new Error("DYTEST writer failed"));
			}
		},
	});
	const host = stdioHost({ input, output, onerror: (error) => errors.push(error) });
	const lease = createSlackSocketLease(host, { plugin: "channel-slack" }, process.signal);
	const track = <T>(operation: Promise<T>): Promise<T> => {
		operations.push(operation);
		void operation.catch(() => {});
		return operation;
	};
	const result: StdioFixture = {
		input,
		output,
		host,
		process,
		lease,
		requests,
		errors,
		operations,
		listen: (caller = new AbortController()) => track(lease.listen(10_000, caller.signal)),
		async request(method, ordinal = 0) {
			for (let attempt = 0; attempt < 8; attempt++) {
				const request = requests.filter((row) => row.method === method)[ordinal];
				if (request) return request;
				await turn();
			}
			throw new Error(`DYTEST missing ${method}`);
		},
		respond,
		close: () => track(lease.close()),
	};
	fixtures.push(result);
	return result;
}
const calls = (f: StdioFixture, method: HostMethod): HostRequest[] =>
	f.requests.filter((row) => row.method === method);

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["performance", "setTimeout", "clearTimeout"] });
	network.mockReset();
	network.mockRejectedValue(new Error("DYTEST network forbidden"));
	vi.stubGlobal("fetch", network);
});
afterEach(async () => {
	const owned = fixtures.splice(0);
	try {
		for (const f of owned) {
			f.process.abort();
			f.host.close();
			f.input.destroy();
			f.output.destroy();
			const closing = f.lease.close();
			f.operations.push(closing);
			void closing.catch(() => {});
		}
		await Promise.allSettled(owned.flatMap((f) => f.operations));
		for (const f of owned) expect(f.errors).toEqual([]);
		expect(network).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
	} finally {
		vi.unstubAllGlobals();
		vi.useRealTimers();
	}
});

describe("Slack Socket lease on the SDK stdio channel", () => {
	it.each(["before", "after"] as const)(
		"keeps the owned notification %s the open reply in the same chunk",
		async (position) => {
			const f = fixture({
				opening: (_request, reply) => (position === "before" ? event() + reply : reply + event()),
			});
			await expect(f.listen()).resolves.toEqual({ leaseMs: 10_000 });
			await f.request("host/changed");
			expect(calls(f, "host/ws.send").map((row) => row.params)).toEqual([
				{ socketId: SOCKET_ID, envelopeId: ENVELOPE_ID },
			]);
			expect(calls(f, "host/changed").map((row) => row.params)).toEqual([{}]);
			expect(JSON.stringify(f.requests)).not.toContain("DYTEST private message is not forwarded");
			await f.close();
			expect(calls(f, "host/ws.close").map((row) => row.params)).toEqual([{ socketId: SOCKET_ID }]);
		},
	);

	it("discards foreign IDs from the same stdio chunk before processing the bound socket", async () => {
		const f = fixture({
			opening: (_request, reply) => event(FOREIGN_ID, FOREIGN_ENVELOPE_ID) + reply,
		});
		await f.listen();
		await turn();
		expect(calls(f, "host/ws.send")).toHaveLength(0);
		expect(calls(f, "host/changed")).toHaveLength(0);
		f.input.write(event());
		await f.request("host/changed");
		expect(calls(f, "host/ws.send").map((row) => row.params)).toEqual([
			{ socketId: SOCKET_ID, envelopeId: ENVELOPE_ID },
		]);
		f.input.write(event(FOREIGN_ID, FOREIGN_ENVELOPE_ID));
		await turn();
		expect(calls(f, "host/ws.send")).toHaveLength(1);
		expect(calls(f, "host/changed")).toHaveLength(1);
		await f.close();
	});

	it("keeps a committed lease after its successful listen caller is aborted", async () => {
		const f = fixture();
		const caller = new AbortController();
		await expect(f.listen(caller)).resolves.toEqual({ leaseMs: 10_000 });
		caller.abort();
		f.input.write(event());
		await f.request("host/changed");
		expect(calls(f, "host/ws.send")).toHaveLength(1);
		expect(calls(f, "host/ws.close")).toHaveLength(0);
		expect(f.process.signal.aborted).toBe(false);
		await f.close();
		expect(calls(f, "host/ws.close")).toHaveLength(1);
	});

	it("retires a pending SDK open on EOF without attempting a closed-channel RPC", async () => {
		const f = fixture({ opening: () => undefined });
		const opening = f.listen();
		await f.request("host/ws.open");
		f.input.end();
		await expect(opening).rejects.toThrow("SLACK_LEASE_ABORTED");
		await f.close();
		await vi.advanceTimersByTimeAsync(60_000);
		expect(calls(f, "host/ws.open")).toHaveLength(1);
		expect(calls(f, "host/ws.close")).toHaveLength(0);
		expect(calls(f, "host/ws.send")).toHaveLength(0);
		expect(vi.getTimerCount()).toBe(0);
		await expect(f.listen()).rejects.toThrow("SLACK_LEASE_ABORTED");
	});

	it("settles pending acknowledgement work on EOF without notifying or reconnecting", async () => {
		const f = fixture({ holdAck: true });
		await f.listen();
		f.input.write(event());
		await f.request("host/ws.send");
		f.input.end();
		await turn();
		await f.close();
		await vi.advanceTimersByTimeAsync(60_000);
		expect(calls(f, "host/changed")).toHaveLength(0);
		expect(calls(f, "host/ws.open")).toHaveLength(1);
		expect(calls(f, "host/ws.close")).toHaveLength(0);
		expect(vi.getTimerCount()).toBe(0);
	});
});
