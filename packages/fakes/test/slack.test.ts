import { createConnection } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Listening } from "../src/server.ts";
import {
	createSlackReadFake,
	MAX_SLACK_CONVERSATIONS,
	MAX_SLACK_MESSAGES,
	MAX_SLACK_READ_RECORDS,
	MAX_SLACK_USERS,
	type SlackReadConversation,
	type SlackReadFake,
	type SlackReadScope,
	type SlackReadUser,
} from "../src/slack.ts";
import { targetOf, withTarget } from "../src/target.ts";

interface Document {
	ok: boolean;
	error?: string;
	channel: Record<string, unknown>;
	channels: { id: string; name: string }[];
	messages: { text: string; reply_count: number }[];
	response_metadata: { next_cursor: string };
}
const listeners: Listening[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(listeners.splice(0).map((value) => value.close()));
});
const channel = (n = 1, change: Partial<SlackReadConversation> = {}): SlackReadConversation => ({
	id: `C${String(n).padStart(8, "0")}`,
	name: `dytest-${n}`,
	kind: "public_channel",
	member: true,
	archived: false,
	sharing: "none",
	memberCount: 30,
	...change,
});
async function listen(fake: SlackReadFake): Promise<Listening> {
	const value = await fake.listen();
	listeners.push(value);
	expect(value.origin).toBe(`http://127.0.0.1:${value.port}`);
	return value;
}
async function read(origin: string, path: string): Promise<{ response: Response; data: Document }> {
	const response = await fetch(origin + path, {
		redirect: "error",
		signal: AbortSignal.timeout(2000),
	});
	return { response, data: (await response.json()) as Document };
}
const json = async (fake: SlackReadFake, target: string): Promise<Document> =>
	(await fake.fetch(target, { redirect: "error" })).json() as Promise<Document>;
const info = (id = channel().id) =>
	`/api/conversations.info?channel=${id}&include_num_members=true`;

