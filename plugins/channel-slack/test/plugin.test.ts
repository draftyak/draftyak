import { readFileSync } from "node:fs";
import type { SyncPage, SyncRequest } from "@draftyak/protocol/channel-v1";
import type { HostFetchParams } from "@draftyak/protocol/host-channel";
import { validateManifest } from "@draftyak/protocol/manifest";
import { SEND_TICKET_META } from "@draftyak/protocol/send-ticket";
import { createPluginContext, type PluginContext } from "@draftyak/sdk/context";
import { memoryHost } from "@draftyak/sdk/host";
import type { PluginEntry } from "@draftyak/sdk/serve";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SLACK_PLUGIN_MANIFEST } from "../src/manifest.ts";
import { createSlackPlugin } from "../src/plugin.ts";
import {
	LEGACY_SYNC_CHANNEL as CHANNEL,
	createLegacySyncFixture,
	type LegacySyncFixture,
} from "./helpers/legacy-sync-fake.ts";

const SCOPE = "dytest-legacy-account";
const SINCE = 1_800_000_000_000;
const ROOT = "1799999900.000000001";
const REPLY = "1800000000.000000002";
const fixtures: LegacySyncFixture[] = [];
const cleanups: (() => void)[] = [];
const network = vi.fn<typeof fetch>();

function fixture(): LegacySyncFixture {
	const f = createLegacySyncFixture();
	fixtures.push(f);
	return f;
}
function plugin(): PluginEntry {
	return createSlackPlugin({ scope: SCOPE, account: SCOPE });
}
async function invoke(
	entry: PluginEntry,
	name: string,
	args: unknown,
	context: PluginContext,
	metadata: Readonly<Record<string, unknown>> = {},
): Promise<unknown> {
	const tool = entry.tools.find((value) => value.name === name);
	if (!tool) throw new Error("DYTEST tool missing");
	return tool.handler(args, context, metadata);
}
async function drain(f: LegacySyncFixture, entry: PluginEntry, first: SyncRequest) {
	let args = first;
	const pages: SyncPage[] = [];
	for (let pageNumber = 0; pageNumber < 64; pageNumber++) {
		const rpc = f.rpc();
		const result = (await invoke(entry, "channel_sync", args, rpc.context)) as SyncPage;
		rpc.shared.abort();
		pages.push(result);
		if (!result.more)
			return { cursor: result.cursor, changes: pages.flatMap((page) => page.changes) };
		args = { ...first, cursor: result.cursor };
	}
	throw new Error("DYTEST fixture page limit");
}
beforeEach(() => {
	network.mockReset().mockRejectedValue(new Error("DYTEST network forbidden"));
	vi.stubGlobal("fetch", network);
});
afterEach(async () => {
	try {
		for (const close of cleanups.splice(0).reverse()) close();
		for (const f of fixtures.splice(0).reverse()) {
			await f.close();
			expect(f.unexpected).toEqual([]);
			expect(f.pumpErrors).toEqual([]);
		}
		expect(network).not.toHaveBeenCalled();
	} finally {
		vi.unstubAllGlobals();
	}
});

