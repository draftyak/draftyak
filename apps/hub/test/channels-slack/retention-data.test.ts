import { describe, expect, it } from "vitest";
import {
	SLACK_RETENTION_MS,
	type SlackContactRetentionRow,
	type SlackDraftRetentionRow,
	type SlackMessageRetentionRow,
	type SlackOutboxRetentionRow,
	slackContactRetention,
	slackDraftRetention,
	slackMessageRetention,
	slackOutboxRetention,
} from "../../src/channels/slack/retention-data.ts";

const DAY = 24 * 60 * 60 * 1_000;
const NOW = 200 * DAY;
const CUTOFF = NOW - 90 * DAY;
const ACCOUNT = "00000000000000000000000001";
const OTHER_ACCOUNT = "00000000000000000000000002";
const DRAFT = "00000000000000000000000003";
const OTHER_DRAFT = "00000000000000000000000004";

function message(overrides: Partial<SlackMessageRetentionRow> = {}): SlackMessageRetentionRow {
	return { accountId: ACCOUNT, channel: "chat", sentAt: 1, editedAt: null, ...overrides };
}
function contact(overrides: Partial<SlackContactRetentionRow> = {}): SlackContactRetentionRow {
	return { accountId: ACCOUNT, lastActivityAt: 1, ...overrides };
}
function draft(overrides: Partial<SlackDraftRetentionRow> = {}): SlackDraftRetentionRow {
	return { id: DRAFT, accountId: ACCOUNT, state: "sent", createdAt: 0, updatedAt: 1, ...overrides };
}
function outbox(overrides: Partial<SlackOutboxRetentionRow> = {}): SlackOutboxRetentionRow {
	return {
		accountId: ACCOUNT,
		draftId: DRAFT,
		state: "SENT",
		createdAt: 0,
		updatedAt: 1,
		...overrides,
	};
}

