import type { OutboxItem, OutboxState, StateReason } from "@draftyak/protocol/entities/outbox";
import type { SchedulingStatus } from "@draftyak/protocol/hub-runtime";
import { renderLocalWallTime, ScheduleError } from "@draftyak/protocol/schedule";

export interface ScheduledSelection {
	readonly outboxId: string;
	readonly draftId: string;
}

export interface ScheduledTime {
	readonly kind: "local" | "utc" | "unavailable";
	readonly text: string;
	readonly dateTime?: string;
}

export interface ScheduledRow {
	readonly outboxId: string;
	readonly draftId: string;
	readonly accountId: string;
	readonly stateLabel: string;
	readonly reasonLabel?: string;
	readonly notBefore: ScheduledTime;
	readonly deliverBy: ScheduledTime;
	readonly selection: ScheduledSelection;
}

export interface ScheduledGroup {
	readonly accountId: string;
	readonly label: string;
	readonly rows: readonly ScheduledRow[];
}

export interface ScheduledViewModel {
	readonly groups: readonly ScheduledGroup[];
	readonly scheduledCount: number;
	readonly visibleCount: number;
	readonly localTimeUnavailable: boolean;
	readonly warnings: readonly string[];
}

const STATE_LABELS: Readonly<Record<OutboxState, string>> = {
	PENDING_APPROVAL: "Pending approval",
	APPROVED: "Approved",
	SCHEDULED: "Scheduled",
	SENDING: "Sending",
	RETRY_WAIT: "Waiting to retry",
	UNKNOWN: "Send outcome unknown",
	SENT: "Sent",
	FAILED: "Failed",
	NEEDS_REAPPROVAL: "Needs new approval",
	CANCELLED: "Cancelled",
	REJECTED: "Rejected",
	SUPERSEDED: "Superseded",
	EXPIRED: "Expired",
};

const REASON_LABELS: Readonly<Record<StateReason, string>> = {
	missed: "Needs new approval",
	new_reply: "New reply received",
	channel_changed: "Channel changed",
	approver_revoked: "Approver revoked",
	credential_lost: "Account credentials lost",
	plugin_quarantined: "Plugin quarantined",
	policy: "Policy changed",
	restored: "Restored from backup",
	not_found: "Original message not found",
};

interface RenderedTime {
	readonly value: ScheduledTime;
	readonly utcFallback: boolean;
	readonly invalid: boolean;
}

function displayTime(instant: number | null, ownerZone: string): RenderedTime {
	if (instant === null) {
		return {
			value: Object.freeze({ kind: "unavailable", text: "No delivery deadline" }),
			utcFallback: false,
			invalid: false,
		};
	}
	try {
		const wall = renderLocalWallTime(instant, ownerZone);
		return {
			value: Object.freeze({
				kind: "local",
				text: `${wall} (${ownerZone})`,
				dateTime: new Date(instant).toISOString(),
			}),
			utcFallback: false,
			invalid: false,
		};
	} catch (error) {
		if (error instanceof ScheduleError && error.code === "SCHEDULING_UNAVAILABLE") {
			const dateTime = new Date(instant).toISOString();
			return {
				value: Object.freeze({ kind: "utc", text: `${dateTime} (UTC)`, dateTime }),
				utcFallback: true,
				invalid: false,
			};
		}
		return {
			value: Object.freeze({ kind: "unavailable", text: "Time unavailable" }),
			utcFallback: false,
			invalid: true,
		};
	}
}

function accountLabel(accountId: string, labels?: Readonly<Record<string, string>>): string {
	const entry =
		labels === undefined ? undefined : Object.getOwnPropertyDescriptor(labels, accountId);
	return entry !== undefined &&
		"value" in entry &&
		typeof entry.value === "string" &&
		entry.value.trim().length > 0
		? entry.value
		: accountId;
}

/** Project persisted proposal state. Account selection changes the display, never authorization. */
export function buildScheduledViewModel(
	items: readonly OutboxItem[],
	ownerZone: string,
	scheduling: SchedulingStatus,
	accountId?: string,
	accountLabels?: Readonly<Record<string, string>>,
): ScheduledViewModel {
	const scheduled = items.filter((item) => item.notBefore !== null);
	const visible = scheduled
		.filter((item) => accountId === undefined || item.accountId === accountId)
		.sort((left, right) => {
			const timeOrder = (left.notBefore ?? 0) - (right.notBefore ?? 0);
			return timeOrder || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
		});
	const groups = new Map<string, ScheduledRow[]>();
	let utcFallback = false;
	let invalidTime = false;
	for (const item of visible) {
		const notBefore = displayTime(item.notBefore, ownerZone);
		const deliverBy = displayTime(item.deliverBy, ownerZone);
		utcFallback ||= notBefore.utcFallback || deliverBy.utcFallback;
		invalidTime ||= notBefore.invalid || deliverBy.invalid;
		const reason = item.state === "NEEDS_REAPPROVAL" ? item.stateReason : null;
		const row: ScheduledRow = Object.freeze({
			outboxId: item.id,
			draftId: item.draftId,
			accountId: item.accountId,
			stateLabel: reason === "missed" ? "Missed" : STATE_LABELS[item.state],
			...(reason === null ? {} : { reasonLabel: REASON_LABELS[reason] }),
			notBefore: notBefore.value,
			deliverBy: deliverBy.value,
			selection: Object.freeze({ outboxId: item.id, draftId: item.draftId }),
		});
		const rows = groups.get(item.accountId);
		if (rows === undefined) groups.set(item.accountId, [row]);
		else rows.push(row);
	}
	const warnings = [
		"Scheduled sends require the computer to be awake and the hub to be running.",
		"Changing a scheduled time requires fresh owner approval.",
		scheduling.mode === "sidecar"
			? "Sidecar mode requires the app to remain open."
			: "Service mode still requires the hub service to be running.",
	];
	if (scheduling.scheduler === "unavailable") {
		warnings.push(
			"Scheduling is unavailable; scheduled messages cannot be sent until the scheduler is running.",
		);
	}
	if (scheduling.syncPaused) warnings.push("Sync is paused. This does not pause scheduled sends.");
	if (utcFallback) {
		warnings.push("Local time display is unavailable; valid times are shown in UTC.");
	}
	if (invalidTime) warnings.push("Some scheduled times could not be displayed.");
	return Object.freeze({
		groups: Object.freeze(
			Array.from(groups, ([id, rows]) =>
				Object.freeze({
					accountId: id,
					label: accountLabel(id, accountLabels),
					rows: Object.freeze(rows),
				}),
			),
		),
		scheduledCount: scheduled.length,
		visibleCount: visible.length,
		localTimeUnavailable: utcFallback || invalidTime,
		warnings: Object.freeze(warnings),
	});
}
