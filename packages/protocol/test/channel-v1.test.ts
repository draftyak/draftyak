import { Validator } from "@cfworker/json-schema";
import { describe, expect, expectTypeOf, it } from "vitest";
import type * as z from "zod";
import {
	CHANNEL_V1,
	channelV1,
	MAX_LEASE_MS,
	MAX_SLACK_CATALOG_CONVERSATIONS,
	SelectedCatalogSyncPage,
	SelectedCatalogSyncRequest,
	SelectedSlackCatalogWork,
	SelectedSlackWork,
	SelectedSyncPage,
	SelectedSyncRequest,
	SyncPage,
	SyncRequest,
	selectedSlackCatalogPageMatches,
	selectedSlackCatalogWorkEqual,
	selectedSlackReplyCountsMatch,
	selectedSlackWorkEqual,
} from "../src/channel-v1.ts";
import { checkToolCall, checkToolResult, type ToolContract } from "../src/extension.ts";
import { MAX_CHANGES, type PluginChange } from "../src/normalized-change.ts";
import { SEND_TICKET_META } from "../src/send-ticket.ts";
import { changes, committed, withMember } from "./plugin-contracts.ts";

const ulid = "01JAZ3W3B6Q8M2V0G5T9K4X7RC";
const url = `https://hello.draftyak.example/v1/conversations/conv-1/messages?idempotency_key=${ulid}`;
const ticket = {
	id: "01JAZ3W5N8P0Q2R4S6T8V0W2X4",
	outboxId: ulid,
	instanceId: "01JAZ3W4C8D9E0F1G2H3J4K5M6",
	method: "POST",
	url,
	headersSha256: "d33c5901b41788cc15e274196a4db43be6dbd01cd499853d8e58ad99d1f2859c",
	contentType: "application/json",
	bodySha256: "f0ede3661d70f98862cc15849035f81866d28dde77385426cf8cb48daa649475",
	exp: 1_792_000_060_000,
};
const chatRef = { kind: "chat", channelId: "conv-1", ts: "msg_000001" };
const emailRef = { kind: "email", providerId: "18c2f0a1b2c3d4e5" };

// One call of every tool, shaped as §3 and §4 describe them: together a channel-v1 document.
const calls: Record<string, { input: object; output: object; meta?: object }> = {
	channel_describe: {
		input: {},
		output: { channel: "chat", mutations: [], attachments: true, listen: true },
	},
	channel_probe: { input: {}, output: { status: "ok" } },
	channel_sync: {
		input: { mode: "initial", since: 1_789_408_000_000 },
		output: {
			changes: [changes.conversation, changes.chat, changes.chatDeleted],
			cursor: "cur_000002",
			more: false,
		},
	},
	channel_body_fetch: { input: { message: emailRef }, output: { message: changes.email } },
	channel_attachment_fetch: {
		input: { message: chatRef, attachmentId: "F0123ABCD" },
		output: { contentType: "application/pdf", size: 3, content: { base64: "AAEC" } },
	},
	channel_mutate: {
		input: { op: "label", messages: [emailRef], labelIds: ["Label_7"] },
		output: {},
	},
	channel_send: {
		input: { method: "POST", url, contentType: "application/json", body: { ref: ulid } },
		output: { message: { kind: "chat", channelId: "conv-1", ts: "msg_000004" } },
		meta: { progressToken: 7, [SEND_TICKET_META]: ticket },
	},
	channel_send_reconcile: {
		input: { attemptAt: 1_792_000_000_000, target: { kind: "chat", channelId: "conv-1" } },
		output: { candidates: [changes.chatHello], complete: true },
	},
	channel_listen: { input: { leaseMs: MAX_LEASE_MS }, output: { leaseMs: 300_000 } },
};

const document = new Validator(committed("schemas/channel-v1.schema.json"), "2020-12", false);
const tools = channelV1.tools as unknown as Record<string, ToolContract>;
const tool = (name: string): ToolContract => {
	const found = tools[name];
	if (found === undefined) throw new Error(`no tool ${name}`);
	return found;
};
// Both zod and the exported document must judge `value` as `part` of the tool's call alike.
function judged(name: string, part: "input" | "output" | "meta", value: unknown): boolean {
	const zod = (tool(name)[part] as z.ZodType).safeParse(value).success;
	const json = document.validate({ ...calls, [name]: { ...calls[name], [part]: value } }).valid;
	expect(json, `${name}.${part}: ${JSON.stringify(value).slice(0, 200)}`).toBe(zod);
	return zod;
}