describe("Slack rolling retention DATA", () => {
	it("selects only activity strictly older than 90 days", () => {
		expect(SLACK_RETENTION_MS).toBe(90 * DAY);
		for (const [at, candidate] of [
			[CUTOFF - 1, true],
			[CUTOFF, false],
			[CUTOFF + 1, false],
			[NOW + DAY, false],
		] as const) {
			expect(slackMessageRetention(ACCOUNT, message({ sentAt: at }), NOW).candidate).toBe(
				candidate,
			);
			expect(slackContactRetention(ACCOUNT, contact({ lastActivityAt: at }), NOW).candidate).toBe(
				candidate,
			);
			expect(slackOutboxRetention(ACCOUNT, outbox({ updatedAt: at }), NOW).candidate).toBe(
				candidate,
			);
			expect(slackDraftRetention(ACCOUNT, draft({ updatedAt: at }), [], NOW).candidate).toBe(
				candidate,
			);
		}
	});

	it("uses a recent edit as message activity without retaining an expired local thread", () => {
		expect(slackMessageRetention(ACCOUNT, message({ editedAt: CUTOFF }), NOW)).toEqual({
			candidate: false,
			reason: "within_window",
		});
		expect(
			slackMessageRetention(ACCOUNT, message({ sentAt: CUTOFF, editedAt: 1 }), NOW).candidate,
		).toBe(false);
		expect(slackMessageRetention(ACCOUNT, message({ editedAt: CUTOFF - 1 }), NOW).candidate).toBe(
			true,
		);
	});

	it("preserves every active outbox state, including overdue scheduled snapshots", () => {
		for (const state of [
			"PENDING_APPROVAL",
			"APPROVED",
			"SCHEDULED",
			"SENDING",
			"RETRY_WAIT",
			"UNKNOWN",
		] as const) {
			const item = outbox({ state });
			expect(slackOutboxRetention(ACCOUNT, item, NOW)).toEqual({
				candidate: false,
				reason: "active",
			});
			expect(slackDraftRetention(ACCOUNT, draft(), [item], NOW)).toEqual({
				candidate: false,
				reason: "outbox_reference",
			});
		}
		// Old thread content can expire while the scheduled reply's frozen draft remains.
		expect(slackMessageRetention(ACCOUNT, message(), NOW).candidate).toBe(true);
	});

	it("expires terminal items, including NEEDS_REAPPROVAL, by their latest update", () => {
		for (const state of [
			"SENT",
			"FAILED",
			"NEEDS_REAPPROVAL",
			"CANCELLED",
			"REJECTED",
			"SUPERSEDED",
			"EXPIRED",
		] as const) {
			expect(slackOutboxRetention(ACCOUNT, outbox({ state }), NOW)).toEqual({
				candidate: true,
				reason: "expired",
			});
			expect(slackOutboxRetention(ACCOUNT, outbox({ state, updatedAt: NOW }), NOW).candidate).toBe(
				false,
			);
		}
	});

	it("retains open drafts and snapshots referenced by any retained outbox row", () => {
		expect(slackDraftRetention(ACCOUNT, draft({ state: "open" }), [], NOW)).toEqual({
			candidate: false,
			reason: "active",
		});
		for (const state of ["sent", "discarded"] as const) {
			expect(slackDraftRetention(ACCOUNT, draft({ state }), [outbox()], NOW).candidate).toBe(true);
			expect(
				slackDraftRetention(ACCOUNT, draft({ state }), [outbox({ updatedAt: CUTOFF })], NOW),
			).toEqual({ candidate: false, reason: "outbox_reference" });
		}
	});

	it("does not let an old terminal reference hide a later live reference", () => {
		expect(
			slackDraftRetention(ACCOUNT, draft(), [outbox(), outbox({ state: "UNKNOWN" })], NOW),
		).toEqual({ candidate: false, reason: "outbox_reference" });
	});

	it("never selects foreign-account rows or unrelated draft references", () => {
		const decisions = [
			slackMessageRetention(ACCOUNT, message({ accountId: OTHER_ACCOUNT }), NOW),
			slackContactRetention(ACCOUNT, contact({ accountId: OTHER_ACCOUNT }), NOW),
			slackOutboxRetention(ACCOUNT, outbox({ accountId: OTHER_ACCOUNT }), NOW),
			slackDraftRetention(ACCOUNT, draft({ accountId: OTHER_ACCOUNT }), [], NOW),
			slackDraftRetention(ACCOUNT, draft(), [outbox({ accountId: OTHER_ACCOUNT })], NOW),
			slackDraftRetention(ACCOUNT, draft(), [outbox({ draftId: OTHER_DRAFT })], NOW),
		];
		for (const decision of decisions)
			expect(decision).toEqual({ candidate: false, reason: "invalid" });
	});

	it("retains unknown states and invalid or contradictory times", () => {
		for (const invalid of [
			Number.NaN,
			Number.POSITIVE_INFINITY,
			-1,
			0.5,
			Number.MAX_SAFE_INTEGER + 1,
		]) {
			expect(slackMessageRetention(ACCOUNT, message(), invalid).candidate).toBe(false);
			expect(slackMessageRetention(ACCOUNT, message({ editedAt: invalid }), NOW).candidate).toBe(
				false,
			);
			expect(
				slackContactRetention(ACCOUNT, contact({ lastActivityAt: invalid }), NOW).candidate,
			).toBe(false);
			expect(slackOutboxRetention(ACCOUNT, outbox({ updatedAt: invalid }), NOW).candidate).toBe(
				false,
			);
		}
		expect(
			slackOutboxRetention(ACCOUNT, outbox({ createdAt: 2, updatedAt: 1 }), NOW).candidate,
		).toBe(false);
		expect(
			slackDraftRetention(ACCOUNT, draft({ createdAt: 2, updatedAt: 1 }), [], NOW).candidate,
		).toBe(false);
		for (const state of ["future_state", "__proto__", "toString"] as never[]) {
			expect(slackOutboxRetention(ACCOUNT, outbox({ state }), NOW)).toEqual({
				candidate: false,
				reason: "invalid",
			});
			expect(slackDraftRetention(ACCOUNT, draft({ state }), [], NOW).candidate).toBe(false);
		}
	});

	it("handles safe epoch bounds without rounding or clamping the cutoff", () => {
		expect(slackContactRetention(ACCOUNT, contact({ lastActivityAt: 0 }), 0).candidate).toBe(false);
		expect(
			slackContactRetention(ACCOUNT, contact({ lastActivityAt: 0 }), SLACK_RETENTION_MS).candidate,
		).toBe(false);
		expect(
			slackContactRetention(ACCOUNT, contact({ lastActivityAt: 0 }), SLACK_RETENTION_MS + 1)
				.candidate,
		).toBe(true);
		const now = Number.MAX_SAFE_INTEGER;
		expect(
			slackContactRetention(ACCOUNT, contact({ lastActivityAt: now - SLACK_RETENTION_MS }), now)
				.candidate,
		).toBe(false);
		expect(
			slackContactRetention(ACCOUNT, contact({ lastActivityAt: now - SLACK_RETENTION_MS - 1 }), now)
				.candidate,
		).toBe(true);
	});

	it("retains malformed or missing projections without invoking getters or proxies", () => {
		let invoked = 0;
		const accessor = {
			...message(),
			get editedAt() {
				invoked++;
				return 0;
			},
		};
		const proxy = new Proxy(message(), {
			getPrototypeOf() {
				invoked++;
				return Object.prototype;
			},
		});
		for (const value of [undefined, null, [], {}, accessor, proxy, Object.create(message())]) {
			expect(slackMessageRetention(ACCOUNT, value as SlackMessageRetentionRow, NOW)).toEqual({
				candidate: false,
				reason: "invalid",
			});
		}
		const references = [outbox()];
		Object.defineProperty(references, "0", {
			enumerable: true,
			get() {
				invoked++;
				return outbox();
			},
		});
		for (const values of [undefined, references, new Array(1), new Proxy([], {})]) {
			expect(
				slackDraftRetention(ACCOUNT, draft(), values as SlackOutboxRetentionRow[], NOW).candidate,
			).toBe(false);
		}
		expect(invoked).toBe(0);
	});

	it("requires a canonical account identity and returns immutable decisions without changing inputs", () => {
		const item = Object.freeze(outbox({ state: "SCHEDULED" }));
		const source = Object.freeze(draft());
		const references = Object.freeze([item]);
		expect(slackDraftRetention(ACCOUNT, source, references, NOW).candidate).toBe(false);
		expect(source).toEqual(draft());
		expect(item).toEqual(outbox({ state: "SCHEDULED" }));
		expect(Object.isFrozen(slackMessageRetention(ACCOUNT, message(), NOW))).toBe(true);
		for (const invalid of ["", "slack-1", `${ACCOUNT}\n`, "8".repeat(26)]) {
			expect(slackContactRetention(invalid, contact({ accountId: invalid }), NOW).candidate).toBe(
				false,
			);
		}
	});
});