describe("synthetic stateful read-only channel upstream", () => {
	it.each(["absent", "explicit"] as const)(
		"refuses malformed tagged Request targets with %s init and records their raw spelling",
		async (kind) => {
			const fake = createSlackReadFake({ conversations: [channel()] });
			const target = "/api/../api/users.conversations?limit=1";
			const url = `https://${fake.host}${target}`;
			const request = withTarget(new Request(url), targetOf(url));
			const response = await fake.fetch(
				request,
				kind === "explicit" ? { redirect: "manual" } : undefined,
			);
			expect(response.status).toBe(400);
			expect(await response.json()).toEqual({ ok: false, error: "invalid_arguments" });
			expect(fake.recorder.takeRequests()).toMatchObject([
				{ target, path: "/api/../api/users.conversations", query: "limit=1" },
			]);
		},
	);
	it.each(["absent", "explicit"] as const)(
		"selects and consumes raw-path faults for tagged Requests with %s init",
		async (kind) => {
			const fake = createSlackReadFake({ conversations: [channel()] });
			const target = "/api/../api/users.conversations?limit=1";
			const url = `https://${fake.host}${target}`;
			fake.faults.add({
				kind: "server-error",
				status: 502,
				path: "/api/../api/users.conversations",
			});
			const request = withTarget(new Request(url), targetOf(url));
			const response = await fake.fetch(
				request,
				kind === "explicit" ? { redirect: "manual" } : undefined,
			);
			expect(response.status).toBe(502);
			expect(await response.json()).toEqual({ error: "server_error" });
			expect(fake.faults.pending()).toEqual([]);
			expect(fake.recorder.takeRequests()).toMatchObject([
				{ target, path: "/api/../api/users.conversations", query: "limit=1" },
			]);
		},
	);
	it.each(["absent", "explicit"] as const)(
		"accepts canonical tagged Requests and retains native header overrides with %s init",
		async (kind) => {
			const fake = createSlackReadFake({ conversations: [channel()] });
			const target = "/api/users.conversations?limit=1";
			const url = `https://${fake.host}${target}`;
			const request = withTarget(
				new Request(url, { headers: { "x-dytest-source": "DYTEST source" } }),
				targetOf(url),
			);
			const response = await fake.fetch(
				request,
				kind === "explicit"
					? { headers: { "x-dytest-init": "DYTEST replacement" }, redirect: "manual" }
					: undefined,
			);
			expect(response.status).toBe(200);
			expect(((await response.json()) as Document).channels.map(({ id }) => id)).toEqual([
				channel().id,
			]);
			expect(fake.recorder.takeRequests()).toMatchObject([
				{
					target,
					headerNames: kind === "explicit" ? ["x-dytest-init"] : ["x-dytest-source"],
					headers: {},
				},
			]);
		},
	);
	it.each(["Request", "URL"] as const)(
		"retains the documented normalization limit for untagged %s inputs",
		async (kind) => {
			const fake = createSlackReadFake({ conversations: [channel()] });
			const url = `https://${fake.host}/api/../api/users.conversations?limit=1`;
			const response = await fake.fetch(kind === "Request" ? new Request(url) : new URL(url));
			expect(response.status).toBe(200);
			expect(((await response.json()) as Document).ok).toBe(true);
			expect(fake.recorder.takeRequests()).toMatchObject([
				{ target: "/api/users.conversations?limit=1", path: "/api/users.conversations" },
			]);
		},
	);
	it("preserves Promise rejection for invalid native Request init", async () => {
		const fake = createSlackReadFake({ conversations: [channel()] });
		const request = new Request(`https://${fake.host}/api/users.conversations`);
		let response: Promise<Response> | undefined;
		expect(() => {
			response = fake.fetch(request, { method: "GET", body: "DYTEST refused" });
		}).not.toThrow();
		await expect(response).rejects.toBeInstanceOf(TypeError);
		expect(fake.recorder.takeRequests()).toEqual([]);
	});
	it("exports the usable read fake from both package entry points", async () => {
		const root = await import("@draftyak/fakes"),
			subpath = await import("@draftyak/fakes/slack");
		expect(root.createSlackReadFake).toBe(createSlackReadFake);
		expect(subpath.createSlackReadFake).toBe(createSlackReadFake);
	});
	it("lists only the connected owner's current conversations without a caller-selected owner", async () => {
		const fake = createSlackReadFake({
			ownerId: "UDYTEST02",
			conversations: [channel(), channel(2, { member: false }), channel(3)],
		});
		expect(fake.ownerId).toBe("UDYTEST02");
		const first = await json(fake, "/api/users.conversations?limit=1");
		fake.changeConversation(channel(3).id, { member: false });
		const remaining = await json(
			fake,
			`/api/users.conversations?limit=1&cursor=${first.response_metadata.next_cursor}`,
		);
		expect(remaining.channels).toEqual([]);
		const last = await json(
			fake,
			`/api/users.conversations?limit=1&cursor=${remaining.response_metadata.next_cursor}`,
		);
		expect(last.channels).toEqual([]);
		expect(last.response_metadata.next_cursor).toBe("");
		for (const target of [
			`/api/users.conversations?user=${fake.ownerId}`,
			"/api/users.conversations?%75ser=UDYTEST99",
			"/api/conversations.list",
			"/api/users.list",
		])
			expect((await json(fake, target)).ok).toBe(false);
		const all = await json(fake, "/api/users.conversations");
		expect(all.channels.map(({ id }) => id)).toEqual([channel().id]);
	});
	it("serves bounded detached user profiles and requires users:read before profile lookup", async () => {
		const profile: SlackReadUser = {
			id: "UDYTEST01",
			name: "dytest-owner",
			displayName: "DYTEST display",
			realName: "DYTEST synthetic",
		};
		const fake = createSlackReadFake({ conversations: [channel()], users: [profile] });
		(profile as { displayName: string }).displayName = "CALLER_MUTATION_CANARY";
		const server = await listen(fake);
		const response = await read(server.origin, "/api/users.info?user=UDYTEST01");
		expect(response.response.headers.get("date")).toBe(new Date(fake.clock.now()).toUTCString());
		expect((response.data as unknown as { user: object }).user).toEqual({
			id: "UDYTEST01",
			name: "dytest-owner",
			is_bot: false,
			deleted: false,
			real_name: "DYTEST synthetic",
			profile: { display_name: "DYTEST display", real_name: "DYTEST synthetic" },
		});
		const returned = response.data as unknown as { user: { profile: { display_name: string } } };
		returned.user.profile.display_name = "RESPONSE_MUTATION_CANARY";
		expect((await json(fake, "/api/users.info?user=UDYTEST01")) as unknown).toMatchObject({
			user: { profile: { display_name: "DYTEST display" } },
		});
		expect((await json(fake, "/api/users.info?user=UDYTEST99")).error).toBe("user_not_found");
		for (const scopes of [[], ["channels:read"]] as SlackReadScope[][]) {
			const limited = createSlackReadFake({ conversations: [channel()], scopes });
			for (const id of ["UDYTEST01", "UDYTEST99"])
				expect((await json(limited, `/api/users.info?user=${id}`)).error).toBe("missing_scope");
		}
	});
	it.each([
		"/api/users.info",
		"/api/users.info?user=",
		"/api/users.info?user=U1",
		"/api/users.info?user=C00000001",
		"/api/users.info?user=UDYTEST01%0A",
		"/api/users.info?user=UDYTEST01&user=UDYTEST02",
		"/api/users.info?user=UDYTEST01&token=DYTEST",
		`/api/users.info?user=U${"A".repeat(21)}`,
	])("refuses malformed or ambiguous profile selectors %s", async (target) => {
		const fake = createSlackReadFake({ conversations: [] });
		expect((await json(fake, target)).error).toBe("invalid_arguments");
	});
	it("applies synthetic channel scopes to list, info, history and replies independently", async () => {
		const fake = createSlackReadFake({
			conversations: [channel(), channel(2, { kind: "im" })],
			scopes: ["channels:read", "users:read"],
		});
		expect(
			(await json(fake, "/api/users.conversations?types=public_channel,im")).channels.map(
				({ id }) => id,
			),
		).toEqual([channel().id]);
		expect((await json(fake, info())).ok).toBe(true);
		expect((await json(fake, info(channel(2).id))).error).toBe("missing_scope");
		expect(
			(await json(fake, `/api/conversations.history?channel=${channel().id}&ts=1800000000.0`))
				.error,
		).toBe("invalid_arguments");
		expect((await json(fake, `/api/conversations.history?channel=${channel().id}`)).error).toBe(
			"missing_scope",
		);
		expect(
			(await json(fake, `/api/conversations.replies?channel=${channel().id}&ts=1800000000.0`))
				.error,
		).toBe("missing_scope");
	});
	it("rejects malformed profile/configuration data without invoking accessors or proxies", () => {
		let hooks = 0;
		const hook = () => {
			hooks++;
			throw new Error("DYTEST accessor must stay unread");
		};
		const profile = {
			id: "UDYTEST01",
			name: "dytest-owner",
			displayName: "DYTEST owner",
			realName: "DYTEST owner",
		};
		const invalid = [
			{ ownerId: null },
			{ ownerId: "C00000001" },
			{ users: null },
			{ scopes: null },
			{ scopes: ["users:read", "users:read"] },
			{ scopes: ["chat:write"] },
			{ users: [profile, profile] },
			{ users: [{ ...profile, name: "" }] },
			{ users: [{ ...profile, realName: "DYTEST\nname" }] },
			{ users: [{ ...profile, displayName: "x".repeat(257) }] },
			{ users: [{ ...profile, name: "x".repeat(65) }] },
			{ users: [{ ...profile, displayName: "\ud800" }] },
			{ users: [Object.defineProperty({ ...profile }, "name", { get: hook })] },
			{ users: new Proxy([], { ownKeys: hook, get: hook, getPrototypeOf: hook }) },
			{ scopes: new Array(1) },
		];
		for (const extra of invalid)
			expect(() =>
				createSlackReadFake({ conversations: [], ...extra } as unknown as Parameters<
					typeof createSlackReadFake
				>[0]),
			).toThrow(/^Slack read fixture refused$/);
		expect(hooks).toBe(0);
	});
	it("accepts conversation/profile limits and refuses their exact next neighbors", async () => {
		const conversations = Array.from({ length: MAX_SLACK_CONVERSATIONS }, (_, n) => channel(n));
		const users = Array.from({ length: MAX_SLACK_USERS }, (_, n) => ({
			id: `U${String(n).padStart(8, "0")}`,
			name: `dytest-${n}`,
			displayName: "x".repeat(256),
			realName: "x".repeat(256),
		}));
		users[0] = {
			id: `U${"A".repeat(20)}`,
			name: "x".repeat(64),
			displayName: "é".repeat(128),
			realName: "x".repeat(256),
		};
		const fake = createSlackReadFake({ conversations, users });
		expect((await json(fake, `/api/users.info?user=${users[0]?.id}`)).ok).toBe(true);
		expect(() =>
			createSlackReadFake({ conversations: [...conversations, channel(1000)] }),
		).toThrow();
		expect(() =>
			createSlackReadFake({
				conversations: [],
				users: [
					...users,
					{
						id: "UDYTEST99",
						name: "dytest-extra",
						displayName: "DYTEST extra",
						realName: "DYTEST extra",
					},
				],
			}),
		).toThrow();
		expect(() =>
			createSlackReadFake({ conversations: [channel(1, { name: "x".repeat(257) })] }),
		).toThrow();
		expect(() =>
			createSlackReadFake({ conversations: [channel(1, { memberCount: 1_000_000_001 })] }),
		).toThrow();
		expect(
			(
				await json(
					createSlackReadFake({
						conversations: [channel(1, { name: "x".repeat(256), memberCount: 1_000_000_000 })],
					}),
					info(),
				)
			).ok,
		).toBe(true);
	});
	it("bounds message bytes, timestamps and duplicate identity before changing state", async () => {
		const fake = createSlackReadFake({ conversations: [channel()] });
		fake.addMessage(channel().id, { ts: "1800000000.1", user: "UDYTEST1", text: "x".repeat(4096) });
		for (const candidate of [
			{ ts: "1800000000.100000000", text: "DYTEST duplicate" },
			{ ts: "1800000001.0", text: "x".repeat(4097) },
			{ ts: "1800000001.0", text: "é".repeat(2049) },
			{ ts: "1800000001.0", text: "DYTEST\rbody" },
			{ ts: "1800000001.0", text: "DYTEST e\u0301" },
			{ ts: "1800000001.0000000000", text: "DYTEST overprecise" },
			{ ts: "1800000001.0", text: "DYTEST orphan", threadTs: "1700000000.0" },
		])
			expect(() => fake.addMessage(channel().id, { ...candidate, user: "UDYTEST1" })).toThrow();
		expect(
			(await json(fake, `/api/conversations.history?channel=${channel().id}`)).messages,
		).toHaveLength(1);
	});
	it("bounds clock and rate configuration, including rollback and HTTP-Date endpoints", async () => {
		for (const extra of [
			{ nowMs: -1 },
			{ nowMs: 253_402_300_799_001 },
			{ nowMs: 0.5 },
			{ readBudget: { calls: 0, windowMs: 1 } },
			{ readBudget: { calls: 10001, windowMs: 1 } },
			{ readBudget: { calls: 1, windowMs: 0 } },
			{ readBudget: { calls: 1, windowMs: 3_600_001 } },
		])
			expect(() => createSlackReadFake({ conversations: [], ...extra })).toThrow();
		const fake = createSlackReadFake({
			conversations: [channel()],
			nowMs: 0,
			readBudget: { calls: 1, windowMs: 1000 },
		});
		expect((await fake.fetch(info())).headers.get("date")).toBe("Thu, 01 Jan 1970 00:00:00 GMT");
		fake.clock.set(100);
		expect((await fake.fetch(info())).status).toBe(429);
		fake.clock.set(0);
		expect((await fake.fetch(info())).status).toBe(200);
		for (const bad of [-1, 0.5, 253_402_300_799_001, Number.NaN])
			expect(() => fake.clock.set(bad)).toThrow();
		expect(fake.clock.now()).toBe(0);
		fake.clock.set(253_402_300_799_000);
		expect((await fake.fetch(info())).headers.get("date")).toBe("Fri, 31 Dec 9999 23:59:59 GMT");
		expect(() => fake.clock.advance(1)).toThrow();
	});
	it("bounds cursor and recorder storage and releases it on expiry or drain", async () => {
		const cursors = createSlackReadFake({ conversations: [channel(), channel(2)] });
		for (let i = 0; i < 128; i++)
			expect((await json(cursors, "/api/users.conversations?limit=1")).ok).toBe(true);
		expect((await json(cursors, "/api/users.conversations?limit=1")).error).toBe(
			"fixture_cursor_limit",
		);
		cursors.clock.advance(60_000);
		expect((await json(cursors, "/api/users.conversations?limit=1")).ok).toBe(true);
		const records = createSlackReadFake({ conversations: [channel()] });
		for (let i = 0; i < MAX_SLACK_READ_RECORDS; i++) await records.fetch(info());
		await expect(records.fetch(info())).rejects.toThrow();
		expect(records.recorder.takeRequests()).toHaveLength(MAX_SLACK_READ_RECORDS);
		expect((await records.fetch(info())).status).toBe(429);
		const bytes = createSlackReadFake({ conversations: [channel()] });
		let admitted = 0;
		for (; admitted < MAX_SLACK_READ_RECORDS; admitted++) {
			try {
				await bytes.fetch(info(), { headers: { "x-dytest": "x".repeat(6000) } });
			} catch {
				break;
			}
		}
		expect(admitted).toBeGreaterThan(0);
		expect(admitted).toBeLessThan(MAX_SLACK_READ_RECORDS);
		expect(bytes.recorder.takeRequests()).toHaveLength(admitted);
		expect((await bytes.fetch(info())).status).toBe(200);
	});
	it("refuses oversized query/header intake before retaining a record", async () => {
		const fake = createSlackReadFake({ conversations: [channel()] });
		const accepted = Object.fromEntries(Array.from({ length: 64 }, (_, n) => [`x-${n}`, "DYTEST"]));
		expect((await fake.fetch(info(), { headers: accepted })).status).toBe(200);
		const [record] = fake.recorder.takeRequests();
		expect(record?.headerNames).toHaveLength(64);
		expect(record?.headers).toEqual({});
		await expect(fake.fetch(`/api/users.conversations?${"x".repeat(2048)}`)).rejects.toThrow();
		await expect(
			fake.fetch(info(), { headers: { "x-dytest": "x".repeat(8192) } }),
		).rejects.toThrow();
		const headers = Object.fromEntries(Array.from({ length: 65 }, (_, n) => [`x-${n}`, "DYTEST"]));
		await expect(fake.fetch(info(), { headers })).rejects.toThrow();
		expect(fake.recorder.takeRequests()).toEqual([]);
	});
	it.each(["memory", "loopback"] as const)(
		"shares fault/Date/abort behavior over %s without a network fallback",
		async (transport) => {
			const fake = createSlackReadFake({ conversations: [channel()], nowMs: 1_800_000_000_000 });
			const server = transport === "loopback" ? await listen(fake) : undefined;
			const request = (path: string, signal?: AbortSignal) =>
				server
					? fetch(server.origin + path, { signal, redirect: "error" })
					: fake.fetch(path, { signal });
			fake.faults.add({ kind: "rate-limit", retryAfter: 1.1 });
			expect(
				(await fake.fetch("https://other.draftyak.example/api/users.conversations")).status,
			).toBe(421);
			expect(fake.faults.pending()).toHaveLength(1);
			const limited = await request(info());
			expect(limited.status).toBe(429);
			expect(limited.headers.get("retry-after")).toBe("2");
			expect(limited.headers.get("date")).toBe(new Date(fake.clock.now()).toUTCString());
			fake.faults.add({ kind: "server-error", status: 502 });
			expect((await request(info())).status).toBe(502);
			fake.faults.add({ kind: "drop" });
			await expect(request(info())).rejects.toThrow(TypeError);
			fake.faults.add({ kind: "latency", ms: Infinity });
			const controller = new AbortController(),
				pending = request(info(), controller.signal);
			await new Promise<void>((resolve) => setTimeout(resolve, 10));
			controller.abort();
			await expect(pending).rejects.toThrow();
			fake.faults.clear();
			expect((await request(info())).status).toBe(200);
		},
	);
	it("simulates revocation on every read route without revoking another instance", async () => {
		const a = createSlackReadFake({ conversations: [channel()] }),
			b = createSlackReadFake({ conversations: [channel()] });
		const server = await listen(a);
		a.revoke();
		a.revoke();
		for (const target of [
			"/api/users.conversations",
			"/api/users.info?user=UDYTEST01",
			info(),
			`/api/conversations.history?channel=${channel().id}`,
			`/api/conversations.replies?channel=${channel().id}&ts=1800000000.0`,
		]) {
			expect((await json(a, target)).error).toBe("token_revoked");
			expect((await read(server.origin, target)).data.error).toBe("token_revoked");
		}
		expect((await json(b, info())).ok).toBe(true);
	});
	it("projects all four conversation types from fixture facts, not identifier prefixes", async () => {
		const kinds = ["public_channel", "private_channel", "im", "mpim"] as const;
		const fake = createSlackReadFake({
			conversations: kinds.map((kind, n) => channel(n, { kind })),
		});
		const result = await json(
			fake,
			"/api/users.conversations?types=public_channel,private_channel,im,mpim&limit=200",
		);
		expect(result.channels).toHaveLength(4);
		expect(result.response_metadata.next_cursor).toBe("");
		for (const [n, kind] of kinds.entries()) {
			const current = (await json(fake, info(channel(n).id))).channel;
			expect(current.is_im).toBe(kind === "im");
			expect(current.is_mpim).toBe(kind === "mpim");
			expect(current.is_private).toBe(kind === "private_channel" || kind === "mpim");
		}
	});
	it("paginates 300 conversations over real loopback with opaque stable cursors", async () => {
		const fake = createSlackReadFake({
			conversations: Array.from({ length: 300 }, (_, n) => channel(n)),
		});
		const server = await listen(fake),
			ids: string[] = [];
		let cursor = "",
			pages = 0;
		do {
			const { response, data } = await read(
				server.origin,
				`/api/users.conversations?limit=20${cursor ? `&cursor=${cursor}` : ""}`,
			);
			expect(response.status).toBe(200);
			expect(data.ok).toBe(true);
			ids.push(...data.channels.map((value) => value.id));
			cursor = data.response_metadata.next_cursor;
			expect(cursor === "" || /^[0-9a-f]{32}$/.test(cursor)).toBe(true);
			pages++;
			expect(pages).toBeLessThanOrEqual(15);
		} while (cursor);
		expect(pages).toBe(15);
		expect(ids).toHaveLength(300);
		expect(new Set(ids).size).toBe(300);
		const recorded = fake.recorder.takeRequests();
		expect(recorded).toHaveLength(15);
		expect(
			recorded.every(
				(value) =>
					value.method === "GET" &&
					value.bodyLength === 0 &&
					value.headerNames.every((name) => name !== "authorization"),
			),
		).toBe(true);
	});
	it("retains an empty nonfinal filtered virtual page rather than hiding the cursor", async () => {
		const fake = createSlackReadFake({
				conversations: [channel(1, { archived: true }), channel(2)],
			}),
			server = await listen(fake);
		const first = await read(
			server.origin,
			"/api/users.conversations?limit=1&exclude_archived=true",
		);
		expect(first.data.channels).toEqual([]);
		expect(first.data.response_metadata.next_cursor).not.toBe("");
		const second = await read(
			server.origin,
			`/api/users.conversations?limit=1&exclude_archived=true&cursor=${first.data.response_metadata.next_cursor}`,
		);
		expect(second.data.channels.map((value) => value.id)).toEqual([channel(2).id]);
		expect(second.data.response_metadata.next_cursor).toBe("");
	});
	it("exposes controlled rename/archive/share/member transitions while snapshots stay detached", async () => {
		const seed = channel(),
			fake = createSlackReadFake({ conversations: [seed, channel(2)] }),
			server = await listen(fake);
		const before = await read(server.origin, info());
		const first = await read(server.origin, "/api/users.conversations?limit=1");
		fake.changeConversation(seed.id, {
			name: "dytest-renamed",
			archived: true,
			sharing: "external",
			member: false,
			memberCount: 35,
		});
		(seed as { name: string }).name = "CALLER_MUTATION_CANARY";
		const after = await read(server.origin, info());
		expect(after.data.channel).toMatchObject({
			name: "dytest-renamed",
			is_archived: true,
			is_shared: true,
			is_ext_shared: true,
			is_org_shared: false,
			is_member: false,
			num_members: 35,
		});
		expect(before.data.channel.name).toBe("dytest-1");
		after.data.channel.name = "RESPONSE_MUTATION_CANARY";
		expect((await json(fake, info())).channel.name).toBe("dytest-renamed");
		fake.changeConversation(channel(2).id, { name: "new-second-name" });
		const next = await read(
			server.origin,
			`/api/users.conversations?limit=1&cursor=${first.data.response_metadata.next_cursor}`,
		);
		expect(next.data.channels[0]?.name).toBe("dytest-2");
		expect(
			(await json(fake, `/api/conversations.info?channel=${seed.id}`)).channel.num_members,
		).toBeUndefined();
	});
	it("models root/reply changes and exact nanosecond inclusive windows with documented ordering", async () => {
		const fake = createSlackReadFake({ conversations: [channel()] });
		fake.addMessage(channel().id, { ts: "1800000000.000000001", user: "UDYTEST1", text: "root" });
		fake.addMessage(channel().id, {
			ts: "1800000000.000000002",
			user: "UDYTEST2",
			text: "reply",
			threadTs: "1800000000.000000001",
		});
		fake.addMessage(channel().id, {
			ts: "1800000000.000000003",
			user: "UDYTEST1",
			text: "new-root",
		});
		const server = await listen(fake),
			history = await read(server.origin, `/api/conversations.history?channel=${channel().id}`);
		expect(history.data.messages.map((m: { text: string }) => m.text)).toEqual([
			"new-root",
			"root",
		]);
		expect(history.data.messages[1]?.reply_count).toBe(1);
		const replies = await read(
			server.origin,
			`/api/conversations.replies?channel=${channel().id}&ts=1800000000.000000001`,
		);
		expect(replies.data.messages.map((m: { text: string }) => m.text)).toEqual(["root", "reply"]);
		const target = `/api/conversations.replies?channel=${channel().id}&ts=1800000000.000000001&oldest=1800000000.000000001&latest=1800000000.000000002`;
		expect((await json(fake, target)).messages).toEqual([]);
		expect((await json(fake, `${target}&inclusive=true`)).messages).toHaveLength(2);
	});
	it("enforces configurable synthetic per-method429 windows without real timers", async () => {
		const fake = createSlackReadFake({
				conversations: [channel()],
				readBudget: { calls: 1, windowMs: 5000 },
			}),
			server = await listen(fake);
		expect((await read(server.origin, info())).response.status).toBe(200);
		const limited = await read(server.origin, info());
		expect(limited.response.status).toBe(429);
		expect(limited.response.headers.get("retry-after")).toBe("5");
		expect((await read(server.origin, "/api/users.conversations")).response.status).toBe(200);
		fake.clock.advance(4999);
		expect((await read(server.origin, info())).response.status).toBe(429);
		fake.clock.advance(1);
		expect((await read(server.origin, info())).response.status).toBe(200);
	});
	it("binds opaque cursors to instance, route, filter and expiry, preserving retries", async () => {
		const fake = createSlackReadFake({ conversations: [channel(), channel(2), channel(3)] }),
			other = createSlackReadFake({ conversations: [channel()] });
		const first = await json(fake, "/api/users.conversations?limit=1"),
			cursor = first.response_metadata.next_cursor,
			target = `/api/users.conversations?limit=1&cursor=${cursor}`;
		expect(await json(fake, target)).toEqual(await json(fake, target));
		expect((await json(other, target)).error).toBe("invalid_cursor");
		expect((await json(fake, `${target}&types=im`)).error).toBe("invalid_cursor");
		expect(
			(
				await json(
					fake,
					`/api/conversations.history?channel=${channel().id}&limit=1&cursor=${cursor}`,
				)
			).error,
		).toBe("invalid_cursor");
		fake.clock.advance(59_999);
		expect((await json(fake, target)).ok).toBe(true);
		fake.clock.advance(1);
		expect((await json(fake, target)).error).toBe("invalid_cursor");
		const next = await json(fake, "/api/users.conversations?limit=1");
		fake.clock.set(fake.clock.now() - 1);
		expect(
			(
				await json(
					fake,
					`/api/users.conversations?limit=1&cursor=${next.response_metadata.next_cursor}`,
				)
			).error,
		).toBe("invalid_cursor");
	});
	describe("denied provider scheduling", () => {
		const targets = [
			"/api/chat.scheduleMessage",
			"/api/chat.deleteScheduledMessage",
			"/api/chat.scheduledMessages.list",
		] as const;
		const seeded = () => {
			const fake = createSlackReadFake({ conversations: [channel()] });
			fake.addMessage(channel().id, {
				ts: "1760000000.000001",
				user: "UDYTEST01",
				text: "DYTEST scheduling refusal",
			});
			return fake;
		};
		const history = () => `/api/conversations.history?channel=${channel().id}`;
		const seededHistory = async (fake: SlackReadFake) => {
			const result = await json(fake, history());
			expect(result).toMatchObject({
				ok: true,
				messages: [
					{
						ts: "1760000000.000001",
						user: "UDYTEST01",
						text: "DYTEST scheduling refusal",
					},
				],
			});
			return result;
		};

		it.each(["string", "tagged", "tagged-init", "loopback"] as const)(
			"refuses all three methods over %s without changing state or retaining POSTs",
			async (transport) => {
				const fake = seeded(),
					other = seeded(),
					before = await seededHistory(fake),
					otherBefore = await seededHistory(other),
					facts = fake.conversation(channel().id),
					server = transport === "loopback" ? await listen(fake) : undefined,
					localFetch = globalThis.fetch;
				expect(otherBefore).toEqual(before);
				fake.recorder.takeRequests();
				const native = vi
					.spyOn(globalThis, "fetch")
					.mockRejectedValue(new Error("Native network forbidden"));
				const request = (target: string, method: "GET" | "POST") => {
					if (server) return localFetch(server.origin + target, { method, redirect: "error" });
					if (transport === "string") return fake.fetch(target, { method });
					const url = `https://${fake.host}${target}`;
					return fake.fetch(
						withTarget(new Request(url, { method }), targetOf(url)),
						transport === "tagged-init" ? { redirect: "manual" } : undefined,
					);
				};
				for (const target of targets) {
					const post = await request(target, "POST");
					expect(post.status).toBe(405);
					expect(await post.json()).toEqual({ ok: false, error: "unknown_method" });
					expect(fake.recorder.takeRequests()).toEqual([]);
					const get = await request(target, "GET");
					expect(get.status).toBe(400);
					expect(await get.json()).toEqual({ ok: false, error: "invalid_arguments" });
					const [record, ...extra] = fake.recorder.takeRequests();
					expect(extra).toEqual([]);
					expect(record).toMatchObject({ method: "GET", target, path: target, headers: {} });
					expect(record?.bodyLength).toBe(0);
				}
				expect(fake.conversation(channel().id)).toEqual(facts);
				expect(await seededHistory(fake)).toEqual(before);
				expect(await seededHistory(other)).toEqual(otherBefore);
				expect(native).not.toHaveBeenCalled();
			},
		);

		it.each(["memory", "loopback"] as const)(
			"keeps denials effect-free when before/after faults mask their response over %s",
			async (transport) => {
				const fake = seeded(),
					before = await seededHistory(fake),
					facts = fake.conversation(channel().id),
					server = transport === "loopback" ? await listen(fake) : undefined,
					localFetch = globalThis.fetch;
				fake.recorder.takeRequests();
				const native = vi
					.spyOn(globalThis, "fetch")
					.mockRejectedValue(new Error("Native network forbidden"));
				const request = (target: string) =>
					server
						? localFetch(server.origin + target, { method: "POST", redirect: "error" })
						: fake.fetch(target, { method: "POST" });
				for (const target of targets) {
					for (const after of [false, true]) {
						for (const kind of ["server-error", "rate-limit", "drop"] as const) {
							const scope = { method: "POST", path: target, times: 1, after };
							if (kind === "server-error") fake.faults.add({ ...scope, kind, status: 502 });
							else if (kind === "rate-limit") fake.faults.add({ ...scope, kind, retryAfter: 1.1 });
							else fake.faults.add({ ...scope, kind });
							if (kind === "drop") await expect(request(target)).rejects.toBeInstanceOf(TypeError);
							else {
								const response = await request(target);
								expect(response.status).toBe(kind === "server-error" ? 502 : 429);
								expect(response.headers.get("date")).toBe(new Date(fake.clock.now()).toUTCString());
								if (kind === "rate-limit") expect(response.headers.get("retry-after")).toBe("2");
								await response.body?.cancel();
							}
							expect(fake.faults.pending()).toEqual([]);
							// A scripted transport response is not an application authorization result.
							const retry = await request(target);
							expect(retry.status).toBe(405);
							expect(await retry.json()).toEqual({ ok: false, error: "unknown_method" });
							expect(fake.recorder.takeRequests()).toEqual([]);
						}
					}
				}
				expect(fake.conversation(channel().id)).toEqual(facts);
				expect(await seededHistory(fake)).toEqual(before);
				expect(native).not.toHaveBeenCalled();
			},
		);

		it.each(["string", "tagged", "tagged-init"] as const)(
			"cancels each unsupported stream without cloning or retaining it over %s",
			async (transport) => {
				const clone = vi.spyOn(Request.prototype, "clone").mockImplementation(() => {
					throw new Error("Unexpected body tee");
				});
				for (const target of targets) {
					const fake = seeded();
					let pulls = 0,
						cancelled = 0;
					const body = new ReadableStream<Uint8Array>({
						pull(controller) {
							pulls++;
							controller.enqueue(new Uint8Array(16));
						},
						cancel() {
							cancelled++;
						},
					});
					const init: RequestInit & { duplex: "half" } = { method: "POST", body, duplex: "half" };
					const url = `https://${fake.host}${target}`;
					const response =
						transport === "string"
							? await fake.fetch(url, init)
							: await fake.fetch(
									withTarget(new Request(url, init), targetOf(url)),
									transport === "tagged-init" ? { redirect: "manual" } : undefined,
								);
					expect(response.status).toBe(405);
					expect(await response.json()).toEqual({ ok: false, error: "unknown_method" });
					expect(cancelled).toBe(1);
					expect(pulls).toBeLessThanOrEqual(transport === "string" ? 2 : 4);
					const settled = pulls;
					await new Promise<void>((resolve) => setTimeout(resolve, 0));
					expect(pulls).toBe(settled);
					expect(fake.recorder.takeRequests()).toEqual([]);
				}
				expect(clone).not.toHaveBeenCalled();
			},
		);

		it.each(targets)(
			"closes rawHTTP %s after a prefix without awaiting the declared body",
			async (target) => {
				const fake = seeded(),
					server = await listen(fake),
					before = await seededHistory(fake);
				fake.recorder.takeRequests();
				const wire = await new Promise<string>((resolve, reject) => {
					const socket = createConnection({ host: "127.0.0.1", port: server.port });
					let output = "";
					const timeout = setTimeout(() => {
						socket.destroy();
						reject(new Error("Raw fixture refusal timed out"));
					}, 2000);
					socket.on("data", (chunk) => {
						output += chunk.toString("ascii");
						if (output.length > 4096) {
							socket.destroy();
							reject(new Error("Raw fixture response exceeded bounds"));
						}
					});
					socket.once("error", reject);
					socket.once("close", () => {
						clearTimeout(timeout);
						resolve(output);
					});
					socket.once("connect", () =>
						socket.write(
							`POST ${target} HTTP/1.1\r\nHost: 127.0.0.1:${server.port}\r\nContent-Length: 33554432\r\nConnection: close\r\n\r\nDYTEST prefix`,
						),
					);
				});
				expect(wire).toMatch(/^HTTP\/1\.1 405 /);
				expect(wire).toContain('"error":"unknown_method"');
				expect(fake.recorder.takeRequests()).toEqual([]);
				expect(await seededHistory(fake)).toEqual(before);
			},
		);
	});

	it("keeps fixtures isolated, has no native fetch fallback and refuses send/schedule/write requests", async () => {
		const a = createSlackReadFake({ conversations: [channel()] }),
			b = createSlackReadFake({ conversations: [channel()] });
		a.changeConversation(channel().id, { sharing: "internal" });
		expect((await json(b, info())).channel.is_shared).toBe(false);
		const native = vi
			.spyOn(globalThis, "fetch")
			.mockRejectedValue(new Error("Native network forbidden"));
		for (const path of [
			"/api/chat.postMessage",
			"/api/chat.scheduleMessage",
			"/api/conversations.archive",
		]) {
			const response = await a.fetch(path, { method: "POST" });
			expect(response.status).toBe(405);
			expect(((await response.json()) as { ok: boolean }).ok).toBe(false);
		}
		expect(a.conversation(channel().id).archived).toBe(false);
		expect(native).not.toHaveBeenCalled();
		expect(a.recorder.takeRequests()).toEqual([]);
	});
	it.each([
		["request", undefined],
		["request", "manual"],
		["request", "follow"],
		["tagged", undefined],
		["tagged", "manual"],
		["tagged", "follow"],
		["string", undefined],
		["string", "manual"],
		["string", "follow"],
	] as const)(
		"cancels a body-bearing stream without tee/collection (%s, %s)",
		async (kind, redirect) => {
			const fake = createSlackReadFake({ conversations: [channel()] });
			let pulls = 0,
				cancelled = 0;
			const clone = vi.spyOn(Request.prototype, "clone").mockImplementation(() => {
				throw new Error("Unexpected body tee");
			});
			const body = new ReadableStream<Uint8Array>({
				pull(controller) {
					pulls++;
					controller.enqueue(new Uint8Array(16));
				},
				cancel() {
					cancelled++;
				},
			});
			const url = `https://${fake.host}/api/chat.postMessage`;
			const init: RequestInit & { duplex: "half" } = {
				method: "POST",
				body,
				duplex: "half",
			};
			let response: Promise<Response>;
			if (kind === "request" || kind === "tagged") {
				const request = new Request(url, init);
				response = fake.fetch(
					kind === "tagged" ? withTarget(request, targetOf(url)) : request,
					redirect === undefined ? undefined : { redirect },
				);
			} else
				response = fake.fetch(url, {
					...init,
					...(redirect === undefined ? {} : { redirect }),
				});
			await expect(response).resolves.toMatchObject({ status: 405 });
			// Native Request-to-Request transfer has two bounded buffering stages.
			expect(pulls).toBeLessThanOrEqual(kind === "string" ? 2 : 4);
			expect(cancelled).toBe(1);
			expect(clone).not.toHaveBeenCalled();
			const settledPulls = pulls;
			await new Promise<void>((resolve) => setTimeout(resolve, 0));
			expect(pulls).toBe(settledPulls);
			expect(fake.recorder.takeRequests()).toEqual([]);
		},
	);
	it("refuses an oversized response whole while a smaller page preserves the same messages", async () => {
		const fake = createSlackReadFake({ conversations: [channel()] });
		for (let n = 0; n < 70; n++)
			fake.addMessage(channel().id, {
				ts: `1800000000.${String(n).padStart(9, "0")}`,
				user: "UDYTEST1",
				text: "x".repeat(4096),
			});
		const response = await fake.fetch(`/api/conversations.history?channel=${channel().id}`);
		expect(response.status).toBe(413);
		expect(((await response.json()) as { error: string }).error).toBe("fixture_response_limit");
		const page = await json(fake, `/api/conversations.history?channel=${channel().id}&limit=20`);
		expect(page.messages).toHaveLength(20);
		expect(page.response_metadata.next_cursor).not.toBe("");
	});
	it.each([
		"/api/users.conversations?limit=01",
		"/api/users.conversations?limit=1e2",
		"/api/users.conversations?limit=0",
		"/api/users.conversations?limit=201",
		"/api/users.conversations?limit=1&limit=1",
		"/api/users.conversations?types=im,im",
		"/api/users.conversations?types=unknown",
		"/api/users.conversations?exclude_archived=1",
		"/api/conversations.info?channel=C00000001&include_num_members=1",
		"/api/conversations.history?channel=C00000001&oldest=2.0&latest=1.0",
		"/api/conversations.history?channel=C00000001&inclusive=1",
		"/api/conversations.info?channel=C00000001&token=PRIVATE_CANARY",
		"/api/../api/users.conversations",
		"/api/users.conversations#fragment",
	])("refuses malformed raw target %s", async (target) => {
		const fake = createSlackReadFake({ conversations: [channel()] });
		expect((await json(fake, target)).ok).toBe(false);
	});
	it("refuses getters/proxies/dense-array violations and state overflow before mutation", () => {
		let hooks = 0;
		const hook = () => {
			hooks++;
			throw new Error("PRIVATE_FIXTURE_CANARY");
		};
		for (const conversations of [
			new Array(1),
			[Object.defineProperty(channel(), "name", { get: hook })],
			new Proxy([], { get: hook, ownKeys: hook, getPrototypeOf: hook }),
		])
			expect(() =>
				createSlackReadFake({ conversations: conversations as readonly SlackReadConversation[] }),
			).toThrow(/^Slack read fixture refused$/);
		const fake = createSlackReadFake({ conversations: [channel()] });
		expect(() =>
			fake.changeConversation(
				channel().id,
				Object.defineProperty({}, "sharing", { enumerable: true, get: hook }),
			),
		).toThrow(/^Slack read fixture refused$/);
		expect(hooks).toBe(0);
		for (let n = 0; n < MAX_SLACK_MESSAGES; n++)
			fake.addMessage(channel().id, {
				ts: `1800000000.${String(n).padStart(9, "0")}`,
				user: "UDYTEST1",
				text: "x",
			});
		expect(() =>
			fake.addMessage(channel().id, { ts: "1800000001.0", user: "UDYTEST1", text: "overflow" }),
		).toThrow(/^Slack read fixture refused$/);
		expect(fake.conversation(channel().id).name).toBe("dytest-1");
	});
	it("rejects body-bearing rawHTTP before waiting for its advertised oversized body and closes", async () => {
		const fake = createSlackReadFake({ conversations: [channel()] }),
			server = await listen(fake);
		const wire = await new Promise<string>((resolve, reject) => {
			const socket = createConnection({ host: "127.0.0.1", port: server.port });
			let output = "";
			const timeout = setTimeout(() => {
				socket.destroy();
				reject(new Error("Raw fixture refusal timed out"));
			}, 2000);
			socket.on("data", (chunk) => {
				output += chunk.toString("ascii");
				if (output.length > 4096) {
					socket.destroy();
					reject(new Error("Raw fixture response exceeded bounds"));
				}
			});
			socket.once("error", reject);
			socket.once("close", () => {
				clearTimeout(timeout);
				resolve(output);
			});
			socket.once("connect", () =>
				socket.write(
					`GET ${info()} HTTP/1.1\r\nHost: 127.0.0.1:${server.port}\r\nContent-Length: 33554432\r\nConnection: close\r\n\r\ntiny-prefix`,
				),
			);
		});
		expect(wire).toMatch(/^HTTP\/1\.1 400 /);
		expect(wire).toContain('"error":"body_not_allowed"');
		expect(fake.recorder.takeRequests()).toEqual([]);
		expect(fake.conversation(channel().id).memberCount).toBe(30);
	});
});
