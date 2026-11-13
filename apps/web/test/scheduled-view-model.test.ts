import { runInNewContext } from "node:vm";
import { OutboxItem, type OutboxState, type StateReason } from "@draftyak/protocol/entities/outbox";
import { SchedulingStatus } from "@draftyak/protocol/hub-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildScheduledViewModel } from "../src/scheduling/scheduled-view-model.ts";

const WHEN = Date.parse("2030-04-10T15:00:00.000Z");
const ZONE = "America/Chicago";
const nativeTemporal: unknown =
	Reflect.get(globalThis, "Temporal") ??
	runInNewContext("typeof Temporal === 'undefined' ? undefined : Temporal");
const id = (ordinal: number): string =>
	`${"01ARZ3NDEKTSV4RRFFQ69G5FAV".slice(0, -2)}${String(ordinal).padStart(2, "0")}`;
const ACCOUNT_A = id(21);
const ACCOUNT_B = id(22);
const RUNNING = SchedulingStatus.parse({
	mode: "service",
	scheduler: "running",
	syncPaused: false,
});

type ItemOverrides = Partial<Omit<OutboxItem, "state" | "stateReason">> & {
	readonly state?: OutboxState;
	readonly stateReason?: StateReason | null;
};

function item(overrides: ItemOverrides = {}): OutboxItem {
	return OutboxItem.parse({
		id: id(1),
		accountId: ACCOUNT_A,
		draftId: id(31),
		rev: 1,
		proposedBy: { kind: "owner", id: id(11) },
		contentHash: "a".repeat(64),
		flagsHash: "b".repeat(64),
		notBefore: WHEN,
		deliverBy: WHEN + 3_600_000,
		requiredApprovals: 1,
		createdAt: WHEN - 60_000,
		updatedAt: WHEN - 60_000,
		state: "SCHEDULED",
		stateReason: null,
		...overrides,
	});
}

function onlyRow(items: readonly OutboxItem[], zone = ZONE) {
	const row = buildScheduledViewModel(items, zone, RUNNING).groups[0]?.rows[0];
	if (row === undefined) throw new Error("DYTEST scheduled row missing");
	return row;
}

beforeEach(() => vi.stubGlobal("Temporal", undefined));
afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("persisted scheduled-message state", () => {
	const labels: readonly [OutboxState, string][] = [
		["PENDING_APPROVAL", "Pending approval"],
		["APPROVED", "Approved"],
		["SCHEDULED", "Scheduled"],
		["SENDING", "Sending"],
		["RETRY_WAIT", "Waiting to retry"],
		["UNKNOWN", "Send outcome unknown"],
		["SENT", "Sent"],
		["FAILED", "Failed"],
		["NEEDS_REAPPROVAL", "Needs new approval"],
		["CANCELLED", "Cancelled"],
		["REJECTED", "Rejected"],
		["SUPERSEDED", "Superseded"],
		["EXPIRED", "Expired"],
	];
	it.each(labels)("labels persisted %s without changing state", (state, label) => {
		const value = item({ state, stateReason: state === "NEEDS_REAPPROVAL" ? "policy" : null });
		const before = structuredClone(value);
		expect(onlyRow([value]).stateLabel).toBe(label);
		expect(value).toEqual(before);
	});

	const reasons: readonly [StateReason, string][] = [
		["missed", "Needs new approval"],
		["new_reply", "New reply received"],
		["channel_changed", "Channel changed"],
		["approver_revoked", "Approver revoked"],
		["credential_lost", "Account credentials lost"],
		["plugin_quarantined", "Plugin quarantined"],
		["policy", "Policy changed"],
		["restored", "Restored from backup"],
		["not_found", "Original message not found"],
	];
	it.each(reasons)("shows the persisted %s reason", (stateReason, reasonLabel) => {
		const row = onlyRow([item({ state: "NEEDS_REAPPROVAL", stateReason })]);
		expect(row.reasonLabel).toBe(reasonLabel);
		expect(row.stateLabel).toBe(stateReason === "missed" ? "Missed" : "Needs new approval");
	});

	it("does not infer Missed or Expired from a past instant or a client clock", () => {
		const clock = vi.spyOn(Date, "now").mockImplementation(() => {
			throw new Error("DYTEST current clock must not be read");
		});
		const rows = [
			item({ id: id(1), notBefore: 0, deliverBy: 1 }),
			item({ id: id(2), state: "APPROVED", notBefore: 1, deliverBy: 2 }),
		];
		const model = buildScheduledViewModel(rows, ZONE, RUNNING);
		expect(model.groups[0]?.rows.map((row) => row.stateLabel)).toEqual(["Scheduled", "Approved"]);
		expect(model.groups[0]?.rows.every((row) => row.reasonLabel === undefined)).toBe(true);
		expect(clock).not.toHaveBeenCalled();
	});

	it("changes the Missed label only when a new persisted snapshot carries that reason", () => {
		const original = item();
		const first = onlyRow([original]);
		const updated = item({ state: "NEEDS_REAPPROVAL", stateReason: "missed" });
		expect(onlyRow([updated]).stateLabel).toBe("Missed");
		expect(first.stateLabel).toBe("Scheduled");
		expect(original.state).toBe("SCHEDULED");
	});
});