describe("channel-v1", () => {
	it("is io.github.draftyak/channel version 1 with §4's nine tools", () => {
		expect(channelV1.id).toBe(CHANNEL_V1);
		expect(channelV1.id).toBe("io.github.draftyak/channel");
		expect(channelV1.version).toBe(1);
		expect(Object.keys(channelV1.tools)).toEqual(Object.keys(calls));
	});

	it("leaves exactly attachments, mutations and listening optional", () => {
		const optional = Object.entries(tools).filter(([, entry]) => entry.optional === true);
		expect(optional.map(([name]) => name)).toEqual([
			"channel_attachment_fetch",
			"channel_mutate",
			"channel_listen",
		]);
		const { required } = committed("schemas/channel-v1.schema.json") as { required: string[] };
		expect(required).toEqual(Object.keys(calls).filter((name) => tools[name]?.optional !== true));
	});

	it("accepts a call of every tool, in zod and as an exported document", () => {
		expect(document.validate(calls).valid).toBe(true);
		const {
			channel_attachment_fetch: _a,
			channel_mutate: _m,
			channel_listen: _l,
			...required
		} = calls;
		expect(document.validate(required).valid).toBe(true);
		for (const [name, call] of Object.entries(calls)) {
			for (const part of ["input", "output", "meta"] as const) {
				if (call[part] !== undefined)
					expect(judged(name, part, call[part]), `${name}.${part}`).toBe(true);
			}
		}
	});

	it.each(Object.keys(calls))("%s refuses an unknown field in its input and output", (name) => {
		const call = calls[name] ?? { input: {}, output: {} };
		expect(judged(name, "input", withMember(call.input, "extra", 1))).toBe(false);
		expect(judged(name, "output", withMember(call.output, "extra", 1))).toBe(false);
	});

	it("refuses channel_send without a ticket in _meta, and lets MCP's own _meta members be", () => {
		expect(judged("channel_send", "meta", { progressToken: 7 })).toBe(false);
		expect(
			judged("channel_send", "meta", { [SEND_TICKET_META]: withMember(ticket, "exp", 1.5) }),
		).toBe(false);
		expect(judged("channel_send", "meta", { [SEND_TICKET_META]: ticket })).toBe(true);
		const { channel_send: send, ...others } = calls;
		const { meta: _, ...unticketed } = send ?? { input: {}, output: {} };
		expect(document.validate({ ...others, channel_send: unticketed }).valid).toBe(false);
		const call = { name: "channel_send", arguments: send?.input };
		expect(checkToolCall(channelV1, call)).toEqual({
			ok: false,
			problems: ["_meta: invalid_type"],
		});
		expect(checkToolCall(channelV1, { ...call, _meta: { progressToken: 7 } })).toEqual({
			ok: false,
			problems: [`_meta.${SEND_TICKET_META}: invalid_type`],
		});
		expect(checkToolCall(channelV1, { ...call, _meta: send?.meta })).toEqual({
			ok: true,
			name: "channel_send",
			arguments: send?.input,
			meta: send?.meta,
		});
	});

	it("sends only a hub-rendered canonical https request whose body the hub holds", () => {
		const input = calls.channel_send?.input ?? {};
		for (const bad of [
			withMember(input, "body", { base64: "AAEC" }),
			withMember(input, "method", "GET"),
			withMember(input, "url", url.replace("https:", "http:")),
			withMember(input, "url", url.replace("hello", "Hello")),
			withMember(input, "url", url.replace("conv-1", "%2e%2e")),
			withMember(input, "url", url.replace("://", "://dytest@")),
			withMember(input, "url", `${url}\n`),
			withMember(input, "contentType", ""),
			withMember(input, "contentType", "application/json\n"),
		]) {
			expect(judged("channel_send", "input", bad)).toBe(false);
		}
		// Dot segments and port 443 are the validator's to refuse; JSON Schema can't state them.
		const meta = calls.channel_send?.meta;
		for (const to of [url.replace("conv-1", ".."), url.replace(".example/", ".example:443/")]) {
			const call = { name: "channel_send", arguments: { ...input, url: to }, _meta: meta };
			expect(checkToolCall(channelV1, call)).toEqual({
				ok: false,
				problems: ["arguments.url: not canonical"],
			});
		}
	});

	it("documents each tool's error result, which the hub checks", () => {
		const sync = calls.channel_sync ?? { input: {}, output: {} };
		const withError = (error: unknown) => ({ ...calls, channel_sync: { ...sync, error } });
		expect(document.validate(withError({ code: "CURSOR_EXPIRED" })).valid).toBe(true);
		expect(document.validate(withError({ code: "OOPS" })).valid).toBe(false);
		const detail = { isError: true, structuredContent: { code: "TRANSIENT", detail: "\ud800" } };
		expect(checkToolResult(channelV1, "channel_sync", detail)).toEqual({
			ok: false,
			problems: ["structuredContent.detail: lone surrogate"],
		});
	});

	it("syncs in pages of at most 500 changes a plugin may report", () => {
		const page = (list: unknown[]) => ({ changes: list, cursor: "cur_000002", more: true });
		expect(judged("channel_sync", "output", page(Array(MAX_CHANGES).fill(changes.chat)))).toBe(
			true,
		);
		expect(judged("channel_sync", "output", page(Array(MAX_CHANGES + 1).fill(changes.chat)))).toBe(
			false,
		);
		expect(
			judged("channel_sync", "output", page([withMember(changes.chat, "kind", "sms.message")])),
		).toBe(false);
		expect(judged("channel_sync", "output", { ...page([]), cursor: "" })).toBe(false);
		const valid = [
			{ mode: "delta", cursor: "cur_000002" },
			{ mode: "resync", since: 1_789_408_000_000 },
			{ mode: "initial", since: 1_789_408_000_000, cursor: "cur_000001" },
		];
		for (const input of valid) expect(judged("channel_sync", "input", input)).toBe(true);
		const invalid = [
			{ mode: "delta" },
			{ mode: "initial" },
			{ mode: "delta", cursor: "cur_000002", since: 1 },
			{ mode: "full", since: 1 },
			{ mode: "delta", cursor: "a b" },
			{ mode: "delta", cursor: "cur_000002\n" },
		];
		for (const input of invalid) expect(judged("channel_sync", "input", input)).toBe(false);
	});

	it("returns a message with its body, mutates by the ops described and leases for at most 10 minutes", () => {
		const { raw: _, ...withoutRaw } = changes.email;
		expect(judged("channel_body_fetch", "output", { message: withoutRaw })).toBe(false);
		expect(judged("channel_body_fetch", "output", { message: changes.emailDeleted })).toBe(false);
		expect(
			judged("channel_mutate", "input", { op: "archive", messages: [emailRef, chatRef] }),
		).toBe(true);
		const mutations = [
			{ op: "label", messages: [emailRef] },
			{ op: "archive", messages: [emailRef], labelIds: ["Label_7"] },
			{ op: "archive", messages: [] },
			{ op: "archive", messages: Array(101).fill(emailRef) },
			{ op: "delete", messages: [emailRef] },
		];
		for (const input of mutations) expect(judged("channel_mutate", "input", input)).toBe(false);
		for (const leaseMs of [1_000, MAX_LEASE_MS])
			expect(judged("channel_listen", "input", { leaseMs })).toBe(true);
		for (const leaseMs of [999, MAX_LEASE_MS + 1, 1_500.5]) {
			expect(judged("channel_listen", "input", { leaseMs })).toBe(false);
			expect(judged("channel_listen", "output", { leaseMs })).toBe(false);
		}
	});

	it("reconciles by thread, Message-ID or channel", () => {
		const target = (value: object) => ({ attemptAt: 1_792_000_000_000, target: value });
		const email = {
			kind: "email",
			threadId: "18c2f0a1b2c3d4e0",
			rfc822MessageId: "<a.b@draftyak.example>",
		};
		expect(judged("channel_send_reconcile", "input", target(email))).toBe(true);
		const ids = ["a.b@draftyak.example", "<a b@draftyak.example>", "<a<b@draftyak.example>"];
		for (const id of [...ids, "<a.b@draftyak.example>\n"]) {
			expect(
				judged("channel_send_reconcile", "input", target({ ...email, rfc822MessageId: id })),
			).toBe(false);
		}
		expect(judged("channel_send_reconcile", "input", target({ kind: "chat" }))).toBe(false);
		const { raw: _, ...withoutRaw } = changes.email;
		const found = (candidates: unknown[]) => ({ candidates, complete: false });
		expect(judged("channel_send_reconcile", "output", found([changes.email, changes.chat]))).toBe(
			true,
		);
		for (const candidate of [withoutRaw, changes.chatDeleted, changes.conversation]) {
			expect(judged("channel_send_reconcile", "output", found([candidate]))).toBe(false);
		}
		const many = found(Array(51).fill(changes.chat));
		expect(judged("channel_send_reconcile", "output", many)).toBe(false);
	});
});

