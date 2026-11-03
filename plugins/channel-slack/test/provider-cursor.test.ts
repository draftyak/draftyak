import { createSlackReadFake, SLACK_READ_HOST, type SlackReadFake } from "@draftyak/fakes/slack";
import type { HostFetchParams } from "@draftyak/protocol/host-channel";
import { createPluginContext, type PluginContext } from "@draftyak/sdk/context";
import { PluginError } from "@draftyak/sdk/errors";
import type { HostFetch } from "@draftyak/sdk/fetch";
import { memoryHost } from "@draftyak/sdk/host";
import { afterEach, describe, expect, it } from "vitest";
import { fetchConversationInfo, pollConversationListPages } from "../src/catalog.ts";
import { pollMessages } from "../src/poll.ts";

const CHANNEL = "CDYTEST1";
const ROOT = "1800000000.000000001";
const EXPIRY = { ok: false, error: "invalid_cursor" };
const turn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

interface Gate {
	readonly promise: Promise<void>;
	release(): void;
}
function gate(): Gate {
	let release = (): void => {};
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release };
}

interface Controls {
	readonly stream?: boolean;
	readonly reference?: string;
	readonly cleanupSeen?: Gate;
	readonly cleanupGate?: Gate;
}
interface Fixture {
	readonly ctx: Pick<PluginContext, "fetch" | "signal">;
	readonly shared: AbortController;
	readonly requests: HostFetchParams[];
	readonly requestSignals: AbortSignal[];
	readonly statuses: number[];
	dispose(): Promise<void>;
}
const fixtures: Fixture[] = [];
type Serve = (url: URL, init: RequestInit) => Response | Promise<Response>;

/** In-memory provider bytes pass through the real host/fetch response and SDK body. */
function sdk(serve: Serve, controls: Controls = {}): Fixture {
	const shared = new AbortController();
	const requests: HostFetchParams[] = [];
	const requestSignals: AbortSignal[] = [];
	const statuses: number[] = [];
	const pumps = new Set<Promise<void>>();
	const pumpErrors: unknown[] = [];
	let closed = false;
	let streamNumber = 0;
	const host = memoryHost(async (method, raw, signal) => {
		if (method !== "host/fetch") throw new Error("DYTEST unexpected host method");
		const params = raw as HostFetchParams;
		requests.push(params);
		const response = await serve(new URL(params.url), {
			method: params.method,
			headers: params.headers as [string, string][],
			signal,
		});
		statuses.push(response.status);
		const bytes = Buffer.from(await response.arrayBuffer());
		const headers = [...response.headers.entries()];
		if (controls.reference !== undefined) {
			return { status: response.status, headers, body: { ref: controls.reference } };
		}
		if (!controls.stream) {
			return { status: response.status, headers, body: { base64: bytes.toString("base64url") } };
		}
		const streamId = `dytest-expiry-${++streamNumber}`;
		const requestSignal = requestSignals.at(-1);
		const pump = (async () => {
			// The SDK must receive the stream ID before any body notification.
			await turn();
			for (let offset = 0, sequence = 0; ; sequence++) {
				if (closed || shared.signal.aborted || requestSignal?.aborted) return;
				const end = Math.min(offset + 16_384, bytes.length);
				host.notify({
					jsonrpc: "2.0",
					method: "host/stream.chunk",
					params: {
						streamId,
						sequence,
						base64: bytes.subarray(offset, end).toString("base64url"),
						done: end === bytes.length,
					},
				});
				if (end === bytes.length) return;
				offset = end;
				await turn();
			}
		})();
		pumps.add(pump);
		void pump.then(
			() => pumps.delete(pump),
			(error: unknown) => {
				pumps.delete(pump);
				if (!closed && !requestSignal?.aborted) pumpErrors.push(error);
			},
		);
		return { status: response.status, headers, streamId };
	});
	const original = createPluginContext({ plugin: "channel-slack" }, host, shared.signal);
	const fetch: HostFetch = async (input, init) => {
		if (init?.signal instanceof AbortSignal) requestSignals.push(init.signal);
		const response = await original.fetch(input, init);
		if ((controls.cleanupSeen || controls.cleanupGate) && response.body !== null) {
			const body = response.body;
			const getReader = body.getReader.bind(body);
			Object.defineProperty(body, "getReader", {
				configurable: true,
				value: () => {
					const reader = getReader();
					const cancel = reader.cancel.bind(reader);
					Object.defineProperty(reader, "cancel", {
						configurable: true,
						value: async (reason?: unknown) => {
							controls.cleanupSeen?.release();
							await controls.cleanupGate?.promise;
							return cancel(reason);
						},
					});
					return reader;
				},
			});
		}
		return response;
	};
	const owned: Fixture = {
		ctx: Object.freeze({ fetch, signal: original.signal }),
		shared,
		requests,
		requestSignals,
		statuses,
		async dispose() {
			closed = true;
			controls.cleanupGate?.release();
			shared.abort();
			host.close();
			await Promise.allSettled([...pumps]);
			expect(pumpErrors).toEqual([]);
		},
	};
	fixtures.push(owned);
	return owned;
}

