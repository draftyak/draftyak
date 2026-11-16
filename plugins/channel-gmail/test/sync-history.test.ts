import {
	createFake,
	createGmailFake,
	GMAIL_HOST,
	GMAIL_READONLY_SCOPE,
	type GmailFake,
	manualClock,
} from "@draftyak/fakes";
import { createMockHub, type MockPlugin } from "@draftyak/plugin-testkit";
import {
	CHANNEL_V1,
	channelV1,
	type SyncPage,
	type SyncRequest,
} from "@draftyak/protocol/channel-v1";
import { extensionDeclaration } from "@draftyak/protocol/extension";
import { canonicalize } from "@draftyak/protocol/jcs";
import { createPluginContext, type HostChannel, PluginError } from "@draftyak/sdk";
import { checkedTool } from "@draftyak/sdk/definitions";
import { describe, expect, it } from "vitest";
import { gmailHistoryCursor, syncGmailHistory } from "../src/sync-history.ts";

const DATE = 1_710_000_000_123;
const START = "1000";
const ACCOUNT = "00000000000000000000000001";
const PLUGIN = "@example/gmail-sync-history";
const HISTORY = "/gmail/v1/users/me/history";
const MESSAGES = "/gmail/v1/users/me/messages/";
const RAW = new TextEncoder().encode("Subject: DYTEST history sync\r\n\r\nSynthetic body.\r\n");
type DeltaRequest = Extract<SyncRequest, { mode: "delta" }>;

function json(value: unknown): Response {
	return new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
}
function added(count: number) {
	return {
		historyId: String(1000 + count),
		history: Array.from({ length: count }, (_, i) => {
			const suffix = String(i).padStart(6, "0");
			const message = { id: `m${suffix}`, threadId: `t${suffix}` };
			return { id: String(1001 + i), messages: [message], messagesAdded: [{ message }] };
		}),
	};
}
function metadata(id: string) {
	return { id, threadId: `t${id.slice(1)}`, internalDate: String(DATE), labelIds: ["INBOX"] };
}
function errorCode(error: unknown, code: string): boolean {
	return (
		error instanceof PluginError &&
		error.message === code &&
		error.result.code === code &&
		!Object.hasOwn(error, "cause") &&
		!Object.hasOwn(error.result, "detail")
	);
}
async function refused(operation: () => Promise<unknown>, code: string): Promise<boolean> {
	return operation().then(
		() => false,
		(error: unknown) => errorCode(error, code),
	);
}
function refusedNow(operation: () => unknown, code: string): boolean {
	try {
		operation();
		return false;
	} catch (error) {
		return errorCode(error, code);
	}
}

