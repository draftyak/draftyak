import {
	createSlackReadFake,
	SLACK_READ_HOST,
	type SlackReadConversation,
} from "@draftyak/fakes/slack";
import { describe, expect, it } from "vitest";
import {
	MAX_SLACK_CONVERSATIONS_PER_PAGE,
	reduceConversationInfo,
	reduceConversationListPage,
} from "../src/conversations.ts";

function channel(patch: Record<string, unknown> = {}): Record<string, unknown> {
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
function facts(patch: Record<string, unknown> = {}): Record<string, unknown> {
	return channel({
		is_member: true,
		is_archived: false,
		is_shared: false,
		is_ext_shared: false,
		is_org_shared: false,
		is_pending_ext_shared: false,
		num_members: 4,
		...patch,
	});
}
function list(rows: unknown[] = [channel()], patch: Record<string, unknown> = {}): unknown {
	return { ok: true, channels: rows, response_metadata: { next_cursor: "" }, ...patch };
}
function info(row: unknown = facts(), patch: Record<string, unknown> = {}): unknown {
	return { ok: true, channel: row, ...patch };
}
function fixture(patch: Partial<SlackReadConversation> = {}): SlackReadConversation {
	return {
		id: "CDYTEST01",
		name: "DYTEST room",
		kind: "public_channel",
		member: true,
		archived: false,
		sharing: "none",
		memberCount: 4,
		...patch,
	};
}
const invalidList = (input: unknown): void => {
	expect(() => reduceConversationListPage(input)).toThrow(/^SLACK_CONVERSATIONS_INVALID$/);
};
const invalidInfo = (input: unknown): void => {
	expect(() => reduceConversationInfo(input)).toThrow(/^SLACK_CONVERSATIONS_INVALID$/);
};

describe("Slack conversation discovery and facts", () => {
	it("decodes limited listing shapes without making membership or normalized-change claims", () => {
		const input = list([
			channel(),
			channel({ id: "CDYTEST02", is_private: true }),
			channel({ id: "GDYTEST03", is_channel: false, is_group: true, is_private: true }),
			{ id: "DDYTEST04", is_im: true },
			{ id: "GDYTEST05", is_mpim: true, is_private: true },
		]);
		const result = reduceConversationListPage(input);
		expect(result).toEqual({
			conversations: [
				{ channelId: "CDYTEST01", name: "DYTEST room", type: "public" },
				{ channelId: "CDYTEST02", name: "DYTEST room", type: "private" },
				{ channelId: "GDYTEST03", name: "DYTEST room", type: "private" },
				{ channelId: "DDYTEST04", type: "dm" },
				{ channelId: "GDYTEST05", type: "group_dm" },
			],
			nextCursor: undefined,
			more: false,
		});
		expect(result).not.toHaveProperty("changes");
		for (const item of result.conversations) {
			for (const key of ["kind", "member", "memberCount", "external", "shared", "archived"]) {
				expect(item).not.toHaveProperty(key);
			}
		}
	});

	it("preserves the real read fixture's empty filtered non-final page and opaque cursor", async () => {
		const upstream = createSlackReadFake({
			conversations: [fixture({ member: false }), fixture({ id: "CDYTEST02" })],
		});
		const url = new URL(`https://${SLACK_READ_HOST}/api/users.conversations?limit=1`);
		const first = reduceConversationListPage(await (await upstream.fetch(url)).json());
		expect(first.conversations).toEqual([]);
		expect(first.more).toBe(true);
		expect(first.nextCursor).toEqual(expect.any(String));
		url.searchParams.set("cursor", first.nextCursor as string);
		const second = reduceConversationListPage(await (await upstream.fetch(url)).json());
		expect(second.conversations).toEqual([
			{ channelId: "CDYTEST02", name: "DYTEST room", type: "public" },
		]);
		expect(second.more).toBe(false);
		expect(second.nextCursor).toBeUndefined();
	});

	it("requires the real info response's explicit count instead of using list data as facts", async () => {
		const upstream = createSlackReadFake({ conversations: [fixture({ memberCount: 0 })] });
		const url = new URL(`https://${SLACK_READ_HOST}/api/conversations.info?channel=CDYTEST01`);
		invalidInfo(await (await upstream.fetch(url)).json());
		url.searchParams.set("include_num_members", "true");
		expect(reduceConversationInfo(await (await upstream.fetch(url)).json())).toEqual({
			kind: "chat.conversation",
			channelId: "CDYTEST01",
			name: "DYTEST room",
			type: "public",
			external: false,
			shared: false,
			memberCount: 0,
			archived: false,
			member: true,
		});
		invalidInfo({ ok: true, channels: [facts()] });
		invalidInfo(info(channel()));
	});

	it.each([
		["modern private", { is_private: true }, "private"],
		["legacy private", { is_channel: false, is_group: true, is_private: true }, "private"],
		["private DM", { is_channel: false, is_im: true, is_private: true, name: undefined }, "dm"],
		[
			"private MPIM",
			{ is_channel: false, is_group: true, is_mpim: true, is_private: true },
			"group_dm",
		],
	] as const)("hydrates %s without imposing legacy flag equivalences", (_label, patch, type) => {
		expect(reduceConversationInfo(info(facts(patch))).type).toBe(type);
	});

	it("refuses absent or unsupported normalized facts rather than inferring membership or DM count", () => {
		for (const key of ["is_member", "is_archived", "is_shared", "is_ext_shared", "num_members"]) {
			const row = facts({ is_im: true, is_private: true, is_channel: false });
			delete row[key];
			invalidInfo(info(row));
		}
		for (const patch of [
			{ is_member: "true" },
			{ is_archived: undefined },
			{ num_members: -1 },
			{ num_members: 1.5 },
			{ num_members: Number.MAX_SAFE_INTEGER + 1 },
			{ is_ext_shared: true },
			{ is_org_shared: true },
			{ is_pending_ext_shared: true },
			{ is_pending_ext_shared: "false" },
		])
			invalidInfo(info(facts(patch)));
		expect(
			reduceConversationInfo(
				info(
					facts({
						num_members: Number.MAX_SAFE_INTEGER,
						is_shared: true,
						is_ext_shared: true,
						is_org_shared: true,
					}),
				),
			),
		).toMatchObject({
			memberCount: Number.MAX_SAFE_INTEGER,
			shared: true,
			external: true,
		});
	});

	it("uses the shared opaque IDs and optional well-formed 256-codepoint names", () => {
		const id = `opaque:${"x".repeat(249)}`;
		const name = "\u{1f642}".repeat(256);
		expect(reduceConversationListPage(list([channel({ id, name })])).conversations[0]).toEqual({
			channelId: id,
			name,
			type: "public",
		});
		for (const name of [undefined, "", "e\u0301", "a\nb"]) {
			const row = { id: "DM:opaque", is_im: true, name };
			const result = reduceConversationListPage(list([row])).conversations[0];
			if (name === undefined) expect(result).not.toHaveProperty("name");
			else expect(result?.name).toBe(name);
		}
		for (const patch of [
			{ id: "" },
			{ id: "a b" },
			{ id: `${id}x` },
			{ name: `${name}x` },
			{ name: "\ud800" },
		])
			invalidList(list([channel(patch)]));
	});

	it("accepts 999 discovery rows independently of the 500 normalized-change limit", () => {
		expect(MAX_SLACK_CONVERSATIONS_PER_PAGE).toBe(999);
		const rows = Array.from({ length: 999 }, (_, at) =>
			channel({ id: `room:${at}`, name: "\u{1f642}".repeat(256) }),
		);
		expect(Buffer.byteLength(JSON.stringify(rows))).toBeGreaterThan(256 * 1024);
		expect(reduceConversationListPage(list(rows)).conversations).toHaveLength(999);
		invalidList(list([...rows, channel({ id: "extra" })]));
	});

	it("validates present type flags, accepts omitted irrelevant flags, and refuses contradictions", () => {
		for (const key of ["is_im", "is_mpim", "is_private", "is_channel", "is_group"]) {
			for (const value of [undefined, null, 0, "false", {}])
				invalidList(list([channel({ [key]: value })]));
		}
		for (const row of [
			{ id: "DM:one", is_im: true },
			{ id: "DM:many", is_mpim: true },
		]) {
			expect(reduceConversationListPage(list([row])).conversations).toHaveLength(1);
		}
		for (const row of [
			channel({ is_im: true, is_mpim: true }),
			{ id: "DM:bad", is_im: true, is_private: false },
			{ id: "DM:bad", is_mpim: true, is_private: false },
			channel({ is_group: true }),
			channel({ is_channel: false }),
			{ id: "unknown" },
			channel({ is_private: undefined }),
		])
			invalidList(list([channel(), row]));
		invalidList(list([channel(), channel()]));
	});

	it("refuses conflicting observed conversation roles before choosing a type", () => {
		for (const patch of [
			{ is_im: true, is_private: true },
			{ is_im: true, is_channel: false, is_group: true, is_private: true },
			{ is_mpim: true, is_private: true },
			{ is_group: true, is_private: true },
		]) {
			invalidList(list([channel(patch)]));
			invalidInfo(info(facts(patch)));
		}
	});

	it.each([
		[false, "", false],
		[false, "opaque:next/+%?", true],
		[true, "", true],
		[true, "opaque:next/+%?", true],
	])("preserves more=%s with cursor=%s", (has_more, cursor, more) => {
		const result = reduceConversationListPage(
			list([], { has_more, response_metadata: { next_cursor: cursor } }),
		);
		expect(result.more).toBe(more);
		expect(result.nextCursor).toBe(cursor || undefined);
	});

	it("requires an observed continuation or completion signal", () => {
		invalidList({ ok: true, channels: [] });
		invalidList(list([], { response_metadata: {} }));
		invalidList(list([], { response_metadata: undefined }));
		expect(reduceConversationListPage({ ok: true, channels: [], has_more: true }).more).toBe(true);
		expect(reduceConversationListPage({ ok: true, channels: [], has_more: false }).more).toBe(
			false,
		);
		for (const next_cursor of [undefined, null, 0, "with space", "x".repeat(4097)])
			invalidList(list([], { response_metadata: { next_cursor } }));
		const cursor = "x".repeat(4096);
		expect(
			reduceConversationListPage(list([], { response_metadata: { next_cursor: cursor } }))
				.nextCursor,
		).toBe(cursor);
		invalidList(list([], { has_more: "false" }));
	});

	it("leaves listing membership and sharing branches unread and freezes detached output", () => {
		let calls = 0;
		const poison = new Proxy(
			{},
			{
				get() {
					calls++;
					throw new Error("DYTEST unused");
				},
			},
		);
		const row = channel({ is_pending_ext_shared: true, topic: poison });
		for (const key of ["is_member", "num_members", "is_shared", "is_ext_shared"]) {
			Object.defineProperty(row, key, {
				enumerable: true,
				get() {
					calls++;
					throw new Error("DYTEST unselected");
				},
			});
		}
		const metadata = { next_cursor: "next", ignored: poison };
		const input = { ok: true, channels: [row], response_metadata: metadata };
		for (const object of [row, metadata, input]) {
			Object.defineProperty(object, "unused", {
				enumerable: true,
				get() {
					calls++;
					throw new Error("DYTEST unused");
				},
			});
			Object.defineProperty(object, "toJSON", { value: poison, enumerable: true });
			Object.defineProperty(object, Symbol.iterator, { value: poison });
			Object.defineProperty(object, "cycle", { value: object, enumerable: true });
		}
		const result = reduceConversationListPage(input);
		row.id = "changed";
		row.name = "changed";
		metadata.next_cursor = "changed";
		expect(result.conversations[0]).toEqual({
			channelId: "CDYTEST01",
			name: "DYTEST room",
			type: "public",
		});
		expect(result.nextCursor).toBe("next");
		expect(Object.isFrozen(result)).toBe(true);
		expect(Object.isFrozen(result.conversations)).toBe(true);
		expect(Object.isFrozen(result.conversations[0])).toBe(true);
		expect(Object.isFrozen(reduceConversationInfo(info()))).toBe(true);
		expect(calls).toBe(0);
	});

	it("refuses selected behavior, malformed arrays, and error envelopes without invoking data hooks", () => {
		let calls = 0;
		const traps = {
			get() {
				calls++;
				throw new Error("DYTEST unused");
			},
			ownKeys() {
				calls++;
				return [];
			},
			getPrototypeOf() {
				calls++;
				return null;
			},
		};
		invalidList(new Proxy({}, traps));
		invalidInfo(new Proxy({}, traps));
		invalidList(list([new Proxy({}, traps)]));
		invalidInfo(info(new Proxy({}, traps)));
		invalidList(list([], { response_metadata: new Proxy({}, traps) }));
		for (const key of ["id", "name", "is_im"]) {
			const row = channel();
			Object.defineProperty(row, key, {
				enumerable: true,
				get() {
					calls++;
					return 1;
				},
			});
			invalidList(list([row]));
		}
		for (const key of ["is_member", "num_members", "is_pending_ext_shared"]) {
			const row = facts();
			Object.defineProperty(row, key, {
				enumerable: true,
				get() {
					calls++;
					return 1;
				},
			});
			invalidInfo(info(row));
		}
		for (const [make, refuse] of [
			[list, invalidList],
			[info, invalidInfo],
		] as const) {
			const input = make() as Record<string, unknown>;
			Object.defineProperty(input, "error", {
				get() {
					calls++;
					return "DYTEST provider error";
				},
			});
			refuse(input);
		}
		invalidList(list([], { ok: false }));
		invalidInfo(info(facts(), { ok: false }));
		const accessor: unknown[] = [];
		Object.defineProperty(accessor, "0", {
			enumerable: true,
			get() {
				calls++;
				return channel();
			},
		});
		const extra = [channel()];
		Object.defineProperty(extra, Symbol.iterator, {
			value() {
				calls++;
				return [][Symbol.iterator]();
			},
		});
		for (const rows of [new Array(1), accessor, extra, new Proxy([], traps)])
			invalidList(list(rows));
		expect(calls).toBe(0);
	});
});