function through(fake: SlackReadFake): Fixture {
	return sdk((url, init) => {
		expect(url.origin).toBe("https://slack.com");
		const local = new URL(url);
		local.hostname = SLACK_READ_HOST;
		return fake.fetch(local, init);
	});
}

const readers = [
	{
		name: "history",
		invalid: "SLACK_POLL_INVALID",
		aborted: "SLACK_POLL_ABORTED",
		read: (ctx: Fixture["ctx"], cursor?: string): Promise<unknown> =>
			pollMessages(ctx, { kind: "history", channelId: CHANNEL, maxPages: 1, cursor }).next(),
	},
	{
		name: "catalog",
		invalid: "SLACK_CATALOG_INVALID",
		aborted: "SLACK_CATALOG_ABORTED",
		read: (ctx: Fixture["ctx"], cursor?: string): Promise<unknown> =>
			pollConversationListPages(ctx, { maxPages: 1, cursor }).next(),
	},
];

afterEach(async () => {
	try {
		for (const owned of fixtures) await owned.dispose();
	} finally {
		fixtures.length = 0;
	}
});

async function expectExpired(pending: Promise<unknown>): Promise<void> {
	const error: unknown = await pending.then(
		() => undefined,
		(reason: unknown) => reason,
	);
	expect(error).toBeInstanceOf(PluginError);
	if (!(error instanceof PluginError)) throw new Error("DYTEST missing expiry");
	expect(error.result).toEqual({ code: "CURSOR_EXPIRED" });
	expect(error.message).toBe("CURSOR_EXPIRED");
	expect(error.cause).toBeUndefined();
}

describe.each(readers)("Slack $name provider cursor errors", (reader) => {
	it.each([200, 400])(
		"preserves only the complete exact expiry body at status %i",
		async (status) => {
			const owned = sdk(() => Response.json(EXPIRY, { status }), { stream: true });
			await expectExpired(reader.read(owned.ctx, "opaque-cursor"));
			expect(owned.requests).toHaveLength(1);
			expect(new URL(owned.requests[0]?.url as string).searchParams.get("cursor")).toBe(
				"opaque-cursor",
			);
			expect(owned.requestSignals[0]?.aborted).toBe(true);
			expect(owned.shared.signal.aborted).toBe(false);
		},
	);

	it.each([200, 400])("keeps status %i generic when no cursor was sent", async (status) => {
		const owned = sdk(() => Response.json(EXPIRY, { status }));
		await expect(reader.read(owned.ctx)).rejects.toThrow(reader.invalid);
		expect(owned.requests).toHaveLength(1);
	});

	it.each([
		{ label: "another error", body: { ok: false, error: "not_authed" } },
		{ label: "extra metadata", body: { ...EXPIRY, detail: "DYTEST untrusted detail" } },
		{ label: "mixed success", body: { ok: true, error: "invalid_cursor" } },
		{ label: "nonboolean ok", body: { ok: 0, error: "invalid_cursor" } },
		{ label: "missing ok", body: { error: "invalid_cursor" } },
		{ label: "array", body: [EXPIRY] },
	])("does not classify $label as expiry", async ({ body }) => {
		const owned = sdk(() => Response.json(body, { status: 400 }));
		await expect(reader.read(owned.ctx, "opaque-cursor")).rejects.toThrow(reader.invalid);
	});

	it.each([401, 403, 429, 500])("keeps HTTP %i outside the expiry status set", async (status) => {
		const owned = sdk(() => Response.json(EXPIRY, { status }));
		await expect(reader.read(owned.ctx, "opaque-cursor")).rejects.toThrow(reader.invalid);
	});

	it.each([
		{ label: "truncated JSON", bytes: Buffer.from('{"ok":false,"error":"invalid_cursor"') },
		{ label: "trailing JSON", bytes: Buffer.from(`${JSON.stringify(EXPIRY)}{`) },
		{ label: "invalid UTF-8", bytes: Buffer.from([0xc3, 0x28]) },
	])("requires complete valid JSON and UTF-8: $label", async ({ bytes }) => {
		const owned = sdk(
			() => new Response(bytes, { status: 400, headers: { "content-type": "application/json" } }),
			{ stream: true },
		);
		await expect(reader.read(owned.ctx, "opaque-cursor")).rejects.toThrow(reader.invalid);
	});

	it("does not interpret a non-JSON media type or an opaque body reference", async () => {
		const wrongMedia = sdk(
			() =>
				new Response(JSON.stringify(EXPIRY), {
					status: 400,
					headers: { "content-type": "text/plain" },
				}),
		);
		await expect(reader.read(wrongMedia.ctx, "opaque-cursor")).rejects.toThrow(reader.invalid);
		const opaque = sdk(() => Response.json(EXPIRY, { status: 400 }), {
			reference: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
		});
		await expect(reader.read(opaque.ctx, "opaque-cursor")).rejects.toThrow(reader.invalid);
	});

	it("does not trust a same-code error thrown by the host", async () => {
		const owned = sdk(() => {
			throw new PluginError("CURSOR_EXPIRED");
		});
		await expect(reader.read(owned.ctx, "opaque-cursor")).rejects.toThrow(reader.invalid);
		expect(owned.requests).toHaveLength(1);
	});

	it("lets cancellation during genuine reader cleanup override expiry", async () => {
		const cleanupSeen = gate();
		const cleanupGate = gate();
		const owned = sdk(() => Response.json(EXPIRY, { status: 400 }), { cleanupSeen, cleanupGate });
		const pending = reader.read(owned.ctx, "opaque-cursor");
		const refused = expect(pending).rejects.toThrow(reader.aborted);
		try {
			await cleanupSeen.promise;
			expect(owned.requestSignals[0]?.aborted).toBe(true);
			expect(owned.shared.signal.aborted).toBe(false);
			owned.shared.abort();
		} finally {
			cleanupGate.release();
			await refused;
		}
		expect(owned.requests).toHaveLength(1);
	});
});

