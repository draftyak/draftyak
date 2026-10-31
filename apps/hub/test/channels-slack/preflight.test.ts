import { CHAT_CHANNEL_TYPES } from "@draftyak/protocol/normalized-change";
import type { SnapshotChat } from "@draftyak/protocol/snapshot";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
	checkSlackPreflight,
	type SlackChatFacts,
	SlackCoreError,
	slackChatFacts,
	tsKey,
} from "../../src/channels/slack/index.ts";

const approved: SnapshotChat & { readonly shared: boolean } = {
	channelId: "C0CHAN001",
	channelType: "public",
	channelName: "synthetic-general",
	external: false,
	shared: false,
	memberCount: 30,
	broadcast: false,
};
const current: SlackChatFacts = {
	channelId: approved.channelId,
	type: approved.channelType,
	name: approved.channelName,
	external: approved.external,
	shared: approved.shared,
	memberCount: approved.memberCount,
	archived: false,
	member: true,
};
const base = {
	approved,
	current,
	holdIfReply: true,
	approvedInboundWatermark: "1760000001.000100",
	currentInboundWatermark: "1760000001.000100",
};
const changed = { state: "NEEDS_REAPPROVAL", reason: "channel_changed" };

describe("Slack pre-claim facts", () => {
	it("uses canonical conversation types and freezes validated current facts", () => {
		for (const type of CHAT_CHANNEL_TYPES) {
			const facts = slackChatFacts({ ...current, type });
			expect(facts.type).toBe(type);
			expect(Object.isFrozen(facts)).toBe(true);
		}
		for (const type of ["channel", "group", "im", "mpim"])
			expect(() => slackChatFacts({ ...current, type })).toThrow(SlackCoreError);
	});
	it("allows unchanged frozen SnapshotChat fields and equivalent watermark precision", () => {
		expect(checkSlackPreflight(base)).toEqual({ state: "ALLOW" });
		expect(
			checkSlackPreflight({
				...base,
				approvedInboundWatermark: "1760000001.1",
				currentInboundWatermark: "1760000001.100000000",
			}),
		).toEqual({ state: "ALLOW" });
	});
	it.each([
		{ channelId: "C0OTHER01" },
		{ name: "synthetic-renamed" },
		{ type: "private" },
		{ archived: true },
		{ external: true },
		{ shared: true },
		{ pendingExternal: true },
		{ member: false },
		{ memberCount: 34 },
	])("requires reapproval after current channel change %o", (change) =>
		expect(checkSlackPreflight({ ...base, current: { ...current, ...change } })).toEqual(changed),
	);
	it.each(CHAT_CHANNEL_TYPES)("checks frozen and current sharing for %s", (type) => {
		for (const [beforeShared, shared] of [
			[false, false],
			[true, true],
			[true, false],
		] as const)
			expect(
				checkSlackPreflight({
					...base,
					approved: { ...approved, channelType: type, shared: beforeShared },
					current: { ...current, type, shared },
				}),
			).toEqual({ state: "ALLOW" });
		expect(
			checkSlackPreflight({
				...base,
				approved: { ...approved, channelType: type },
				current: { ...current, type, shared: true, external: false },
			}),
		).toEqual(changed);
	});
	it.each(["approved", "current"] as const)(
		"refuses missing or nonboolean %s sharing evidence",
		(side) => {
			const original = base[side];
			const { shared: _shared, ...legacy } = original;
			const legacyBytes = JSON.stringify(legacy);
			Object.freeze(legacy);
			for (const evidence of [
				legacy,
				...[undefined, null, "false", 0, 1].map((shared) => ({ ...original, shared })),
			])
				expect(() => checkSlackPreflight({ ...base, [side]: evidence })).toThrow(SlackCoreError);
			expect(original.shared).toBe(false);
			expect(Object.hasOwn(legacy, "shared")).toBe(false);
			expect(JSON.stringify(legacy)).toBe(legacyBytes);
		},
	);
	it("treats pending external sharing as a current restriction even for approved external chats", () => {
		expect(
			checkSlackPreflight({
				...base,
				approved: { ...approved, external: true },
				current: { ...current, external: true, pendingExternal: true },
			}),
		).toEqual(changed);
		expect(
			checkSlackPreflight({ ...base, current: { ...current, pendingExternal: false } }),
		).toEqual({ state: "ALLOW" });
	});
	it.each(["dm", "group_dm"] as const)(
		"does not compare %s names or member-count growth",
		(type) => {
			const direct = { ...approved, channelType: type, channelName: "", memberCount: 0 };
			for (const name of [undefined, null, "synthetic-new-display"]) {
				const facts: SlackChatFacts = {
					channelId: current.channelId,
					type,
					memberCount: 500,
					archived: false,
					external: false,
					shared: false,
					member: true,
					...(name === undefined ? {} : { name }),
				};
				expect(checkSlackPreflight({ ...base, approved: direct, current: facts })).toEqual({
					state: "ALLOW",
				});
			}
			for (const change of [
				{ archived: true },
				{ member: false },
				{ external: true },
				{ pendingExternal: true },
			])
				expect(
					checkSlackPreflight({
						...base,
						approved: direct,
						current: { ...current, type, ...change },
					}),
				).toEqual(changed);
		},
	);
	it("requires both strictly over ten percent growth and at least three members for channels", () => {
		for (const type of ["public", "private"] as const)
			for (const [before, after, blocked] of [
				[10, 12, false],
				[10, 13, true],
				[30, 33, false],
				[30, 34, true],
				[0, 2, false],
				[0, 3, true],
				[100, 110, false],
				[100, 111, true],
				[30, 20, false],
			] as const) {
				expect(
					checkSlackPreflight({
						...base,
						approved: { ...approved, channelType: type, memberCount: before },
						current: { ...current, type, memberCount: after },
					}),
				).toEqual(blocked ? changed : { state: "ALLOW" });
			}
	});
	it("requires reapproval only for a newer inbound watermark when hold-if-reply is enabled", () => {
		const currentInboundWatermark = "1760000001.000101";
		expect(checkSlackPreflight({ ...base, currentInboundWatermark })).toEqual({
			state: "NEEDS_REAPPROVAL",
			reason: "new_reply",
		});
		expect(
			checkSlackPreflight({ ...base, approvedInboundWatermark: null, currentInboundWatermark }),
		).toEqual({ state: "NEEDS_REAPPROVAL", reason: "new_reply" });
		expect(checkSlackPreflight({ ...base, holdIfReply: false, currentInboundWatermark })).toEqual({
			state: "ALLOW",
		});
		expect(checkSlackPreflight({ ...base, currentInboundWatermark: "1760000001.000099" })).toEqual({
			state: "ALLOW",
		});
		expect(
			checkSlackPreflight({
				...base,
				approvedInboundWatermark: null,
				currentInboundWatermark: null,
			}),
		).toEqual({ state: "ALLOW" });
		expect(
			checkSlackPreflight({
				...base,
				currentInboundWatermark,
				current: { ...current, pendingExternal: true },
			}),
		).toEqual(changed);
	});
	it("orders beyond floating-point precision and canonicalizes fractional precision exactly", () => {
		expect(tsKey("999999999999.999999999") > tsKey("999999999999.999999998")).toBe(true);
		expect(tsKey("1.1")).toBe(tsKey("1.100000000"));
		expect(() => tsKey("01.1")).toThrow(SlackCoreError);
	});
	it("rejects line terminators in facts and inbound watermarks", () => {
		for (const suffix of ["\n", "\r\n", "\u2028", "\u2029"]) {
			expect(() =>
				checkSlackPreflight({
					...base,
					current: { ...current, channelId: current.channelId + suffix },
				}),
			).toThrow(SlackCoreError);
			expect(() =>
				checkSlackPreflight({
					...base,
					currentInboundWatermark: base.currentInboundWatermark + suffix,
				}),
			).toThrow(SlackCoreError);
		}
	});
	it("requires the actual frozen chat shape without current-only restrictions", () => {
		for (const change of [
			{ channelName: null },
			{ broadcast: undefined },
			{ broadcast: true },
			{ archived: false },
			{ member: true },
			{ pendingExternal: false },
		])
			expect(() => checkSlackPreflight({ ...base, approved: { ...approved, ...change } })).toThrow(
				SlackCoreError,
			);
		expect(
			checkSlackPreflight({
				...base,
				approved: { ...approved, threadTs: "1760000001.1", broadcast: true },
			}),
		).toEqual({ state: "ALLOW" });
	});
	it("rejects malformed current facts rather than erasing restrictions", () => {
		for (const change of [
			{ member: undefined },
			{ memberCount: -1 },
			{ external: "false" },
			{ name: "a\u0000b" },
			{ name: null },
			{ topic: "PRIVATE_CANARY" },
			{ type: "PRIVATE_CANARY" },
			{ pendingExternal: undefined },
			{ pendingExternal: "true" },
			{ isShared: false },
		])
			expect(() => checkSlackPreflight({ ...base, current: { ...current, ...change } })).toThrow(
				SlackCoreError,
			);
	});
	it("matches the approved growth rule for integer channel member counts (200 runs)", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 0, max: 10000 }),
				fc.integer({ min: 0, max: 1000 }),
				(count, growth) => {
					const result = checkSlackPreflight({
						...base,
						approved: { ...approved, memberCount: count },
						current: { ...current, memberCount: count + growth },
					});
					expect(result).toEqual(growth >= 3 && growth * 10 > count ? changed : { state: "ALLOW" });
				},
			),
			{ numRuns: 200, seed: 6103 },
		);
	});
});
