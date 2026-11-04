import {
	createFake,
	createGmailFake,
	GMAIL_HOST,
	GMAIL_READONLY_SCOPE,
	type GmailFake,
	manualClock,
} from "@draftyak/fakes";
import { createMockHub, type MockPlugin } from "@draftyak/plugin-testkit";
import { CHANNEL_V1, channelV1, type SyncRequest } from "@draftyak/protocol/channel-v1";
import { extensionDeclaration } from "@draftyak/protocol/extension";
import { createPluginContext, PluginError } from "@draftyak/sdk";
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
	} = {},
) {
	const backend = createGmailFake({
		clock: manualClock(DATE),
		accessGrant: () => ({ scopes: [GMAIL_READONLY_SCOPE], expiresAt: DATE + 60_000 }),
	});
	const start = backend.historyId;
	settings.prepare?.(backend);
	let count = 0;
	const upstream = createFake(
		{
			async fetch(request) {
				count++;
				const scripted = settings.reply?.(request);
				if (scripted !== undefined) return scripted;
				// Synthetic fixture authentication only; the component receives no credential.
				const headers = new Headers(request.headers);
				headers.set("authorization", "Bearer synthetic-sync-history-fixture");
				return backend.fetch(new Request(request, { headers }));
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
				{
					name: "history_component",
					handler: (args, context) => syncGmailHistory(context, args as DeltaRequest),
				},
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
	const context = createPluginContext(
		{ plugin: PLUGIN, account: ACCOUNT },
		hub.host,
		controller.signal,
	);
	return {
		context,
		start,
		backend,
		call: (cursor: string) => syncGmailHistory(context, { mode: "delta", cursor }),
		count: () => count,
		requests: () => upstream.recorder.takeRequests().map(({ path, query }) => ({ path, query })),
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
			const page = await f.call(gmailHistoryCursor(START));
			expect(page.changes.length).toBe(500);
			expect(
				new Set(page.changes.map((c) => (c.kind === "email.message" ? c.providerId : "invalid")))
					.size,
			).toBe(500);
			expect(page.cursor === gmailHistoryCursor("1500") && !page.more).toBe(true);
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