describe("genuine Slack cursor expiry", () => {
	it("resumes a real history token while live and preserves its timed expiry", async () => {
		const fake = createSlackReadFake({ conversations: [conversation(1)] });
		for (let at = 1; at <= 101; at++) {
			fake.addMessage(CHANNEL, {
				ts: `1800000000.${String(at).padStart(9, "0")}`,
				user: "UDYTEST1",
				text: `DYTEST message ${at}`,
			});
		}
		const owned = through(fake);
		const first = await pollMessages(owned.ctx, {
			kind: "history",
			channelId: CHANNEL,
			maxPages: 1,
		}).next();
		const cursor = first.value?.nextCursor;
		expect(cursor).toMatch(/^[a-f0-9]{32}$/);
		if (cursor === undefined) throw new Error("DYTEST missing real cursor");
		expect(first.value?.changes).toHaveLength(100);
		const resumed = await pollMessages(owned.ctx, {
			kind: "history",
			channelId: CHANNEL,
			maxPages: 1,
			cursor,
		}).next();
		expect(resumed.value?.changes).toHaveLength(1);
		fake.clock.advance(60_000);
		await expectExpired(
			pollMessages(owned.ctx, { kind: "history", channelId: CHANNEL, maxPages: 1, cursor }).next(),
		);
		expect(owned.statuses).toEqual([200, 200, 400]);
	});

	it("resumes a real catalog token while live and preserves its timed expiry", async () => {
		const fake = createSlackReadFake({
			conversations: Array.from({ length: 101 }, (_, at) => conversation(at + 1)),
		});
		const owned = through(fake);
		const first = await pollConversationListPages(owned.ctx, { maxPages: 1 }).next();
		const cursor = first.value?.nextCursor;
		expect(cursor).toMatch(/^[a-f0-9]{32}$/);
		if (cursor === undefined) throw new Error("DYTEST missing real cursor");
		expect(first.value?.conversations).toHaveLength(100);
		const resumed = await pollConversationListPages(owned.ctx, { maxPages: 1, cursor }).next();
		expect(resumed.value?.conversations).toHaveLength(1);
		fake.clock.advance(60_000);
		await expectExpired(pollConversationListPages(owned.ctx, { maxPages: 1, cursor }).next());
		expect(owned.statuses).toEqual([200, 200, 400]);
	});

	it("also preserves expiry for an actual cursor-bearing replies request", async () => {
		const owned = sdk(() => Response.json(EXPIRY, { status: 400 }));
		await expectExpired(
			pollMessages(owned.ctx, {
				kind: "replies",
				channelId: CHANNEL,
				threadTs: ROOT,
				maxPages: 1,
				cursor: "opaque-cursor",
			}).next(),
		);
		expect(new URL(owned.requests[0]?.url as string).pathname).toBe("/api/conversations.replies");
	});

	it.each([200, 400])(
		"does not classify conversation info status %i as cursor expiry",
		async (status) => {
			const owned = sdk(() => Response.json(EXPIRY, { status }));
			await expect(fetchConversationInfo(owned.ctx, CHANNEL)).rejects.toThrow(
				"SLACK_CATALOG_INVALID",
			);
			expect(new URL(owned.requests[0]?.url as string).searchParams.has("cursor")).toBe(false);
		},
	);
});

function conversation(at: number) {
	return {
		id: at === 1 ? CHANNEL : `CDYTEST${at}`,
		name: `dytest-${at}`,
		kind: "public_channel" as const,
		member: true,
		archived: false,
		sharing: "none" as const,
		memberCount: 1,
	};
}
