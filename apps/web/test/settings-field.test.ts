import { OwnerSettings, Weekday } from "@draftyak/protocol/entities/settings";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement, type FormEvent } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type OwnerSettingsEdit, OwnerSettingsField } from "../src/settings/OwnerSettingsField.tsx";

const ACTION = "Use these settings";
const ZONE_LABEL = "Owner time zone";
const START_LABEL = "Working hours start";
const END_LABEL = "Working hours end";
const ERRORS = {
	INVALID_VALUE: "Settings are unavailable.",
	INVALID_DRAFT: "Enter valid owner settings.",
	EDIT_FAILED: "Settings could not be returned.",
} as const;
const DAY_LABELS = {
	mon: "Monday",
	tue: "Tuesday",
	wed: "Wednesday",
	thu: "Thursday",
	fri: "Friday",
	sat: "Saturday",
	sun: "Sunday",
} as const;

function example(): OwnerSettings {
	return OwnerSettings.parse({
		zone: "America/Chicago",
		workingHours: { days: ["mon", "tue", "wed", "thu", "fri"], start: "09:00", end: "17:00" },
	});
}
function alternate(): OwnerSettings {
	return OwnerSettings.parse({
		zone: "Etc/GMT+5",
		workingHours: { days: ["sat", "sun"], start: "13:07", end: "24:00" },
	});
}
const view = (value: unknown, onEdit: (edit: OwnerSettingsEdit) => void, disabled = false) =>
	createElement(OwnerSettingsField, { value, onEdit, disabled });

