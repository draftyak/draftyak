import {
	createFake,
	createHelloFake,
	createRecorder,
	HELLO_HOST,
	manualClock,
} from "@draftyak/fakes";
import { createMockHub, type MockHub } from "@draftyak/plugin-testkit";
import { CHANNEL_V1, channelV1, type SyncPage } from "@draftyak/protocol/channel-v1";
import {
	checkPluginSurface,
	checkToolResult,
	extensionDeclaration,
} from "@draftyak/protocol/extension";
import { validateTemplate } from "@draftyak/protocol/json-template";
import { validateManifest } from "@draftyak/protocol/manifest";
import { SEND_TICKET_META } from "@draftyak/protocol/send-ticket";
import { afterEach, expect, it } from "vitest";
import { manifest, plugin } from "../src/plugin.ts";

const hubs: MockHub[] = [];
afterEach(async () => {
	await Promise.all(hubs.splice(0).map((hub) => hub.close()));
});
function setup(fake = createHelloFake()): MockHub {
	const hub = createMockHub({
		mode: "in-memory",
		plugin: { manifest, entry: plugin },
		upstreams: [fake],
	});
	hubs.push(hub);
	return hub;
}
async function call(
	hub: MockHub,
	name: keyof typeof channelV1.tools,
	args: Record<string, unknown>,
) {
	const result = await hub.call(name, args);
	expect(checkToolResult(channelV1, name, result).ok).toBe(true);
	expect(result.isError).not.toBe(true);
	return result.structuredContent;
}
async function drain(
	hub: MockHub,
	mode: "initial" | "delta" | "resync",
	cursor?: string,
	since = 0,
): Promise<SyncPage> {
	const changes: SyncPage["changes"][number][] = [];
	for (let count = 0; count < 64; count++) {
		const args =
			mode === "delta" ? { mode, cursor } : { mode, since, ...(cursor ? { cursor } : {}) };
		const page = channelV1.tools.channel_sync.output.parse(await call(hub, "channel_sync", args));
		changes.push(...page.changes);
		if (!page.more) return { ...page, changes };
		cursor = page.cursor;
	}
	throw new Error("Sync did not finish");
}
it("declares the pinned channel extension and stable canonical tools without optional capabilities", async () => {
	const hub = setup();
	const discover = await hub.discover();
	const list = await hub.listTools();
	expect(discover).toMatchObject({
		supportedVersions: ["2026-07-28"],
		capabilities: { extensions: { [CHANNEL_V1]: extensionDeclaration(channelV1) } },
	});
	expect(checkPluginSurface(discover, list, channelV1)).toEqual([]);
	expect(await hub.listTools()).toEqual(list);
	expect(await call(hub, "channel_describe", {})).toEqual({
		channel: "chat",
		mutations: [],
		attachments: false,
		listen: false,
	});
	expect((list.tools as { name: string }[]).map((tool) => tool.name).sort()).toEqual(
		Object.entries(channelV1.tools)
			.filter(([, tool]) => !tool.optional)
			.map(([name]) => name)
			.sort(),
	);
	expect(await call(hub, "channel_probe", {})).toEqual({ status: "ok" });
});
it("validates the constrained send manifest and canonical footer binding", () => {
	expect(validateManifest(manifest).ok).toBe(true);
	expect(
		validateTemplate(manifest.send.template, manifest.egress.rules, manifest.send.constants),
	).toEqual([]);
	expect(manifest.send.template.body).toEqual({ text: { bind: "body.textWithFooter" } });
	expect(manifest.send.template.query).toEqual({ idempotency_key: { bind: "outbox.id" } });
});
it("syncs initial, delta and resync pages, fetches a body and recovers from expired cursors", async () => {
	const clock = manualClock(1_000);
	const fake = createHelloFake({ clock, cursorTtlMs: 100 });
	const hub = setup(fake);
	const initial = await drain(hub, "initial");
	expect(initial.changes.filter((change) => change.kind === "chat.message")).toHaveLength(4);
	expect(initial.changes).toHaveLength(4);
	const added = fake.addMessage("conv-2", { author: "DYTEST-user", text: "DYTEST delta" });
	const delta = await drain(hub, "delta", initial.cursor);
	expect(delta.changes).toEqual([
		{
			kind: "chat.message",
			channelId: "conv-2",
			ts: added.id,
			sentAt: 1_000,
			author: { kind: "user", id: "DYTEST-user" },
			text: "DYTEST delta",
		},
	]);
	expect(
		await call(hub, "channel_body_fetch", {
			message: { kind: "chat", channelId: "conv-2", ts: added.id },
		}),
	).toEqual({ message: delta.changes[0] });
	clock.advance(100);
	expect(await hub.call("channel_sync", { mode: "delta", cursor: delta.cursor })).toMatchObject({
		isError: true,
		structuredContent: { code: "CURSOR_EXPIRED" },
	});
	expect(await hub.call("channel_sync", { mode: "delta", cursor: "DYTEST-invalid" })).toMatchObject(
		{ isError: true, structuredContent: { code: "CURSOR_EXPIRED" } },
	);
	const resync = await drain(hub, "resync");
	expect(resync.changes.filter((change) => change.kind === "chat.message")).toHaveLength(5);
	expect(
		(await drain(hub, "initial", undefined, 1_001)).changes.filter(
			(change) => change.kind === "chat.message",
		),
	).toEqual([]);
	expect(hub.host.denials).toEqual([]);
});
it("paginates within a conversation without losing messages", async () => {
	const fake = createHelloFake({
		conversations: [
			{
				id: "DYTEST-room",
				name: "DYTEST paging",
				messages: Array.from({ length: 51 }, (_, index) => ({
					author: "DYTEST-user",
					text: `DYTEST message ${index}`,
				})),
			},
		],
	});
	const hub = setup(fake);
	const initial = await drain(hub, "initial");
	expect(initial.changes.filter((change) => change.kind === "chat.message")).toHaveLength(51);
	expect((await drain(hub, "delta", initial.cursor)).changes).toEqual([]);
	const last = fake.messages("DYTEST-room").at(-1);
	expect(
		await call(hub, "channel_body_fetch", {
			message: { kind: "chat", channelId: "DYTEST-room", ts: last?.id },
		}),
	).toMatchObject({ message: { text: "DYTEST message 50" } });
});
it("transports one approved body unchanged, consumes its ticket, and reconciles the provider id", async () => {
	const clock = manualClock(2_000);
	const recorder = createRecorder({ headerValues: ["content-type"] });
	const fake = createHelloFake({ clock, recorder });
	const hub = setup(fake);
	const outboxId = "00000000000000000000000003";
	const url = `https://${HELLO_HOST}/v1/conversations/conv-1/messages?idempotency_key=${outboxId}`;
	const body = new TextEncoder().encode('{"text":"DYTEST approved\\nDYTEST footer"}');
	const now = Date.now();
	const ticket = hub.host.mintTicket({
		outboxId,
		method: "POST",
		url,
		headers: [["content-type", "application/json"]],
		body,
		mintedAt: now,
		deliverBy: now + 60_000,
	});
	const args = {
		method: "POST",
		url,
		contentType: "application/json",
		body: hub.host.putBlob(body),
	};
	const result = await hub.call("channel_send", args, { [SEND_TICKET_META]: ticket });
	expect(checkToolResult(channelV1, "channel_send", result)).toMatchObject({
		ok: true,
		isError: false,
	});
	const sent = fake.messages("conv-1").at(-1);
	expect(result.structuredContent).toEqual({
		message: { kind: "chat", channelId: "conv-1", ts: sent?.id },
	});
	expect(sent?.text).toBe("DYTEST approved\nDYTEST footer");
	const requests = recorder.takeRequests();
	expect(requests).toHaveLength(1);
	expect(requests[0]).toMatchObject({
		method: "POST",
		host: HELLO_HOST,
		target: new URL(url).pathname + new URL(url).search,
		headers: { "content-type": "application/json" },
		body,
		bodySha256: ticket.bodySha256,
	});
	expect(hub.host.hasTicket(ticket.id)).toBe(false);
	expect(
		await call(hub, "channel_send_reconcile", {
			attemptAt: 2_000,
			target: { kind: "chat", channelId: "conv-1" },
		}),
	).toEqual({
		candidates: [
			{
				kind: "chat.message",
				channelId: "conv-1",
				ts: sent?.id,
				sentAt: 2_000,
				author: { kind: "user", id: "me" },
				text: "DYTEST approved\nDYTEST footer",
			},
		],
		complete: true,
	});
	recorder.takeRequests();
	await expect(hub.call("channel_send", args, { [SEND_TICKET_META]: ticket })).rejects.toThrow(
		"DENIED",
	);
	expect(recorder.takeRequests()).toEqual([]);
});
it("refuses unticketed sends and unsupported body kinds without dispatch", async () => {
	const fake = createHelloFake();
	const hub = setup(fake);
	expect(
		await hub.call("channel_send", {
			method: "POST",
			url: `https://${HELLO_HOST}/v1/conversations/conv-1/messages`,
			contentType: "application/json",
			body: hub.host.putBlob(new TextEncoder().encode('{"text":"DYTEST forbidden"}')),
		}),
	).toMatchObject({ isError: true, structuredContent: { code: "INVALID_INPUT" } });
	expect(
		await hub.call("channel_body_fetch", {
			message: { kind: "email", providerId: "DYTEST-email" },
		}),
	).toMatchObject({ isError: true, structuredContent: { code: "UNSUPPORTED" } });
	expect(fake.recorder.takeRequests()).toEqual([]);
	expect(
		await hub.call("channel_body_fetch", {
			message: { kind: "chat", channelId: "conv-1", ts: "DYTEST-missing" },
		}),
	).toMatchObject({ isError: true, structuredContent: { code: "NOT_FOUND" } });
});
it("rejects malformed upstream replies through the real SDK result boundary", async () => {
	const fake = createFake({ fetch: () => Response.json({ id: 17 }) }, { host: HELLO_HOST });
	const hub = createMockHub({
		mode: "in-memory",
		plugin: { manifest, entry: plugin },
		upstreams: [fake],
	});
	hubs.push(hub);
	expect(await hub.call("channel_probe", {})).toMatchObject({
		isError: true,
		structuredContent: { code: "TRANSIENT" },
	});
});
