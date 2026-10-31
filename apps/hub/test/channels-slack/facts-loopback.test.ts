import type { Listening } from "@draftyak/fakes/server";
import type { SnapshotChat } from "@draftyak/protocol/snapshot";
import { afterEach, describe, expect, it } from "vitest";
import {
	checkSlackPreflight,
	decodeSlackChannelFacts,
	type SlackChatFacts,
	SlackCoreError,
} from "../../src/channels/slack/index.ts";
import {
	type ChannelInfoFixture,
	createChannelInfoFixture,
	explicitSharing,
	frozenChat,
	sparseIm,
	sparseMpim,
} from "./helpers/channel-info-fake.ts";

const directIm = (id: string) => explicitSharing(sparseIm(id));
const directMpim = (id: string) => explicitSharing(sparseMpim(id));

const id = "C0DYTEST1";
const listeners: Listening[] = [];
afterEach(async () => {
	await Promise.all(listeners.splice(0).map((listener) => listener.close()));
});

function channel(change: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id,
		name: "dytest-general",
		is_channel: true,
		is_group: false,
		is_im: false,
		is_mpim: false,
		is_private: false,
		is_archived: false,
		is_shared: false,
		is_ext_shared: false,
		is_org_shared: false,
		is_pending_ext_shared: false,
		is_member: true,
		num_members: 30,
		...change,
	};
}
function fixture(
	raw: Record<string, unknown> = channel(),
	account = "DYTEST_ACCOUNT_A",
): ChannelInfoFixture {
	return createChannelInfoFixture({ account, expectedChannelId: id, channel: raw });
}
async function listen(value: ChannelInfoFixture): Promise<Listening> {
	const listener = await value.fake.listen();
	listeners.push(listener);
	expect(listener.origin).toBe(`http://127.0.0.1:${listener.port}`);
	return listener;
}
async function read(
	listener: Listening,
	value: ChannelInfoFixture,
	expected = id,
): Promise<SlackChatFacts> {
	const response = await fetch(listener.origin + value.target, {
		redirect: "error",
		signal: AbortSignal.timeout(2_000),
	});
	expect(response.status).toBe(200);
	return decodeSlackChannelFacts(expected, await response.json());
}
function preflight(approved: SnapshotChat, current: SlackChatFacts) {
	return checkSlackPreflight({
		approved,
		current,
		holdIfReply: false,
		approvedInboundWatermark: null,
		currentInboundWatermark: null,
	});
}
function onlyReads(value: ChannelInfoFixture, count: number): void {
	const requests = value.fake.recorder.takeRequests();
	expect(requests).toHaveLength(count);
	for (const request of requests) {
		expect(request).toMatchObject({
			method: "GET",
			target: value.target,
			path: "/api/conversations.info",
			bodyLength: 0,
		});
		expect(request.headerNames).not.toContain("authorization");
	}
}

