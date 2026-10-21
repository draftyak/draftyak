import type { OwnerState } from "@draftyak/lookup-core/calendar";

export interface IndependentCase {
	readonly id: string;
	readonly feed: string;
	readonly owner: OwnerState;
	readonly now: string;
	readonly window: readonly [string, string];
	readonly horizon?: 3 | 5 | 10;
	readonly busy: readonly (readonly [string, string, "busy" | "tentative"])[];
	readonly slots: readonly (readonly [string, string, string])[];
}

export function syntheticCalendar(...events: readonly string[]): string {
	return [
		"BEGIN:VCALENDAR",
		"VERSION:2.0",
		"PRODID:-//DraftYak//Synthetic independent calendar//EN",
		...events.flatMap((event, index) => [
			"BEGIN:VEVENT",
			`UID:DYTEST-independent-${index}`,
			"DTSTAMP:20260101T000000Z",
			...event.split("\n"),
			"SUMMARY:ICS_CANARY_INDEPENDENT_TITLE",
			"DESCRIPTION:ICS_CANARY_INDEPENDENT_DESCRIPTION",
			"LOCATION:ICS_CANARY_INDEPENDENT_LOCATION",
			"ATTENDEE:mailto:ICS_CANARY_INDEPENDENT@example.invalid",
			"END:VEVENT",
		]),
		"END:VCALENDAR",
		"",
	].join("\r\n");
}

const weekdayOwner: OwnerState = {
	zone: "America/New_York",
	workingHours: { days: ["mon", "tue", "wed", "thu", "fri"], start: "09:00", end: "17:00" },
};

// Literal weekday dates and local labels span the Sunday offset change.
const novemberSlots: readonly (readonly [string, string, string])[] = [
	[
		"2026-11-02T14:00:00Z",
		"2026-11-02T22:00:00Z",
		"Mon 02 Nov 2026, 09:00–17:00 America/New_York (UTC-05:00)",
	],
	[
		"2026-11-03T14:00:00Z",
		"2026-11-03T22:00:00Z",
		"Tue 03 Nov 2026, 09:00–17:00 America/New_York (UTC-05:00)",
	],
	[
		"2026-11-04T14:00:00Z",
		"2026-11-04T22:00:00Z",
		"Wed 04 Nov 2026, 09:00–17:00 America/New_York (UTC-05:00)",
	],
	[
		"2026-11-05T14:00:00Z",
		"2026-11-05T22:00:00Z",
		"Thu 05 Nov 2026, 09:00–17:00 America/New_York (UTC-05:00)",
	],
	[
		"2026-11-06T14:00:00Z",
		"2026-11-06T22:00:00Z",
		"Fri 06 Nov 2026, 09:00–17:00 America/New_York (UTC-05:00)",
	],
	[
		"2026-11-09T14:00:00Z",
		"2026-11-09T22:00:00Z",
		"Mon 09 Nov 2026, 09:00–17:00 America/New_York (UTC-05:00)",
	],
	[
		"2026-11-10T14:00:00Z",
		"2026-11-10T22:00:00Z",
		"Tue 10 Nov 2026, 09:00–17:00 America/New_York (UTC-05:00)",
	],
	[
		"2026-11-11T14:00:00Z",
		"2026-11-11T22:00:00Z",
		"Wed 11 Nov 2026, 09:00–17:00 America/New_York (UTC-05:00)",
	],
	[
		"2026-11-12T14:00:00Z",
		"2026-11-12T22:00:00Z",
		"Thu 12 Nov 2026, 09:00–17:00 America/New_York (UTC-05:00)",
	],
];

const horizonCases = (
	[
		[3, "2026-11-04T05:00:00Z", 2],
		[5, "2026-11-06T05:00:00Z", 4],
		[10, "2026-11-13T05:00:00Z", 9],
	] as const
).map(
	([horizon, end, count]): IndependentCase => ({
		id: `late-friday-dst-${horizon}-working-days`,
		feed: syntheticCalendar("DTSTART:20261030T203000Z\nDTEND:20261030T210000Z"),
		owner: weekdayOwner,
		now: "2026-10-30T20:37:00Z",
		window: ["2026-10-30T20:30:00Z", end],
		horizon,
		busy: [["2026-10-30T20:30:00Z", "2026-10-30T21:00:00Z", "busy"]],
		slots: novemberSlots.slice(0, count),
	}),
);