describe("Slack channel plugin composition", () => {
	it("ships the same checked brokered manifest used by the factory", () => {
		const declared: unknown = JSON.parse(
			readFileSync(new URL("../draftyak.plugin.json", import.meta.url), "utf8"),
		);
		expect(declared).toEqual(SLACK_PLUGIN_MANIFEST);
		expect(validateManifest(declared)).toMatchObject({ ok: true });
		expect(declared).toMatchObject({
			auth: { kind: "manifest-app" },
			egress: { profile: "slack-v1" },
			send: { render: "slack-postmessage" },
			credentials: { mode: "brokered", urlSecrets: [] },
		});
		expect(SLACK_PLUGIN_MANIFEST.auth.scopes).toHaveLength(10);
		expect(SLACK_PLUGIN_MANIFEST.auth.scopes).toContain("chat:write");
		expect(SLACK_PLUGIN_MANIFEST.auth.scopes).not.toContain("connections:write");
		expect(SLACK_PLUGIN_MANIFEST.auth.requiredGrantedScopes).toEqual(
			SLACK_PLUGIN_MANIFEST.auth.scopes,
		);
		expect(Object.isFrozen(SLACK_PLUGIN_MANIFEST.auth.scopes)).toBe(true);
	});

	it.each([
		{},
		{ scope: "" },
		{ scope: "x".repeat(4097) },
		{ scope: "\ud800" },
		{ scope: SCOPE, account: "" },
		{ scope: SCOPE, account: "with space" },
	])("refuses unusable captured identity data before any transport", (options) => {
		expect(() => createSlackPlugin(options as Parameters<typeof createSlackPlugin>[0])).toThrow(
			expect.objectContaining({ result: { code: "INVALID_INPUT" } }),
		);
	});

	it("never evaluates an options accessor or proxy while capturing identity", () => {
		const read = vi.fn(() => SCOPE);
		const getter = Object.defineProperty({}, "scope", { enumerable: true, get: read });
		const proxy = new Proxy({ scope: SCOPE }, { get: read });
		for (const options of [getter, proxy])
			expect(() => createSlackPlugin(options as Parameters<typeof createSlackPlugin>[0])).toThrow();
		expect(read).not.toHaveBeenCalled();
	});

	it("serves the real mandatory handlers and an honest optional-tool description", async () => {
		const entry = plugin();
		expect(entry.plugin).toBe("@draftyak/channel-slack");
		expect(entry.account).toBe(SCOPE);
		expect(Object.isFrozen(entry)).toBe(true);
		expect(entry.tools.map((tool) => tool.name).sort()).toEqual([
			"channel_body_fetch",
			"channel_describe",
			"channel_probe",
			"channel_send",
			"channel_send_reconcile",
			"channel_sync",
		]);
		const f = fixture();
		expect(await invoke(entry, "channel_describe", {}, f.rpc().context)).toEqual({
			channel: "chat",
			mutations: [],
			attachments: false,
			listen: false,
		});
		expect(f.requests).toEqual([]);
	});

	it("syncs an old root and recent reply, then fetches its body through the observed root", async () => {
		const f = fixture();
		f.fake.addMessage(CHANNEL, { ts: ROOT, user: "UDYTEST1", text: "DYTEST root" });
		f.fake.addMessage(CHANNEL, {
			ts: REPLY,
			threadTs: ROOT,
			user: "UDYTEST1",
			text: "DYTEST reply body",
		});
		const entry = plugin();
		const initial = await drain(f, entry, { mode: "initial", since: SINCE });
		expect(initial.changes).toContainEqual(
			expect.objectContaining({
				kind: "chat.message",
				ts: REPLY,
				threadTs: ROOT,
			}),
		);
		const offset = f.requests.length;
		const body = await invoke(
			entry,
			"channel_body_fetch",
			{
				message: { kind: "chat", channelId: CHANNEL, ts: REPLY },
			},
			f.rpc().context,
		);
		expect(body).toMatchObject({
			message: {
				kind: "chat.message",
				channelId: CHANNEL,
				ts: REPLY,
				threadTs: ROOT,
				text: "DYTEST reply body",
			},
		});
		const request = f.requests[offset];
		if (request === undefined) throw new Error("DYTEST missing body request");
		const url = new URL(request.params.url);
		expect(url.pathname).toBe("/api/conversations.replies");
		expect(url.searchParams.get("ts")).toBe(ROOT);
		expect(url.searchParams.get("oldest")).toBe(REPLY);
		expect(url.searchParams.get("latest")).toBe(REPLY);
		const delta = await drain(f, entry, { mode: "delta", cursor: initial.cursor });
		expect(delta.changes).toEqual([]);
		expect(delta.cursor).toBe(initial.cursor);
	});

	it("keeps a missing unobserved reply inconclusive and rejects email body requests", async () => {
		const f = fixture();
		const entry = plugin();
		await expect(
			invoke(
				entry,
				"channel_body_fetch",
				{
					message: { kind: "chat", channelId: CHANNEL, ts: REPLY },
				},
				f.rpc().context,
			),
		).rejects.toMatchObject({ result: { code: "TRANSIENT" } });
		const offset = f.requests.length;
		await expect(
			invoke(
				entry,
				"channel_body_fetch",
				{
					message: { kind: "email", providerId: "dytest-email" },
				},
				f.rpc().context,
			),
		).rejects.toMatchObject({ result: { code: "UNSUPPORTED" } });
		expect(f.requests).toHaveLength(offset);
	});

	it("uses SDK metadata for exactly one rendered send and provides advisory probe/reconciliation", async () => {
		const requests: HostFetchParams[] = [];
		const controller = new AbortController();
		const host = memoryHost(async (method, raw) => {
			if (method !== "host/fetch") throw new Error("DYTEST unexpected host method");
			const request = raw as HostFetchParams;
			requests.push(request);
			const route = new URL(request.url).pathname;
			const payload =
				route === "/api/auth.test"
					? { ok: true, user_id: "UDYTEST1" }
					: route === "/api/conversations.history"
						? {
								ok: true,
								messages: [
									{ type: "message", ts: REPLY, user: "UDYTEST1", text: "DYTEST sent candidate" },
								],
								has_more: false,
								response_metadata: { next_cursor: "" },
							}
						: { ok: true, channel: CHANNEL, ts: REPLY };
			return {
				status: 200,
				headers: [["content-type", "application/json"]],
				body: { base64: Buffer.from(JSON.stringify(payload)).toString("base64url") },
			};
		});
		cleanups.push(() => {
			controller.abort();
			host.close();
		});
		const entry = plugin();
		const context = createPluginContext(
			{ plugin: entry.plugin, account: SCOPE },
			host,
			controller.signal,
		);
		const args = {
			method: "POST",
			url: "https://slack.com/api/chat.postMessage",
			contentType: "application/json",
			body: { ref: "01ARZ3NDEKTSV4RRFFQ69G5FAV" },
		};
		await expect(invoke(entry, "channel_send", args, context)).rejects.toMatchObject({
			result: { code: "INVALID_INPUT" },
		});
		expect(requests).toEqual([]);
		const ticket = {
			id: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
			outboxId: "01ARZ3NDEKTSV4RRFFQ69G5FAX",
			instanceId: "01ARZ3NDEKTSV4RRFFQ69G5FAY",
			method: args.method,
			url: args.url,
			contentType: args.contentType,
			headersSha256: "a".repeat(64),
			bodySha256: "b".repeat(64),
			exp: 1000,
		};
		expect(
			await invoke(entry, "channel_send", args, context, { [SEND_TICKET_META]: ticket }),
		).toEqual({
			message: { kind: "chat", channelId: CHANNEL, ts: REPLY },
		});
		expect(requests).toHaveLength(1);
		expect(requests[0]).toMatchObject({
			method: args.method,
			url: args.url,
			body: args.body,
			sendTicket: ticket,
			headers: [["content-type", args.contentType]],
		});
		expect(await invoke(entry, "channel_probe", {}, context)).toEqual({ status: "ok" });
		expect(
			await invoke(
				entry,
				"channel_send_reconcile",
				{
					attemptAt: SINCE,
					target: { kind: "chat", channelId: CHANNEL },
				},
				context,
			),
		).toMatchObject({ complete: true, candidates: [{ ts: REPLY, text: "DYTEST sent candidate" }] });
		expect(requests).toHaveLength(4);
	});
});