function fixture(
	settings: {
		readonly prepare?: (backend: GmailFake) => void;
		readonly reply?: (request: Request) => Response | Promise<Response> | undefined;
		readonly afterSet?: (host: HostChannel, signal: AbortSignal) => void | Promise<void>;
	} = {},
) {
	const backend = createGmailFake({
		clock: manualClock(DATE),
		accessGrant: () => ({ scopes: [GMAIL_READONLY_SCOPE], expiresAt: DATE + 60_000 }),
	});
	const start = backend.historyId;
	settings.prepare?.(backend);
	let count = 0;
	const historyReplies: { historyId: unknown; nextPageToken: unknown }[] = [];
	const upstream = createFake(
		{
			async fetch(request) {
				count++;
				const scripted = settings.reply?.(request);
				if (scripted !== undefined) return scripted;
				// Synthetic fixture authentication only; the component receives no credential.
				const headers = new Headers(request.headers);
				headers.set("authorization", "Bearer synthetic-sync-history-fixture");
				const response = await backend.fetch(new Request(request, { headers }));
				if (new URL(request.url).pathname === HISTORY && response.status === 200) {
					const data = (await response.clone().json()) as Record<string, unknown>;
					historyReplies.push({ historyId: data.historyId, nextPageToken: data.nextPageToken });
				}
				return response;
			},
		},
		{ host: GMAIL_HOST },
	);
	const plugin: MockPlugin = {
		manifest: {
			id: PLUGIN,
			version: "1.0.0",
			kind: "channel",
			sdk: "1.0.0",
			runtime: "node",
			isolation: "standard",
			contract: { extension: CHANNEL_V1, version: 1 },
			auth: { kind: "none", scopes: [], requiredGrantedScopes: [] },
			credentials: { mode: "brokered", urlSecrets: [] },
			permissions: {},
			dataClasses: ["example.content"],
			license: "Apache-2.0",
			egress: {
				rules: [
					{
						class: "read",
						method: "GET",
						host: GMAIL_HOST,
						pathTemplate: HISTORY,
						query: ["startHistoryId", "maxResults", "pageToken"],
						maxBytes: 4 * 1024 * 1024 + 1024,
						timeoutMs: 30_000,
					},
					{
						class: "read",
						method: "GET",
						host: GMAIL_HOST,
						pathTemplate: `${MESSAGES}{id}`,
						query: ["format"],
						maxBytes: 4 * 1024 * 1024 + 1024,
						timeoutMs: 30_000,
					},
				],
			},
		},
		entry: {
			name: "sync-history-component",
			version: "1.0.0",
			plugin: PLUGIN,
			account: ACCOUNT,
			extensions: { [CHANNEL_V1]: extensionDeclaration(channelV1) },
			tools: [
				checkedTool("history_component", channelV1.tools.channel_sync, (args, context) =>
					syncGmailHistory(context, args as DeltaRequest),
				),
			],
		},
	};
	const hub = createMockHub({
		mode: "in-memory",
		plugin,
		upstreams: [upstream],
		account: { id: ACCOUNT, mode: "read_only" },
	});
	const controller = new AbortController();
	// This owned SDK-reply barrier delegates every real Host operation/result unchanged.
	// It is used only by the two set-acknowledgment tests, not as storage authority.
	const request: HostChannel["request"] = async (method, params, options) => {
		const result = await hub.host.request(method, params, options);
		if (method === "host/kv.set") await settings.afterSet?.(hub.host, controller.signal);
		return result;
	};
	const context = createPluginContext(
		{ plugin: PLUGIN, account: ACCOUNT },
		settings.afterSet ? { ...hub.host, request } : hub.host,
		controller.signal,
	);
	return {
		context,
		start,
		backend,
		historyReplies,
		sdk: (cursor: string) => hub.call("history_component", { mode: "delta", cursor }),
		contextFor: (account: string) =>
			createPluginContext({ plugin: PLUGIN, account }, hub.host, controller.signal),
		call: (cursor: string) => syncGmailHistory(context, { mode: "delta", cursor }),
		count: () => count,
		requests: () =>
			upstream.recorder.takeRequests().map(({ method, path, query, target, bodyLength }) => ({
				method,
				path,
				query,
				target,
				bodyLength,
			})),
		abort: () => controller.abort(),
		async close() {
			controller.abort();
			await hub.close();
		},
	};
}

