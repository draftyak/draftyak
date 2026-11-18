import { isProxy } from "node:util/types";
import type { Contact } from "@draftyak/protocol/entities/contact";
import type { Draft } from "@draftyak/protocol/entities/draft";
import type { ChatMessage } from "@draftyak/protocol/entities/message/chat";
import type { OutboxItem, OutboxState } from "@draftyak/protocol/entities/outbox";

export const SLACK_RETENTION_MS: number = 90 * 24 * 60 * 60 * 1_000;

export type SlackMessageRetentionRow = Readonly<
	Pick<ChatMessage, "accountId" | "channel" | "sentAt" | "editedAt">
>;
export type SlackContactRetentionRow = Readonly<Pick<Contact, "accountId" | "lastActivityAt">>;
export type SlackDraftRetentionRow = Readonly<
	Pick<Draft, "id" | "accountId" | "state" | "createdAt" | "updatedAt">
>;
export type SlackOutboxRetentionRow = Readonly<
	Pick<OutboxItem, "accountId" | "draftId" | "state" | "createdAt" | "updatedAt">
>;

export interface SlackRetentionDecision {
	readonly candidate: boolean;
	readonly reason: "expired" | "within_window" | "active" | "outbox_reference" | "invalid";
}

const EXPIRED: SlackRetentionDecision = Object.freeze({ candidate: true, reason: "expired" });
const RECENT: SlackRetentionDecision = Object.freeze({ candidate: false, reason: "within_window" });
const ACTIVE: SlackRetentionDecision = Object.freeze({ candidate: false, reason: "active" });
const REFERENCED: SlackRetentionDecision = Object.freeze({
	candidate: false,
	reason: "outbox_reference",
});
const INVALID: SlackRetentionDecision = Object.freeze({ candidate: false, reason: "invalid" });

// Keep this exhaustive over the existing protocol states. UNKNOWN is a live send,
// and an elapsed delivery window does not itself retire a SCHEDULED snapshot.
const outboxStates: Readonly<Record<OutboxState, "active" | "terminal">> = Object.freeze({
	PENDING_APPROVAL: "active",
	APPROVED: "active",
	SCHEDULED: "active",
	SENDING: "active",
	RETRY_WAIT: "active",
	UNKNOWN: "active",
	SENT: "terminal",
	FAILED: "terminal",
	NEEDS_REAPPROVAL: "terminal",
	CANCELLED: "terminal",
	REJECTED: "terminal",
	SUPERSEDED: "terminal",
	EXPIRED: "terminal",
});

function row(value: unknown): object | undefined {
	if (value === null || typeof value !== "object" || isProxy(value) || Array.isArray(value))
		return undefined;
	const prototype: unknown = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null ? value : undefined;
}

function own(value: object, key: string): unknown {
	const descriptor = Object.getOwnPropertyDescriptor(value, key);
	return descriptor?.enumerable && "value" in descriptor ? descriptor.value : undefined;
}

function utc(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function id(value: unknown): value is string {
	return (
		typeof value === "string" && value.length === 26 && /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(value)
	);
}

function accountRow(accountId: string, value: unknown, now: number): object | undefined {
	if (!id(accountId) || !utc(now)) return undefined;
	const valueRow = row(value);
	return valueRow && own(valueRow, "accountId") === accountId ? valueRow : undefined;
}

function age(lastActivityAt: number, now: number): SlackRetentionDecision {
	// "Older than 90 days" excludes the exact boundary. Subtraction stays safe
	// even near the upper UtcMs bound and before the first full retention window.
	return lastActivityAt < now - SLACK_RETENTION_MS ? EXPIRED : RECENT;
}

function updated(value: object): number | undefined {
	const createdAt = own(value, "createdAt");
	const updatedAt = own(value, "updatedAt");
	return utc(createdAt) && utc(updatedAt) && createdAt <= updatedAt ? updatedAt : undefined;
}

/**
 * Classify stored DATA from one caller-selected Slack account. These functions
 * neither identify a Slack account nor authorize deletion. The retention caller
 * supplies a coherent current store projection and rechecks it in the original
 * deletion transaction before applying candidates to rows, bodies and FTS.
 * Invalid or unrecognized DATA is retained for repair rather than discarded.
 */
export function slackMessageRetention(
	accountId: string,
	message: SlackMessageRetentionRow,
	now: number,
): SlackRetentionDecision {
	const value = accountRow(accountId, message, now);
	if (!value || own(value, "channel") !== "chat") return INVALID;
	const sentAt = own(value, "sentAt");
	const editedAt = own(value, "editedAt");
	if (!utc(sentAt) || (editedAt !== null && !utc(editedAt))) return INVALID;
	return age(Math.max(sentAt, editedAt ?? sentAt), now);
}

export function slackContactRetention(
	accountId: string,
	contact: SlackContactRetentionRow,
	now: number,
): SlackRetentionDecision {
	const value = accountRow(accountId, contact, now);
	if (!value) return INVALID;
	const lastActivityAt = own(value, "lastActivityAt");
	return utc(lastActivityAt) ? age(lastActivityAt, now) : INVALID;
}

export function slackOutboxRetention(
	accountId: string,
	item: SlackOutboxRetentionRow,
	now: number,
): SlackRetentionDecision {
	const value = accountRow(accountId, item, now);
	if (!value || !id(own(value, "draftId"))) return INVALID;
	const state = own(value, "state");
	const updatedAt = updated(value);
	if (typeof state !== "string" || !Object.hasOwn(outboxStates, state) || updatedAt === undefined)
		return INVALID;
	return outboxStates[state as OutboxState] === "active" ? ACTIVE : age(updatedAt, now);
}

/**
 * The caller supplies ALL outbox rows referencing this draft from the same
 * current projection, including terminal rows. A retained outbox row retains
 * its draft/revisions and frozen snapshot; purging the local thread is separate.
 * No validity flag, fabricated approval, or provider timestamp retires it.
 */
export function slackDraftRetention(
	accountId: string,
	draft: SlackDraftRetentionRow,
	outboxItems: readonly SlackOutboxRetentionRow[],
	now: number,
): SlackRetentionDecision {
	const value = accountRow(accountId, draft, now);
	if (!value) return INVALID;
	const draftId = own(value, "id");
	const state = own(value, "state");
	const updatedAt = updated(value);
	if (!id(draftId) || updatedAt === undefined) return INVALID;
	if (state === "open") return ACTIVE;
	if (state !== "sent" && state !== "discarded") return INVALID;
	if (isProxy(outboxItems) || !Array.isArray(outboxItems)) return INVALID;
	for (let index = 0; index < outboxItems.length; index++) {
		const item = own(outboxItems, String(index));
		const itemRow = row(item);
		if (!itemRow || own(itemRow, "draftId") !== draftId) return INVALID;
		const decision = slackOutboxRetention(accountId, item as SlackOutboxRetentionRow, now);
		if (decision.reason === "invalid") return INVALID;
		if (!decision.candidate) return REFERENCED;
	}
	return age(updatedAt, now);
}
