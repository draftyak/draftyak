import { runInNewContext } from "node:vm";
import { OutboxItem } from "@draftyak/protocol/entities/outbox";
import { SchedulingStatus } from "@draftyak/protocol/hub-runtime";
import { renderLocalWallTime } from "@draftyak/protocol/schedule";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { type ComponentProps, createElement, type FormEvent } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ScheduledView } from "../src/scheduling/ScheduledView.tsx";

type Props = ComponentProps<typeof ScheduledView>;
const id = (value: number): string => String(value).padStart(26, "0");
const ACCOUNT_A = id(100);
const ACCOUNT_B = id(200);
const NOT_BEFORE = Date.UTC(2030, 0, 15, 17, 45);
const nativeTemporal: unknown =
	Reflect.get(globalThis, "Temporal") ??
	runInNewContext("typeof Temporal === 'undefined' ? undefined : Temporal");
const RUNNING = SchedulingStatus.parse({
	mode: "service",
	scheduler: "running",
	syncPaused: false,
});

function item(sequence: number, overrides: Readonly<Record<string, unknown>> = {}): OutboxItem {
	return OutboxItem.parse({
		id: id(sequence),
		accountId: ACCOUNT_A,
		draftId: id(1000 + sequence),
		rev: 1,
		proposedBy: { kind: "owner", id: id(300) },
		contentHash: "a".repeat(64),
		flagsHash: "b".repeat(64),
		notBefore: NOT_BEFORE,
		deliverBy: NOT_BEFORE + 60_000,
		requiredApprovals: 1,
		createdAt: NOT_BEFORE - 60_000,
		updatedAt: NOT_BEFORE - 60_000,
		state: "SCHEDULED",
		stateReason: null,
		...overrides,
	});
}
function props(overrides: Partial<Props> = {}): Props {
	return { items: [item(1)], ownerZone: "UTC", scheduling: RUNNING, ...overrides };
}
function rowFor(outboxId: string): HTMLElement {
	const row = screen.getByText(outboxId, { exact: true }).closest("tr");
	if (!(row instanceof HTMLElement)) throw new Error("DYTEST expected a scheduled row");
	return row;
}
function rowIds(table: HTMLElement): (string | null)[] {
	return within(table)
		.getAllByRole("row")
		.slice(1)
		.map((row) => within(row).getByRole("rowheader").textContent);
}
function freeze<T>(value: T): T {
	if (value !== null && typeof value === "object") {
		for (const child of Object.values(value)) freeze(child);
		Object.freeze(value);
	}
	return value;
}

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe("scheduled sends snapshot", () => {
	it("groups accounts and orders equal-time proposals by their persisted IDs", () => {
		const items = [
			item(4, { accountId: ACCOUNT_B }),
			item(3, { notBefore: NOT_BEFORE + 60_000 }),
			item(2),
			item(1),
			item(5, { notBefore: null }),
		];
		render(
			createElement(
				ScheduledView,
				props({
					items,
					accountLabels: { [ACCOUNT_A]: "DYTEST Work", [ACCOUNT_B]: "DYTEST Personal" },
				}),
			),
		);
		expect(screen.getByRole("heading", { name: "Scheduled sends", level: 2 })).toBeTruthy();
		const work = screen.getByRole("table", { name: "Scheduled sends for DYTEST Work" });
		const personal = screen.getByRole("table", { name: "Scheduled sends for DYTEST Personal" });
		expect(screen.getAllByRole("table")).toEqual([work, personal]);
		expect(rowIds(work)).toEqual([id(1), id(2), id(3)]);
		expect(rowIds(personal)).toEqual([id(4)]);
		expect(screen.queryByText(id(5), { exact: true })).toBeNull();
	});

	it("filters the actual account snapshot without exposing another account's rows", () => {
		const items = [item(1), item(2, { accountId: ACCOUNT_B })];
		render(createElement(ScheduledView, props({ items, accountId: ACCOUNT_B })));
		expect(screen.queryByText(id(1), { exact: true })).toBeNull();
		expect(rowFor(id(2))).toBeTruthy();
		expect(screen.getAllByRole("table")).toHaveLength(1);
	});

	it("displays the thirteen real persisted states rather than collapsing send outcomes", () => {
		const states = [
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
		] as const;
		const items = states.map(([state], index) =>
			item(index + 1, {
				state,
				stateReason: state === "NEEDS_REAPPROVAL" ? "policy" : null,
			}),
		);
		render(createElement(ScheduledView, props({ items })));
		for (const [index, [, label]] of states.entries()) {
			expect(within(rowFor(id(index + 1))).getByText(label, { exact: true })).toBeTruthy();
		}
	});

	it("shows Missed only for the persisted missed reapproval reason", () => {
		render(
			createElement(
				ScheduledView,
				props({
					items: [
						item(1, { state: "NEEDS_REAPPROVAL", stateReason: "missed" }),
						item(2, { state: "NEEDS_REAPPROVAL", stateReason: "new_reply" }),
					],
				}),
			),
		);
		expect(within(rowFor(id(1))).getByText("Missed", { exact: true })).toBeTruthy();
		expect(within(rowFor(id(1))).getByText("Needs new approval", { exact: true })).toBeTruthy();
		expect(within(rowFor(id(2))).queryByText("Missed", { exact: true })).toBeNull();
		expect(within(rowFor(id(2))).getByText("Needs new approval", { exact: true })).toBeTruthy();
	});

	it("does not invent a Missed or Expired state when only the client clock advances", () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(NOT_BEFORE - 1);
		const snapshot = props();
		const view = render(createElement(ScheduledView, snapshot));
		vi.setSystemTime(NOT_BEFORE + 86_400_000);
		view.rerender(createElement(ScheduledView, snapshot));
		expect(within(rowFor(id(1))).getByText("Scheduled", { exact: true })).toBeTruthy();
		expect(screen.queryByText("Missed", { exact: true })).toBeNull();
		expect(screen.queryByText("Expired", { exact: true })).toBeNull();
	});

	it("uses the shared owner-zone renderer and preserves the machine-readable instant", () => {
		expect(nativeTemporal).toBeDefined();
		vi.stubGlobal("Temporal", nativeTemporal);
		const ownerZone = "America/New_York";
		const expected = `${renderLocalWallTime(NOT_BEFORE, ownerZone)} (${ownerZone})`;
		render(createElement(ScheduledView, props({ ownerZone })));
		const zone = screen.getByText(ownerZone, { selector: "strong", exact: true });
		expect(zone.closest("p")?.textContent).toBe(`Owner time zone: ${ownerZone}`);
		const time = screen.getByText(expected, { exact: true });
		expect(time.tagName).toBe("TIME");
		expect(time.getAttribute("datetime")).toBe(new Date(NOT_BEFORE).toISOString());
	});

	it("falls back honestly to UTC when the shared Temporal API is unavailable", () => {
		vi.stubGlobal("Temporal", undefined);
		const view = render(createElement(ScheduledView, props({ ownerZone: "America/New_York" })));
		const iso = new Date(NOT_BEFORE).toISOString();
		expect(screen.getByText(`${iso} (UTC)`, { exact: true }).getAttribute("datetime")).toBe(iso);
		expect(screen.getByText(/local time is unavailable.*times are shown in UTC/i)).toBeTruthy();
		const times = view.container.querySelectorAll("time");
		expect(times).toHaveLength(2);
		for (const time of times) expect(time.textContent).toMatch(/\(UTC\)$/);
	});

	it("represents a missing delivery deadline without reporting a corrupt time", () => {
		render(createElement(ScheduledView, props({ items: [item(1, { deliverBy: null })] })));
		expect(within(rowFor(id(1))).getByText("No delivery deadline", { exact: true })).toBeTruthy();
		expect(within(rowFor(id(1))).queryByText("Time unavailable", { exact: true })).toBeNull();
	});

	it.each([
		["loading", /loading scheduled sends/i],
		["unavailable", /scheduled sends are unavailable/i],
	] as const)("hides saved rows while the view is %s", (status, message) => {
		const inspect = vi.fn();
		render(createElement(ScheduledView, props({ status, onInspect: inspect })));
		expect(screen.getByText(message)).toBeTruthy();
		expect(screen.queryByRole("table")).toBeNull();
		expect(screen.queryByRole("button")).toBeNull();
		expect(inspect).not.toHaveBeenCalled();
	});

	it("distinguishes an empty snapshot from an account with no scheduled rows", () => {
		const view = render(createElement(ScheduledView, props({ items: [] })));
		expect(screen.getByText("No scheduled sends.", { exact: true })).toBeTruthy();
		view.rerender(createElement(ScheduledView, props({ accountId: ACCOUNT_B })));
		expect(screen.getByText("No scheduled sends for this account.", { exact: true })).toBeTruthy();
		expect(screen.queryByRole("table")).toBeNull();
	});

	it("keeps stale saved data visible with an explicit warning", () => {
		render(createElement(ScheduledView, props({ stale: true })));
		expect(
			screen.getByText("Saved schedule data may be out of date.", { exact: true }),
		).toBeTruthy();
		expect(rowFor(id(1))).toBeTruthy();
		expect(screen.queryByRole("button")).toBeNull();
		expect(screen.queryByRole("columnheader", { name: "Inspect" })).toBeNull();
	});

	it.each([
		["sidecar", /sidecar mode requires the app to remain open/i],
		["service", /service mode still requires the hub service to be running/i],
	] as const)("explains actual %s scheduling limits", (mode, warning) => {
		const scheduling = SchedulingStatus.parse({ ...RUNNING, mode });
		render(createElement(ScheduledView, props({ scheduling })));
		expect(screen.getByText(warning)).toBeTruthy();
		expect(screen.getByText(/computer to be awake and the hub to be running/i)).toBeTruthy();
		expect(
			screen.getByText(/changing a scheduled time requires fresh owner approval/i),
		).toBeTruthy();
	});

	it("explains that Pause sync does not pause scheduled sends and reports scheduler failure", () => {
		const scheduling = SchedulingStatus.parse({
			mode: "service",
			scheduler: "unavailable",
			syncPaused: true,
		});
		render(createElement(ScheduledView, props({ scheduling })));
		expect(screen.getByText(/sync is paused.*does not pause scheduled sends/i)).toBeTruthy();
		expect(
			screen.getByText(/scheduling is unavailable.*until the scheduler is running/i),
		).toBeTruthy();
		expect(within(rowFor(id(1))).getByText("Scheduled", { exact: true })).toBeTruthy();
	});

	it("emits only the selected IDs once without submitting its surrounding form", () => {
		const inspect = vi.fn();
		const submit = vi.fn();
		const selected = item(1);
		render(
			createElement(
				"form",
				{
					onSubmit: (event: FormEvent<HTMLFormElement>) => {
						event.preventDefault();
						submit();
					},
				},
				createElement(ScheduledView, props({ items: [selected], onInspect: inspect })),
			),
		);
		expect(inspect).not.toHaveBeenCalled();
		const button = screen.getByRole("button", { name: "Inspect scheduled send" });
		expect(button.getAttribute("type")).toBe("button");
		fireEvent.click(button, { detail: 1 });
		expect(inspect.mock.calls).toEqual([[{ outboxId: selected.id, draftId: selected.draftId }]]);
		expect(submit).not.toHaveBeenCalled();
	});

	it("provides a focusable native button for keyboard-style activation", () => {
		const inspect = vi.fn();
		const selected = item(1);
		render(createElement(ScheduledView, props({ onInspect: inspect })));
		const button = screen.getByRole("button", { name: "Inspect scheduled send" });
		expect(button.tagName).toBe("BUTTON");
		button.focus();
		expect(document.activeElement).toBe(button);
		expect(inspect).not.toHaveBeenCalled();
		fireEvent.click(button, { detail: 0 });
		expect(inspect.mock.calls).toEqual([[{ outboxId: selected.id, draftId: selected.draftId }]]);
	});

	it("escapes hostile account aliases and does not render private snapshot hashes", () => {
		const hostile = "DYTEST <img src=x onerror=alert(1)> <script>throw 1</script>";
		const selected = item(1);
		const view = render(
			createElement(
				ScheduledView,
				props({
					items: [selected],
					accountLabels: { [ACCOUNT_A]: hostile },
				}),
			),
		);
		expect(screen.getByRole("heading", { name: hostile, level: 3 })).toBeTruthy();
		expect(view.container.textContent).toContain(hostile);
		expect(view.container.querySelectorAll("img,script")).toHaveLength(0);
		expect(view.container.innerHTML).not.toContain(selected.contentHash);
		expect(view.container.innerHTML).not.toContain(selected.flagsHash);
	});

	it("keeps accessible identifiers unique when two scheduled views are mounted", () => {
		const view = render(
			createElement(
				"div",
				null,
				createElement(ScheduledView, props()),
				createElement(ScheduledView, props({ accountLabels: { [ACCOUNT_A]: "DYTEST Other" } })),
			),
		);
		expect(screen.getAllByRole("region", { name: "Scheduled sends" })).toHaveLength(2);
		const ids = Array.from(view.container.querySelectorAll("[id]"), (element) => element.id);
		expect(ids.length).toBeGreaterThan(0);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it("updates only from a new snapshot and leaves deeply frozen input data untouched", () => {
		const inspect = vi.fn();
		const first = freeze(
			props({
				items: [item(3, { notBefore: NOT_BEFORE + 60_000 }), item(1)],
				onInspect: inspect,
			}),
		);
		const second = freeze(
			props({
				items: [item(2, { state: "NEEDS_REAPPROVAL", stateReason: "missed" })],
				accountLabels: { [ACCOUNT_A]: "DYTEST New snapshot" },
				onInspect: inspect,
			}),
		);
		const beforeFirst = JSON.stringify(first);
		const beforeSecond = JSON.stringify(second);
		const view = render(createElement(ScheduledView, first));
		expect(rowFor(id(1))).toBeTruthy();
		view.rerender(createElement(ScheduledView, second));
		expect(screen.queryByText(id(1), { exact: true })).toBeNull();
		expect(screen.queryByText(id(3), { exact: true })).toBeNull();
		expect(within(rowFor(id(2))).getByText("Missed", { exact: true })).toBeTruthy();
		expect(screen.getByRole("heading", { name: "DYTEST New snapshot", level: 3 })).toBeTruthy();
		expect(inspect).not.toHaveBeenCalled();
		expect(JSON.stringify(first)).toBe(beforeFirst);
		expect(JSON.stringify(second)).toBe(beforeSecond);
	});
});
