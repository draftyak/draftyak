import { CHAT_CHANNEL_TYPES } from "@draftyak/protocol/normalized-change";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { checkSlackPreflight, SlackCoreError, slackChatFacts, tsKey } from "../src/index.ts";

const approved = {
	id: "C0CHAN001",
	type: "public",
	name: "synthetic-general",
	isArchived: false,
	isShared: false,
	isExternal: false,
	isMember: true,
	memberCount: 30,
};
const base = {
	approved,
	current: approved,
	holdIfReply: true,
	approvedInboundWatermark: "1760000001.000100",
	currentInboundWatermark: "1760000001.000100",
};
const changed = { state: "NEEDS_REAPPROVAL", reason: "channel_changed" };

describe("Slack pre-claim facts", () => {
	it("uses the canonical protocol channel types, and freezes validated snapshot facts", () => {
		for (const type of CHAT_CHANNEL_TYPES) {
			const facts = slackChatFacts({ ...approved, type });
			expect(facts.type).toBe(type);
			expect(Object.isFrozen(facts)).toBe(true);
		}
		for (const type of ["channel", "group", "im", "mpim"])
			expect(() => slackChatFacts({ ...approved, type })).toThrow(SlackCoreError);
	});
	it("allows unchanged facts and a watermark with equivalent precision", () => {
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
		{ id: "C0OTHER01" },
		{ name: "synthetic-renamed" },
		{ type: "private" },
		{ isArchived: true },
		{ isShared: true },
		{ isExternal: true },
		{ isMember: false },
		{ memberCount: 34 },
	])("requires reapproval after channel change %o", (change) =>
		expect(checkSlackPreflight({ ...base, current: { ...approved, ...change } })).toEqual(changed),
	);
	it("detects a Connect transition even if the channel was already shared internally", () => {
		const shared = { ...approved, isShared: true };
		expect(
			checkSlackPreflight({ ...base, approved: shared, current: { ...shared, isExternal: true } }),
		).toEqual(changed);
	});
	it("requires both strictly over ten percent growth and at least three members", () => {
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
					approved: { ...approved, memberCount: before },
					current: { ...approved, memberCount: after },
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
	});
	it("orders beyond floating-point precision and canonicalizes fractional precision exactly", () => {
		expect(tsKey("999999999999.999999999") > tsKey("999999999999.999999998")).toBe(true);
		expect(tsKey("1.1")).toBe(tsKey("1.100000000"));
		expect(() => tsKey("01.1")).toThrow(SlackCoreError);
	});
	it("rejects line terminators in facts and inbound watermarks", () => {
		for (const suffix of ["\n", "\r\n", "\u2028", "\u2029"]) {
			expect(() =>
				checkSlackPreflight({ ...base, current: { ...approved, id: `${approved.id}${suffix}` } }),
			).toThrow(SlackCoreError);
			expect(() =>
				checkSlackPreflight({
					...base,
					currentInboundWatermark: `${base.currentInboundWatermark}${suffix}`,
				}),
			).toThrow(SlackCoreError);
		}
	});
	it("rejects missing facts or display metadata instead of inventing send targets", () => {
		for (const change of [
			{ isMember: undefined },
			{ memberCount: -1 },
			{ isExternal: "false" },
			{ name: "a\u0000b" },
			{ topic: "PRIVATE_CANARY" },
			{ type: "PRIVATE_CANARY" },
		]) {
			expect(() => checkSlackPreflight({ ...base, current: { ...approved, ...change } })).toThrow(
				SlackCoreError,
			);
		}
	});
	it("matches the approved growth rule for integer member counts (200 runs)", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 0, max: 10000 }),
				fc.integer({ min: 0, max: 1000 }),
				(count, growth) => {
					const result = checkSlackPreflight({
						...base,
						approved: { ...approved, memberCount: count },
						current: { ...approved, memberCount: count + growth },
					});
					expect(result).toEqual(growth >= 3 && growth * 10 > count ? changed : { state: "ALLOW" });
				},
			),
			{ numRuns: 200, seed: 6103 },
		);
	});
});
