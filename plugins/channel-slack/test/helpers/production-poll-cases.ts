import { createSlackReadFake, SLACK_READ_HOST } from "@draftyak/fakes/slack";
import { channelV1, type SyncPage, type SyncRequest } from "@draftyak/protocol/channel-v1";
import { HostFetchParams, type HostMethods } from "@draftyak/protocol/host-channel";
import type { PluginChange } from "@draftyak/protocol/normalized-change";
import { describe, expect, it, vi } from "vitest";
import { LEGACY_SYNC_NOW, legacySyncConversation } from "./legacy-sync-fake.ts";
import { type HostRequest, startProductionMain } from "./production-process.ts";

const CHANNEL = "CDYTEST1";
const OTHER = "CDYTEST2";
const SINCE = 1_800_000_000_000;
const ROOT = "1800000000.000000001";
const REPLY = "1800000000.000000002";
const SECOND_ROOT = "1800000001.000000001";
const NEXT = "1800000002.000000001";
const CATALOG_PAGE = "DYTEST-catalog-page";
const HISTORY_PAGE = "DYTEST-history-page";
const REPLIES_PAGE = "DYTEST-replies-page";

interface ProviderPage {
	ok: boolean;
	channels?: unknown[];
	messages?: unknown[];
	has_more?: boolean;
	response_metadata?: { next_cursor: string };
}
type PageFault = "missing" | "malformed";

function initial(cursor?: string): SyncRequest {
	return { mode: "initial", since: SINCE, ...(cursor === undefined ? {} : { cursor }) };
}

function messages(changes: readonly PluginChange[]) {
	return changes.filter((change) => change.kind === "chat.message");
}