describe("Gmail history SyncPage adapter", () => {
	it("adapts genuine Gmail add and labels DATA without a parallel decoder", async () => {
		const f = fixture({
			prepare(backend) {
				backend.addMessage({
					id: "m1",
					threadId: "t1",
					raw: RAW,
					internalDate: DATE,
					labelIds: ["INBOX"],
				});
				backend.setLabels("m1", ["INBOX", "UNREAD"]);
			},
		});
		try {
			const page = await f.call(gmailHistoryCursor(f.start));
			expect(page.changes.length).toBe(1);
			expect(page.changes[0]).toEqual({
				kind: "email.message",
				providerId: "m1",
				threadId: "t1",
				internalDate: DATE,
				labelIds: ["INBOX", "UNREAD"],
				sizeBytes: RAW.byteLength,
			});
			expect(page.cursor === gmailHistoryCursor(f.backend.historyId) && !page.more).toBe(true);
			expect(
				Object.isFrozen(page) && Object.isFrozen(page.changes) && Object.isFrozen(page.changes[0]),
			).toBe(true);
			expect(f.count()).toBe(2);
		} finally {
			await f.close();
		}
	});
	it("keeps an unchanged empty delta at the same position", async () => {
		const f = fixture();
		try {
			const cursor = gmailHistoryCursor(f.start);
			const page = await f.call(cursor);
			expect(page.changes.length).toBe(0);
			expect(page.cursor === cursor && !page.more).toBe(true);
			expect(f.count()).toBe(1);
		} finally {
			await f.close();
		}
	});
	it("retains original start and provider tokens and resumes from the conservative watermark", async () => {
		const f = fixture({
			reply(request) {
				const params = new URL(request.url).searchParams;
				if (params.get("startHistoryId") === "1100") return json({ historyId: "1100" });
				const token = params.get("pageToken");
				const ordinal = token === null ? 1 : token === "p1" ? 2 : 3;
				return json({
					historyId: ordinal === 1 ? "1100" : ordinal === 2 ? "1200" : "1150",
					history: [
						{
							id: String(1000 + ordinal),
							messagesDeleted: [{ message: { id: `m${ordinal}`, threadId: `t${ordinal}` } }],
						},
					],
					...(ordinal === 3 ? {} : { nextPageToken: `p${ordinal}` }),
				});
			},
		});
		try {
			const first = await f.call(gmailHistoryCursor(START));
			const second = await f.call(first.cursor);
			const third = await f.call(second.cursor);
			expect(first.more && second.more && !third.more).toBe(true);
			expect([first, second, third].map((p) => p.changes.length)).toEqual([1, 1, 1]);
			expect(third.cursor === gmailHistoryCursor("1100")).toBe(true);
			const fourth = await f.call(third.cursor);
			expect(fourth.cursor === third.cursor && fourth.changes.length === 0 && !fourth.more).toBe(
				true,
			);
			const params = f.requests().map((r) => new URLSearchParams(r.query));
			expect(params.map((p) => p.get("startHistoryId"))).toEqual([START, START, START, "1100"]);
			expect(params.map((p) => p.get("pageToken"))).toEqual([null, "p1", "p2", null]);
			expect(params.every((p) => p.get("maxResults") === "500")).toBe(true);
		} finally {
			await f.close();
		}
	});
	it("retains all500 changes and each existing hydration request", async () => {
		const f = fixture({
			reply(request) {
				const url = new URL(request.url);
				return url.pathname === HISTORY
					? json(added(500))
					: json(metadata(url.pathname.slice(MESSAGES.length)));
			},
		});
		try {
			let cursor = gmailHistoryCursor(START),
				more = true,
				pages = 0;
			const changes: SyncPage["changes"][number][] = [];
			while (more && pages < 72) {
				const page = await f.call(cursor);
				expect(page.changes.length <= 7).toBe(true);
				changes.push(...page.changes);
				cursor = page.cursor;
				more = page.more;
				pages++;
			}
			expect(changes.length).toBe(500);
			expect(pages).toBe(72);
			expect(
				changes.every(
					(change, index) =>
						change.kind === "email.message" &&
						change.providerId === `m${String(index).padStart(6, "0")}`,
				),
			).toBe(true);
			expect(cursor === gmailHistoryCursor("1500") && !more).toBe(true);
			expect(f.count()).toBe(501);
		} finally {
			await f.close();
		}
	});
	it("preserves the existing501 oversized-page refusal instead of slicing", async () => {
		const f = fixture({ reply: () => json(added(501)) });
		try {
			expect(await refused(() => f.call(gmailHistoryCursor(START)), "TRANSIENT")).toBe(true);
			expect(f.count()).toBe(1);
		} finally {
			await f.close();
		}
	});
	it("round-trips a2048-byte quote and backslash token below the4096 cursor cap", async () => {
		const token = '"\\'.repeat(1024);
		const f = fixture({
			reply(request) {
				return json({
					historyId: "1001",
					...(new URL(request.url).searchParams.has("pageToken") ? {} : { nextPageToken: token }),
				});
			},
		});
		try {
			const first = await f.call(gmailHistoryCursor(START));
			expect(first.more && first.cursor.length <= 4096 && /^[!-~]+$/.test(first.cursor)).toBe(true);
			const second = await f.call(first.cursor);
			expect(!second.more && second.cursor === gmailHistoryCursor("1001")).toBe(true);
			const requests = f.requests();
			expect(new URLSearchParams(requests[1]?.query).get("pageToken") === token).toBe(true);
			expect(f.count()).toBe(2);
		} finally {
			await f.close();
		}
	});
	it("snapshots caller cursor DATA before awaiting transport", async () => {
		const request: DeltaRequest = { mode: "delta", cursor: gmailHistoryCursor(START) };
		const f = fixture({
			reply() {
				Object.assign(request, { cursor: gmailHistoryCursor("9000") });
				return json({ historyId: "1001" });
			},
		});
		try {
			const page = await syncGmailHistory(f.context, request);
			expect(page.cursor === gmailHistoryCursor("1001")).toBe(true);
			expect(new URLSearchParams(f.requests()[0]?.query).get("startHistoryId")).toBe(START);
		} finally {
			await f.close();
		}
	});
	for (const id of ["0", "18446744073709551615"])
		it(`keeps canonical uint64 position ${id}`, async () => {
			const f = fixture({ reply: () => json({ historyId: id }) });
			try {
				const cursor = gmailHistoryCursor(id);
				const page = await f.call(cursor);
				expect(page.cursor === cursor && !page.more && page.changes.length === 0).toBe(true);
			} finally {
				await f.close();
			}
		});
	for (const id of ["", "01", "-1", "18446744073709551616"])
		it(`refuses invalid seed ${id.length}:${id.slice(0, 3)}`, () => {
			expect(refusedNow(() => gmailHistoryCursor(id), "INVALID_INPUT")).toBe(true);
		});
	for (const [name, cursor] of [
		["empty", ""],
		["foreign version", "gh2.p.1000"],
		["leading zero", "gh1.p.01000"],
		["overflow", "gh1.p.18446744073709551616"],
		["extra position field", "gh1.p.1000.x"],
		["backward watermark", "gh1.c.1000.999.eA"],
		["empty token", "gh1.c.1000.1001."],
		["padding", "gh1.c.1000.1001.eA=="],
		["noncanonical bits", "gh1.c.1000.1001.eB"],
		["nonASCII token", "gh1.c.1000.1001._w"],
		["oversized cursor", "x".repeat(4097)],
	] as const)
		it(`expires ${name} before fetch`, async () => {
			const f = fixture();
			try {
				expect(await refused(() => f.call(cursor), "CURSOR_EXPIRED")).toBe(true);
				expect(f.count()).toBe(0);
			} finally {
				await f.close();
			}
		});
	it("refuses accessor and proxy request DATA without invoking object behavior", async () => {
		let touched = 0;
		const accessor = Object.defineProperty({ mode: "delta" }, "cursor", {
			enumerable: true,
			get() {
				touched++;
				return "gh1.p.1000";
			},
		});
		const proxy = new Proxy(
			{},
			{
				get() {
					touched++;
					return "gh1.p.1000";
				},
				ownKeys() {
					touched++;
					return [];
				},
			},
		);
		const cyclic: Record<string, unknown> = { mode: "delta", cursor: "gh1.p.1000" };
		cyclic.extra = cyclic;
		const f = fixture();
		try {
			for (const request of [
				accessor,
				proxy,
				cyclic,
				{ mode: "initial", since: 0 },
				{ mode: "delta", cursor: "gh1.p.1000", extra: true },
			]) {
				expect(
					await refused(
						() => syncGmailHistory(f.context, request as DeltaRequest),
						"INVALID_INPUT",
					),
				).toBe(true);
			}
			expect(touched).toBe(0);
			expect(f.count()).toBe(0);
		} finally {
			await f.close();
		}
	});
	for (const [status, code] of [
		[404, "CURSOR_EXPIRED"],
		[401, "AUTH_EXPIRED"],
		[403, "PERMISSION_DENIED"],
		[429, "RATE_LIMITED"],
		[206, "TRANSIENT"],
		[500, "TRANSIENT"],
	] as const) {
		it(`preserves history HTTP${status} as${code}`, async () => {
			const f = fixture({ reply: () => new Response("{}", { status }) });
			try {
				expect(await refused(() => f.call(gmailHistoryCursor(START)), code)).toBe(true);
				expect(f.count()).toBe(1);
			} finally {
				await f.close();
			}
		});
	}
	it("does not misclassify hydration404 as an expired history cursor", async () => {
		const f = fixture({
			reply: (request) =>
				new URL(request.url).pathname === HISTORY
					? json(added(1))
					: new Response("{}", { status: 404 }),
		});
		try {
			expect(await refused(() => f.call(gmailHistoryCursor(START)), "TRANSIENT")).toBe(true);
			expect(f.count()).toBe(2);
		} finally {
			await f.close();
		}
	});
	it("preserves cancellation before a continuation without another request", async () => {
		const f = fixture({ reply: () => json({ historyId: "1001", nextPageToken: "p1" }) });
		try {
			const page = await f.call(gmailHistoryCursor(START));
			expect(page.more).toBe(true);
			f.abort();
			expect(await refused(() => f.call(page.cursor), "TRANSIENT")).toBe(true);
			expect(f.count()).toBe(1);
		} finally {
			await f.close();
		}
	});
});