function field(label: string): HTMLInputElement {
	const element = screen.getByLabelText(label);
	if (!(element instanceof HTMLInputElement)) throw new Error("Expected a settings input");
	return element;
}
function button(): HTMLButtonElement {
	const element = screen.getByRole("button", { name: ACTION });
	if (!(element instanceof HTMLButtonElement)) throw new Error("Expected the local edit action");
	return element;
}
function change(label: string, value: string): void {
	fireEvent.change(field(label), { target: { value } });
}
function day(code: keyof typeof DAY_LABELS): HTMLInputElement {
	const element = screen.getByRole("checkbox", { name: DAY_LABELS[code] });
	if (!(element instanceof HTMLInputElement)) throw new Error("Expected a working-day checkbox");
	return element;
}
function commit(): void {
	fireEvent.click(button());
}
function expectError(code: keyof typeof ERRORS): void {
	const alert = screen.getByRole("alert");
	expect(alert.getAttribute("data-error-code")).toBe(code);
	expect(alert.textContent).toBe(ERRORS[code]);
}
function expectLoaded(value: OwnerSettings): void {
	expect(field(ZONE_LABEL).value).toBe(value.zone);
	expect(field(START_LABEL).value).toBe(value.workingHours.start);
	expect(field(END_LABEL).value).toBe(value.workingHours.end);
	for (const code of Weekday.options)
		expect(day(code).checked).toBe(value.workingHours.days.includes(code));
}

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe("OwnerSettingsField", () => {
	it("renders the supplied non-default values without editing or inventing settings", () => {
		const value = alternate();
		const edited = vi.fn<(edit: OwnerSettingsEdit) => void>();
		render(view(value, edited));
		expectLoaded(value);
		expect(field(END_LABEL).type).toBe("text");
		expect(screen.getByRole("group", { name: "Working days" })).toBeDefined();
		expect(screen.getAllByRole("checkbox")).toHaveLength(7);
		expect(button().type).toBe("button");
		expect(screen.queryByRole("alert")).toBeNull();
		expect(edited).not.toHaveBeenCalled();
	});

	it.each([
		{ zone: "UTC", workingHours: { days: [...Weekday.options], start: "00:00", end: "24:00" } },
		{ zone: "Etc/GMT+5", workingHours: { days: ["sun"], start: "13:07", end: "24:00" } },
		{ zone: "EST5EDT", workingHours: { days: ["mon"], start: "23:59", end: "24:00" } },
	])("roundtrips canonical working-hour boundaries in $zone", (value) => {
		expect(OwnerSettings.safeParse(value).success).toBe(true);
		const edited = vi.fn<(edit: OwnerSettingsEdit) => void>();
		render(view(value, edited));
		expectLoaded(OwnerSettings.parse(value));
		commit();
		expect(edited).toHaveBeenCalledExactlyOnceWith(value);
		expect(OwnerSettings.safeParse(edited.mock.calls[0]?.[0]).success).toBe(true);
	});

	it("returns the explicitly edited canonical zone, days and hours only on action", () => {
		const value = example();
		const before = JSON.stringify(value);
		const edited = vi.fn<(edit: OwnerSettingsEdit) => void>();
		render(view(value, edited));
		change(ZONE_LABEL, "Europe/London");
		change(START_LABEL, "08:30");
		change(END_LABEL, "16:45");
		fireEvent.click(day("mon"));
		fireEvent.click(day("wed"));
		fireEvent.click(day("fri"));
		expect(edited).not.toHaveBeenCalled();
		commit();
		const expected = {
			zone: "Europe/London",
			workingHours: { days: ["tue", "thu"], start: "08:30", end: "16:45" },
		};
		expect(edited).toHaveBeenCalledExactlyOnceWith(expected);
		expect(OwnerSettings.safeParse(edited.mock.calls[0]?.[0]).success).toBe(true);
		expect(JSON.stringify(value)).toBe(before);
	});

	it("validates edits through the real canonical OwnerSettings schema", () => {
		const parse = vi.spyOn(OwnerSettings, "safeParse");
		const edited = vi.fn<(edit: OwnerSettingsEdit) => void>();
		render(view(example(), edited));
		change(END_LABEL, "24:00");
		parse.mockClear();
		commit();
		expect(parse).toHaveBeenCalledWith({
			zone: "America/Chicago",
			workingHours: { days: ["mon", "tue", "wed", "thu", "fri"], start: "09:00", end: "24:00" },
		});
		expect(edited).toHaveBeenCalledExactlyOnceWith({
			zone: "America/Chicago",
			workingHours: { days: ["mon", "tue", "wed", "thu", "fri"], start: "09:00", end: "24:00" },
		});
	});

	const invalidValues: ReadonlyArray<readonly [string, unknown]> = [
		["null", null],
		["undefined", undefined],
		["a scalar", 7],
		["text", "SETTINGS_VALUE_CANARY"],
		["an array", []],
		["missing members", {}],
		["an extra owner member", { ...example(), admin: true }],
		[
			"an extra hours member",
			{ ...example(), workingHours: { ...example().workingHours, extra: true } },
		],
		["no working days", { ...example(), workingHours: { days: [], start: "09:00", end: "17:00" } }],
		[
			"duplicate days",
			{ ...example(), workingHours: { days: ["mon", "mon"], start: "09:00", end: "17:00" } },
		],
		[
			"an unknown day",
			{ ...example(), workingHours: { days: ["monday"], start: "09:00", end: "17:00" } },
		],
		[
			"a 24:00 start",
			{ ...example(), workingHours: { days: ["mon"], start: "24:00", end: "24:00" } },
		],
		[
			"an end after 24:00",
			{ ...example(), workingHours: { days: ["mon"], start: "09:00", end: "24:01" } },
		],
		["an invalid zone grammar", { ...example(), zone: "+01:00" }],
		[
			"reversed hours",
			{ ...example(), workingHours: { days: ["mon"], start: "17:00", end: "09:00" } },
		],
	];
	it.each(invalidValues)(
		"refuses loaded %s with no fabricated editable defaults",
		(_name, value) => {
			expect(OwnerSettings.safeParse(value).success).toBe(false);
			const edited = vi.fn<(edit: OwnerSettingsEdit) => void>();
			render(view(value, edited));
			expectError("INVALID_VALUE");
			expect(screen.queryByLabelText(ZONE_LABEL)).toBeNull();
			expect(screen.queryByLabelText(START_LABEL)).toBeNull();
			expect(screen.queryByLabelText(END_LABEL)).toBeNull();
			expect(screen.queryByRole("checkbox")).toBeNull();
			expect(button().disabled).toBe(true);
			commit();
			expect(edited).not.toHaveBeenCalled();
		},
	);

	it.each([
		[START_LABEL, "24:00"],
		[START_LABEL, "9:00"],
		[START_LABEL, "09:00:01"],
		[END_LABEL, "24:01"],
		[END_LABEL, "09:00"],
		[END_LABEL, "08:59"],
	])("refuses draft %s=%s as minute grammar or start/end ordering", (label, value) => {
		const edited = vi.fn<(edit: OwnerSettingsEdit) => void>();
		render(view(example(), edited));
		change(label, value);
		commit();
		expectError("INVALID_DRAFT");
		expect(edited).not.toHaveBeenCalled();
	});

	it.each(["", "+01:00", "America Chicago", "A".repeat(65)])(
		"refuses the draft zone %s using canonical grammar rather than date arithmetic",
		(value) => {
			const edited = vi.fn<(edit: OwnerSettingsEdit) => void>();
			render(view(example(), edited));
			change(ZONE_LABEL, value);
			commit();
			expectError("INVALID_DRAFT");
			expect(edited).not.toHaveBeenCalled();
		},
	);

	it("refuses an empty working-day selection without restoring default weekdays", () => {
		const edited = vi.fn<(edit: OwnerSettingsEdit) => void>();
		render(view(example(), edited));
		for (const code of example().workingHours.days) fireEvent.click(day(code));
		commit();
		expectError("INVALID_DRAFT");
		expect(screen.getAllByRole("checkbox").every((el) => !(el as HTMLInputElement).checked)).toBe(
			true,
		);
		expect(edited).not.toHaveBeenCalled();
	});

	it("sanitizes a synchronous callback exception and can return a corrected edit", () => {
		const edited = vi.fn<(edit: OwnerSettingsEdit) => void>().mockImplementationOnce(() => {
			throw new Error("SETTINGS_CALLBACK_CANARY");
		});
		const { container } = render(view(example(), edited));
		commit();
		expectError("EDIT_FAILED");
		expect(container.textContent).not.toContain("SETTINGS_CALLBACK_CANARY");
		change(START_LABEL, "10:00");
		expect(screen.queryByRole("alert")).toBeNull();
		commit();
		expect(edited).toHaveBeenCalledTimes(2);
		expect(edited).toHaveBeenLastCalledWith({
			zone: "America/Chicago",
			workingHours: { days: ["mon", "tue", "wed", "thu", "fri"], start: "10:00", end: "17:00" },
		});
		expect(screen.queryByRole("alert")).toBeNull();
	});

	it("clears an invalid-draft error when a different valid loaded value arrives", () => {
		const edited = vi.fn<(edit: OwnerSettingsEdit) => void>();
		const rendered = render(view(example(), edited));
		change(ZONE_LABEL, "");
		commit();
		expectError("INVALID_DRAFT");
		rendered.rerender(view(alternate(), edited));
		expectLoaded(alternate());
		expect(screen.queryByRole("alert")).toBeNull();
		expect(edited).not.toHaveBeenCalled();
	});

	it("returns fresh deeply frozen payloads without mutating deeply frozen loaded data", () => {
		const mutable = example();
		const value = Object.freeze({
			zone: mutable.zone,
			workingHours: Object.freeze({
				days: Object.freeze([...mutable.workingHours.days]),
				start: mutable.workingHours.start,
				end: mutable.workingHours.end,
			}),
		});
		const before = JSON.stringify(value);
		const edited = vi.fn<(edit: OwnerSettingsEdit) => void>();
		render(view(value, edited));
		commit();
		commit();
		const first = edited.mock.calls[0]?.[0];
		const second = edited.mock.calls[1]?.[0];
		expect(first).toEqual(value);
		expect(second).toEqual(value);
		if (!first || !second) throw new Error("Expected explicit edits");
		expect(first).not.toBe(second);
		expect(first.workingHours).not.toBe(second.workingHours);
		expect(first.workingHours.days).not.toBe(second.workingHours.days);
		expect(first).not.toBe(value);
		expect(first.workingHours).not.toBe(value.workingHours);
		expect(first.workingHours.days).not.toBe(value.workingHours.days);
		for (const edit of [first, second]) {
			expect(Object.keys(edit).sort()).toEqual(["workingHours", "zone"]);
			expect(Object.keys(edit.workingHours).sort()).toEqual(["days", "end", "start"]);
			expect(Object.isFrozen(edit)).toBe(true);
			expect(Object.isFrozen(edit.workingHours)).toBe(true);
			expect(Object.isFrozen(edit.workingHours.days)).toBe(true);
			expect(OwnerSettings.safeParse(edit).success).toBe(true);
		}
		expect(JSON.stringify(value)).toBe(before);
	});

	it("blocks edit emission while disabled after both a prior edit and a valid draft", () => {
		const edited = vi.fn<(edit: OwnerSettingsEdit) => void>();
		const value = example();
		const rendered = render(view(value, edited));
		commit();
		change(START_LABEL, "10:00");
		rendered.rerender(view(value, edited, true));
		for (const label of [ZONE_LABEL, START_LABEL, END_LABEL])
			expect(field(label).matches(":disabled")).toBe(true);
		for (const el of screen.getAllByRole("checkbox")) expect(el.matches(":disabled")).toBe(true);
		expect(button().disabled).toBe(true);
		commit();
		fireEvent.keyDown(field(START_LABEL), { key: "Enter", code: "Enter" });
		expect(edited).toHaveBeenCalledTimes(1);
		rendered.rerender(view(value, edited, false));
		expect(edited).toHaveBeenCalledTimes(1);
		commit();
		expect(edited).toHaveBeenCalledTimes(2);
		expect(edited.mock.calls[1]?.[0].workingHours.start).toBe("10:00");
	});

	it("uses the latest callback without invoking either callback on a prop change", () => {
		const oldEdit = vi.fn<(edit: OwnerSettingsEdit) => void>();
		const newEdit = vi.fn<(edit: OwnerSettingsEdit) => void>();
		const value = example();
		const rendered = render(view(value, oldEdit));
		change(START_LABEL, "10:00");
		rendered.rerender(view(value, newEdit));
		expect(oldEdit).not.toHaveBeenCalled();
		expect(newEdit).not.toHaveBeenCalled();
		commit();
		expect(oldEdit).not.toHaveBeenCalled();
		expect(newEdit).toHaveBeenCalledTimes(1);
		expect(newEdit.mock.calls[0]?.[0].workingHours.start).toBe("10:00");
	});

	it("preserves a local draft across an identical canonical value clone", () => {
		const edited = vi.fn<(edit: OwnerSettingsEdit) => void>();
		const value = example();
		const rendered = render(view(value, edited));
		change(ZONE_LABEL, "Europe/London");
		change(START_LABEL, "08:30");
		rendered.rerender(view(OwnerSettings.parse(value), edited));
		expect(field(ZONE_LABEL).value).toBe("Europe/London");
		expect(field(START_LABEL).value).toBe("08:30");
		expect(edited).not.toHaveBeenCalled();
		commit();
		expect(edited.mock.calls[0]?.[0].zone).toBe("Europe/London");
	});

	it("does not resurrect an earlier draft when loaded data changes A to B to A", () => {
		const edited = vi.fn<(edit: OwnerSettingsEdit) => void>();
		const value = example();
		const rendered = render(view(value, edited));
		change(ZONE_LABEL, "UTC");
		change(START_LABEL, "10:00");
		commit();
		rendered.rerender(view(alternate(), edited));
		expectLoaded(alternate());
		rendered.rerender(view(value, edited));
		expectLoaded(value);
		expect(edited).toHaveBeenCalledTimes(1);
		commit();
		expect(edited).toHaveBeenLastCalledWith(value);
	});

	it("cannot emit stale valid settings after loaded data becomes invalid", () => {
		const edited = vi.fn<(edit: OwnerSettingsEdit) => void>();
		const rendered = render(view(example(), edited));
		change(START_LABEL, "10:00");
		commit();
		rendered.rerender(view(undefined, edited));
		expectError("INVALID_VALUE");
		expect(screen.queryByLabelText(START_LABEL)).toBeNull();
		commit();
		expect(edited).toHaveBeenCalledTimes(1);
		rendered.rerender(view(alternate(), edited));
		expectLoaded(alternate());
		expect(screen.queryByRole("alert")).toBeNull();
		expect(edited).toHaveBeenCalledTimes(1);
	});

	it("supports focused Enter without submitting an enclosing form", () => {
		const edited = vi.fn<(edit: OwnerSettingsEdit) => void>();
		const submit = vi.fn((event: FormEvent) => event.preventDefault());
		render(createElement("form", { onSubmit: submit }, view(example(), edited)));
		field(START_LABEL).focus();
		expect(document.activeElement).toBe(field(START_LABEL));
		expect(fireEvent.keyDown(field(START_LABEL), { key: "Enter", code: "Enter" })).toBe(false);
		expect(edited).toHaveBeenCalledTimes(1);
		expect(submit).not.toHaveBeenCalled();
	});

	it("does not treat a composing Enter as an explicit completed edit", () => {
		const edited = vi.fn<(edit: OwnerSettingsEdit) => void>();
		render(view(example(), edited));
		fireEvent.keyDown(field(START_LABEL), { key: "Enter", code: "Enter", isComposing: true });
		expect(edited).not.toHaveBeenCalled();
	});

	it("does not emit, fetch or persist automatically on load, edits, focus or elapsed time", async () => {
		vi.useFakeTimers();
		const fetch = vi.fn(() => {
			throw new Error("Unexpected settings request");
		});
		vi.stubGlobal("fetch", fetch);
		const get = vi.spyOn(Storage.prototype, "getItem");
		const set = vi.spyOn(Storage.prototype, "setItem");
		const remove = vi.spyOn(Storage.prototype, "removeItem");
		const edited = vi.fn<(edit: OwnerSettingsEdit) => void>();
		const { container } = render(view(example(), edited));
		change(START_LABEL, "10:00");
		fireEvent.click(day("sat"));
		field(END_LABEL).focus();
		await act(async () => {
			vi.advanceTimersByTime(86_400_000);
			await Promise.resolve();
		});
		expect(edited).not.toHaveBeenCalled();
		commit();
		expect(edited).toHaveBeenCalledTimes(1);
		expect(fetch).not.toHaveBeenCalled();
		expect(get).not.toHaveBeenCalled();
		expect(set).not.toHaveBeenCalled();
		expect(remove).not.toHaveBeenCalled();
		expect(container.querySelector("a")).toBeNull();
		expect(screen.getAllByRole("button")).toHaveLength(1);
	});

	it.each(["throwing getter", "throwing proxy", "revoked proxy"] as const)(
		"sanitizes a loaded %s without returning caller error text",
		(kind) => {
			let value: unknown;
			if (kind === "throwing getter") {
				value = { workingHours: example().workingHours };
				Object.defineProperty(value, "zone", {
					enumerable: true,
					get() {
						throw new Error("SETTINGS_LOADED_CANARY");
					},
				});
			} else if (kind === "throwing proxy") {
				value = new Proxy(
					{},
					{
						get() {
							throw new Error("SETTINGS_LOADED_CANARY");
						},
					},
				);
			} else {
				const revocable = Proxy.revocable({}, {});
				revocable.revoke();
				value = revocable.proxy;
			}
			const edited = vi.fn<(edit: OwnerSettingsEdit) => void>();
			const { container } = render(view(value, edited));
			expectError("INVALID_VALUE");
			expect(container.textContent).not.toContain("SETTINGS_LOADED_CANARY");
			expect(screen.queryByLabelText(ZONE_LABEL)).toBeNull();
			expect(button().disabled).toBe(true);
			expect(edited).not.toHaveBeenCalled();
		},
	);

	it("never activates markup from an invalid loaded zone or echoes it as an error", () => {
		const hostile =
			'<img src=x onerror="globalThis.settingsCompromised=true"><a href="javascript:1">x</a>';
		const edited = vi.fn<(edit: OwnerSettingsEdit) => void>();
		const { container } = render(view({ ...example(), zone: hostile }, edited));
		expectError("INVALID_VALUE");
		expect(container.querySelector("img,script,a")).toBeNull();
		expect(container.textContent).not.toContain(hostile);
		expect(edited).not.toHaveBeenCalled();
	});

	it("keeps the same labels associated with distinct inputs in two editors", () => {
		const edited = vi.fn<(edit: OwnerSettingsEdit) => void>();
		render(createElement("div", null, view(example(), edited), view(alternate(), edited)));
		for (const label of [ZONE_LABEL, START_LABEL, END_LABEL]) {
			const fields = screen.getAllByLabelText(label);
			expect(fields).toHaveLength(2);
			expect(fields.every((el) => el.id.length > 0)).toBe(true);
			expect(new Set(fields.map((el) => el.id)).size).toBe(2);
		}
	});
});