async function fixture(entry: string) {
	const main = await startProductionMain(entry);
	const fake = createSlackReadFake({
		conversations: [legacySyncConversation(CHANNEL), legacySyncConversation(OTHER)],
		nowMs: LEGACY_SYNC_NOW,
	});
	const values = new Map<string, unknown>();
	const fetches: HostFetchParams[] = [];
	const problems: unknown[] = [];
	let fault: PageFault | undefined;
	let networkCalls = 0;
	const network = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
		networkCalls++;
		throw new Error("DYTEST parent network forbidden");
	});
	const add = (ts: string, threadTs?: string) =>
		fake.addMessage(CHANNEL, {
			ts,
			user: "UDYTEST1",
			text: `DYTEST ${ts}`,
			...(threadTs === undefined ? {} : { threadTs }),
		});
	add(ROOT);
	add(REPLY, ROOT);
	add(SECOND_ROOT);

	function reply(request: HostRequest, data: unknown): void {
		main.respond(request, {
			status: 200,
			headers: [["content-type", "application/json"]],
			body: { base64: Buffer.from(JSON.stringify(data)).toString("base64url") },
		});
	}

	async function provider(request: HostRequest): Promise<void> {
		const params = HostFetchParams.parse(request.params);
		fetches.push(params);
		const url = new URL(params.url);
		expect(url.origin).toBe("https://slack.com");
		for (const key of ["body", "sendTicket", "saveAs"]) expect(params).not.toHaveProperty(key);
		if (url.pathname === "/api/auth.test") {
			expect(params.method).toBe("POST");
			expect(params.stream).toBe(false);
			expect([...url.searchParams]).toEqual([]);
			reply(request, { ok: true });
			return;
		}
		expect(params.method).toBe("GET");
		expect(params.stream).toBe(true);
		expect([
			"/api/users.conversations",
			"/api/conversations.info",
			"/api/conversations.history",
			"/api/conversations.replies",
		]).toContain(url.pathname);
		const cursor = url.searchParams.get("cursor");
		const isBody = url.searchParams.has("latest");
		url.searchParams.delete("cursor");
		url.hostname = SLACK_READ_HOST;
		const response = await fake.fetch(url, {
			method: params.method,
			headers: params.headers as [string, string][],
		});
		expect(response.status).toBe(200);
		const page = (await response.json()) as ProviderPage;
		expect(page.ok).toBe(true);
		if (url.pathname === "/api/users.conversations") {
			expect([...url.searchParams.keys()].sort()).toEqual(["limit", "types"]);
			expect(url.searchParams.get("limit")).toBe("100");
			expect(url.searchParams.get("types")).toBe("public_channel,private_channel,mpim,im");
			expect([null, CATALOG_PAGE]).toContain(cursor);
			expect(page.channels).toHaveLength(2);
			if (!Array.isArray(page.channels)) throw new Error("DYTEST missing channel fixture rows");
			page.channels = cursor === null ? page.channels.slice(0, 1) : page.channels.slice(1);
			page.response_metadata = { next_cursor: cursor === null ? CATALOG_PAGE : "" };
		} else if (
			url.pathname === "/api/conversations.history" &&
			url.searchParams.get("channel") === CHANNEL
		) {
			expect([null, HISTORY_PAGE]).toContain(cursor);
			expect(page.messages).toHaveLength(2);
			if (!Array.isArray(page.messages)) throw new Error("DYTEST missing history fixture rows");
			page.messages = cursor === null ? page.messages.slice(0, 1) : page.messages.slice(1);
			page.has_more = cursor === null;
			page.response_metadata = { next_cursor: cursor === null ? HISTORY_PAGE : "" };
			if (fault !== undefined) {
				const selected = fault;
				fault = undefined;
				reply(request, {
					ok: true,
					has_more: false,
					...(selected === "missing" ? {} : { messages: "DYTEST invalid rows" }),
				});
				return;
			}
		} else if (
			url.pathname === "/api/conversations.replies" &&
			url.searchParams.get("ts") === ROOT &&
			!isBody
		) {
			expect([null, REPLIES_PAGE]).toContain(cursor);
			if (!Array.isArray(page.messages)) throw new Error("DYTEST missing reply fixture rows");
			expect(page.messages.length).toBeGreaterThanOrEqual(2);
			page.messages = cursor === null ? page.messages.slice(0, 1) : page.messages.slice(1);
			page.has_more = cursor === null;
			page.response_metadata = { next_cursor: cursor === null ? REPLIES_PAGE : "" };
		} else {
			expect(cursor).toBeNull();
		}
		reply(request, page);
	}

	main.setHostHandler(async (request) => {
		try {
			switch (request.method) {
				case "host/kv.get": {
					const { key } = request.params as HostMethods["host/kv.get"]["params"];
					main.respond(request, { value: structuredClone(values.get(key) ?? null) });
					return;
				}
				case "host/kv.set": {
					const { key, value } = request.params as HostMethods["host/kv.set"]["params"];
					values.set(key, structuredClone(value));
					main.respond(request, null);
					return;
				}
				case "host/kv.delete": {
					const { key } = request.params as HostMethods["host/kv.delete"]["params"];
					values.delete(key);
					main.respond(request, null);
					return;
				}
				case "host/fetch":
					await provider(request);
					return;
				default:
					throw new Error("DYTEST unexpected poll host method");
			}
		} catch (error) {
			problems.push(error);
			main.respondError(request, "DENIED");
		}
	});

	async function step(args: SyncRequest): Promise<SyncPage> {
		const before = fetches.length;
		const page = channelV1.tools.channel_sync.output.parse(await main.call("channel_sync", args));
		expect(fetches.length - before).toBeLessThanOrEqual(1);
		expect(page.cursor).not.toBe(CATALOG_PAGE);
		expect(page.cursor).not.toBe(HISTORY_PAGE);
		expect(page.cursor).not.toBe(REPLIES_PAGE);
		return page;
	}

	async function drain(first: SyncRequest) {
		const pages: SyncPage[] = [];
		let args = first;
		for (let turn = 0; turn < 32; turn++) {
			const page = await step(args);
			pages.push(page);
			if (!page.more)
				return { pages, changes: pages.flatMap((item) => item.changes), cursor: page.cursor };
			args = { ...first, cursor: page.cursor };
		}
		throw new Error("DYTEST bounded process poll did not finish");
	}

	return {
		main,
		values,
		fetches,
		add,
		step,
		drain,
		failNextHistory(value: PageFault) {
			fault = value;
		},
		async finish() {
			main.endInput();
			const exit = await main.waitForExit(3_000);
			expect(exit).toMatchObject({ code: 0, signal: null, originalClose: true });
			expect(exit.error ?? null).toBeNull();
			expect(exit.drains.map((drain) => drain.result)).toEqual(["eof", "eof"]);
			expect(exit.outputEof).toEqual([true, true]);
			expect(main.forcedSignals).toEqual([]);
			expect(main.errors).toEqual([]);
			expect(main.argv).toEqual(main.expectedArgv);
			expect(problems).toEqual([]);
			expect(networkCalls).toBe(0);
		},
		async close() {
			try {
				await main.close();
			} finally {
				network.mockRestore();
			}
		},
	};
}

