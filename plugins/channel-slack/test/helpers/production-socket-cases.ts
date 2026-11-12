import { afterEach, describe, expect, it } from "vitest";
import { type ProductionMain, startProductionMain } from "./production-process.ts";

const SOCKET = "DYTEST-production-socket";
const NEXT_SOCKET = "DYTEST-production-next-socket";
const FOREIGN_SOCKET = "DYTEST-production-foreign-socket";
const CONNECTIONS = "https://slack.com/api/apps.connections.open";
const SOCKET_URL = "wss://wss-primary.slack.com/link/?ticket=DYTEST-production";
const LEASE_MS = 10_000;

function event(envelope: string, identity: string): string {
	return JSON.stringify({
		envelope_id: envelope,
		type: "events_api",
		payload: { event_id: identity, event: { type: "message" } },
	});
}

function connectionReply() {
	return {
		status: 200,
		headers: [["content-type", "application/json"]],
		body: {
			base64: Buffer.from(JSON.stringify({ ok: true, url: SOCKET_URL })).toString("base64url"),
		},
	};
}

const count = (child: ProductionMain, method: string): number =>
	child.requests.filter((request) => request.method === method).length;

/** Register against the enclosing suite's one build of the real shipping entry. */
export function productionSocketCases(entry: () => string): void {
	describe("Slack Socket Mode through the production main process", () => {
		const children: ProductionMain[] = [];
		const joined = new WeakSet<ProductionMain>();

		async function start(): Promise<ProductionMain> {
			const child = await startProductionMain(entry());
			children.push(child);
			return child;
		}

		async function naturalEof(child: ProductionMain): Promise<void> {
			child.endInput();
			const result = await child.waitForExit(3_000);
			expect(result).toMatchObject({
				code: 0,
				signal: null,
				error: null,
				originalClose: true,
			});
			expect(result.drains).toHaveLength(2);
			for (const drain of result.drains) {
				expect(drain.result).toBe("eof");
				expect(Number.isSafeInteger(drain.bytes) && drain.bytes >= 0).toBe(true);
			}
			expect(result.outputEof).toEqual([true, true]);
			expect(child.forcedSignals).toEqual([]);
			expect(child.errors).toEqual([]);
			joined.add(child);
		}

		async function describeBarrier(child: ProductionMain): Promise<void> {
			expect(await child.call("channel_describe", {})).toEqual({
				channel: "chat",
				mutations: [],
				attachments: false,
				listen: true,
			});
		}

		async function beginListen(child: ProductionMain) {
			const reply = child.call("channel_listen", { leaseMs: LEASE_MS });
			// A deliberately held opening can be refused by EOF before this function's caller awaits it.
			void reply.catch(() => {});
			const fetch = await child.waitForHost("host/fetch");
			expect(fetch.params).toMatchObject({
				url: CONNECTIONS,
				method: "POST",
				stream: false,
			});
			child.respond(fetch, connectionReply());
			const opening = await child.waitForHost("host/ws.open");
			expect(opening.params).toEqual({ url: SOCKET_URL });
			return { reply, opening };
		}

		async function listen(child: ProductionMain): Promise<void> {
			const pending = await beginListen(child);
			child.respond(pending.opening, { socketId: SOCKET });
			expect(await pending.reply).toEqual({ leaseMs: LEASE_MS });
		}

		async function acknowledge(
			child: ProductionMain,
			ordinal: number,
			envelope: string,
			socketId = SOCKET,
		): Promise<void> {
			const acknowledgement = await child.waitForHost("host/ws.send", ordinal);
			expect(acknowledgement.params).toEqual({ socketId, envelopeId: envelope });
			child.respond(acknowledgement, null);
		}

		async function changed(child: ProductionMain, ordinal: number): Promise<void> {
			const notification = await child.waitForHost("host/changed", ordinal);
			child.respond(notification, null);
		}

		afterEach(async () => {
			const results = await Promise.allSettled(
				children.splice(0).map(async (child) => {
					try {
						if (!joined.has(child)) await naturalEof(child);
					} finally {
						// Cleanup cannot supply the preceding successful natural-exit assertion.
						await child.close();
					}
					expect(child.forcedSignals).toEqual([]);
					expect(child.errors).toEqual([]);
				}),
			);
			expect(results.filter((result) => result.status === "rejected")).toEqual([]);
		});

		it("uses canonical production arguments and exits naturally from a committed idle lease", async () => {
			const child = await start();
			expect(child.argv).toEqual(child.expectedArgv);
			expect(child.kind).toBe(process.platform === "win32" ? "pipe" : "fifo");
			await describeBarrier(child);
			await listen(child);
			expect(count(child, "host/fetch")).toBe(1);
			expect(count(child, "host/ws.open")).toBe(1);
			const beforeEof = child.requests.length;
			await naturalEof(child);
			expect(child.requests).toHaveLength(beforeEof);
			expect(count(child, "host/ws.close")).toBe(0);
		});

		it("queues an owned notification before the open reply and then delivers later notifications", async () => {
			const child = await start();
			const pending = await beginListen(child);
			child.notifySocket(FOREIGN_SOCKET, event("DYTEST-early-foreign", "DYTEST-foreign"));
			child.notifySocket(SOCKET, event("DYTEST-early-owned", "DYTEST-early-event"));
			// These are ordered writes to the real parent pipe, without a same-chunk assumption.
			child.respond(pending.opening, { socketId: SOCKET });
			expect(await pending.reply).toEqual({ leaseMs: LEASE_MS });
			await acknowledge(child, 0, "DYTEST-early-owned");
			await changed(child, 0);
			child.notifySocket(SOCKET, event("DYTEST-late-owned", "DYTEST-late-event"));
			await acknowledge(child, 1, "DYTEST-late-owned");
			await changed(child, 1);
			await naturalEof(child);
			expect(count(child, "host/ws.send")).toBe(2);
			expect(count(child, "host/changed")).toBe(2);
		});

		it("keeps changed behind the actual parent acknowledgement reply", async () => {
			const child = await start();
			await listen(child);
			child.notifySocket(SOCKET, event("DYTEST-held-ack", "DYTEST-held-event"));
			const acknowledgement = await child.waitForHost("host/ws.send");
			expect(acknowledgement.params).toEqual({
				socketId: SOCKET,
				envelopeId: "DYTEST-held-ack",
			});
			await describeBarrier(child);
			expect(count(child, "host/changed")).toBe(0);
			child.respond(acknowledgement, null);
			await changed(child, 0);
			await naturalEof(child);
			expect(count(child, "host/ws.send")).toBe(1);
			expect(count(child, "host/changed")).toBe(1);
		});

		it("acknowledges a repeated envelope without publishing its event twice", async () => {
			const child = await start();
			await listen(child);
			const repeated = event("DYTEST-repeated-envelope", "DYTEST-repeated-event");
			child.notifySocket(SOCKET, repeated);
			await acknowledge(child, 0, "DYTEST-repeated-envelope");
			await changed(child, 0);
			child.notifySocket(SOCKET, repeated);
			await acknowledge(child, 1, "DYTEST-repeated-envelope");
			// A subsequent distinct event is a processor-order barrier after the duplicate.
			child.notifySocket(SOCKET, event("DYTEST-envelope-barrier", "DYTEST-event-barrier"));
			await acknowledge(child, 2, "DYTEST-envelope-barrier");
			await changed(child, 1);
			await naturalEof(child);
			expect(count(child, "host/ws.send")).toBe(3);
			expect(count(child, "host/changed")).toBe(2);
		});

		it("acknowledges distinct envelopes sharing one event id but changes only once for that event", async () => {
			const child = await start();
			await listen(child);
			child.notifySocket(SOCKET, event("DYTEST-first-envelope", "DYTEST-shared-event"));
			await acknowledge(child, 0, "DYTEST-first-envelope");
			await changed(child, 0);
			child.notifySocket(SOCKET, event("DYTEST-second-envelope", "DYTEST-shared-event"));
			await acknowledge(child, 1, "DYTEST-second-envelope");
			child.notifySocket(SOCKET, event("DYTEST-distinct-envelope", "DYTEST-distinct-event"));
			await acknowledge(child, 2, "DYTEST-distinct-envelope");
			await changed(child, 1);
			await naturalEof(child);
			expect(count(child, "host/ws.send")).toBe(3);
			expect(count(child, "host/changed")).toBe(2);
		});

		it("discards a foreign socket notification before an owned message barrier", async () => {
			const child = await start();
			await listen(child);
			child.notifySocket(FOREIGN_SOCKET, event("DYTEST-foreign-envelope", "DYTEST-foreign-event"));
			child.notifySocket(SOCKET, event("DYTEST-owned-envelope", "DYTEST-owned-event"));
			await acknowledge(child, 0, "DYTEST-owned-envelope");
			await changed(child, 0);
			await naturalEof(child);
			expect(count(child, "host/ws.send")).toBe(1);
			expect(count(child, "host/changed")).toBe(1);
		});

		it("joins natural EOF while the parent's socket-open reply is still pending", async () => {
			const child = await start();
			const pending = await beginListen(child);
			const outcome = pending.reply.then(
				() => "resolved",
				() => "rejected",
			);
			expect(count(child, "host/ws.open")).toBe(1);
			await naturalEof(child);
			expect(await outcome).toBe("rejected");
			expect(count(child, "host/ws.close")).toBe(0);
			expect(count(child, "host/ws.send")).toBe(0);
			expect(count(child, "host/changed")).toBe(0);
		});

		it("joins natural EOF with an acknowledgement pending without publishing changed", async () => {
			const child = await start();
			await listen(child);
			child.notifySocket(SOCKET, event("DYTEST-eof-envelope", "DYTEST-eof-event"));
			const acknowledgement = await child.waitForHost("host/ws.send");
			expect(acknowledgement.params).toEqual({
				socketId: SOCKET,
				envelopeId: "DYTEST-eof-envelope",
			});
			await describeBarrier(child);
			expect(count(child, "host/changed")).toBe(0);
			await naturalEof(child);
			expect(count(child, "host/ws.close")).toBe(0);
			expect(count(child, "host/changed")).toBe(0);
		});

		it("reconnects through a fresh provider open and ignores the retired socket", async () => {
			const child = await start();
			await listen(child);
			child.notifySocket(SOCKET, JSON.stringify({ type: "disconnect" }));
			const closing = await child.waitForHost("host/ws.close");
			expect(closing.params).toEqual({ socketId: SOCKET });
			child.respond(closing, null);
			// Exercise the production one-second backoff without replacing timers.
			const fetch = await child.waitForHost("host/fetch", 1);
			expect(fetch.params).toMatchObject({ url: CONNECTIONS, method: "POST", stream: false });
			child.respond(fetch, connectionReply());
			const opening = await child.waitForHost("host/ws.open", 1);
			expect(opening.params).toEqual({ url: SOCKET_URL });
			child.respond(opening, { socketId: NEXT_SOCKET });
			child.notifySocket(SOCKET, event("DYTEST-retired-envelope", "DYTEST-retired-event"));
			child.notifySocket(NEXT_SOCKET, event("DYTEST-reconnected-envelope", "DYTEST-new-event"));
			await acknowledge(child, 0, "DYTEST-reconnected-envelope", NEXT_SOCKET);
			await changed(child, 0);
			await naturalEof(child);
			expect(count(child, "host/fetch")).toBe(2);
			expect(count(child, "host/ws.open")).toBe(2);
			expect(count(child, "host/ws.close")).toBe(1);
			expect(count(child, "host/ws.send")).toBe(1);
			expect(count(child, "host/changed")).toBe(1);
		});
	});
}
