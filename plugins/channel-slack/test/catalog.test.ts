import { createSlackReadFake, SLACK_READ_HOST } from "@draftyak/fakes/slack";
import { HOST_MAX_STREAM_BYTES } from "@draftyak/protocol/host-channel";
import { createPluginContext, type PluginContext } from "@draftyak/sdk/context";
import type { HostFetch } from "@draftyak/sdk/fetch";
import { memoryHost } from "@draftyak/sdk/host";
import { afterEach, describe, expect, it } from "vitest";
import {
	fetchConversationInfo,
	MAX_SLACK_CATALOG_PAGES,
	pollConversationListPages,
	type SlackConversationListOptions,
} from "../src/catalog.ts";

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

interface Plan {
	readonly bytes: Uint8Array;
	readonly status?: number;
	readonly media?: string;
	readonly reference?: string;
	readonly stream?: boolean;
	readonly chunkSize?: number;
	readonly headerGate?: Gate;
	readonly headersSeen?: Gate;
	readonly cleanupSeen?: Gate;
	readonly cleanupGate?: Gate;
	signal?: AbortSignal;
	streamId?: string;
}

function json(value: unknown, options: Omit<Plan, "bytes"> = {}): Plan {
	return { bytes: Buffer.from(JSON.stringify(value)), ...options };
}
function row(patch: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: "CDYTEST01",
		name: "DYTEST room",
		is_channel: true,
		is_group: false,
		is_im: false,
		is_mpim: false,
		is_private: false,
		...patch,
	};
}
function page(
	cursor = "",
	rows: unknown[] = [row()],
	extra: Record<string, unknown> = {},
): unknown {
	return { ok: true, channels: rows, response_metadata: { next_cursor: cursor }, ...extra };
}
function info(id = "CDYTEST01", patch: Record<string, unknown> = {}): unknown {
	return {
		ok: true,
		channel: row({
			id,
			is_member: true,
			num_members: 7,
			is_archived: false,
			is_shared: false,
			is_ext_shared: false,
			is_org_shared: false,
			is_pending_ext_shared: false,
			...patch,
		}),
	};
}

interface Fixture {
	readonly ctx: Pick<PluginContext, "fetch" | "signal">;
	readonly controller: AbortController;
	readonly requests: Record<string, unknown>[];
	dispose(): Promise<void>;
}
const fixtures: Fixture[] = [];