export const independentCases: readonly IndependentCase[] = [
	{
		id: "in-progress-clipping-thirty-minute-neighbor",
		feed: syntheticCalendar(
			"DTSTART:20261019T084500Z\nDTEND:20261019T103100Z",
			"DTSTART:20261019T111500Z\nDTEND:20261019T114500Z\nSTATUS:TENTATIVE",
		),
		owner: { zone: "UTC", workingHours: { days: ["mon"], start: "09:00", end: "13:00" } },
		now: "2026-10-19T09:07:00Z",
		window: ["2026-10-19T09:00:00Z", "2026-10-19T13:00:00Z"],
		busy: [
			["2026-10-19T09:00:00Z", "2026-10-19T10:31:00Z", "busy"],
			["2026-10-19T11:15:00Z", "2026-10-19T11:45:00Z", "tentative"],
		],
		slots: [
			[
				"2026-10-19T10:45:00Z",
				"2026-10-19T11:15:00Z",
				"Mon 19 Oct 2026, 10:45–11:15 UTC (UTC+00:00)",
			],
			[
				"2026-10-19T11:45:00Z",
				"2026-10-19T13:00:00Z",
				"Mon 19 Oct 2026, 11:45–13:00 UTC (UTC+00:00)",
			],
		],
	},
	{
		id: "in-progress-clipping-twenty-nine-minute-neighbor",
		feed: syntheticCalendar(
			"DTSTART:20261019T084500Z\nDTEND:20261019T103100Z",
			"DTSTART:20261019T111400Z\nDTEND:20261019T114500Z\nSTATUS:TENTATIVE",
		),
		owner: { zone: "UTC", workingHours: { days: ["mon"], start: "09:00", end: "13:00" } },
		now: "2026-10-19T09:07:00Z",
		window: ["2026-10-19T09:00:00Z", "2026-10-19T13:00:00Z"],
		busy: [
			["2026-10-19T09:00:00Z", "2026-10-19T10:31:00Z", "busy"],
			["2026-10-19T11:14:00Z", "2026-10-19T11:45:00Z", "tentative"],
		],
		slots: [
			[
				"2026-10-19T11:45:00Z",
				"2026-10-19T13:00:00Z",
				"Mon 19 Oct 2026, 11:45–13:00 UTC (UTC+00:00)",
			],
		],
	},
	{
		id: "fractional-floating-clipped-window-with-unrounded-end",
		feed: syntheticCalendar(
			"DTSTART:20261019T030000Z\nDTEND:20261019T032500Z",
			"DTSTART:20261019T094500\nDTEND:20261019T103000",
		),
		owner: {
			zone: "Asia/Kathmandu",
			workingHours: { days: ["mon"], start: "09:00", end: "12:00" },
		},
		now: "2026-10-19T02:17:00Z",
		window: ["2026-10-19T03:20:00Z", "2026-10-19T05:46:00Z"],
		busy: [
			["2026-10-19T03:20:00Z", "2026-10-19T03:25:00Z", "busy"],
			["2026-10-19T04:00:00Z", "2026-10-19T04:45:00Z", "busy"],
		],
		slots: [
			[
				"2026-10-19T03:30:00Z",
				"2026-10-19T04:00:00Z",
				"Mon 19 Oct 2026, 09:15–09:45 Asia/Kathmandu (UTC+05:45)",
			],
			[
				"2026-10-19T04:45:00Z",
				"2026-10-19T05:46:00Z",
				"Mon 19 Oct 2026, 10:30–11:31 Asia/Kathmandu (UTC+05:45)",
			],
		],
	},
	{
		id: "fold-spanning-free-slot-labels-both-offsets",
		feed: syntheticCalendar("DTSTART:20261101T044500Z\nDTEND:20261101T051500Z"),
		owner: {
			zone: "America/New_York",
			workingHours: { days: ["sun"], start: "00:30", end: "04:00" },
		},
		now: "2026-11-01T03:00:00Z",
		window: ["2026-11-01T04:00:00Z", "2026-11-01T09:00:00Z"],
		busy: [["2026-11-01T04:45:00Z", "2026-11-01T05:15:00Z", "busy"]],
		slots: [
			[
				"2026-11-01T05:15:00Z",
				"2026-11-01T09:00:00Z",
				"Sun 01 Nov 2026, 01:15–04:00 America/New_York (UTC-04:00 → UTC-05:00)",
			],
		],
	},
	{
		id: "spring-gap-unambiguous-working-hours-positive",
		feed: syntheticCalendar("DTSTART:20260308T060000Z\nDTEND:20260308T063000Z"),
		owner: {
			zone: "America/New_York",
			workingHours: { days: ["sun"], start: "03:00", end: "04:00" },
		},
		now: "2026-03-08T05:00:00Z",
		window: ["2026-03-08T05:00:00Z", "2026-03-08T08:00:00Z"],
		busy: [["2026-03-08T06:00:00Z", "2026-03-08T06:30:00Z", "busy"]],
		slots: [
			[
				"2026-03-08T07:00:00Z",
				"2026-03-08T08:00:00Z",
				"Sun 08 Mar 2026, 03:00–04:00 America/New_York (UTC-04:00)",
			],
		],
	},
	{
		id: "skipped-midnight-with-valid-one-am-working-boundary",
		feed: syntheticCalendar("DTSTART:20181104T040000Z\nDTEND:20181104T050000Z"),
		owner: {
			zone: "America/Sao_Paulo",
			workingHours: { days: ["sun"], start: "01:00", end: "04:00" },
		},
		now: "2018-11-04T01:00:00Z",
		window: ["2018-11-04T03:00:00Z", "2018-11-04T06:00:00Z"],
		busy: [["2018-11-04T04:00:00Z", "2018-11-04T05:00:00Z", "busy"]],
		slots: [
			[
				"2018-11-04T03:00:00Z",
				"2018-11-04T04:00:00Z",
				"Sun 04 Nov 2018, 01:00–02:00 America/Sao_Paulo (UTC-02:00)",
			],
			[
				"2018-11-04T05:00:00Z",
				"2018-11-04T06:00:00Z",
				"Sun 04 Nov 2018, 03:00–04:00 America/Sao_Paulo (UTC-02:00)",
			],
		],
	},
	...horizonCases,
];
