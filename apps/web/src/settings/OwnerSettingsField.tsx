import { OwnerSettings, Weekday } from "@draftyak/protocol/entities/settings";
import { type KeyboardEvent, type ReactElement, useId, useState } from "react";

type DeepReadonly<Value> = Value extends readonly (infer Item)[]
	? readonly DeepReadonly<Item>[]
	: Value extends object
		? { readonly [Key in keyof Value]: DeepReadonly<Value[Key]> }
		: Value;

export type OwnerSettingsEdit = DeepReadonly<OwnerSettings>;

export type OwnerSettingsFieldProps = Readonly<{
	value: unknown;
	onEdit: (edit: OwnerSettingsEdit) => void;
	disabled?: boolean;
}>;

type EditError = "INVALID_DRAFT" | "EDIT_FAILED";
type Draft = Readonly<{
	zone: string;
	start: string;
	end: string;
	days: readonly Weekday[];
	error: EditError | null;
}>;

const DAY_LABELS: Readonly<Record<Weekday, string>> = {
	mon: "Monday",
	tue: "Tuesday",
	wed: "Wednesday",
	thu: "Thursday",
	fri: "Friday",
	sat: "Saturday",
	sun: "Sunday",
};
const MESSAGES: Readonly<Record<EditError, string>> = {
	INVALID_DRAFT: "Enter valid owner settings.",
	EDIT_FAILED: "Settings could not be returned.",
};

function readSettings(value: unknown): OwnerSettings | null {
	try {
		const parsed = OwnerSettings.safeParse(value);
		return parsed.success ? parsed.data : null;
	} catch {
		return null;
	}
}

export function OwnerSettingsField({
	value,
	onEdit,
	disabled = false,
}: OwnerSettingsFieldProps): ReactElement {
	const settings = readSettings(value);
	if (settings === null) {
		return (
			<div>
				<p role="alert" data-error-code="INVALID_VALUE">
					Settings are unavailable.
				</p>
				<button type="button" disabled>
					Use these settings
				</button>
			</div>
		);
	}
	return (
		<SettingsEditor
			key={JSON.stringify(settings)}
			value={settings}
			onEdit={onEdit}
			disabled={disabled}
		/>
	);
}

function SettingsEditor({
	value,
	onEdit,
	disabled,
}: Readonly<{
	value: OwnerSettings;
	onEdit: (edit: OwnerSettingsEdit) => void;
	disabled: boolean;
}>): ReactElement {
	const id = useId();
	const [draft, setDraft] = useState<Draft>(() => ({
		zone: value.zone,
		start: value.workingHours.start,
		end: value.workingHours.end,
		days: [...value.workingHours.days],
		error: null,
	}));
	const errorId = `${id}-error`;
	const hintId = `${id}-hint`;
	const invalid = draft.error === "INVALID_DRAFT";
	const description = `${hintId}${draft.error ? ` ${errorId}` : ""}`;

	function change(field: "zone" | "start" | "end", text: string): void {
		setDraft((previous) => ({ ...previous, [field]: text, error: null }));
	}

	function changeDay(day: Weekday, checked: boolean): void {
		setDraft((previous) => ({
			...previous,
			days: checked
				? previous.days.includes(day)
					? previous.days
					: [...previous.days, day]
				: previous.days.filter((value) => value !== day),
			error: null,
		}));
	}

	function commit(): void {
		if (disabled) return;
		const parsed = readSettings({
			zone: draft.zone,
			workingHours: { days: [...draft.days], start: draft.start, end: draft.end },
		});
		if (parsed === null) {
			setDraft((previous) => ({ ...previous, error: "INVALID_DRAFT" }));
			return;
		}
		const edit: OwnerSettingsEdit = Object.freeze({
			zone: parsed.zone,
			workingHours: Object.freeze({
				days: Object.freeze([...parsed.workingHours.days]),
				start: parsed.workingHours.start,
				end: parsed.workingHours.end,
			}),
		});
		setDraft((previous) => ({ ...previous, error: null }));
		try {
			onEdit(edit);
		} catch {
			setDraft((previous) => ({ ...previous, error: "EDIT_FAILED" }));
		}
	}

	function keyDown(event: KeyboardEvent<HTMLInputElement>): void {
		if (event.key === "Enter" && !event.nativeEvent.isComposing) {
			event.preventDefault();
			commit();
		}
	}

	return (
		<div>
			<label htmlFor={`${id}-zone`}>Owner time zone</label>
			<input
				id={`${id}-zone`}
				type="text"
				value={draft.zone}
				maxLength={64}
				disabled={disabled}
				aria-invalid={invalid}
				aria-describedby={draft.error ? errorId : undefined}
				onChange={(event) => change("zone", event.currentTarget.value)}
				onKeyDown={keyDown}
			/>
			<fieldset disabled={disabled} aria-describedby={draft.error ? errorId : undefined}>
				<legend>Working days</legend>
				{Weekday.options.map((day) => (
					<div key={day}>
						<input
							id={`${id}-${day}`}
							type="checkbox"
							checked={draft.days.includes(day)}
							disabled={disabled}
							onChange={(event) => changeDay(day, event.currentTarget.checked)}
							onKeyDown={keyDown}
						/>
						<label htmlFor={`${id}-${day}`}>{DAY_LABELS[day]}</label>
					</div>
				))}
			</fieldset>
			<label htmlFor={`${id}-start`}>Working hours start</label>
			<input
				id={`${id}-start`}
				type="text"
				value={draft.start}
				maxLength={5}
				disabled={disabled}
				aria-invalid={invalid}
				aria-describedby={description}
				onChange={(event) => change("start", event.currentTarget.value)}
				onKeyDown={keyDown}
			/>
			<label htmlFor={`${id}-end`}>Working hours end</label>
			<input
				id={`${id}-end`}
				type="text"
				value={draft.end}
				maxLength={5}
				disabled={disabled}
				aria-invalid={invalid}
				aria-describedby={description}
				onChange={(event) => change("end", event.currentTarget.value)}
				onKeyDown={keyDown}
			/>
			<p id={hintId}>Use HH:mm, with 24:00 allowed only for the end.</p>
			<button
				type="button"
				disabled={disabled}
				aria-describedby={draft.error ? errorId : undefined}
				onClick={commit}
			>
				Use these settings
			</button>
			{draft.error && (
				<p id={errorId} role="alert" data-error-code={draft.error}>
					{MESSAGES[draft.error]}
				</p>
			)}
		</div>
	);
}