describe("synthetic loopback channel-facts contract", () => {
	it.each([
		{ name: "public", change: {}, type: "public" },
		{ name: "modern private", change: { is_private: true }, type: "private" },
		{
			name: "legacy private",
			change: { is_channel: false, is_group: true, is_private: true },
			type: "private",
		},
	])("decodes actual JSON and allows unchanged explicit $name facts", async ({ change, type }) => {
		const value = fixture(channel(change)),
			listener = await listen(value);
		const approved = frozenChat(await read(listener, value)),
			current = await read(listener, value);
		expect(current).toMatchObject({
			channelId: id,
			type,
			name: "dytest-general",
			member: true,
			memberCount: 30,
		});
		expect(Object.isFrozen(current)).toBe(true);
		expect(preflight(approved, current)).toEqual({ state: "ALLOW" });
		onlyReads(value, 2);
	});
	it.each([
		{ name: "rename", change: { name: "dytest-renamed" } },
		{ name: "archive", change: { is_archived: true } },
		{ name: "membership loss", change: { is_member: false } },
		{ name: "member growth", change: { num_members: 34 } },
		{ name: "private conversion", change: { is_private: true } },
		{ name: "external sharing", change: { is_shared: true, is_ext_shared: true } },
		{ name: "pending external sharing", change: { is_pending_ext_shared: true } },
	])("feeds a real readback $name into the existing preflight refusal", async ({ change }) => {
		const value = fixture(),
			listener = await listen(value);
		const approved = frozenChat(await read(listener, value));
		value.setChannel(channel(change));
		const current = await read(listener, value);
		expect(preflight(approved, current)).toEqual({
			state: "NEEDS_REAPPROVAL",
			reason: "channel_changed",
		});
		onlyReads(value, 2);
	});
	it("does not hide an internal-shared to external-shared transition", async () => {
		const value = fixture(channel({ is_shared: true, is_org_shared: true })),
			listener = await listen(value);
		const approved = frozenChat(await read(listener, value));
		value.setChannel(channel({ is_shared: true, is_org_shared: true, is_ext_shared: true }));
		const current = await read(listener, value);
		expect(preflight(approved, current)).toEqual({
			state: "NEEDS_REAPPROVAL",
			reason: "channel_changed",
		});
		onlyReads(value, 2);
	});
	it("requires reapproval when fresh internal sharing exceeds the frozen facts", async () => {
		const value = fixture(),
			listener = await listen(value);
		const approved = frozenChat(await read(listener, value));
		value.setChannel(channel({ is_shared: true, is_org_shared: true }));
		expect(preflight(approved, await read(listener, value))).toEqual({
			state: "NEEDS_REAPPROVAL",
			reason: "channel_changed",
		});
		expect(approved.shared).toBe(false);
		onlyReads(value, 2);
	});
	it.each([
		{ name: "IM", raw: directIm(id), type: "dm", count: 2 },
		{ name: "MPIM", raw: directMpim(id), type: "group_dm", count: 0 },
	])(
		"admits sparse $name JSON carrying explicit sharing evidence",
		async ({ raw, type, count }) => {
			const value = fixture(raw),
				listener = await listen(value);
			const initial = await read(listener, value),
				approved = frozenChat(initial);
			expect(initial).toMatchObject({
				channelId: id,
				type,
				memberCount: count,
				member: true,
				archived: false,
			});
			expect(preflight(approved, initial)).toEqual({ state: "ALLOW" });
			value.setChannel({ ...raw, name: "synthetic-display-change", num_members: 500 });
			expect(preflight(approved, await read(listener, value))).toEqual({ state: "ALLOW" });
			value.setChannel({ ...raw, is_pending_ext_shared: true });
			expect(preflight(approved, await read(listener, value))).toEqual({
				state: "NEEDS_REAPPROVAL",
				reason: "channel_changed",
			});
			value.setChannel({ ...raw, is_member: false });
			expect(preflight(approved, await read(listener, value))).toEqual({
				state: "NEEDS_REAPPROVAL",
				reason: "channel_changed",
			});
			onlyReads(value, 4);
		},
	);
	it.each([false, true])("allows unchanged explicit shared=%s from real JSON", async (shared) => {
		const value = fixture(channel({ is_shared: shared, is_org_shared: shared })),
			listener = await listen(value);
		const approved = frozenChat(await read(listener, value));
		expect(approved.shared).toBe(shared);
		expect(preflight(approved, await read(listener, value))).toEqual({ state: "ALLOW" });
		onlyReads(value, 2);
	});
	it("refuses a legacy approval without enriching its frozen bytes", async () => {
		const value = fixture(),
			listener = await listen(value),
			initial = await read(listener, value);
		const { shared: _shared, ...legacy } = frozenChat(initial);
		Object.freeze(legacy);
		const legacyBytes = JSON.stringify(legacy);
		expect(() => preflight(legacy, initial)).toThrow(SlackCoreError);
		expect(JSON.stringify(legacy)).toBe(legacyBytes);
		expect(legacy).not.toHaveProperty("shared");
		onlyReads(value, 1);
	});
	it.each([sparseIm, sparseMpim])(
		"refuses sparse direct JSON missing sharing evidence %#",
		async (shape) => {
			for (const key of ["is_shared", "is_ext_shared", "is_org_shared", "is_pending_ext_shared"]) {
				const raw = explicitSharing(shape(id));
				delete raw[key];
				const value = fixture(raw),
					listener = await listen(value);
				await expect(read(listener, value)).rejects.toEqual(new SlackCoreError("INVALID_INPUT"));
				onlyReads(value, 1);
			}
		},
	);
	it("keeps the existing hold-if-reply check after the caller's current-facts read", async () => {
		const value = fixture(),
			listener = await listen(value),
			current = await read(listener, value);
		const result = checkSlackPreflight({
			approved: frozenChat(current),
			current,
			holdIfReply: true,
			approvedInboundWatermark: null,
			currentInboundWatermark: "1760000001.000100",
		});
		expect(result).toEqual({ state: "NEEDS_REAPPROVAL", reason: "new_reply" });
		onlyReads(value, 1);
	});
	it.each([
		{ name: "missing member count", raw: channel({ num_members: undefined }) },
		{ name: "missing membership", raw: channel({ is_member: undefined }) },
		{ name: "frozen channel", raw: channel({ is_frozen: true }) },
		{ name: "read-only channel", raw: channel({ is_read_only: true }) },
		{ name: "thread-only channel", raw: channel({ is_thread_only: true }) },
		{ name: "wrong returned ID", raw: channel({ id: "C0OTHER01" }) },
	])("refuses actual JSON carrying $name without calling preflight", async ({ raw }) => {
		const value = fixture(raw),
			listener = await listen(value);
		await expect(read(listener, value)).rejects.toEqual(new SlackCoreError("INVALID_INPUT"));
		onlyReads(value, 1);
	});
	it("uses the requested ID even when a different valid ID would otherwise parse", async () => {
		const value = fixture(),
			listener = await listen(value);
		await expect(read(listener, value, "C0OTHER01")).rejects.toEqual(
			new SlackCoreError("INVALID_INPUT"),
		);
		onlyReads(value, 1);
	});
	it("keeps explicit membership data isolated between two synthetic account fixtures", async () => {
		const a = fixture(channel(), "DYTEST_ACCOUNT_A"),
			b = fixture(channel({ is_member: false }), "DYTEST_ACCOUNT_B");
		const first = await listen(a),
			second = await listen(b);
		expect(a.account).not.toBe(b.account);
		expect(first.origin).not.toBe(second.origin);
		const aFacts = await read(first, a),
			bFacts = await read(second, b);
		expect(aFacts.member).toBe(true);
		expect(bFacts.member).toBe(false);
		expect(aFacts).not.toHaveProperty("account");
		expect(bFacts).not.toHaveProperty("account");
		onlyReads(a, 1);
		onlyReads(b, 1);
	});
	it("does not interpret the real fake-server 429 as successful channel facts", async () => {
		const value = fixture(),
			listener = await listen(value);
		value.fake.faults.add({
			kind: "rate-limit",
			retryAfter: 60,
			method: "GET",
			path: "/api/conversations.info",
		});
		const response = await fetch(listener.origin + value.target, {
			signal: AbortSignal.timeout(2_000),
			redirect: "error",
		});
		expect(response.status).toBe(429);
		expect(response.headers.get("retry-after")).toBe("60");
		const raw: unknown = await response.json();
		expect(() => decodeSlackChannelFacts(id, raw)).toThrowError(
			new SlackCoreError("INVALID_INPUT"),
		);
		onlyReads(value, 1);
	});
	it("requires the exact channel query with an explicit member-count request", async () => {
		const value = fixture(),
			listener = await listen(value);
		const targets = [
			`/api/conversations.info?channel=${id}`,
			`${value.target}&channel=${id}`,
			value.target.replace("=true", "=false"),
		];
		for (const target of targets) {
			const response = await fetch(listener.origin + target, {
				signal: AbortSignal.timeout(2_000),
				redirect: "error",
			});
			expect(response.status).toBe(400);
			const raw: unknown = await response.json();
			expect(() => decodeSlackChannelFacts(id, raw)).toThrowError(
				new SlackCoreError("INVALID_INPUT"),
			);
		}
		expect(
			value.fake.recorder
				.takeRequests()
				.map(({ method, target, bodyLength }) => ({ method, target, bodyLength })),
		).toEqual(targets.map((target) => ({ method: "GET", target, bodyLength: 0 })));
	});
});