describe("scheduled selection and account grouping", () => {
	it("includes exactly the records with a persisted notBefore, including epoch zero and terminal states", () => {
		const values = [
			item({ id: id(1), notBefore: null, deliverBy: WHEN }),
			item({ id: id(2), notBefore: 0, deliverBy: null }),
			item({ id: id(3), state: "SENT" }),
			item({ id: id(4), state: "CANCELLED" }),
		];
		const model = buildScheduledViewModel(values, ZONE, RUNNING);
		expect(model.scheduledCount).toBe(3);
		expect(model.visibleCount).toBe(3);
		expect(model.groups[0]?.rows.map((row) => row.outboxId)).toEqual([id(2), id(3), id(4)]);
	});

	it("sorts each account by persisted instant then outbox id with deterministic group order", () => {
		const values = [
			item({ id: id(4), accountId: ACCOUNT_A, notBefore: WHEN + 1000 }),
			item({ id: id(3), accountId: ACCOUNT_B, notBefore: WHEN }),
			item({ id: id(2), accountId: ACCOUNT_A, notBefore: WHEN + 1000 }),
			item({ id: id(1), accountId: ACCOUNT_B, notBefore: WHEN - 1000 }),
		];
		const before = structuredClone(values);
		const model = buildScheduledViewModel(values, ZONE, RUNNING);
		expect(model.groups.map((group) => group.accountId)).toEqual([ACCOUNT_B, ACCOUNT_A]);
		expect(model.groups.map((group) => group.rows.map((row) => row.outboxId))).toEqual([
			[id(1), id(3)],
			[id(2), id(4)],
		]);
		expect(buildScheduledViewModel([...values].reverse(), ZONE, RUNNING)).toEqual(model);
		expect(values).toEqual(before);
	});

	it("filters only the visible account while retaining the total scheduled count", () => {
		const values = [item(), item({ id: id(2), accountId: ACCOUNT_B })];
		const model = buildScheduledViewModel(values, ZONE, RUNNING, ACCOUNT_B);
		expect(model.scheduledCount).toBe(2);
		expect(model.visibleCount).toBe(1);
		expect(model.groups.map((group) => group.accountId)).toEqual([ACCOUNT_B]);
		expect(buildScheduledViewModel(values, ZONE, RUNNING, "").visibleCount).toBe(0);
		expect(buildScheduledViewModel(values, ZONE, RUNNING).visibleCount).toBe(2);
	});

	it("uses an own display alias, falling back to the actual account id", () => {
		const labels = Object.create({ [ACCOUNT_B]: "DYTEST inherited alias" }) as Record<
			string,
			string
		>;
		labels[ACCOUNT_A] = "Personal mailbox";
		const model = buildScheduledViewModel(
			[item(), item({ id: id(2), accountId: ACCOUNT_B })],
			ZONE,
			RUNNING,
			undefined,
			labels,
		);
		expect(model.groups.map((group) => group.label)).toEqual(["Personal mailbox", ACCOUNT_B]);
	});

	it("does not invoke alias accessors or display blank aliases", () => {
		let reads = 0;
		const labels: Record<string, string> = { [ACCOUNT_B]: "  " };
		Object.defineProperty(labels, ACCOUNT_A, {
			enumerable: true,
			get() {
				reads++;
				throw new Error("DYTEST alias getter");
			},
		});
		const model = buildScheduledViewModel(
			[item(), item({ id: id(2), accountId: ACCOUNT_B })],
			ZONE,
			RUNNING,
			undefined,
			labels,
		);
		expect(model.groups.map((group) => group.label)).toEqual([ACCOUNT_A, ACCOUNT_B]);
		expect(reads).toBe(0);
	});

	it("returns immutable display snapshots and identity-only draft selection", () => {
		const value = item();
		const values = Object.freeze([Object.freeze(value)]);
		const model = buildScheduledViewModel(values, ZONE, RUNNING);
		const group = model.groups[0]!;
		const row = group.rows[0]!;
		expect(row.selection).toEqual({ outboxId: value.id, draftId: value.draftId });
		expect(Object.keys(row.selection)).toEqual(["outboxId", "draftId"]);
		for (const snapshot of [
			model,
			model.groups,
			model.warnings,
			group,
			group.rows,
			row,
			row.selection,
			row.notBefore,
			row.deliverBy,
		]) {
			expect(Object.isFrozen(snapshot)).toBe(true);
		}
		expect(row).not.toHaveProperty("contentHash");
		expect(row).not.toHaveProperty("flagsHash");
		expect(row).not.toHaveProperty("proposedBy");
	});
});

