import {
	renderLocalWallTime,
	resolveLocalTime,
	ScheduleError,
	type ScheduleErrorCode,
} from "@draftyak/protocol/schedule";
import { IanaZone } from "@draftyak/protocol/tool-v1/kinds";
import { type ReactElement, useId, useState } from "react";

export type ScheduleTimeSelection = Readonly<{
	notBefore: number;
	zone: string;
	localWallTime: string;
}>;

export type ScheduleTimeFieldProps = Readonly<{
	ownerZone: string;
	onSelect: (selection: ScheduleTimeSelection) => void;
	disabled?: boolean;
}>;

type Draft = Readonly<{
	zone: string;
	wall: string;
	error: ScheduleErrorCode | null;
	selection: ScheduleTimeSelection | null;
}>;

const MESSAGES: Readonly<Record<ScheduleErrorCode, string>> = {
	INVALID_INPUT: "Enter a valid local date and time in the owner time zone.",
	NONEXISTENT_LOCAL_TIME: "This local time does not exist in the owner time zone.",
	AMBIGUOUS_LOCAL_TIME: "This local time occurs twice. Choose a different time.",
	SCHEDULING_UNAVAILABLE: "Scheduling is unavailable in this browser.",
};

function errorCode(error: unknown): ScheduleErrorCode {
	if (error instanceof ScheduleError) {
		switch (error.code) {
			case "INVALID_INPUT":
			case "NONEXISTENT_LOCAL_TIME":
			case "AMBIGUOUS_LOCAL_TIME":
			case "SCHEDULING_UNAVAILABLE":
				return error.code;
		}
	}
	return "INVALID_INPUT";
}

export function ScheduleTimeField(props: ScheduleTimeFieldProps): ReactElement {
	const zoneKey = typeof props.ownerZone === "string" ? props.ownerZone : "";
	return <ScheduleTimeInput key={zoneKey} {...props} />;
}

function ScheduleTimeInput({ ownerZone, onSelect, disabled = false }: ScheduleTimeFieldProps) {
	const id = useId();
	const [draft, setDraft] = useState<Draft>(() => ({
		zone: ownerZone,
		wall: "",
		error: null,
		selection: null,
	}));
	const validZone = typeof ownerZone === "string" && IanaZone.safeParse(ownerZone).success;
	let contextError: ScheduleErrorCode | null = validZone ? null : "INVALID_INPUT";
	if (contextError === null) {
		try {
			if (Reflect.get(globalThis, "Temporal") === undefined)
				contextError = "SCHEDULING_UNAVAILABLE";
		} catch {
			contextError = "SCHEDULING_UNAVAILABLE";
		}
	}
	const current = draft.zone === ownerZone;
	const wall = current ? draft.wall : "";
	const selection = current ? draft.selection : null;
	const shownError = contextError ?? (current ? draft.error : null);
	const blocked = disabled || contextError !== null;
	const zoneId = `${id}-zone`;
	const helpId = `${id}-help`;
	const errorId = `${id}-error`;

	function commit() {
		if (disabled) return;
		if (contextError !== null) {
			setDraft({ zone: ownerZone, wall, error: contextError, selection: null });
			return;
		}
		let next: ScheduleTimeSelection;
		try {
			const notBefore = resolveLocalTime(wall, ownerZone);
			const localWallTime = renderLocalWallTime(notBefore, ownerZone);
			next = Object.freeze({ notBefore, zone: ownerZone, localWallTime });
		} catch (error) {
			setDraft({ zone: ownerZone, wall, error: errorCode(error), selection: null });
			return;
		}
		setDraft({ zone: ownerZone, wall, error: null, selection: next });
		onSelect(next);
	}

	return (
		<div>
			<p id={zoneId}>Owner time zone: {validZone ? ownerZone : "Unavailable"}</p>
			<label htmlFor={id}>Local date and time</label>
			<input
				id={id}
				type="datetime-local"
				step={60}
				required
				value={wall}
				disabled={blocked}
				aria-describedby={`${zoneId} ${helpId}${shownError ? ` ${errorId}` : ""}`}
				aria-invalid={shownError !== null && shownError !== "SCHEDULING_UNAVAILABLE"}
				onChange={(event) => {
					setDraft({
						zone: ownerZone,
						wall: event.currentTarget.value,
						error: null,
						selection: null,
					});
				}}
				onKeyDown={(event) => {
					if (event.key === "Enter" && !event.nativeEvent.isComposing) {
						event.preventDefault();
						commit();
					}
				}}
			/>
			<p id={helpId}>Choose a local date and time, then select Use this time.</p>
			<button type="button" disabled={blocked} onClick={commit}>
				Use this time
			</button>
			{shownError && (
				<p id={errorId} role="alert" data-error-code={shownError}>
					{MESSAGES[shownError]}
				</p>
			)}
			{selection && (
				<output aria-label="Selected local time" aria-live="polite">
					{selection.localWallTime}
				</output>
			)}
		</div>
	);
}