function fixture(...plans: Plan[]): Fixture {
	const allPlans = [...plans];
	const controller = new AbortController();
	const requests: Record<string, unknown>[] = [];
	const pending: Plan[] = [];
	const pumps = new Set<Promise<void>>();
	const pumpErrors: unknown[] = [];
	let disposed = false;
	let nextStream = 0;
	const parent = memoryHost(async (method, raw) => {
		if (method !== "host/fetch") throw new Error("DYTEST unexpected host method");
		requests.push(raw as Record<string, unknown>);
		const plan = pending.shift();
		if (!plan) throw new Error("DYTEST missing response plan");
		const common = {
			status: plan.status ?? 200,
			headers: [["content-type", plan.media ?? "application/json"]],
		};
		if (plan.stream) {
			plan.streamId = `catalog-stream-${++nextStream}`;
			return { ...common, streamId: plan.streamId };
		}
		return {
			...common,
			body:
				plan.reference === undefined
					? { base64: Buffer.from(plan.bytes).toString("base64url") }
					: { ref: plan.reference },
		};
	});
	const original = createPluginContext({ plugin: "slack-dytest" }, parent, controller.signal);
	const fetch: HostFetch = async (input, init) => {
		const plan = plans.shift();
		if (!plan) throw new Error("DYTEST unexpected fetch");
		plan.signal = init?.signal instanceof AbortSignal ? init.signal : undefined;
		pending.push(plan);
		const response = await original.fetch(input, init);
		if ((plan.cleanupSeen || plan.cleanupGate) && response.body !== null) {
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
							plan.cleanupSeen?.release();
							if (plan.cleanupGate) await plan.cleanupGate.promise;
							return cancel(reason);
						},
					});
					return reader;
				},
			});
		}
		if (plan.streamId !== undefined) {
			const work = (async () => {
				const size = plan.chunkSize ?? 65_536;
				for (
					let offset = 0, sequence = 0;
					offset < plan.bytes.length || sequence === 0;
					sequence++
				) {
					if (disposed || controller.signal.aborted || plan.signal?.aborted) return;
					const end = Math.min(offset + size, plan.bytes.length);
					parent.notify({
						jsonrpc: "2.0",
						method: "host/stream.chunk",
						params: {
							streamId: plan.streamId as string,
							sequence,
							base64: Buffer.from(plan.bytes.subarray(offset, end)).toString("base64url"),
							done: end === plan.bytes.length,
						},
					});
					if (end === plan.bytes.length) return;
					offset = end;
					await new Promise<void>((resolve) => setImmediate(resolve));
				}
			})();
			pumps.add(work);
			void work.then(
				() => pumps.delete(work),
				(error: unknown) => {
					pumps.delete(work);
					if (!disposed && !plan.signal?.aborted) pumpErrors.push(error);
				},
			);
		}
		plan.headersSeen?.release();
		if (plan.headerGate) await plan.headerGate.promise;
		return response;
	};
	const owned: Fixture = {
		ctx: Object.freeze({ fetch, signal: original.signal }),
		controller,
		requests,
		async dispose() {
			disposed = true;
			for (const plan of allPlans) {
				plan.headerGate?.release();
				plan.cleanupGate?.release();
			}
			controller.abort();
			parent.close();
			await Promise.allSettled([...pumps]);
			expect(pumpErrors).toEqual([]);
		},
	};
	fixtures.push(owned);
	return owned;
}

afterEach(async () => {
	try {
		for (const owned of fixtures) await owned.dispose();
	} finally {
		fixtures.length = 0;
	}
});