describe("honest scheduling display and operating status", () => {
	it("renders the owner's actual zone through the shared renderer and retains the UTC semantic instant", () => {
		expect(nativeTemporal).toBeDefined();
		vi.stubGlobal("Temporal", nativeTemporal);
		const model = buildScheduledViewModel([item()], ZONE, RUNNING);
		expect(model.groups[0]!.rows[0]!.notBefore).toEqual({
			kind: "local",
			text: "2030-04-10T10:00-05:00 (America/Chicago)",
			dateTime: "2030-04-10T15:00:00.000Z",
		});
		expect(model.localTimeUnavailable).toBe(false);
		expect(model.warnings).not.toContain(
			"Local time display is unavailable; valid times are shown in UTC.",
		);
	});

	it.each([
		["2024-03-10T07:59:00.000Z", "2024-03-10T01:59-06:00"],
		["2024-03-10T08:00:00.000Z", "2024-03-10T03:00-05:00"],
		["2024-11-03T06:30:00.000Z", "2024-11-03T01:30-05:00"],
		["2024-11-03T07:30:00.000Z", "2024-11-03T01:30-06:00"],
	])("keeps the real offset at the persisted DST instant %s", (instant, expected) => {
		expect(nativeTemporal).toBeDefined();
		vi.stubGlobal("Temporal", nativeTemporal);
		const row = onlyRow([item({ notBefore: Date.parse(instant), deliverBy: null })]);
		expect(row.notBefore).toEqual({
			kind: "local",
			text: `${expected} (${ZONE})`,
			dateTime: instant,
		});
		expect(row.stateLabel).toBe("Scheduled");
	});

	it("shows an explicit UTC fallback and semantic instant when Temporal is unavailable", () => {
		const model = buildScheduledViewModel([item()], ZONE, RUNNING);
		const row = model.groups[0]!.rows[0]!;
		expect(row.notBefore).toEqual({
			kind: "utc",
			text: "2030-04-10T15:00:00.000Z (UTC)",
			dateTime: "2030-04-10T15:00:00.000Z",
		});
		expect(row.deliverBy.dateTime).toBe("2030-04-10T16:00:00.000Z");
		expect(row.notBefore.text).not.toContain(ZONE);
		expect(model.localTimeUnavailable).toBe(true);
		expect(model.warnings).toContain(
			"Local time display is unavailable; valid times are shown in UTC.",
		);
	});

	it("keeps a missing deadline distinct from an invalid scheduled time", () => {
		const model = buildScheduledViewModel([item({ deliverBy: null })], ZONE, RUNNING);
		expect(model.groups[0]!.rows[0]!.deliverBy).toEqual({
			kind: "unavailable",
			text: "No delivery deadline",
		});
		expect(model.warnings).not.toContain("Some scheduled times could not be displayed.");
	});

	it.each([Number.NaN, Number.POSITIVE_INFINITY, -1, 0.5, Number.MAX_SAFE_INTEGER])(
		"does not fabricate a display instant for invalid input %s",
		(notBefore) => {
			const invalid = { ...item({ deliverBy: null }), notBefore };
			const model = buildScheduledViewModel([invalid], ZONE, RUNNING);
			expect(model.groups[0]!.rows[0]!.notBefore).toEqual({
				kind: "unavailable",
				text: "Time unavailable",
			});
			expect(model.localTimeUnavailable).toBe(true);
			expect(model.warnings).toContain("Some scheduled times could not be displayed.");
			expect(model.warnings).not.toContain(
				"Local time display is unavailable; valid times are shown in UTC.",
			);
		},
	);

	it("does not substitute UTC for an invalid owner zone", () => {
		const model = buildScheduledViewModel([item()], "Bad zone", RUNNING);
		expect(model.groups[0]!.rows[0]!.notBefore).toEqual({
			kind: "unavailable",
			text: "Time unavailable",
		});
		expect(model.groups[0]!.rows[0]!.deliverBy).not.toHaveProperty("dateTime");
		expect(model.warnings).not.toContain(
			"Local time display is unavailable; valid times are shown in UTC.",
		);
	});

	it("reports a syntactically valid but nonexistent zone without inventing a local offset", () => {
		expect(nativeTemporal).toBeDefined();
		vi.stubGlobal("Temporal", nativeTemporal);
		const row = onlyRow([item({ deliverBy: null })], "Mars/Olympus_Mons");
		expect(row.notBefore).toEqual({ kind: "unavailable", text: "Time unavailable" });
	});

	it("does not diagnose local-time failure for an empty display", () => {
		const model = buildScheduledViewModel([], ZONE, RUNNING);
		expect(model.groups).toEqual([]);
		expect(model.scheduledCount).toBe(0);
		expect(model.visibleCount).toBe(0);
		expect(model.localTimeUnavailable).toBe(false);
	});

	it("states awake, hub-running and fresh approval requirements", () => {
		const warnings = buildScheduledViewModel([], ZONE, RUNNING).warnings;
		expect(warnings).toContain(
			"Scheduled sends require the computer to be awake and the hub to be running.",
		);
		expect(warnings).toContain("Changing a scheduled time requires fresh owner approval.");
		expect(warnings).toContain("Service mode still requires the hub service to be running.");
	});

	it("distinguishes sidecar lifetime from scheduler unavailability without changing proposals", () => {
		const status = SchedulingStatus.parse({
			mode: "sidecar",
			scheduler: "unavailable",
			syncPaused: false,
		});
		const model = buildScheduledViewModel([item()], ZONE, status);
		expect(model.warnings).toContain("Sidecar mode requires the app to remain open.");
		expect(model.warnings).toContain(
			"Scheduling is unavailable; scheduled messages cannot be sent until the scheduler is running.",
		);
		expect(model.groups[0]!.rows[0]!.stateLabel).toBe("Scheduled");
	});

	it("explains Pause sync without implying it pauses scheduled sends", () => {
		const paused = SchedulingStatus.parse({ ...RUNNING, syncPaused: true });
		const model = buildScheduledViewModel([item()], ZONE, paused);
		expect(model.warnings).toContain("Sync is paused. This does not pause scheduled sends.");
		expect(model.groups[0]!.rows[0]!.stateLabel).toBe("Scheduled");
		expect(buildScheduledViewModel([item()], ZONE, RUNNING).warnings).not.toContain(
			"Sync is paused. This does not pause scheduled sends.",
		);
	});
});