describe("selected Slack sync work", () => {
	const window = {
		oldest: "1800000000.000000001",
		latest: "1800003600.000000001",
		inclusive: true,
	};
	const history: SelectedSlackWork = {
		kind: "slack.history",
		channelId: "CDYTEST1",
		window,
	};
	const replies: SelectedSlackWork = {
		kind: "slack.replies",
		channelId: "CDYTEST1",
		threadTs: "1799999999.000000001",
		window,
	};
	const selected = (work: unknown = history, cursor?: string) => ({
		mode: "selected",
		work,
		...(cursor === undefined ? {} : { cursor }),
	});
	const selectedPage = (continuation: object, work: unknown = history) => ({
		work,
		changes: [{ ...changes.chatHello, channelId: "CDYTEST1", ts: window.oldest }],
		replyCounts: [],
		continuation,
	});

	it("keeps the exact legacy public aliases and their three-field result", () => {
		expectTypeOf<SyncRequest>().toEqualTypeOf<
			| { readonly mode: "initial" | "resync"; readonly since: number; readonly cursor?: string }
			| { readonly mode: "delta"; readonly cursor: string }
		>();
		expectTypeOf<SyncPage>().toEqualTypeOf<{
			readonly changes: readonly PluginChange[];
			readonly cursor: string;
			readonly more: boolean;
		}>();
		for (const input of [
			{ mode: "initial", since: 1 },
			{ mode: "resync", since: 1, cursor: "legacy" },
			{ mode: "delta", cursor: "legacy" },
		]) {
			expect(SyncRequest.safeParse(input).success).toBe(true);
			expect(judged("channel_sync", "input", input)).toBe(true);
			expect(SelectedSyncRequest.safeParse(input).success).toBe(false);
		}
		const page = { changes: [changes.chat], cursor: "legacy", more: false };
		expect(SyncPage.safeParse(page).success).toBe(true);
		expect(judged("channel_sync", "output", page)).toBe(true);
		expect(SelectedSyncPage.safeParse(page).success).toBe(false);
		expect(SyncRequest.safeParse(selected()).success).toBe(false);
		expect(SyncPage.safeParse(selectedPage({ state: "complete" })).success).toBe(false);
		expect(SyncPage.safeParse({ ...page, replyCounts: [] }).success).toBe(false);
		expect(judged("channel_sync", "output", { ...page, replyCounts: [] })).toBe(false);
	});

	it.each([history, replies])("accepts one exact $kind work unit and its resume cursor", (work) => {
		for (const input of [selected(work), selected(work, "opaque+/&=")]) {
			expect(SelectedSyncRequest.safeParse(input).success).toBe(true);
			expect(judged("channel_sync", "input", input)).toBe(true);
		}
	});

	it.each([
		{ ...history, kind: "slack.conversations" },
		{ ...history, threadTs: replies.threadTs },
		{ kind: "slack.history", window },
		{ kind: "slack.replies", channelId: "CDYTEST1", window },
		{ ...history, window: { oldest: window.oldest, latest: window.latest } },
		{ ...history, window: { oldest: window.oldest, inclusive: true } },
		{ ...history, window: { latest: window.latest, inclusive: true } },
		{ ...history, window: { ...window, inclusive: 1 } },
		{ ...history, window: { ...window, extra: 1 } },
		{ ...history, grant: true },
	])("refuses incomplete, mixed, unknown or authority-shaped work", (work) => {
		expect(judged("channel_sync", "input", selected(work))).toBe(false);
	});

	it.each(["", "a b", "value\n", "x".repeat(257), 1, null])(
		"retains the existing opaque ID bounds for channel, root and provider boundaries (%j)",
		(value) => {
			for (const work of [
				{ ...history, channelId: value },
				{ ...replies, threadTs: value },
				{ ...history, window: { ...window, oldest: value } },
				{ ...history, window: { ...window, latest: value } },
			])
				expect(judged("channel_sync", "input", selected(work))).toBe(false);
		},
	);

	it("keeps cursor bounds without hiding selection in a legacy arm", () => {
		for (const cursor of ["", "space here", "end\n", "x".repeat(4097)])
			expect(judged("channel_sync", "input", selected(history, cursor))).toBe(false);
		expect(judged("channel_sync", "input", selected(history, "x".repeat(4096)))).toBe(true);
		for (const input of [
			{ ...selected(), since: 1 },
			{ mode: "initial", since: 1, work: history },
			{ mode: "delta", cursor: "legacy", work: history },
			{ mode: "selected", work: [history, replies] },
		])
			expect(judged("channel_sync", "input", input)).toBe(false);
	});

	it.each([
		{ state: "more", cursor: "next" },
		{ state: "complete" },
		{ state: "truncated" },
		{ state: "truncated", cursor: "resume-later" },
	])("preserves the explicit $state continuation state", (continuation) => {
		const page = selectedPage(continuation);
		expect(SelectedSyncPage.safeParse(page).success).toBe(true);
		expect(judged("channel_sync", "output", page)).toBe(true);
	});

	it.each([
		{ state: "more" },
		{ state: "more", cursor: "" },
		{ state: "complete", cursor: "invented" },
		{ state: "complete", more: false },
		{ state: "truncated", cursor: "bad cursor" },
		{ state: "unknown" },
	])("refuses ambiguous, incomplete or unknown continuation data", (continuation) => {
		expect(judged("channel_sync", "output", selectedPage(continuation))).toBe(false);
	});

	it("keeps selected message bounds and rejects other change families or legacy page fields", () => {
		const page = selectedPage({ state: "complete" });
		expect(
			judged("channel_sync", "output", { ...page, changes: Array(500).fill(page.changes[0]) }),
		).toBe(true);
		for (const list of [
			Array(501).fill(page.changes[0]),
			[changes.email],
			[changes.conversation],
			[changes.chatDeleted],
		])
			expect(judged("channel_sync", "output", { ...page, changes: list })).toBe(false);
		for (const extra of [{ cursor: "legacy" }, { more: false }, { extra: 1 }])
			expect(judged("channel_sync", "output", { ...page, ...extra })).toBe(false);
	});

	it("compares validated work scalars exactly without claiming cursor or request correlation", () => {
		expect(selectedSlackWorkEqual(replies, structuredClone(replies))).toBe(true);
		expect(
			selectedSlackWorkEqual(
				{ ...history, window: { ...window, oldest: "1800000000.0" } },
				{ ...history, window: { ...window, oldest: "1800000000.000000000" } },
			),
		).toBe(false);
		for (const work of [
			history,
			{ ...replies, channelId: "CDYTEST2" },
			{ ...replies, threadTs: "1799999999.000000002" },
			{ ...replies, window: { ...window, oldest: "1800000000.1" } },
			{ ...replies, window: { ...window, latest: "1800003600.1" } },
			{ ...replies, window: { ...window, inclusive: false } },
		]) {
			const parsed = SelectedSlackWork.parse(work);
			expect(selectedSlackWorkEqual(replies, parsed)).toBe(false);
			// Schema-valid data alone cannot bind one RPC's result to another request.
			expect(judged("channel_sync", "output", selectedPage({ state: "complete" }, parsed))).toBe(
				true,
			);
		}
	});

	it("requires an observation array while preserving no observation separately from explicit zero", () => {
		expectTypeOf<SelectedSyncPage["replyCounts"]>().toEqualTypeOf<
			readonly { readonly ts: string; readonly count: number }[]
		>();
		const page = selectedPage({ state: "complete" });
		expect(judged("channel_sync", "output", page)).toBe(true);
		expect(selectedSlackReplyCountsMatch(SelectedSyncPage.parse(page))).toBe(true);
		expect(
			judged("channel_sync", "output", {
				work: history,
				changes: page.changes,
				continuation: page.continuation,
			}),
		).toBe(false);
	});

	it.each([0, 3, Number.MAX_SAFE_INTEGER])("preserves explicit observed root count %i", (count) => {
		for (const threadTs of [undefined, window.oldest]) {
			const page = {
				...selectedPage({ state: "complete" }),
				changes: [
					{
						...changes.chatHello,
						channelId: history.channelId,
						ts: window.oldest,
						...(threadTs === undefined ? {} : { threadTs }),
					},
				],
				replyCounts: [{ ts: window.oldest, count }],
			};
			expect(judged("channel_sync", "output", page)).toBe(true);
			expect(selectedSlackReplyCountsMatch(SelectedSyncPage.parse(page))).toBe(true);
		}
	});

	it.each([
		{ ts: window.oldest, count: -1 },
		{ ts: window.oldest, count: 0.5 },
		{ ts: window.oldest, count: Number.MAX_SAFE_INTEGER + 1 },
		{ ts: window.oldest, count: "0" },
		{ ts: "", count: 0 },
		{ ts: "bad timestamp", count: 0 },
		{ ts: "end\n", count: 0 },
		{ ts: "x".repeat(257), count: 0 },
		{ ts: window.oldest, count: 0, extra: true },
	])("refuses malformed count observation in both structural validators", (observation) => {
		expect(
			judged("channel_sync", "output", {
				...selectedPage({ state: "complete" }),
				replyCounts: [observation],
			}),
		).toBe(false);
	});

	it("bounds root observations at 500 without truncating or inventing entries", () => {
		const roots = Array.from({ length: 500 }, (_, at) => ({
			...changes.chatHello,
			channelId: history.channelId,
			ts: `1800000000.${String(at + 1).padStart(9, "0")}`,
		}));
		const replyCounts = roots.map(({ ts }) => ({ ts, count: 0 }));
		const page = { ...selectedPage({ state: "complete" }), changes: roots, replyCounts };
		expect(judged("channel_sync", "output", page)).toBe(true);
		expect(selectedSlackReplyCountsMatch(SelectedSyncPage.parse(page))).toBe(true);
		expect(
			judged("channel_sync", "output", { ...page, replyCounts: [...replyCounts, replyCounts[0]] }),
		).toBe(false);
	});

	it("keeps relational root checks explicit instead of losing a refinement from JSON Schema", () => {
		const root = { ...changes.chatHello, channelId: history.channelId, ts: window.oldest };
		const observation = { ts: window.oldest, count: 0 };
		const page = {
			...selectedPage({ state: "complete" }),
			changes: [root],
			replyCounts: [observation],
		};
		const invalidRelations = [
			{ ...page, replyCounts: [observation, observation] },
			{ ...page, replyCounts: [observation, { ...observation, count: 3 }] },
			{ ...page, replyCounts: [{ ts: "1800000001.000000001", count: 0 }] },
			{ ...page, changes: [{ ...root, channelId: "CDYTEST2" }] },
			{ ...page, changes: [{ ...root, threadTs: "1799999999.000000001" }] },
			{ ...page, changes: [root, { ...root, text: "DYTEST duplicate root" }] },
			{ ...page, work: replies },
		];
		for (const value of invalidRelations) {
			// Both structural validators agree; the separate semantic helper rejects the relation.
			expect(judged("channel_sync", "output", value)).toBe(true);
			expect(selectedSlackReplyCountsMatch(SelectedSyncPage.parse(value))).toBe(false);
		}
		const replyRoot = { ...root, ts: replies.threadTs, threadTs: replies.threadTs };
		const replyPage = {
			...page,
			work: replies,
			changes: [replyRoot],
			replyCounts: [{ ts: replies.threadTs, count: 3 }],
		};
		expect(judged("channel_sync", "output", replyPage)).toBe(true);
		expect(selectedSlackReplyCountsMatch(SelectedSyncPage.parse(replyPage))).toBe(true);
	});
});