describe("Slack catalog transport", () => {
	it("captures request options now but performs the fixed all-types GET only on next", async () => {
		const owned = fixture(json(page()));
		const options = { maxPages: 1, cursor: "opaque/+%=:cursor" };
		const pages = pollConversationListPages(owned.ctx, options);
		options.cursor = "changed";
		options.maxPages = 128;
		expect(owned.requests).toEqual([]);
		const first = await pages.next();
		expect(first.done).toBe(false);
		const request = owned.requests[0];
		expect(request).toMatchObject({ method: "GET", stream: true, headers: [] });
		const url = new URL(request?.url as string);
		expect(url.origin + url.pathname).toBe("https://slack.com/api/users.conversations");
		expect([...url.searchParams]).toEqual([
			["types", "public_channel,private_channel,mpim,im"],
			["limit", "100"],
			["cursor", "opaque/+%=:cursor"],
		]);
		for (const name of ["body", "saveAs", "sendTicket", "lookupPermit"])
			expect(request).not.toHaveProperty(name);
		await pages.return(undefined);
	});

	it.each([undefined, ""])(
		"normalizes absent or empty cursor %s without inventing a provider token",
		async (cursor) => {
			const owned = fixture(json(page()));
			await pollConversationListPages(owned.ctx, { maxPages: 1, cursor }).next();
			expect(new URL(owned.requests[0]?.url as string).searchParams.has("cursor")).toBe(false);
		},
	);

	it("preserves the complete 4096-character opaque cursor through URL encoding", async () => {
		const owned = fixture(json(page()));
		const cursor = `${"x".repeat(4088)}/+%=?:x!`;
		expect(cursor).toHaveLength(4096);
		await pollConversationListPages(owned.ctx, { maxPages: 1, cursor }).next();
		expect(new URL(owned.requests[0]?.url as string).searchParams.get("cursor")).toBe(cursor);
	});

	it("fetches explicit facts for exactly the requested conversation with include_num_members", async () => {
		const owned = fixture(json(info()));
		const value = await fetchConversationInfo(owned.ctx, "CDYTEST01");
		expect(value).toEqual({
			kind: "chat.conversation",
			channelId: "CDYTEST01",
			name: "DYTEST room",
			type: "public",
			external: false,
			shared: false,
			memberCount: 7,
			archived: false,
			member: true,
		});
		expect(Object.isFrozen(value)).toBe(true);
		const request = owned.requests[0];
		expect(request).toMatchObject({ method: "GET", stream: true, headers: [] });
		const url = new URL(request?.url as string);
		expect(url.origin + url.pathname).toBe("https://slack.com/api/conversations.info");
		expect([...url.searchParams]).toEqual([
			["channel", "CDYTEST01"],
			["include_num_members", "true"],
		]);
	});

	it("rejects otherwise valid info belonging to a different requested conversation", async () => {
		const owned = fixture(json(info("CDYTEST02")));
		await expect(fetchConversationInfo(owned.ctx, "CDYTEST01")).rejects.toThrow(
			/^SLACK_CATALOG_INVALID$/,
		);
		expect(owned.requests).toHaveLength(1);
	});

	it("preserves an opaque 256-character conversation ID without interpreting it as URL syntax", async () => {
		const id = `${"x".repeat(248)}/?#&=+%!`;
		expect(id).toHaveLength(256);
		const owned = fixture(json(info(id)));
		expect((await fetchConversationInfo(owned.ctx, id)).channelId).toBe(id);
		const url = new URL(owned.requests[0]?.url as string);
		expect(url.origin + url.pathname).toBe("https://slack.com/api/conversations.info");
		expect(url.searchParams.get("channel")).toBe(id);
	});

	it("does not fabricate a DM count or membership when info omits those facts", async () => {
		const dm = {
			id: "DM:opaque",
			is_im: true,
			is_private: true,
			is_archived: false,
			is_shared: false,
			is_ext_shared: false,
		};
		for (const data of [dm, { ...dm, is_member: true }, { ...dm, num_members: 2 }]) {
			const owned = fixture(json({ ok: true, channel: data }));
			await expect(fetchConversationInfo(owned.ctx, "DM:opaque")).rejects.toThrow(
				/^SLACK_CATALOG_INVALID$/,
			);
		}
	});

	it("returns minimal listing data without inventing info facts", async () => {
		const owned = fixture(json(page("", [{ id: "DM:opaque", is_im: true }])));
		const result = await pollConversationListPages(owned.ctx, { maxPages: 1 }).next();
		expect(result.value).toEqual({
			conversations: [{ channelId: "DM:opaque", type: "dm" }],
			nextCursor: undefined,
			more: false,
		});
		expect(result.value).not.toHaveProperty("changes");
	});

	it("lazily retains empty non-final pages and consumes their exact cursor on demand", async () => {
		const owned = fixture(json(page("opaque-next", [])), json(page("", [row()])));
		const pages = pollConversationListPages(owned.ctx, { maxPages: 2 });
		const first = await pages.next();
		expect(first.value).toEqual({ conversations: [], nextCursor: "opaque-next", more: true });
		expect(owned.requests).toHaveLength(1);
		const second = await pages.next();
		expect(second.value?.conversations).toHaveLength(1);
		expect(new URL(owned.requests[1]?.url as string).searchParams.get("cursor")).toBe(
			"opaque-next",
		);
		expect(await pages.next()).toEqual({ value: undefined, done: true });
	});

	it("rejects a repeated initial cursor before yielding an otherwise valid page", async () => {
		const owned = fixture(json(page("resume-token", [row()])));
		const options = { cursor: "resume-token", maxPages: 2 };
		const pages = pollConversationListPages(owned.ctx, options);
		await expect(pages.next()).rejects.toThrow(/^SLACK_CATALOG_INVALID$/);
		expect(owned.requests).toHaveLength(1);
		expect(options).toEqual({ cursor: "resume-token", maxPages: 2 });
		expect(await pages.next()).toEqual({ value: undefined, done: true });
	});

	it("rejects a later cursor cycle before delivering the cyclic page", async () => {
		const owned = fixture(json(page("next-A")), json(page("next-A", [row({ id: "CDYTEST02" })])));
		const pages = pollConversationListPages(owned.ctx, { maxPages: 3 });
		expect((await pages.next()).value?.nextCursor).toBe("next-A");
		await expect(pages.next()).rejects.toThrow(/^SLACK_CATALOG_INVALID$/);
		expect(owned.requests).toHaveLength(2);
	});

	it("does not turn a mechanical page cap or a missing continuation into completeness", async () => {
		expect(MAX_SLACK_CATALOG_PAGES).toBe(128);
		const capped = fixture(json(page("still-more")));
		const pages = pollConversationListPages(capped.ctx, { maxPages: 1 });
		expect((await pages.next()).value).toMatchObject({ more: true, nextCursor: "still-more" });
		expect(await pages.next()).toEqual({ value: undefined, done: true });
		expect(capped.requests).toHaveLength(1);
		const incomplete = fixture(json(page("", [], { has_more: true })));
		const pending = pollConversationListPages(incomplete.ctx, { maxPages: 128 });
		expect((await pending.next()).value).toEqual({
			conversations: [],
			nextCursor: undefined,
			more: true,
		});
		expect(await pending.next()).toEqual({ value: undefined, done: true });
		expect(incomplete.requests).toHaveLength(1);
	});

	it("refuses a malformed whole page without yielding its valid prefix or advancing", async () => {
		const owned = fixture(
			json(page("would-advance", [row(), row({ id: "CDYTEST02", is_private: "false" })])),
		);
		const pages = pollConversationListPages(owned.ctx, { maxPages: 2 });
		await expect(pages.next()).rejects.toThrow(/^SLACK_CATALOG_INVALID$/);
		expect(owned.requests).toHaveLength(1);
		expect(await pages.next()).toEqual({ value: undefined, done: true });
	});

	it("uses SDK streaming for a 999-row legal discovery page larger than a frame", async () => {
		const data = page(
			"",
			Array.from({ length: 999 }, (_, at) =>
				row({ id: `room:${at}`, name: "\u{1f642}".repeat(256) }),
			),
		);
		const response = json(data, { stream: true });
		expect(response.bytes.length).toBeGreaterThan(1_048_576);
		const owned = fixture(response);
		const result = await pollConversationListPages(owned.ctx, { maxPages: 1 }).next();
		expect(result.value?.conversations).toHaveLength(999);
		expect(result.value?.more).toBe(false);
		expect(owned.requests[0]?.stream).toBe(true);
		expect(response.signal?.aborted).toBe(true);
	});

	it("decodes UTF-8 codepoints split across genuine SDK stream chunks", async () => {
		const owned = fixture(
			json(page("", [row({ name: "DYTEST \u{1f642} e\u0301" })]), { stream: true, chunkSize: 3 }),
		);
		const result = await pollConversationListPages(owned.ctx, { maxPages: 1 }).next();
		expect(result.value?.conversations[0]?.name).toBe("DYTEST \u{1f642} e\u0301");
	});

	it("refuses a real SDK stream beyond the shared byte ceiling", async () => {
		const response: Plan = { bytes: Buffer.alloc(HOST_MAX_STREAM_BYTES + 1, 0x20), stream: true };
		const owned = fixture(response);
		await expect(pollConversationListPages(owned.ctx, { maxPages: 1 }).next()).rejects.toThrow(
			/^SLACK_CATALOG_INVALID$/,
		);
		expect(response.signal?.aborted).toBe(true);
		expect(owned.requests).toHaveLength(1);
	});

	it.each([
		json(page(), { status: 503 }),
		json(page(), { media: "text/plain" }),
		json({ ok: false, error: "DYTEST provider refused" }),
		json(null),
		{ bytes: Buffer.from("{") },
		{ bytes: Buffer.from([0xc3, 0x28]) },
		{ bytes: Buffer.alloc(0), reference: "01ARZ3NDEKTSV4RRFFQ69G5FAV" },
	])(
		"refuses unsuccessful, malformed, non-JSON, or opaque body responses safely",
		async (response) => {
			const owned = fixture(response);
			await expect(pollConversationListPages(owned.ctx, { maxPages: 1 }).next()).rejects.toThrow(
				/^SLACK_CATALOG_INVALID$/,
			);
			expect(owned.requests).toHaveLength(1);
		},
	);

	it("cleans each owned request before exposing either a page or hydrated info", async () => {
		const listReply = json(page());
		const infoReply = json(info());
		const owned = fixture(listReply, infoReply);
		const pageResult = await pollConversationListPages(owned.ctx, { maxPages: 1 }).next();
		expect(pageResult.done).toBe(false);
		expect(listReply.signal?.aborted).toBe(true);
		await fetchConversationInfo(owned.ctx, "CDYTEST01");
		expect(infoReply.signal?.aborted).toBe(true);
		expect(owned.controller.signal.aborted).toBe(false);
	});

	it("refuses a caller cancelled before work and does not prefetch after early return", async () => {
		const cancelled = fixture();
		cancelled.controller.abort();
		await expect(pollConversationListPages(cancelled.ctx, { maxPages: 1 }).next()).rejects.toThrow(
			/^SLACK_CATALOG_ABORTED$/,
		);
		await expect(fetchConversationInfo(cancelled.ctx, "CDYTEST01")).rejects.toThrow(
			/^SLACK_CATALOG_ABORTED$/,
		);
		expect(cancelled.requests).toEqual([]);
		const live = fixture(json(page("unused-next")));
		const pages = pollConversationListPages(live.ctx, { maxPages: 2 });
		await pages.next();
		await pages.return(undefined);
		expect(live.requests).toHaveLength(1);
		expect(live.controller.signal.aborted).toBe(false);
	});

	it("refuses cancellation after genuine inline SDK headers but before page delivery", async () => {
		const headers = gate();
		const resume = gate();
		const response = json(page("would-advance"), { headersSeen: headers, headerGate: resume });
		const owned = fixture(response);
		const pages = pollConversationListPages(owned.ctx, { maxPages: 2 });
		const pending = pages.next();
		const refused = expect(pending).rejects.toThrow(/^SLACK_CATALOG_ABORTED$/);
		await headers.promise;
		owned.controller.abort();
		resume.release();
		await refused;
		expect(owned.requests).toHaveLength(1);
		expect(response.signal?.aborted).toBe(true);
	});

	it("refuses late info cancellation after inline SDK headers rather than returning facts", async () => {
		const headers = gate();
		const resume = gate();
		const owned = fixture(json(info(), { headersSeen: headers, headerGate: resume }));
		const pending = fetchConversationInfo(owned.ctx, "CDYTEST01");
		const refused = expect(pending).rejects.toThrow(/^SLACK_CATALOG_ABORTED$/);
		await headers.promise;
		owned.controller.abort();
		resume.release();
		await refused;
	});

	it("rejects info cancellation while the genuine SDK reader cleanup is pending", async () => {
		const cleanupSeen = gate();
		const cleanupGate = gate();
		const response = json(info(), { cleanupSeen, cleanupGate });
		const owned = fixture(response);
		const pending = fetchConversationInfo(owned.ctx, "CDYTEST01");
		const refused = expect(pending).rejects.toThrow(/^SLACK_CATALOG_ABORTED$/);
		await cleanupSeen.promise;
		expect(response.signal?.aborted).toBe(true);
		expect(owned.controller.signal.aborted).toBe(false);
		owned.controller.abort();
		cleanupGate.release();
		await refused;
		expect(owned.requests).toHaveLength(1);
	});

	it("rejects bad option and channel data synchronously before any request", () => {
		const owned = fixture();
		for (const maxPages of [0, 129, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(() => pollConversationListPages(owned.ctx, { maxPages })).toThrow(
				/^SLACK_CATALOG_INVALID$/,
			);
		}
		for (const cursor of ["has space", "x".repeat(4097), "\n", 7]) {
			expect(() =>
				pollConversationListPages(owned.ctx, {
					maxPages: 1,
					cursor,
				} as unknown as SlackConversationListOptions),
			).toThrow(/^SLACK_CATALOG_INVALID$/);
		}
		for (const channel of ["", "has space", "x".repeat(257), "\n", 7]) {
			expect(() => fetchConversationInfo(owned.ctx, channel as string)).toThrow(
				/^SLACK_CATALOG_INVALID$/,
			);
		}
		expect(owned.requests).toEqual([]);
	});

	it("does not invoke caller behavior while capturing known fields or ignoring extras", async () => {
		const owned = fixture(json(page()));
		let calls = 0;
		const poison = new Proxy(
			{},
			{
				get() {
					calls++;
					throw new Error("DYTEST unselected");
				},
				ownKeys() {
					calls++;
					return [];
				},
				getPrototypeOf() {
					calls++;
					return null;
				},
			},
		);
		expect(() =>
			pollConversationListPages(owned.ctx, poison as SlackConversationListOptions),
		).toThrow(/^SLACK_CATALOG_INVALID$/);
		for (const key of ["cursor", "maxPages"]) {
			const options = { maxPages: 1 };
			Object.defineProperty(options, key, {
				enumerable: true,
				get() {
					calls++;
					return 1;
				},
			});
			expect(() => pollConversationListPages(owned.ctx, options)).toThrow(
				/^SLACK_CATALOG_INVALID$/,
			);
		}
		const options = { maxPages: 1, ignored: poison };
		Object.defineProperty(options, "toJSON", {
			get() {
				calls++;
				return poison;
			},
		});
		Object.defineProperty(options, Symbol.iterator, { value: poison });
		await pollConversationListPages(owned.ctx, options).next();
		expect(calls).toBe(0);
	});

	it("composes actual public-only FakeSlack listing and info through the SDK memory host", async () => {
		const upstream = createSlackReadFake({
			conversations: Array.from({ length: 101 }, (_, at) => ({
				id: `C${String(at).padStart(4, "0")}`,
				name: `DYTEST room ${at}`,
				kind: "public_channel" as const,
				member: at === 100,
				archived: false,
				sharing: "none" as const,
				memberCount: 5,
			})),
		});
		const controller = new AbortController();
		const parent = memoryHost(async (method, raw, signal) => {
			if (method !== "host/fetch") throw new Error("DYTEST unexpected host method");
			const params = raw as { url: string; method: string; headers: [string, string][] };
			const url = new URL(params.url);
			expect(url.origin).toBe("https://slack.com");
			url.hostname = SLACK_READ_HOST;
			const response = await upstream.fetch(url, {
				method: params.method,
				headers: params.headers,
				signal,
			});
			return {
				status: response.status,
				headers: [...response.headers],
				body: { base64: Buffer.from(await response.arrayBuffer()).toString("base64url") },
			};
		});
		const ctx = createPluginContext({ plugin: "slack-dytest" }, parent, controller.signal);
		try {
			const pages = pollConversationListPages(ctx, { maxPages: 3 });
			const first = await pages.next();
			expect(first.value?.conversations).toEqual([]);
			expect(first.value?.more).toBe(true);
			expect(first.value?.nextCursor).toEqual(expect.any(String));
			const second = await pages.next();
			expect(second.value?.conversations.map((item) => item.channelId)).toEqual(["C0100"]);
			expect(second.value?.more).toBe(false);
			expect(await pages.next()).toEqual({ value: undefined, done: true });
			expect(await fetchConversationInfo(ctx, "C0100")).toMatchObject({
				channelId: "C0100",
				member: true,
				memberCount: 5,
			});
		} finally {
			controller.abort();
			parent.close();
		}
	});
});
