import * as z from "zod";
import { uniqueItems } from "./entities/fields.ts";
import { OutboxState } from "./entities/outbox.ts";
import { jcsSha256 } from "./hash.ts";
import { SchedulingStatus } from "./hub-runtime/status.ts";
import { canonicalize } from "./jcs.ts";
import { DISPLAY_NAME_HIDDEN_RANGES } from "./pairing.ts";
import { Alias, Sha256Hex, Ulid, UtcMs } from "./scalars.ts";
import { Schedule, type ScheduleAt, SendSnapshotV1 } from "./snapshot.ts";

export const MAX_PENDING_APPROVAL_IDS = 20;
export const MAX_SCHEDULED_ITEMS = 5;
export const MAX_DESTINATION_BYTES = 512;
// A cut stops before a code point of at most 4 bytes.
export const MIN_CUT_DESTINATION_BYTES: number = MAX_DESTINATION_BYTES - 3;
export const MAX_MORE_RECIPIENTS = 299;

// The code points a display name refuses (controls, separators, bidi controls and other invisible
// ones), since the tray and the Quit dialog show a destination as is.
const HIDDEN = `[${DISPLAY_NAME_HIDDEN_RANGES.map(
	([first, last]) => `${String.fromCodePoint(first)}-${String.fromCodePoint(last)}`,
).join("")}]`;
const hidden = new RegExp(HIDDEN, "u");
const everyHidden = new RegExp(HIDDEN, "gu");
const destination = z
	.string()
	.refine(
		(text) =>
			text.isWellFormed() && Buffer.byteLength(text) <= MAX_DESTINATION_BYTES && !hidden.test(text),
		{ message: "at most 512 UTF-8 bytes, without hidden code points" },
	)
	.meta({ maxLength: MAX_DESTINATION_BYTES, not: { pattern: HIDDEN } });
const atSchedule = Schedule.refine((schedule) => schedule.kind === "at", {
	message: "a frozen at schedule required",
}).meta({ allOf: [{ properties: { kind: { const: "at" } } }] }) as z.ZodType<ScheduleAt>;
function deliverByOf(schedule: Schedule | undefined): number | undefined {
	if (schedule?.kind !== "at") return undefined;
	const deliverBy = schedule.notBefore + schedule.latenessSec * 1000;
	return Number.isSafeInteger(deliverBy) ? deliverBy : undefined;
}

export interface ScheduledItem {
	readonly outboxId: string;
	readonly accountId: string;
	readonly alias: string;
	readonly destination: string;
	readonly destinationTruncated: boolean;
	readonly moreRecipients: number;
	readonly schedule: ScheduleAt;
	readonly deliverBy: number;
}
export const ScheduledItem: z.ZodType<ScheduledItem> = z
	.strictObject({
		outboxId: Ulid,
		accountId: Ulid,
		alias: Alias,
		destination,
		destinationTruncated: z.boolean(),
		moreRecipients: z.int().min(0).max(MAX_MORE_RECIPIENTS),
		schedule: atSchedule,
		deliverBy: UtcMs,
	})
	.refine((item) => deliverByOf(item.schedule) === item.deliverBy, {
		message: "deliverBy is notBefore plus latenessSec",
		path: ["deliverBy"],
	})
	.refine(
		(item) =>
			!item.destinationTruncated ||
			Buffer.byteLength(item.destination) >= MIN_CUT_DESTINATION_BYTES,
		{ message: "a cut destination holds at least 509 bytes", path: ["destinationTruncated"] },
	)
	.meta({
		id: "draftyak.scheduled-summary.ScheduledItem",
		description:
			"A scheduled send as the tray and the Quit dialog show it: no body, subject, statement or credential.",
	});

export interface ScheduledSummary {
	readonly scheduling: SchedulingStatus;
	readonly scopeHash: string;
	readonly pendingApprovalCount: number;
	readonly pendingApprovalIds: readonly string[];
	readonly scheduledCount: number;
	readonly items: readonly ScheduledItem[];
}
const count = z.int().min(0);
const shown = (total: number, cap: number): number => Math.min(total, cap);
const distinctOutboxIds = (items: readonly { outboxId: string }[]): boolean =>
	new Set(items.map((item) => item.outboxId)).size === items.length;
const ascending = (ids: readonly string[]): boolean =>
	ids.every((id, index) => {
		const prior = ids[index - 1];
		return prior === undefined || prior < id;
	});
const precedes = (prior: ScheduledItem, item: ScheduledItem): boolean =>
	prior.schedule.notBefore < item.schedule.notBefore ||
	(prior.schedule.notBefore === item.schedule.notBefore && prior.outboxId < item.outboxId);
