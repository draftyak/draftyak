import { describe, expect, it } from "vitest";
import {
	checkSlackPreflight,
	decodeSlackChannelFacts,
	type SlackChatFacts,
	SlackCoreError,
} from "../../src/channels/slack/index.ts";
import { explicitSharing, frozenChat, sparseIm, sparseMpim } from "./helpers/channel-info-fake.ts";

const directIm = (id: string) => explicitSharing(sparseIm(id));
const directMpim = (id: string) => explicitSharing(sparseMpim(id));

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
	channelId: id,
	type: "public",
	name: "synthetic-general",
	archived: false,
	external: false,
	shared: false,
	member: true,
	memberCount: 30,
	pendingExternal: false,
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
function preflight(current: SlackChatFacts, approved = frozenChat(facts)) {
	return checkSlackPreflight({
		approved,
		current,
		holdIfReply: false,
		approvedInboundWatermark: null,
		currentInboundWatermark: null,
	});
}

describe("conversations.info channel facts", () => {
	it("projects current conversation fields and detaches them from the response", () => {
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
		{ name: "legacy private", change: { is_channel: false, is_group: true }, type: "private" },
		{
			name: "IM before all other flags",
			change: { is_im: true, is_mpim: true, is_group: true },
			type: "dm",
		},
		{
			name: "MPIM before group/private",
			change: { is_group: true, is_mpim: true },
			type: "group_dm",
		},
		{ name: "public fallback", change: { is_channel: false }, type: "public" },
	])("uses type precedence for $name without deriving type from the ID", ({ change, type }) => {
		expect(decodeSlackChannelFacts(id, response({ ...channel(), ...change }))).toEqual({
			...facts,
			type,
			memberCount: type === "dm" ? 2 : 30,
		});
	});
	it.each([
		{ name: "IM", raw: directIm("D0DYTEST1"), type: "dm", nameValue: null, memberCount: 2 },
		{
			name: "MPIM",
			raw: directMpim("G0DYTEST1"),
			type: "group_dm",
			nameValue: "mpdm-dytest-team",
			memberCount: 0,
		},
	])(
		"projects sparse $name facts only with explicit sharing evidence",
		({ raw, type, nameValue, memberCount }) => {
			const parsed = decodeSlackChannelFacts(raw.id, response(raw));
			expect(parsed).toEqual({
				channelId: raw.id,
				type,
				name: nameValue,
				memberCount,
				archived: false,
				external: false,
				shared: false,
				member: true,
				pendingExternal: false,
			});
			expect(Object.isFrozen(parsed)).toBe(true);
			expect(preflight(parsed, frozenChat(parsed))).toEqual({ state: "ALLOW" });
			delete raw.name;
			expect(decodeSlackChannelFacts(raw.id, response(raw)).name).toBeNull();
		},
	);
	it.each([sparseIm, sparseMpim])(
		"refuses direct sharing omissions instead of defaulting them to false %#",
		(shape) => {
			refused(id, response(shape(id)));
			for (const key of ["is_shared", "is_ext_shared", "is_org_shared", "is_pending_ext_shared"]) {
				const raw = explicitSharing(shape(id));
				delete raw[key];
				refused(id, response(raw));
			}
		},
	);
	it("fixes IM count at two and preserves an explicitly supplied MPIM count", () => {
		expect(
			decodeSlackChannelFacts(id, response({ ...directIm(id), num_members: 900 })),
		).toMatchObject({ memberCount: 2 });
		expect(
			decodeSlackChannelFacts(id, response({ ...directMpim(id), num_members: 5 })),
		).toMatchObject({ memberCount: 5 });
	});
	it("preserves current archive, membership, channel rename and growth restrictions", () => {
		for (const change of [
			{ is_archived: true },
			{ is_member: false },
			{ num_members: 34 },
			{ name: "synthetic-renamed" },
		])
			expect(preflight(decodeSlackChannelFacts(id, response({ ...channel(), ...change })))).toEqual(
				{ state: "NEEDS_REAPPROVAL", reason: "channel_changed" },
			);
	});
	it("retains internal sharing and checks both frozen sharing facts", () => {
		const internal = decodeSlackChannelFacts(
			id,
			response({ ...channel(), is_shared: true, is_org_shared: true }),
		);
		const external = decodeSlackChannelFacts(
			id,
			response({ ...channel(), is_shared: true, is_ext_shared: true, is_ext_ws_shared: true }),
		);
		expect(internal).toMatchObject({ shared: true, external: false });
		expect(internal).not.toHaveProperty("isShared");
		expect(preflight(internal)).toEqual({ state: "NEEDS_REAPPROVAL", reason: "channel_changed" });
		expect(preflight(internal, frozenChat(internal))).toEqual({ state: "ALLOW" });
		expect(preflight(external, frozenChat(internal))).toEqual({
			state: "NEEDS_REAPPROVAL",
			reason: "channel_changed",
		});
	});
	it.each([directIm, directMpim, () => channel()])(
		"passes pending external sharing to the current-only preflight restriction %#",
		(shape) => {
			const initial = decodeSlackChannelFacts(id, response(shape(id)));
			const pending = decodeSlackChannelFacts(
				id,
				response({ ...shape(id), is_pending_ext_shared: true }),
			);
			expect(pending.pendingExternal).toBe(true);
			expect(preflight(pending, frozenChat(initial))).toEqual({
				state: "NEEDS_REAPPROVAL",
				reason: "channel_changed",
			});
			for (const change of [
				{ is_member: false },
				{ is_archived: true },
				{ is_shared: true, is_ext_shared: true },
			])
				expect(
					preflight(
						decodeSlackChannelFacts(id, response({ ...shape(id), ...change })),
						frozenChat(initial),
					),
				).toEqual({ state: "NEEDS_REAPPROVAL", reason: "channel_changed" });
		},
	);
	it.each([
		"id",
		"name",
		"is_archived",
		"is_shared",
		"is_ext_shared",
		"is_org_shared",
		"is_pending_ext_shared",
		"is_member",
		"num_members",
	])("refuses a missing required channel %s instead of inventing facts", (key) => {
		const raw = channel();
		delete raw[key];
		refused(id, response(raw));
	});
	it("allows absent type flags to follow the stated public fallback", () => {
		const raw = channel();
		for (const key of ["is_channel", "is_group", "is_im", "is_mpim", "is_private"]) delete raw[key];
		expect(decodeSlackChannelFacts(id, response(raw))).toEqual(facts);
		expect(decodeSlackChannelFacts(id, response({ ...raw, is_group: true }))).toEqual({
			...facts,
			type: "private",
		});
	});
	it.each([
		{ is_ext_shared: true },
		{ is_org_shared: true },
		{ is_ext_ws_shared: true },
		{ is_shared: true, is_ext_ws_shared: true },
	])("refuses inconsistent sharing flags %#", (change) =>
		refused(id, response({ ...channel(), ...change })),
	);
	it.each(["is_frozen", "is_read_only", "is_thread_only"])(
		"refuses an explicit unrepresented %s restriction",
		(key) => {
			for (const raw of [channel(), directIm(id), directMpim(id)]) {
				refused(id, response({ ...raw, [key]: true }));
				expect(decodeSlackChannelFacts(id, response({ ...raw, [key]: false }))).toMatchObject({
					channelId: id,
				});
				refused(id, response({ ...raw, [key]: undefined }));
			}
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
	it("validates every present sparse flag, name and count without coercion", () => {
		for (const shape of [directIm, directMpim]) {
			for (const key of [
				"is_channel",
				"is_group",
				"is_im",
				"is_mpim",
				"is_private",
				"is_archived",
				"is_shared",
				"is_ext_shared",
				"is_org_shared",
				"is_pending_ext_shared",
				"is_member",
				"is_ext_ws_shared",
			])
				for (const bad of [undefined, null, "false", 0])
					refused(id, response({ ...shape(id), [key]: bad }));
			for (const change of [
				{ name: undefined },
				{ name: 1 },
				{ num_members: undefined },
				{ num_members: null },
				{ num_members: -1 },
			])
				refused(id, response({ ...shape(id), ...change }));
			expect(decodeSlackChannelFacts(id, response({ ...shape(id), name: null })).name).toBeNull();
		}
	});
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
	it("requires the exact requested ID and an explicit successful envelope", () => {
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
	it("does not read unused topic, identity, message, metadata or serialization branches", () => {
		let reads = 0;
		const hook = () => {
			reads++;
			throw new Error("PRIVATE_IGNORED_CANARY");
		};
		for (const raw of [channel(), directIm(id), directMpim(id)]) {
			const envelope = response(raw);
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
			expect(decodeSlackChannelFacts(id, envelope)).toMatchObject({ channelId: id });
		}
		expect(reads).toBe(0);
	});
	it("refuses selected getters, proxies and exotic records without executing hooks", () => {
		let reads = 0;
		const hook = () => {
			reads++;
			throw new Error("PRIVATE_HOOK_CANARY");
		};
		for (const raw of [channel(), directIm(id), directMpim(id)])
			for (const key of [
				...Object.keys(channel()),
				"is_frozen",
				"is_read_only",
				"is_thread_only",
				"is_ext_ws_shared",
			])
				refused(
					id,
					response(Object.defineProperty({ ...raw }, key, { enumerable: true, get: hook })),
				);
		refused(
			id,
			response(
				new Proxy(channel(), {
					getPrototypeOf: hook,
					getOwnPropertyDescriptor: hook,
					ownKeys: hook,
					get: hook,
				}),
			),
		);
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