describe("checkToolCall and checkToolResult", () => {
	it("take only the extension's own tools", () => {
		for (const name of ["channel_unknown", "__proto__", "toString", 7]) {
			expect(checkToolCall(channelV1, { name, arguments: {} })).toEqual({
				ok: false,
				problems: ["name: unknown"],
			});
			expect(checkToolResult(channelV1, String(name), { structuredContent: {} }).ok).toBe(false);
		}
		expect(checkToolCall(channelV1, null).ok).toBe(false);
	});

	it("read omitted arguments as {} and name each problem's path", () => {
		expect(checkToolCall(channelV1, { name: "channel_probe" })).toMatchObject({
			ok: true,
			arguments: {},
		});
		expect(checkToolCall(channelV1, { name: "channel_probe", arguments: null })).toEqual({
			ok: false,
			problems: ["arguments: invalid_type"],
		});
		expect(
			checkToolCall(channelV1, { name: "channel_sync", arguments: { mode: "delta", cursor: 1 } }),
		).toEqual({
			ok: false,
			problems: ["arguments: invalid_union"],
		});
	});

	it("check structuredContent as the output, or as a plugin error with isError", () => {
		const output = calls.channel_sync?.output;
		expect(checkToolResult(channelV1, "channel_sync", { structuredContent: output })).toEqual({
			ok: true,
			isError: false,
			value: output,
		});
		const error = { code: "CURSOR_EXPIRED", detail: "start over" };
		expect(
			checkToolResult(channelV1, "channel_sync", { isError: true, structuredContent: error }),
		).toEqual({
			ok: true,
			isError: true,
			value: error,
		});
		const refused = [
			{ isError: true, structuredContent: { code: "OOPS" } },
			{ isError: true, structuredContent: output },
			{ structuredContent: error },
			{ content: [{ type: "text", text: JSON.stringify(output) }] },
			{ resultType: "input_required", structuredContent: output },
			"result",
		];
		for (const result of refused)
			expect(checkToolResult(channelV1, "channel_sync", result).ok).toBe(false);
		const complete = { resultType: "complete", structuredContent: output };
		expect(checkToolResult(channelV1, "channel_sync", complete).ok).toBe(true);
	});
});