export function productionPollCases(entry: () => string): void {
	describe("shipping Slack process polling", () => {
		it("describes the channel and probes only through the parent auth.test request", async () => {
			const f = await fixture(entry());
			try {
				expect(await f.main.call("channel_describe")).toEqual({
					channel: "chat",
					mutations: [],
					attachments: false,
					listen: true,
				});
				expect(await f.main.call("channel_probe")).toEqual({ status: "ok" });
				expect(f.fetches.map((request) => new URL(request.url).pathname)).toEqual([
					"/api/auth.test",
				]);
				expect(f.values.size).toBe(0);
				await f.finish();
			} finally {
				await f.close();
			}
		});

		it("continues provider pages across RPCs, fetches observed reply bodies and resumes delta", async () => {
			const f = await fixture(entry());
			try {
				const start = await f.drain(initial());
				expect(start.pages.length).toBeGreaterThan(4);
				expect(start.pages.slice(0, -1).every((page) => page.more)).toBe(true);
				expect(
					messages(start.changes)
						.map((row) => row.ts)
						.sort(),
				).toEqual([ROOT, REPLY, SECOND_ROOT].sort());
				expect(start.changes.filter((change) => change.kind === "chat.conversation")).toHaveLength(
					2,
				);
				for (const cursor of [CATALOG_PAGE, HISTORY_PAGE, REPLIES_PAGE])
					expect(
						f.fetches.some((request) => new URL(request.url).searchParams.get("cursor") === cursor),
					).toBe(true);
				expect(
					await f.main.call("channel_body_fetch", {
						message: { kind: "chat", channelId: CHANNEL, ts: REPLY },
					}),
				).toMatchObject({
					message: {
						kind: "chat.message",
						channelId: CHANNEL,
						ts: REPLY,
						threadTs: ROOT,
						text: `DYTEST ${REPLY}`,
					},
				});
				const request = f.fetches.at(-1);
				if (!request) throw new Error("DYTEST missing body fixture request");
				const body = new URL(request.url);
				expect(body.pathname).toBe("/api/conversations.replies");
				expect([
					body.searchParams.get("ts"),
					body.searchParams.get("oldest"),
					body.searchParams.get("latest"),
				]).toEqual([ROOT, REPLY, REPLY]);
				const quiet = await f.drain({ mode: "delta", cursor: start.cursor });
				expect(quiet.changes).toEqual([]);
				expect(quiet.cursor).toBe(start.cursor);
				f.add(NEXT, ROOT);
				const delta = await f.drain({ mode: "delta", cursor: quiet.cursor });
				expect(messages(delta.changes).map((row) => row.ts)).toEqual([NEXT]);
				expect(delta.cursor).not.toBe(quiet.cursor);
				expect(JSON.stringify([...f.values.values()])).not.toContain(`DYTEST ${ROOT}`);
				await f.finish();
			} finally {
				await f.close();
			}
		});

		it("does not advance stored work or manufacture a cursor after missing or malformed rows", async () => {
			const f = await fixture(entry());
			try {
				const listed = await f.step(initial());
				const info = await f.step(initial(listed.cursor));
				expect(info.changes[0]?.kind).toBe("chat.conversation");
				for (const fault of ["missing", "malformed"] as const) {
					const before = JSON.stringify([...f.values]);
					const fetched = f.fetches.length;
					f.failNextHistory(fault);
					await expect(f.main.call("channel_sync", initial(info.cursor))).rejects.toMatchObject({
						code: "TRANSIENT",
					});
					expect(f.fetches).toHaveLength(fetched + 1);
					expect(JSON.stringify([...f.values])).toBe(before);
				}
				const recovered = await f.drain(initial(info.cursor));
				expect(
					messages(recovered.changes)
						.map((row) => row.ts)
						.sort(),
				).toEqual([ROOT, REPLY, SECOND_ROOT].sort());
				await f.finish();
			} finally {
				await f.close();
			}
		});

		it("rejects an incompatible continuation without fetching or changing its checkpoint", async () => {
			const f = await fixture(entry());
			try {
				const first = await f.step(initial());
				const before = JSON.stringify([...f.values]);
				const fetched = f.fetches.length;
				await expect(
					f.main.call("channel_sync", { mode: "initial", since: SINCE + 1, cursor: first.cursor }),
				).rejects.toMatchObject({ code: "TRANSIENT" });
				expect(f.fetches).toHaveLength(fetched);
				expect(JSON.stringify([...f.values])).toBe(before);
				const continued = await f.step(initial(first.cursor));
				expect(continued.changes[0]?.kind).toBe("chat.conversation");
				await f.finish();
			} finally {
				await f.close();
			}
		});
	});
}