export const ScheduledSummary: z.ZodType<ScheduledSummary> = z
	.strictObject({
		scheduling: SchedulingStatus,
		scopeHash: Sha256Hex,
		pendingApprovalCount: count,
		pendingApprovalIds: uniqueItems(z.array(Ulid).max(MAX_PENDING_APPROVAL_IDS)),
		scheduledCount: count,
		items: z.array(ScheduledItem).max(MAX_SCHEDULED_ITEMS),
	})
	.refine(
		(summary) =>
			summary.pendingApprovalIds.length ===
			shown(summary.pendingApprovalCount, MAX_PENDING_APPROVAL_IDS),
		{ message: "the first min(pendingApprovalCount, 20) ids", path: ["pendingApprovalIds"] },
	)
	.refine((summary) => ascending(summary.pendingApprovalIds), {
		message: "pendingApprovalIds in ascending order",
		path: ["pendingApprovalIds"],
	})
	.refine(
		(summary) => summary.items.length === shown(summary.scheduledCount, MAX_SCHEDULED_ITEMS),
		{
			message: "the first min(scheduledCount, 5) items",
			path: ["items"],
		},
	)
	.refine((summary) => distinctOutboxIds(summary.items), {
		message: "an outbox item is listed once",
		path: ["items"],
	})
	.refine(
		(summary) =>
			summary.items.every((item, index) => {
				const prior = summary.items[index - 1];
				return prior === undefined || precedes(prior, item);
			}),
		{ message: "items ordered by notBefore, then outboxId", path: ["items"] },
	)
	.meta({
		id: "draftyak.scheduled-summary.ScheduledSummary",
		description:
			"Pending approvals and the next scheduled sends. Counts are totals; the lists hold the first 20 ids in ascending order and the next 5 sends. scopeHash is compared between reads, never recomputed by a device.",
	});

export interface ScopeItem {
	readonly outboxId: string;
	readonly contentHash: string;
	readonly flagsHash: string;
	readonly state: OutboxState;
}
export interface SummaryScope {
	readonly hub: string;
	readonly owner: string;
	readonly epoch: number;
	readonly scheduling: SchedulingStatus;
	readonly pendingApprovalCount: number;
	readonly pendingApprovalIds: readonly string[];
	readonly scheduledCount: number;
	readonly items: readonly ScopeItem[];
}
// Exactly what scopeHash binds: each listed item's frozen content, flags and state.
export const SummaryScope: z.ZodType<SummaryScope> = z
	.strictObject({
		hub: Sha256Hex,
		owner: Ulid,
		epoch: z.int().min(0),
		scheduling: SchedulingStatus,
		pendingApprovalCount: count,
		pendingApprovalIds: uniqueItems(z.array(Ulid).max(MAX_PENDING_APPROVAL_IDS)),
		scheduledCount: count,
		items: z
			.array(
				z.strictObject({
					outboxId: Ulid,
					contentHash: Sha256Hex,
					flagsHash: Sha256Hex,
					state: OutboxState,
				}),
			)
			.max(MAX_SCHEDULED_ITEMS),
	})
	.refine(
		(scope) =>
			scope.pendingApprovalIds.length ===
				shown(scope.pendingApprovalCount, MAX_PENDING_APPROVAL_IDS) &&
			ascending(scope.pendingApprovalIds) &&
			scope.items.length === shown(scope.scheduledCount, MAX_SCHEDULED_ITEMS) &&
			distinctOutboxIds(scope.items),
		{ message: "the listed ids and items of the summary" },
	);

export type ScheduledSummaryErrorCode = "SCOPE_INVALID";
export class ScheduledSummaryError extends Error {
	readonly code: ScheduledSummaryErrorCode;
	constructor(code: ScheduledSummaryErrorCode) {
		super(code);
		this.code = code;
	}
}
/** The SHA-256 of the scope's JCS. The hub computes it; a device only compares it between reads. */
export function scopeHash(scope: SummaryScope): string {
	const parsed = SummaryScope.safeParse(scope);
	if (!parsed.success) throw new ScheduledSummaryError("SCOPE_INVALID");
	return jcsSha256(parsed.data);
}

/**
 * A recipient or channel name as shown: each hidden code point replaced with U+FFFD, then the
 * longest prefix of whole code points within 512 UTF-8 bytes, and whether it was cut.
 */
export function cutDestination(text: string): {
	readonly destination: string;
	readonly destinationTruncated: boolean;
} {
	const shownText = text.replace(everyHidden, "\u{fffd}");
	if (Buffer.byteLength(shownText) <= MAX_DESTINATION_BYTES)
		return { destination: shownText, destinationTruncated: false };
	let bytes = 0;
	let end = 0;
	for (const char of shownText) {
		bytes += Buffer.byteLength(char);
		if (bytes > MAX_DESTINATION_BYTES) break;
		end += char.length;
	}
	return { destination: shownText.slice(0, end), destinationTruncated: true };
}
/**
 * Whether an item shows its frozen snapshot: its ids, the first To/Cc/Bcc recipient or the channel
 * name, the recipients beyond that one (0 for a chat) and the snapshot's own schedule.
 */
export function checkScheduledItemSource(item: unknown, snapshot: unknown): boolean {
	try {
		const parsedItem = ScheduledItem.safeParse(item);
		const parsedSnapshot = SendSnapshotV1.safeParse(snapshot);
		if (!parsedItem.success || !parsedSnapshot.success) return false;
		const shownItem = parsedItem.data;
		const source = parsedSnapshot.data;
		const recipients =
			source.kind === "email" ? [...source.email.to, ...source.email.cc, ...source.email.bcc] : [];
		const first = source.kind === "email" ? recipients[0] : source.chat.channelName;
		if (first === undefined) return false;
		const cut = cutDestination(first);
		return (
			shownItem.outboxId === source.outbox &&
			shownItem.accountId === source.account &&
			shownItem.destination === cut.destination &&
			shownItem.destinationTruncated === cut.destinationTruncated &&
			shownItem.moreRecipients === (source.kind === "email" ? recipients.length - 1 : 0) &&
			canonicalize(shownItem.schedule) === canonicalize(source.schedule)
		);
	} catch {
		return false;
	}
}