describe("selected Slack catalog work", () => {
	const catalog = { kind: "slack.catalog" } as const;
	const info = { kind: "slack.info", channelId: "CDYTEST1" } as const;
	const summary = { channelId: info.channelId, type: "private", name: "DYTEST catalog" } as const;
	const fact = { ...changes.conversation, channelId: info.channelId };
	const request = (work: unknown = catalog, cursor?: string) => ({
		mode: "selected",
		work,
		...(cursor === undefined ? {} : { cursor }),
	});
	const catalogPage = (
		continuation: object = { state: "complete" },
		conversations: readonly unknown[] = [summary],
	) => ({ work: catalog, conversations, continuation });
	const infoPage = (
		conversation: unknown = fact,
		continuation: object = { state: "complete" },
	) => ({ work: info, conversation, continuation });

	it("keeps catalog work outside the unchanged legacy and selected message aliases", () => {
		const history = {
			kind: "slack.history",
			channelId: info.channelId,
			window: { oldest: "1800000000.000000001", latest: "1800003600.000000001", inclusive: true },
		};
		const messagePage = {
			work: history,
			changes: [],
			replyCounts: [],
			continuation: { state: "complete" },
		};
		expect(SelectedSyncRequest.safeParse(request(history)).success).toBe(true);
		expect(SelectedSyncPage.safeParse(messagePage).success).toBe(true);
		expect(SelectedCatalogSyncRequest.safeParse(request(history)).success).toBe(false);
		expect(SelectedCatalogSyncPage.safeParse(messagePage).success).toBe(false);
		for (const work of [catalog, info]) {
			expect(SelectedSyncRequest.safeParse(request(work)).success).toBe(false);
			expect(SyncRequest.safeParse(request(work)).success).toBe(false);
		}
		for (const page of [catalogPage(), infoPage()]) {
			expect(SelectedSyncPage.safeParse(page).success).toBe(false);
			expect(SyncPage.safeParse(page).success).toBe(false);
		}
		for (const legacy of [
			{ mode: "initial", since: 1 },
			{ mode: "resync", since: 1, cursor: "legacy" },
			{ mode: "delta", cursor: "legacy" },
		])
			expect(SelectedCatalogSyncRequest.safeParse(legacy).success).toBe(false);
	});

	it("accepts catalog discovery with only its optional opaque continuation", () => {
		expectTypeOf<SelectedSlackCatalogWork>().toEqualTypeOf<
			| { readonly kind: "slack.catalog" }
			| { readonly kind: "slack.info"; readonly channelId: string }
		>();
		for (const input of [
			request(),
			request(catalog, "opaque+/&="),
			request(catalog, "x".repeat(4096)),
		]) {
			expect(SelectedCatalogSyncRequest.safeParse(input).success).toBe(true);
			expect(judged("channel_sync", "input", input)).toBe(true);
		}
	});

	it("accepts one complete info fact for the exact requested conversation", () => {
		expect(SelectedCatalogSyncRequest.safeParse(request(info)).success).toBe(true);
		expect(judged("channel_sync", "input", request(info))).toBe(true);
		const page = infoPage();
		expect(SelectedCatalogSyncPage.safeParse(page).success).toBe(true);
		expect(judged("channel_sync", "output", page)).toBe(true);
		expect(selectedSlackCatalogPageMatches(SelectedCatalogSyncPage.parse(page))).toBe(true);
	});

	it("refuses mixed selectors, extra request fields and caller authority", () => {
		for (const input of [
			request({ ...catalog, types: ["dm"] }),
			request({ ...catalog, limit: 100 }),
			request({ ...catalog, channelId: info.channelId }),
			request({ ...catalog, window: { oldest: "1", latest: "2", inclusive: true } }),
			request({ ...info, threadTs: "1800000000.000000001" }),
			request({ kind: "slack.conversations" }),
			request([catalog, info]),
			{ ...request(), since: 1 },
			{ ...request(), grant: true },
			{ mode: "initial", since: 1, work: catalog },
			{ mode: "delta", cursor: "legacy", work: info },
		]) {
			expect(SelectedCatalogSyncRequest.safeParse(input).success).toBe(false);
			expect(judged("channel_sync", "input", input)).toBe(false);
		}
	});

	it("refuses info resume cursors and malformed opaque channel identifiers", () => {
		for (const input of [
			request(info, "not-an-info-resume"),
			request({ kind: "slack.info" }),
			...(["", "a b", "end\n", "x".repeat(257), 1, null] as const).map((channelId) =>
				request({ ...info, channelId }),
			),
		])
			expect(judged("channel_sync", "input", input)).toBe(false);
		for (const cursor of ["", "a b", "end\n", "x".repeat(4097)])
			expect(judged("channel_sync", "input", request(catalog, cursor))).toBe(false);
	});

	it.each([
		{ state: "more", cursor: "next" },
		{ state: "complete" },
		{ state: "truncated" },
		{ state: "truncated", cursor: "resume-later" },
	])("preserves catalog's explicit $state continuation", (continuation) => {
		const page = catalogPage(continuation);
		expect(SelectedCatalogSyncPage.safeParse(page).success).toBe(true);
		expect(judged("channel_sync", "output", page)).toBe(true);
		expect(selectedSlackCatalogPageMatches(SelectedCatalogSyncPage.parse(page))).toBe(true);
	});

	it("refuses incomplete or unknown states and any nonterminal info continuation", () => {
		for (const continuation of [
			{ state: "more" },
			{ state: "more", cursor: "" },
			{ state: "more", cursor: "x".repeat(4097) },
			{ state: "complete", cursor: "next" },
			{ state: "complete", more: false },
			{ state: "truncated", cursor: "bad cursor" },
			{ state: "unknown" },
		])
			expect(judged("channel_sync", "output", catalogPage(continuation))).toBe(false);
		for (const continuation of [
			{ state: "more", cursor: "next" },
			{ state: "truncated" },
			{ state: "truncated", cursor: "next" },
			{ state: "complete", cursor: "next" },
		])
			expect(judged("channel_sync", "output", infoPage(fact, continuation))).toBe(false);
	});

	it("refuses output fields from a message, legacy or other catalog branch", () => {
		for (const page of [
			{ ...catalogPage(), conversation: fact },
			{ ...catalogPage(), changes: [] },
			{ ...catalogPage(), replyCounts: [] },
			{ ...catalogPage(), cursor: "legacy", more: false },
			{ ...infoPage(), conversations: [summary] },
			{ ...infoPage(), changes: [fact] },
			{ ...infoPage(), replyCounts: [] },
			{ ...catalogPage(), work: info },
			{ ...infoPage(), work: catalog },
		]) {
			expect(SelectedCatalogSyncPage.safeParse(page).success).toBe(false);
			expect(judged("channel_sync", "output", page)).toBe(false);
		}
	});

	it("preserves all four summary types and absent names without inventing hydrated facts", () => {
		const rows = ["dm", "group_dm", "public", "private"].map((type, at) => ({
			channelId: `CDYTEST${at}`,
			type,
			...(at % 2 === 0 ? { name: "DYTEST named" } : {}),
		}));
		for (const conversations of [rows, []]) {
			const page = catalogPage({ state: "complete" }, conversations);
			expect(judged("channel_sync", "output", page)).toBe(true);
			expect(selectedSlackCatalogPageMatches(SelectedCatalogSyncPage.parse(page))).toBe(true);
		}
		for (const row of [
			{ ...summary, type: "im" },
			{ ...summary, type: "private_channel" },
			{ ...summary, member: true },
			{ ...summary, memberCount: 42 },
			{ ...summary, external: false },
		])
			expect(judged("channel_sync", "output", catalogPage({ state: "complete" }, [row]))).toBe(
				false,
			);
	});

	it("retains the summary name and opaque identifier scalar bounds", () => {
		const page = (row: object) => catalogPage({ state: "complete" }, [row]);
		expect(judged("channel_sync", "output", page({ ...summary, name: "x".repeat(256) }))).toBe(
			true,
		);
		expect(judged("channel_sync", "output", page({ ...summary, channelId: "x".repeat(256) }))).toBe(
			true,
		);
		for (const row of [
			{ ...summary, name: "x".repeat(257) },
			{ ...summary, name: 1 },
			{ ...summary, channelId: "" },
			{ ...summary, channelId: "bad id" },
			{ ...summary, channelId: "end\n" },
			{ ...summary, channelId: "x".repeat(257) },
		])
			expect(judged("channel_sync", "output", page(row))).toBe(false);
		// JSON Schema cannot express the existing well-formed Unicode rule.
		expect(SelectedCatalogSyncPage.safeParse(page({ ...summary, name: "\ud800" })).success).toBe(
			false,
		);
	});

	it("accepts exactly 999 unique summaries without truncating a thousand-row page", () => {
		expect(MAX_SLACK_CATALOG_CONVERSATIONS).toBe(999);
		const rows = Array.from({ length: 999 }, (_, at) => ({
			channelId: `CDYTEST${at}`,
			type: "public",
		}));
		const page = catalogPage({ state: "complete" }, rows);
		expect(judged("channel_sync", "output", page)).toBe(true);
		expect(SelectedCatalogSyncPage.parse(page)).toEqual(page);
		expect(selectedSlackCatalogPageMatches(SelectedCatalogSyncPage.parse(page))).toBe(true);
		expect(
			judged(
				"channel_sync",
				"output",
				catalogPage({ state: "complete" }, [...rows, { channelId: "CDYTEST999", type: "public" }]),
			),
		).toBe(false);
	});

	it("keeps duplicate catalog IDs in the explicit relational helper, with structural parity", () => {
		for (const duplicate of [summary, { ...summary, type: "public", name: "DYTEST different" }]) {
			const page = catalogPage({ state: "complete" }, [summary, duplicate]);
			expect(judged("channel_sync", "output", page)).toBe(true);
			expect(selectedSlackCatalogPageMatches(SelectedCatalogSyncPage.parse(page))).toBe(false);
		}
	});

	it("requires a hydrated info fact to name the selected channel", () => {
		const page = infoPage({ ...fact, channelId: "CDYTEST2" });
		expect(judged("channel_sync", "output", page)).toBe(true);
		expect(selectedSlackCatalogPageMatches(SelectedCatalogSyncPage.parse(page))).toBe(false);
	});

	it("compares only validated catalog kinds and exact info channel bytes", () => {
		const expectedCatalog = SelectedSlackCatalogWork.parse(catalog);
		const expectedInfo = SelectedSlackCatalogWork.parse(info);
		expect(selectedSlackCatalogWorkEqual(expectedCatalog, structuredClone(expectedCatalog))).toBe(
			true,
		);
		expect(selectedSlackCatalogWorkEqual(expectedInfo, structuredClone(expectedInfo))).toBe(true);
		expect(selectedSlackCatalogWorkEqual(expectedCatalog, expectedInfo)).toBe(false);
		expect(selectedSlackCatalogWorkEqual(expectedInfo, expectedCatalog)).toBe(false);
		expect(
			selectedSlackCatalogWorkEqual(
				expectedInfo,
				SelectedSlackCatalogWork.parse({ ...info, channelId: "CDYTEST2" }),
			),
		).toBe(false);
	});

	it("refuses discovery summaries and incomplete normalized facts as successful info hydration", () => {
		for (const conversation of [summary, [], changes.chat, changes.email])
			expect(judged("channel_sync", "output", infoPage(conversation))).toBe(false);
		for (const field of ["member", "archived", "shared", "external", "memberCount"]) {
			const partial = { ...fact } as Record<string, unknown>;
			delete partial[field];
			expect(judged("channel_sync", "output", infoPage(partial))).toBe(false);
		}
	});

	it("keeps authority and provider-private fields outside successful DATA pages", () => {
		for (const page of [
			{ ...catalogPage(), grant: true },
			{ ...infoPage(), authorized: true },
			infoPage({ ...fact, nativeGrant: true }),
			catalogPage({ state: "complete" }, [{ ...summary, accessToken: "DYTEST not a credential" }]),
		])
			expect(judged("channel_sync", "output", page)).toBe(false);
	});
});
