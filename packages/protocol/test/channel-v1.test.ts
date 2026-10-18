import { Validator } from "@cfworker/json-schema";
import { describe, expect, it } from "vitest";
import type * as z from "zod";
import { CHANNEL_V1, channelV1, MAX_LEASE_MS } from "../src/channel-v1.ts";
import { checkToolCall, checkToolResult, type ToolContract } from "../src/extension.ts";
import { MAX_CHANGES } from "../src/normalized-change.ts";
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
			problems: ["arguments.cursor: invalid_type"],
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
