import * as schedule from "@draftyak/protocol/schedule";
import { renderLocalWallTime, resolveLocalTime } from "@draftyak/protocol/schedule";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement, type FormEvent } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	ScheduleTimeField,
	type ScheduleTimeSelection,
} from "../src/scheduling/ScheduleTimeField.tsx";

const LABEL = "Local date and time";
const ACTION = "Use this time";
const WALL = "2026-01-15T09:15";
const ZONE = "America/New_York";
const INSTANT = 1_768_486_500_000;
const DISPLAY = "2026-01-15T09:15-05:00";
const ERROR_TEXT = {
	INVALID_INPUT: "Enter a valid local date and time in the owner time zone.",
	NONEXISTENT_LOCAL_TIME: "This local time does not exist in the owner time zone.",
	AMBIGUOUS_LOCAL_TIME: "This local time occurs twice. Choose a different time.",
	SCHEDULING_UNAVAILABLE: "Scheduling is unavailable in this browser.",
} as const;

const view = (
	ownerZone: string,
	onSelect: (selection: ScheduleTimeSelection) => void,
	disabled = false,
) => createElement(ScheduleTimeField, { ownerZone, onSelect, disabled });

function input(): HTMLInputElement {
	const element = screen.getByLabelText(LABEL);
	if (!(element instanceof HTMLInputElement)) throw new Error("Expected the local time input");
	return element;
}
function button(): HTMLButtonElement {
	const element = screen.getByRole("button", { name: ACTION });
	if (!(element instanceof HTMLButtonElement))
		throw new Error("Expected the time selection button");
	return element;
}
function edit(wall: string): void {
	fireEvent.change(input(), { target: { value: wall } });
}
function commit(): void {
	fireEvent.click(button());
}
function expectError(code: keyof typeof ERROR_TEXT): void {
	const alert = screen.getByRole("alert");
	expect(alert.getAttribute("data-error-code")).toBe(code);
	expect(alert.textContent).toBe(ERROR_TEXT[code]);
	expect(screen.queryByLabelText("Selected local time")).toBeNull();
}

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe("ScheduleTimeField", () => {
	it("offers an associated owner-zone minute field and an explicit selection action", () => {
		const selected = vi.fn<(selection: ScheduleTimeSelection) => void>();
		render(view(ZONE, selected));
		expect(input().type).toBe("datetime-local");
		expect(input().step).toBe("60");
		expect(input().required).toBe(true);
		expect(input().id).not.toBe("");
		expect(input().value).toBe("");
		expect(button().type).toBe("button");
		expect(button().tabIndex).toBe(0);
		expect(screen.getByText(/Owner time zone:/).textContent).toContain(ZONE);
		expect(screen.queryByRole("alert")).toBeNull();
		expect(selected).not.toHaveBeenCalled();
	});

	// Literal values are retained public protocol schedule vectors, not Date arithmetic.
	it.each([
		[WALL, ZONE, INSTANT, DISPLAY],
		["2026-07-15T09:15", "Europe/London", 1_784_103_300_000, "2026-07-15T09:15+01:00"],
		["2026-07-15T09:15", "Australia/Lord_Howe", 1_784_069_100_000, "2026-07-15T09:15+10:30"],
		["2028-02-29T00:00", "UTC", 1_835_395_200_000, "2028-02-29T00:00+00:00"],
		["9999-12-30T22:00", "UTC", 253_402_207_200_000, "9999-12-30T22:00+00:00"],
	] as const)("selects the canonical minute %s in %s", (wall, zone, instant, display) => {
		const selected = vi.fn<(selection: ScheduleTimeSelection) => void>();
		render(view(zone, selected));
		edit(wall);
		expect(selected).not.toHaveBeenCalled();
		commit();
		expect(selected).toHaveBeenCalledExactlyOnceWith({
			notBefore: instant,
			zone,
			localWallTime: display,
		});
		expect(screen.getByLabelText("Selected local time").textContent).toBe(display);
		expect(screen.queryByRole("alert")).toBeNull();
	});

	it("delegates selection and display to the genuine canonical helpers", () => {
		const resolve = vi.spyOn(schedule, "resolveLocalTime");
		const display = vi.spyOn(schedule, "renderLocalWallTime");
		const selected = vi.fn<(selection: ScheduleTimeSelection) => void>();
		render(view(ZONE, selected));
		edit(WALL);
		commit();
		expect(resolve).toHaveBeenCalledWith(WALL, ZONE);
		expect(display).toHaveBeenCalledWith(INSTANT, ZONE);
		expect(selected).toHaveBeenCalledExactlyOnceWith({
			notBefore: INSTANT,
			zone: ZONE,
			localWallTime: DISPLAY,
		});
	});

	it.each([
		["2026-03-08T02:30", "America/New_York", "NONEXISTENT_LOCAL_TIME"],
		["2026-11-01T01:30", "America/New_York", "AMBIGUOUS_LOCAL_TIME"],
		["2026-03-29T01:30", "Europe/London", "NONEXISTENT_LOCAL_TIME"],
		["2026-10-25T01:30", "Europe/London", "AMBIGUOUS_LOCAL_TIME"],
		["2026-10-04T02:15", "Australia/Lord_Howe", "NONEXISTENT_LOCAL_TIME"],
		["2026-04-05T01:45", "Australia/Lord_Howe", "AMBIGUOUS_LOCAL_TIME"],
	] as const)("refuses %s in %s without silently choosing an instant", (wall, zone, code) => {
		const selected = vi.fn<(selection: ScheduleTimeSelection) => void>();
		render(view(zone, selected));
		edit(wall);
		commit();
		expectError(code);
		expect(selected).not.toHaveBeenCalled();
	});

	it.each([
		"",
		"2026-02-29T12:00",
		"2026-13-01T12:00",
		"2026-01-01T12:00:01",
		"1969-12-31T23:59",
		"9999-12-30T22:01",
	])("refuses an invalid or out-of-range local value %s", (wall) => {
		const selected = vi.fn<(selection: ScheduleTimeSelection) => void>();
		render(view("UTC", selected));
		edit(WALL);
		edit(wall);
		commit();
		expectError("INVALID_INPUT");
		expect(selected).not.toHaveBeenCalled();
	});

	it.each(["Invalid/Example", "+01:00", "Etc/Unknown", "Factory"])(
		"refuses the owner zone %s rather than using the machine zone",
		(zone) => {
			const selected = vi.fn<(selection: ScheduleTimeSelection) => void>();
			render(view(zone, selected));
			edit(WALL);
			commit();
			expectError("INVALID_INPUT");
			expect(selected).not.toHaveBeenCalled();
		},
	);

	it("refuses an untouched empty value on explicit selection", () => {
		const selected = vi.fn<(selection: ScheduleTimeSelection) => void>();
		render(view(ZONE, selected));
		commit();
		expectError("INVALID_INPUT");
		expect(selected).not.toHaveBeenCalled();
	});

	it("does not select automatically on editing, rerendering, elapsed time or unrelated keys", async () => {
		vi.useFakeTimers();
		const selected = vi.fn<(selection: ScheduleTimeSelection) => void>();
		const rendered = render(view(ZONE, selected));
		edit(WALL);
		fireEvent.keyDown(input(), { key: "Escape" });
		rendered.rerender(view(ZONE, selected));
		await act(async () => {
			vi.advanceTimersByTime(86_400_000);
			await Promise.resolve();
		});
		expect(selected).not.toHaveBeenCalled();
		expect(screen.queryByLabelText("Selected local time")).toBeNull();
		commit();
		expect(selected).toHaveBeenCalledTimes(1);
	});

	it("does not fetch or persist a selection and emits only the three data fields", () => {
		const fetch = vi.fn(() => {
			throw new Error("Unexpected network request");
		});
		vi.stubGlobal("fetch", fetch);
		const get = vi.spyOn(Storage.prototype, "getItem");
		const set = vi.spyOn(Storage.prototype, "setItem");
		const remove = vi.spyOn(Storage.prototype, "removeItem");
		const selected = vi.fn<(selection: ScheduleTimeSelection) => void>();
		const { container } = render(view(ZONE, selected));
		edit(WALL);
		commit();
		const selection = selected.mock.calls[0]?.[0];
		expect(selection).toBeDefined();
		if (!selection) throw new Error("Expected a selected time");
		expect(Object.keys(selection).sort()).toEqual(["localWallTime", "notBefore", "zone"]);
		expect(fetch).not.toHaveBeenCalled();
		expect(get).not.toHaveBeenCalled();
		expect(set).not.toHaveBeenCalled();
		expect(remove).not.toHaveBeenCalled();
		expect(container.querySelector("a,form")).toBeNull();
		expect(screen.getAllByRole("button")).toHaveLength(1);
	});

	it("drops a successful result when edited and cannot commit the old instant", () => {
		const selected = vi.fn<(selection: ScheduleTimeSelection) => void>();
		render(view(ZONE, selected));
		edit(WALL);
		commit();
		edit("2026-03-08T02:30");
		expect(screen.queryByLabelText("Selected local time")).toBeNull();
		commit();
		expectError("NONEXISTENT_LOCAL_TIME");
		expect(selected).toHaveBeenCalledTimes(1);
		edit("2026-03-08T03:00");
		commit();
		expect(selected).toHaveBeenLastCalledWith({
			notBefore: 1_772_953_200_000,
			zone: ZONE,
			localWallTime: "2026-03-08T03:00-04:00",
		});
	});

	it("clears stale errors after a corrected explicit selection", () => {
		const selected = vi.fn<(selection: ScheduleTimeSelection) => void>();
		render(view(ZONE, selected));
		edit("2026-11-01T01:30");
		commit();
		expectError("AMBIGUOUS_LOCAL_TIME");
		edit(WALL);
		commit();
		expect(screen.queryByRole("alert")).toBeNull();
		expect(selected).toHaveBeenCalledExactlyOnceWith({
			notBefore: INSTANT,
			zone: ZONE,
			localWallTime: DISPLAY,
		});
	});

	it("requires new entry after an owner-zone change instead of reinterpreting stale input", () => {
		const selected = vi.fn<(selection: ScheduleTimeSelection) => void>();
		const rendered = render(view(ZONE, selected));
		edit(WALL);
		commit();
		rendered.rerender(view("Europe/London", selected));
		expect(input().value).toBe("");
		expect(screen.queryByRole("alert")).toBeNull();
		expect(screen.queryByLabelText("Selected local time")).toBeNull();
		expect(selected).toHaveBeenCalledTimes(1);
		commit();
		expectError("INVALID_INPUT");
		expect(selected).toHaveBeenCalledTimes(1);
		edit(WALL);
		commit();
		const expected = resolveLocalTime(WALL, "Europe/London");
		expect(expected).not.toBe(INSTANT);
		expect(selected).toHaveBeenLastCalledWith({
			notBefore: expected,
			zone: "Europe/London",
			localWallTime: renderLocalWallTime(expected, "Europe/London"),
		});
	});

	it("does not resurrect an earlier draft when the zone changes away and back", () => {
		const selected = vi.fn<(selection: ScheduleTimeSelection) => void>();
		const rendered = render(view(ZONE, selected));
		edit(WALL);
		commit();
		rendered.rerender(view("Europe/London", selected));
		rendered.rerender(view(ZONE, selected));
		expect(input().value).toBe("");
		expect(screen.queryByLabelText("Selected local time")).toBeNull();
		expect(selected).toHaveBeenCalledTimes(1);
		commit();
		expectError("INVALID_INPUT");
		expect(selected).toHaveBeenCalledTimes(1);
	});

	it("cannot reuse a successful selection after the owner zone becomes invalid", () => {
		const selected = vi.fn<(selection: ScheduleTimeSelection) => void>();
		const rendered = render(view(ZONE, selected));
		edit(WALL);
		commit();
		rendered.rerender(view("Invalid/Example", selected));
		commit();
		expectError("INVALID_INPUT");
		expect(selected).toHaveBeenCalledTimes(1);
	});

	it("uses the current callback after a prop update without selecting during the update", () => {
		const oldSelect = vi.fn<(selection: ScheduleTimeSelection) => void>();
		const newSelect = vi.fn<(selection: ScheduleTimeSelection) => void>();
		const rendered = render(view(ZONE, oldSelect));
		edit(WALL);
		rendered.rerender(view(ZONE, newSelect));
		expect(oldSelect).not.toHaveBeenCalled();
		expect(newSelect).not.toHaveBeenCalled();
		commit();
		expect(oldSelect).not.toHaveBeenCalled();
		expect(newSelect).toHaveBeenCalledExactlyOnceWith({
			notBefore: INSTANT,
			zone: ZONE,
			localWallTime: DISPLAY,
		});
	});

	it("returns a fresh frozen value for each explicit selection", () => {
		const selected = vi.fn<(selection: ScheduleTimeSelection) => void>();
		render(view(ZONE, selected));
		edit(WALL);
		commit();
		commit();
		const first = selected.mock.calls[0]?.[0];
		const second = selected.mock.calls[1]?.[0];
		expect(first).toEqual(second);
		expect(first).not.toBe(second);
		expect(Object.isFrozen(first)).toBe(true);
		expect(Object.isFrozen(second)).toBe(true);
	});

	it("supports Enter on the labeled input without submitting an enclosing form", () => {
		const selected = vi.fn<(selection: ScheduleTimeSelection) => void>();
		const submit = vi.fn((event: FormEvent) => event.preventDefault());
		render(createElement("form", { onSubmit: submit }, view(ZONE, selected)));
		edit(WALL);
		input().focus();
		expect(document.activeElement).toBe(input());
		expect(fireEvent.keyDown(input(), { key: "Enter", code: "Enter" })).toBe(false);
		expect(selected).toHaveBeenCalledTimes(1);
		expect(submit).not.toHaveBeenCalled();
	});

	it("blocks both pointer and keyboard selection while disabled and does not auto-select on enable", () => {
		const selected = vi.fn<(selection: ScheduleTimeSelection) => void>();
		const rendered = render(view(ZONE, selected));
		edit(WALL);
		rendered.rerender(view(ZONE, selected, true));
		expect(input().disabled).toBe(true);
		expect(button().disabled).toBe(true);
		commit();
		fireEvent.keyDown(input(), { key: "Enter", code: "Enter" });
		expect(selected).not.toHaveBeenCalled();
		rendered.rerender(view(ZONE, selected, false));
		expect(selected).not.toHaveBeenCalled();
		commit();
		expect(selected).toHaveBeenCalledTimes(1);
	});

	it("reports missing Temporal without enabling an approximate fallback", () => {
		vi.stubGlobal("Temporal", undefined);
		const selected = vi.fn<(selection: ScheduleTimeSelection) => void>();
		render(view(ZONE, selected));
		expect(input().disabled).toBe(true);
		expect(button().disabled).toBe(true);
		expectError("SCHEDULING_UNAVAILABLE");
		fireEvent.keyDown(input(), { key: "Enter", code: "Enter" });
		commit();
		expect(selected).not.toHaveBeenCalled();
	});

	it("rechecks actual Temporal availability at commit instead of reusing an earlier candidate", () => {
		const selected = vi.fn<(selection: ScheduleTimeSelection) => void>();
		render(view(ZONE, selected));
		edit(WALL);
		vi.stubGlobal("Temporal", undefined);
		commit();
		expectError("SCHEDULING_UNAVAILABLE");
		expect(selected).not.toHaveBeenCalled();
	});

	it("treats a hostile owner-zone string as text and fixed invalid input", () => {
		const selected = vi.fn<(selection: ScheduleTimeSelection) => void>();
		const hostile = '<img src=x onerror="globalThis.compromised=true"><a href="javascript:1">x</a>';
		const { container } = render(view(hostile, selected));
		expect(container.querySelector("img,script,a")).toBeNull();
		commit();
		expectError("INVALID_INPUT");
		expect(selected).not.toHaveBeenCalled();
	});

	it("keeps labels associated with distinct inputs when two fields are mounted", () => {
		const selected = vi.fn<(selection: ScheduleTimeSelection) => void>();
		render(createElement("div", null, view("UTC", selected), view(ZONE, selected)));
		const fields = screen.getAllByLabelText(LABEL);
		expect(fields).toHaveLength(2);
		const ids = fields.map((field) => field.id);
		expect(ids.every((id) => id.length > 0)).toBe(true);
		expect(new Set(ids).size).toBe(2);
	});
});
