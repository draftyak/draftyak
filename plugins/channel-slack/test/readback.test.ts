import { describe, expect, it } from "vitest";
import {
	checkSlackPreflight,
	decodeSlackChannelFacts,
	type SlackChatFacts,
	SlackCoreError,
} from "../src/index.ts";

const id = "C0CHAN001";
function channel(): Record<string, unknown> {
	return {
		id,
		name: "synthetic-general",
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
	};
}
const response = (value: object = channel()) => ({ ok: true, channel: value });
const facts: SlackChatFacts = {
	id,
	type: "public",
	name: "synthetic-general",
	isArchived: false,
	isShared: false,
	isExternal: false,
	isMember: true,
	memberCount: 30,
};
function refused(expected: unknown, value: unknown): void {
	try {
		decodeSlackChannelFacts(expected, value);
		throw new Error("Expected refusal");
	} catch (error) {
		expect(error).toEqual(new SlackCoreError("INVALID_INPUT"));
		expect(error).not.toHaveProperty("cause");
	}
}

describe("conversations.info channel facts", () => {
	it("projects explicit native preflight facts and detaches them from the response", () => {
		const raw = channel(),
			parsed = decodeSlackChannelFacts(id, response(raw));
		expect(parsed).toEqual(facts);
		expect(Object.isFrozen(parsed)).toBe(true);
		raw.name = "PRIVATE_CHANGED_CANARY";
		raw.is_member = false;
		expect(parsed).toEqual(facts);
	});
	it.each([
		{ name: "modern private", change: { is_private: true }, type: "private" },
		{
			name: "legacy private",
			change: { is_channel: false, is_group: true, is_private: true },
			type: "private",
		},
		{
			name: "complete DM",
			change: { is_channel: false, is_im: true, is_private: true },
			type: "dm",
		},
		{
			name: "complete MPIM",
			change: { is_channel: false, is_mpim: true, is_private: true },
			type: "group_dm",
		},
	])("uses explicit flags for $name without deriving type from the ID", ({ change, type }) => {
		expect(decodeSlackChannelFacts(id, response({ ...channel(), ...change }))).toEqual({
			...facts,
			type,
		});
	});
	it("preserves archive and lost-membership facts for the existing preflight check", () => {
		for (const change of [
			{ is_archived: true },
			{ is_member: false },
			{ num_members: 34 },
			{ name: "synthetic-renamed" },
		]) {
			const current = decodeSlackChannelFacts(id, response({ ...channel(), ...change }));
			expect(
				checkSlackPreflight({
					approved: facts,
					current,
					holdIfReply: false,
					approvedInboundWatermark: null,
					currentInboundWatermark: null,
				}),
			).toEqual({ state: "NEEDS_REAPPROVAL", reason: "channel_changed" });
		}
	});
	it("distinguishes internal sharing from external sharing", () => {
		const internal = decodeSlackChannelFacts(
			id,
			response({ ...channel(), is_shared: true, is_org_shared: true }),
		);
		const external = decodeSlackChannelFacts(
			id,
			response({ ...channel(), is_shared: true, is_ext_shared: true, is_ext_ws_shared: true }),
		);
		expect(internal).toMatchObject({ isShared: true, isExternal: false });
		expect(external).toMatchObject({ isShared: true, isExternal: true });
		expect(
			checkSlackPreflight({
				approved: internal,
				current: external,
				holdIfReply: false,
				approvedInboundWatermark: null,
				currentInboundWatermark: null,
			}),
		).toEqual({ state: "NEEDS_REAPPROVAL", reason: "channel_changed" });
	});
	it.each(Object.keys(channel()))(
		"refuses a missing required %s instead of inventing facts",
		(key) => {
			const raw = channel();
			delete raw[key];
			refused(id, response(raw));
		},
	);
	it("refuses the documented sparse DM shape even when it includes num_members", () => {
		refused(
			id,
			response({
				id,
				is_im: true,
				is_org_shared: false,
				user: "U0SYNTHETIC",
				is_open: true,
				num_members: 2,
			}),
		);
	});
	it.each([
		{ is_channel: false },
		{ is_group: true },
		{ is_im: true },
		{ is_channel: false, is_im: true, is_mpim: true, is_private: true },
		{ is_channel: false, is_group: true, is_private: false },
		{ is_channel: false, is_im: true, is_private: false },
		{ is_channel: false, is_mpim: true, is_private: false },
		{ is_ext_shared: true },
		{ is_org_shared: true },
		{ is_ext_ws_shared: true },
		{ is_shared: true, is_ext_ws_shared: true },
		{ is_pending_ext_shared: true },
		{ is_shared: true, is_org_shared: true, is_pending_ext_shared: true },
	])("refuses contradictory or unrepresentable channel flags %#", (change) =>
		refused(id, response({ ...channel(), ...change })),
	);
	it.each(["is_frozen", "is_read_only", "is_thread_only"])(
		"refuses an explicit unrepresented %s restriction",
		(key) => {
			refused(id, response({ ...channel(), [key]: true }));
			expect(decodeSlackChannelFacts(id, response({ ...channel(), [key]: false }))).toEqual(facts);
			refused(id, response({ ...channel(), [key]: undefined }));
		},
	);
	it.each([
		{ id: "C0OTHER01" },
		{ id: `${id}\n` },
		{ is_member: "true" },
		{ is_private: null },
		{ is_ext_ws_shared: "false" },
		{ num_members: null },
		{ num_members: -1 },
		{ num_members: 1.5 },
		{ num_members: 1_000_000_001 },
		{ num_members: Number.NaN },
		{ name: "" },
		{ name: "PRIVATE_NAME_CANARY\r\n" },
		{ name: "\ud800" },
		{ name: "x".repeat(257) },
	])("refuses invalid scalar facts with content-free errors %#", (change) =>
		refused(id, response({ ...channel(), ...change })),
	);
	it("honors the existing exact name and member-count bounds", () => {
		expect(
			decodeSlackChannelFacts(
				id,
				response({ ...channel(), name: "\u{1f9ad}".repeat(128), num_members: 1_000_000_000 }),
			),
		).toMatchObject({ memberCount: 1_000_000_000 });
		expect(decodeSlackChannelFacts(id, response({ ...channel(), num_members: 0 }))).toMatchObject({
			memberCount: 0,
		});
		refused(id, response({ ...channel(), name: "\u{1f9ad}".repeat(129) }));
	});
	it("requires exact requested ID and an explicit successful envelope", () => {
		for (const expected of [undefined, `${id}\n`, new String(id), "C0OTHER01"])
			refused(expected, response());
		for (const raw of [
			{ channel: channel() },
			{ ok: false, error: "PRIVATE_ERROR_CANARY", channel: channel() },
			{ ok: "true", channel: channel() },
			{ ok: true },
			{ ok: true, channel: [] },
		])
			refused(id, raw);
	});
	it("does not read unused topic, identity, message, metadata or custom serialization branches", () => {
		let reads = 0;
		const hook = () => {
			reads++;
			throw new Error("PRIVATE_IGNORED_CANARY");
		};
		const raw = channel(),
			envelope = response(raw);
		for (const key of [
			"topic",
			"purpose",
			"latest",
			"user",
			"members",
			"title",
			"metadata",
			"toJSON",
		])
			Object.defineProperty(raw, key, { enumerable: true, get: hook });
		Object.defineProperty(envelope, "response_metadata", { enumerable: true, get: hook });
		Object.defineProperty(raw, Symbol("PRIVATE_IGNORED_SYMBOL"), { get: hook });
		expect(decodeSlackChannelFacts(id, envelope)).toEqual(facts);
		expect(reads).toBe(0);
	});
	it("refuses needed getters, proxies and exotic records without executing caller hooks", () => {
		let reads = 0;
		const hook = () => {
			reads++;
			throw new Error("PRIVATE_HOOK_CANARY");
		};
		for (const key of [...Object.keys(channel()), "is_frozen", "is_ext_ws_shared"])
			refused(id, response(Object.defineProperty(channel(), key, { enumerable: true, get: hook })));
		const proxy = new Proxy(channel(), {
			getPrototypeOf: hook,
			getOwnPropertyDescriptor: hook,
			ownKeys: hook,
			get: hook,
		});
		refused(id, response(proxy));
		refused(id, new Proxy(response(), { getPrototypeOf: hook }));
		refused(id, response(Object.assign(Object.create({ inherited: true }), channel())));
		refused(id, response(Object.defineProperty(channel(), "name", { enumerable: false })));
		expect(reads).toBe(0);
	});
	it("accepts a complete null-prototype parsed record without retaining it", () => {
		const raw = Object.assign(Object.create(null), channel());
		const envelope = Object.assign(Object.create(null), { ok: true, channel: raw });
		expect(decodeSlackChannelFacts(id, envelope)).toEqual(facts);
	});
});