const SNAPSHOT_SLOT = "gh1.snapshot.v1";
type HistoryFixture = ReturnType<typeof fixture>;

function seeded(
	count = 16,
	settings: Omit<NonNullable<Parameters<typeof fixture>[0]>, "prepare"> = {},
	toggles = 0,
) {
	const ids = Array.from({ length: count }, (_, index) => `g${String(index).padStart(4, "0")}`);
	const f = fixture({
		...settings,
		prepare(backend) {
			for (const [index, id] of ids.entries())
				backend.addMessage({
					id,
					threadId: `t${String(index).padStart(4, "0")}`,
					raw: RAW,
					internalDate: DATE,
					labelIds: ["INBOX"],
				});
			for (let index = 0; index < toggles; index++) {
				const id = ids[index % ids.length];
				if (id === undefined) throw new Error("Synthetic history seed unavailable");
				backend.setLabels(
					id,
					Math.floor(index / ids.length) % 2 === 0 ? ["INBOX", "UNREAD"] : ["INBOX"],
				);
			}
		},
	});
	const expected = ids.map((providerId, index) => ({
		kind: "email.message",
		providerId,
		threadId: `t${String(index).padStart(4, "0")}`,
		internalDate: DATE,
		labelIds: toggles === 500 && index >= 4 ? ["INBOX", "UNREAD"] : ["INBOX"],
		sizeBytes: RAW.byteLength,
	}));
	return { ...f, ids, expected, origin: gmailHistoryCursor(f.start) };
}
function sameChanges(actual: readonly unknown[], expected: readonly unknown[]): boolean {
	return canonicalize(actual) === canonicalize(expected);
}
async function sdkPage(f: HistoryFixture, cursor: string): Promise<SyncPage> {
	const result = await f.sdk(cursor),
		parsed = channelV1.tools.channel_sync.output.safeParse(result.structuredContent);
	if (result.isError || !parsed.success) throw new Error("Synthetic SDK page unavailable");
	return parsed.data;
}
async function stored(f: HistoryFixture): Promise<Record<string, unknown>> {
	const value = await f.context.kv.get(SNAPSHOT_SLOT);
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("Synthetic snapshot record unavailable");
	return value as Record<string, unknown>;
}
async function evictWithTwoHosts(): Promise<void> {
	const others = [seeded(8), seeded(8)];
	try {
		for (const f of others) {
			const page = await f.call(f.origin);
			if (page.changes.length !== 7 || !page.more)
				throw new Error("Synthetic eviction unavailable");
		}
	} finally {
		for (const f of others) await f.close();
	}
}
function scriptedStress() {
	const ids = Array.from({ length: 16 }, (_, index) => `m${String(index).padStart(2, "0")}`);
	const labels = Array.from(
		{ length: 256 },
		(_, index) => `L${String(index).padStart(3, "0")}_${"x".repeat(251)}`,
	);
	const inputToken = "DYTEST_input_page_token",
		successorToken = "DYTEST_successor_page_token";
	const origin = `gh1.c.${START}.1016.${Buffer.from(inputToken).toString("base64url")}`;
	const history = {
		historyId: "1016",
		history: ids.map((id, index) => {
			const message = { id, threadId: `t${String(index).padStart(2, "0")}` };
			return { id: String(1001 + index), messages: [message], messagesAdded: [{ message }] };
		}),
		nextPageToken: successorToken,
	};
	const rows = ids.map((id, index) => ({
		id,
		threadId: `t${String(index).padStart(2, "0")}`,
		internalDate: String(DATE),
		historyId: String(1001 + index),
		labelIds: [...labels],
		sizeEstimate: 42,
	}));
	const expected = rows.map((row) => ({
		kind: "email.message",
		providerId: row.id,
		threadId: row.threadId,
		internalDate: DATE,
		labelIds: [...labels],
		sizeBytes: 42,
	}));
	const f = fixture({
		reply(request) {
			const url = new URL(request.url);
			if (
				url.pathname === HISTORY &&
				url.searchParams.get("startHistoryId") === START &&
				url.searchParams.get("maxResults") === "500"
			) {
				if (url.searchParams.get("pageToken") === inputToken) return json(history);
				if (url.searchParams.get("pageToken") === successorToken)
					return json({ historyId: "1016" });
			}
			const row = rows.find(
				(item) =>
					url.pathname === MESSAGES + item.id && url.searchParams.get("format") === "metadata",
			);
			return row ? json(row) : new Response("{}", { status: 400 });
		},
	});
	return { ...f, ids, labels, expected, origin, inputToken, successorToken, history, rows };
}

describe("bounded retained Gmail history pages", () => {
	for (const count of [0, 1, 7, 8, 14, 15, 16])
		it(`preserves all${count} captured changes in ordered pages of at most7`, async () => {
			const f = seeded(count);
			try {
				let cursor = f.origin,
					more = true,
					pages = 0;
				const changes: SyncPage["changes"][number][] = [];
				while (more && pages < 4) {
					const page = await sdkPage(f, cursor);
					expect(page.changes.length <= 7).toBe(true);
					changes.push(...page.changes);
					cursor = page.cursor;
					more = page.more;
					pages++;
				}
				expect(sameChanges(changes, f.expected)).toBe(true);
				expect(!more && cursor === gmailHistoryCursor(f.backend.historyId)).toBe(true);
				expect(pages).toBe(Math.max(1, Math.ceil(count / 7)));
				expect(f.count()).toBe(count + 1);
			} finally {
				await f.close();
			}
		});
	it("serves a scripted over-frame provider page as complete7/7/2 SDK outputs", async () => {
		// Protocol-valid scripted HTTP DATA, not a claim about GmailFake's narrower seed grammar.
		const f = scriptedStress();
		try {
			expect(Buffer.byteLength(JSON.stringify(f.expected)) > 1024 * 1024).toBe(true);
			expect(
				Buffer.byteLength(JSON.stringify(f.history)) +
					f.rows.reduce((n, row) => n + Buffer.byteLength(JSON.stringify(row)), 0) <
					4 * 1024 * 1024,
			).toBe(true);
			const first = await sdkPage(f, f.origin),
				second = await sdkPage(f, first.cursor),
				third = await sdkPage(f, second.cursor);
			expect([first, second, third].map((p) => p.changes.length).join(",") === "7,7,2").toBe(true);
			expect(sameChanges([...first.changes, ...second.changes, ...third.changes], f.expected)).toBe(
				true,
			);
			expect(
				first.more &&
					second.more &&
					third.more &&
					first.cursor.startsWith("gh1.s.") &&
					second.cursor.startsWith("gh1.s."),
			).toBe(true);
			expect(
				third.cursor ===
					`gh1.c.${START}.1016.${Buffer.from(f.successorToken).toString("base64url")}`,
			).toBe(true);
			expect(f.count()).toBe(17);
			const requests = f.requests();
			expect(
				requests.length === 17 &&
					requests[0]?.target ===
						`${HISTORY}?startHistoryId=${START}&maxResults=500&pageToken=${f.inputToken}`,
			).toBe(true);
			expect(
				requests
					.slice(1)
					.every((row, index) => row.target === `${MESSAGES}${f.ids[index]}?format=metadata`),
			).toBe(true);
			expect(requests.every((row) => row.method === "GET" && row.bodyLength === 0)).toBe(true);
			const final = await sdkPage(f, third.cursor);
			expect(
				final.changes.length === 0 && !final.more && final.cursor === gmailHistoryCursor("1016"),
			).toBe(true);
		} finally {
			await f.close();
		}
	});
	it("keeps warm immutable DATA then observes a later provider mutation from the captured checkpoint", async () => {
		const f = seeded();
		try {
			const first = await f.call(f.origin);
			const firstChange = first.changes[0];
			expect(
				firstChange?.kind === "email.message" && !Reflect.set(firstChange.labelIds, "0", "changed"),
			).toBe(true);
			f.backend.setLabels(f.ids[0] as string, ["INBOX", "UNREAD"]);
			const second = await f.call(first.cursor),
				third = await f.call(second.cursor);
			expect(sameChanges([...first.changes, ...second.changes, ...third.changes], f.expected)).toBe(
				true,
			);
			expect(f.count()).toBe(17);
			expect(third.cursor === gmailHistoryCursor("1016") && !third.more).toBe(true);
			const later = await f.call(third.cursor);
			expect(
				later.changes.length === 1 &&
					later.changes[0]?.kind === "email.labels" &&
					later.changes[0].labelIds.join(",") === "INBOX,UNREAD",
			).toBe(true);
		} finally {
			await f.close();
		}
	});
	it("cold replays only the exact original provider query after two-Host LRU eviction", async () => {
		const f = scriptedStress();
		try {
			const first = await f.call(f.origin);
			await evictWithTwoHosts();
			const second = await f.call(first.cursor),
				third = await f.call(second.cursor);
			expect(sameChanges([...first.changes, ...second.changes, ...third.changes], f.expected)).toBe(
				true,
			);
			expect(f.count()).toBe(34);
			const requests = f.requests(),
				histories = requests.filter((r) => r.path === HISTORY);
			expect(
				histories.length === 2 &&
					histories.every(
						(row) =>
							row.target ===
							`${HISTORY}?startHistoryId=${START}&maxResults=500&pageToken=${f.inputToken}`,
					),
			).toBe(true);
			expect(
				third.cursor ===
					`gh1.c.${START}.1016.${Buffer.from(f.successorToken).toString("base64url")}`,
			).toBe(true);
		} finally {
			await f.close();
		}
	});
	it("expires a genuine changed provider snapshot on cold replay without returning DATA", async () => {
		const f = seeded();
		try {
			const first = await f.call(f.origin);
			await evictWithTwoHosts();
			f.backend.setLabels(f.ids[0] as string, ["INBOX", "UNREAD"]);
			expect(await refused(() => f.call(first.cursor), "CURSOR_EXPIRED")).toBe(true);
			expect(f.count()).toBe(34);
		} finally {
			await f.close();
		}
	});
	it("retains the original genuine first-page successor when cold replay rotates its token", async () => {
		const f = seeded(16, {}, 500);
		const expected = [...f.expected.slice(4), ...f.expected.slice(0, 4)];
		try {
			const first = await f.call(f.origin),
				original = f.historyReplies[0]?.nextPageToken;
			await evictWithTwoHosts();
			const second = await f.call(first.cursor),
				replayed = f.historyReplies[1]?.nextPageToken;
			const third = await f.call(second.cursor);
			expect(
				typeof original === "string" && typeof replayed === "string" && original !== replayed,
			).toBe(true);
			expect(sameChanges([...first.changes, ...second.changes, ...third.changes], expected)).toBe(
				true,
			);
			expect(
				third.more &&
					third.cursor ===
						`gh1.c.${f.start}.1516.${Buffer.from(original as string).toString("base64url")}`,
			).toBe(true);
			await f.call(third.cursor);
			const histories = f.requests().filter((r) => r.path === HISTORY);
			expect(
				histories.length === 3 &&
					new URLSearchParams(histories[2]?.query).get("pageToken") === original,
			).toBe(true);
		} finally {
			await f.close();
		}
	});
	for (const kind of ["missing", "corrupt", "shape"] as const)
		it(`checks the current${kind} KV slot before a warm memory hit`, async () => {
			const f = seeded();
			try {
				const first = await f.call(f.origin);
				if (kind === "missing") await f.context.kv.delete(SNAPSHOT_SLOT);
				else
					await f.context.kv.set(
						SNAPSHOT_SLOT,
						kind === "shape" ? [] : { ...(await stored(f)), count: 17 },
					);
				expect(await refused(() => f.call(first.cursor), "CURSOR_EXPIRED")).toBe(true);
				expect(f.count()).toBe(17);
			} finally {
				await f.close();
			}
		});
	it("expires a warm old reference after another origin overwrites the same slot", async () => {
		const f = seeded();
		try {
			const first = await f.call(f.origin),
				oldRecord = await stored(f);
			const replacement = await f.call(gmailHistoryCursor(String(BigInt(f.start) + 1n))),
				nextRecord = await stored(f);
			expect(replacement.changes.length === 7 && oldRecord.nonce !== nextRecord.nonce).toBe(true);
			const before = f.count();
			expect(await refused(() => f.call(first.cursor), "CURSOR_EXPIRED")).toBe(true);
			expect(f.count()).toBe(before);
		} finally {
			await f.close();
		}
	});
	it("bounds metadata to one literal key while another DATA scope overwrites it at capacity", async () => {
		const f = seeded();
		try {
			for (let index = 0; index < 1023; index++) await f.context.kv.set(`DYTEST_fill_${index}`, 0);
			const first = await f.call(f.origin),
				firstRecord = await stored(f);
			// Same real Host namespace; different public context DATA is not new account authority.
			const other = f.contextFor("00000000000000000000000002");
			const beforeScope = f.count();
			expect(
				await refused(
					() => syncGmailHistory(other, { mode: "delta", cursor: first.cursor }),
					"CURSOR_EXPIRED",
				),
			).toBe(true);
			expect(f.count()).toBe(beforeScope);
			const replacement = await syncGmailHistory(other, { mode: "delta", cursor: f.origin }),
				nextRecord = await stored(f);
			expect(
				replacement.changes.length === 7 &&
					firstRecord.scope !== nextRecord.scope &&
					firstRecord.nonce !== nextRecord.nonce,
			).toBe(true);
			expect(Buffer.byteLength(JSON.stringify(nextRecord)) <= 8192).toBe(true);
			const before = f.count();
			expect(await refused(() => f.call(first.cursor), "CURSOR_EXPIRED")).toBe(true);
			expect(f.count()).toBe(before);
			const page = await syncGmailHistory(other, { mode: "delta", cursor: replacement.cursor });
			expect(page.changes.length).toBe(7);
		} finally {
			await f.close();
		}
	});
	it("revalidates the record after cold provider I/O observes a slot deletion", async () => {
		let remove = false;
		let target: HistoryFixture | undefined;
		const f = fixture({
			reply: async (request) => {
				const url = new URL(request.url);
				if (url.pathname === HISTORY) return json(added(16));
				if (remove) {
					remove = false;
					await target?.context.kv.delete(SNAPSHOT_SLOT);
				}
				return json(metadata(url.pathname.slice(MESSAGES.length)));
			},
		});
		target = f;
		try {
			const first = await f.call(gmailHistoryCursor(START));
			await evictWithTwoHosts();
			remove = true;
			expect(await refused(() => f.call(first.cursor), "CURSOR_EXPIRED")).toBe(true);
			expect(!remove && f.count() === 34).toBe(true);
		} finally {
			await f.close();
		}
	});
	it("revalidates a genuine KV set acknowledgment before first DATA", async () => {
		const f = seeded(16, {
			afterSet: async (host, signal) => {
				await host.request("host/kv.delete", { key: SNAPSHOT_SLOT }, { signal });
			},
		});
		try {
			expect(await refused(() => f.call(f.origin), "CURSOR_EXPIRED")).toBe(true);
			expect(f.count()).toBe(17);
		} finally {
			await f.close();
		}
	});
	it("observes cancellation after a held genuine set acknowledgment without publishing DATA", async () => {
		let release!: () => void, began!: () => void;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const written = new Promise<void>((resolve) => {
			began = resolve;
		});
		const f = seeded(16, {
			afterSet: async () => {
				began();
				await held;
			},
		});
		try {
			const pending = f.call(f.origin);
			await written;
			f.abort();
			release();
			expect(await refused(() => pending, "TRANSIENT")).toBe(true);
			expect(f.count()).toBe(17);
		} finally {
			release();
			await f.close();
		}
	});
	it("represents both maximum opaque provider tokens in bounded metadata and a short cursor", async () => {
		const input = '"\\'.repeat(1024),
			successor = '\\"'.repeat(1024);
		const origin = `gh1.c.${START}.1008.${Buffer.from(input).toString("base64url")}`;
		const f = fixture({
			reply(request) {
				const url = new URL(request.url);
				return url.pathname === HISTORY
					? json({ ...added(8), nextPageToken: successor })
					: json(metadata(url.pathname.slice(MESSAGES.length)));
			},
		});
		try {
			const first = await f.call(origin),
				record = await stored(f);
			expect(
				first.changes.length === 7 && first.cursor.length < 128 && /^[!-~]+$/.test(first.cursor),
			).toBe(true);
			expect(
				record.input === origin &&
					record.successor ===
						`gh1.c.${START}.1008.${Buffer.from(successor).toString("base64url")}`,
			).toBe(true);
			expect(Buffer.byteLength(JSON.stringify(record)) <= 8192).toBe(true);
			const last = await f.call(first.cursor);
			expect(last.changes.length === 1 && last.more && last.cursor === record.successor).toBe(true);
			expect(new URLSearchParams(f.requests()[0]?.query).get("pageToken") === input).toBe(true);
		} finally {
			await f.close();
		}
	});
	for (const [name, offset] of [
		["zero", "0"],
		["leading zero", "07"],
		["not a page boundary", "8"],
		["too large", "500"],
		["negative", "-7"],
	] as const)
		it(`expires snapshot ${name} before provider I/O`, async () => {
			const f = seeded();
			try {
				const cursor = `gh1.s.${"A".repeat(43)}.${"a".repeat(64)}.${offset}`;
				expect(await refused(() => f.call(cursor), "CURSOR_EXPIRED")).toBe(true);
				expect(f.count()).toBe(0);
			} finally {
				await f.close();
			}
		});
	it("rejects an exact-end offset and malformed record reference before returning a warm slice", async () => {
		const f = seeded(14);
		try {
			const first = await f.call(f.origin),
				parts = first.cursor.split(".");
			parts[4] = "14";
			expect(await refused(() => f.call(parts.join(".")), "CURSOR_EXPIRED")).toBe(true);
			parts[3] = (parts[3] as string).toUpperCase();
			parts[4] = "7";
			expect(await refused(() => f.call(parts.join(".")), "CURSOR_EXPIRED")).toBe(true);
			expect(f.count()).toBe(15);
		} finally {
			await f.close();
		}
	});
});
