# Calendar free/busy engine

Pure, synchronous calendar computation with no network, storage, logging, SDK or manifest.
`ical.js` is an exact-pinned normal dependency and remains external to the build.
The merged `@draftyak/protocol` tool-v1 contract also remains external.

## Public API

```ts
freeBusy(feed: Uint8Array, window: UtcWindow, timeZone: string,
  options?: {timeoutMs?: number}): CalendarResult
mergeBusy(intervals: readonly BusyInterval[]): BusyInterval[]
```

`UtcWindow` contains nonnegative integer UTC epoch milliseconds `{start, end}`.
`BusyInterval` adds `status: 'busy' | 'tentative'`. `CalendarResult` is an alias for
the exact shared `CalendarFreebusyResult`: `{busy: [{start: number, end: number,
status}]}`, with UTC milliseconds. The engine uses the merged tool-v1 argument
and result validators directly. `mergeBusy` is the shared tool-v1 helper; it drops
empty intervals, sorts and copies them, and merges touching intervals with busy
status taking precedence. `CalendarError` and its `CalendarErrorCode` type are
also exported. Errors contain only fixed codes, with no parser cause or feed data.

## Decisions where the brief leaves a choice

| Rule | Reason |
| --- | --- |
| Windows are half-open, clipped at both edges, with finite integer millisecond bounds and `start < end`. | Prevent boundary-only events and invalid instants from becoming busy intervals. |
| All-day dates occupy owner-local calendar days; DTEND is exclusive; a missing end means one day. | Preserve full days across 23-, 24-, 25- and half-hour DST days. |
| A date-time without DTEND or DURATION has zero duration and is omitted; inverted/negative intervals fail. | Use iCalendar's default without inventing a meeting length. |
| DTEND gives timed recurrences a fixed elapsed duration. DURATION weeks/days are nominal local days, followed by elapsed hours/minutes/seconds. All-day durations may contain only weeks/days. | Preserve the distinction in RFC 5545 sections 3.3.6 and 3.8.5.3. |
| DST gaps/folds choose the earlier instant in a fold and the pre-transition offset in a gap. | IANA/floating times use Temporal `compatible`; feed definitions use our bounded transition resolver with the same RFC 5545 section 3.3.5 policy. Google-style and Outlook-style definitions use the six independent DST goldens. |
| Unknown TZIDs, including unmapped Windows names, fail with `UNKNOWN_TIME_ZONE`. Numeric offset owner zones are refused. | Guessing a zone could mark occupied time as free. |
| Explicit event TZIDs use a feed VTIMEZONE first. Floating/all-day times always use the owner's native IANA zone; UTC values stay UTC. All zone maps are call-local. | Honor feed definitions without contaminating other feeds or replacing owner settings. |
| An explicit opaque override can occupy time even when its master is transparent/cancelled. Overrides are independently considered at their moved start and suppress the original occurrence. Explicit overrides take precedence over EXDATE. | Avoid losing moved-in busy time or explicit busy exceptions; cancelled/transparent overrides themselves contribute no time. |
| DTSTART is included in a recurrence set unless excluded/overridden; duplicate generated instants are counted once. | RDATE-only series must not lose their initial occurrence. |
| Evaluate RRULE independently from RDATE and EXDATE. Apply set positions and per-instant deduplication before COUNT; UTC UNTIL is inclusive and DATE UNTIL uses nominal dates. Sort/deduplicate numeric lists for every frequency. | RDATE can add instances after RRULE COUNT/UNTIL; EXDATE does not refund COUNT. SECONDLY through WEEKLY rank complete natural intervals after limiting parts, retaining the original INTERVAL phase and lower defaults. Supported MONTHLY/YEARLY rules use a custom Gregorian generator over complete natural periods, filtering valid dates and expanding time tuples before instant deduplication, COUNT and UNTIL. This follows [RFC 5545 section 3.3.10](https://www.rfc-editor.org/rfc/rfc5545.html#section-3.3.10). |
| Duplicate retained masters and duplicate relevant recurrence IDs fail. An override with no retained recurring master is a standalone event at its actual start; CANCELLED/TRANSPARENT contributes nothing. | Avoid guessing revision order while supporting invitations to individual occurrences. Standalone events may omit UID; recurring events and overrides require it. |
| Accept one VCALENDAR with VEVENT/VTIMEZONE; ignore VTODO, VJOURNAL, nested VALARM and non-timing values. Other component types fail, including VFREEBUSY. Accept CRLF/LF and retained unfolded UTF-8, including folds inside a code point. | Preserve structural checks while skipping discarded property bytes without assembling or parsing their values. |
| EXRULE, recurrence RANGE and RDATE PERIOD fail rather than being partly interpreted. Duplicate timing singletons, malformed dates/offsets and invalid/unknown RRULE parts fail. Leap seconds fail. STATUS/TRANSP enum comparisons are case-insensitive; unknown statuses remain busy. | Fail closed on unsupported/ambiguous time semantics; preserve conservative busy treatment for extensions. |
| Count VTIMEZONE and retained top-level event components toward 5,000; count positive, non-dropped window-overlapping instances before merging toward 2,000. | Bound retained state and expansion without spending the instance budget on cancelled/transparent or out-of-window time. |
| Scan zones, index relevant recurrence masters, then retain events; parse one sanitized component at a time. | No whole-calendar object is constructed. Raw DTSTART/DTEND/DURATION with conservative ±26-hour slack proves non-overlap before strict validation. Proven-ended rules are pruned independently from RDATE; relevant moved overrides still suppress their originals. |
| Limit a retained logical line to 65,536 source bytes, including continuation whitespace but excluding CRLF, and 1,024 physical segments; limit a sanitized component to 262,144 UTF-8 bytes, charging two bytes per retained line terminator including the final one. | Bound parser allocation. Discarded descriptions and ignored-component values are bounded by the 32 MiB input cap instead. |
| Limit recurrence work to 100,000, retained RDATE/EXDATE scalar values to 10,000, and feed-zone work/unique transitions to 100,000/10,000 per computation. | Each raw iterator call and emitted RDATE, plus each Gregorian period, examined day and generated time tuple, spends shared recurrence work; observance RDATEs spend the scalar limit. Resource exhaustion refuses the result. Non-UTC series retain a conservative 48-hour UTC lookahead because gap resolution can move later wall occurrences backwards; mixed-zone RDATEs use the same bound. UTC-only series stop at the window end. Dense series may fail closed during lookahead. |
| The trusted caller supplies integer `timeoutMs` from 1 through the shared calendar ceiling of 15,000 ms; the pure API defaults to that ceiling. | The future fetch adapter must pass only the ready-instance budget remaining after fetch, never start another fifteen seconds. The option is local API data and does not change wire arguments. |
| The execution deadline uses a constant `node:vm` script calling the engine callback; feed text is never evaluated. | V8 can interrupt a single stuck library iteration as well as the outer loop. |
| Cap both merged interval count and UTF-8 JSON bytes; fail rather than truncate. Test the byte guard independently because 200 fixed-format UTC intervals already fit below 20,480 bytes. | Preserve the output ceiling even if the wire adapter changes later. |
| Use package-local `skipLibCheck`. | The pinned upstream declarations contain extensionless relative imports and an accessor/property conflict under NodeNext; project source remains strictly typechecked without altering the dependency. |
| Build with `ical.js` external and run package tests with one worker. | Keep the upstream library separate and keep local verification light. |

## Supported bounded recurrence and feed definitions

Negative BYMONTHDAY is supported only on MONTHLY/YEARLY; other frequencies
refuse it. RFC-invalid combinations (WEEKLY BYMONTHDAY, DAILY/WEEKLY/MONTHLY
BYYEARDAY, non-YEARLY BYWEEKNO and ordinal YEARLY BYDAY with BYWEEKNO) refuse.
MONTHLY/YEARLY BYSETPOS requires BYDAY and refuses BYMONTHDAY, BYYEARDAY,
BYWEEKNO, BYHOUR, BYMINUTE and BYSECOND; YEARLY BYSETPOS also requires exactly
one BYMONTH. YEARLY BYMONTHDAY requires BYMONTH. These supported-rule restrictions
remain in force with the Gregorian generator. Impossible BYMONTH/BYMONTHDAY
combinations refuse before recurrence generation. DATE starts ignore time-of-day BY
parts. Other supported forms retain the deadline as an interruptible backstop
for a library call; exhaustion never returns partial availability.

Feed STANDARD/DAYLIGHT definitions require local DATE-TIME DTSTART and offsets
strictly within ±24 hours. Observance RRULEs must be YEARLY, with no BYWEEKNO;
UNTIL must be a UTC DATE-TIME. The event-rule restrictions above also apply.
Local DATE-TIME RDATE is supported; PERIOD, UTC/TZID-qualified observance RDATE,
unknown parts and ambiguous conflicting transitions refuse. Expansion uses a
call-local counted transition table, never upstream timezone expansion. Before
the first transition its TZOFFSETFROM applies. Fold/gap resolution tries the
declared offsets and chooses the RFC instant. An unrepresentable year or an
exhausted transition/work limit gives `RESOURCE_LIMIT`.

## Verification

```text
pnpm --filter @draftyak/tool-calendar-ics test
pnpm --filter @draftyak/tool-calendar-ics test:heavy
pnpm --filter @draftyak/tool-calendar-ics typecheck
pnpm --filter @draftyak/tool-calendar-ics build
```

The unit tier checks corpus/privacy, recurrence and counted-limit neighbors.
The heavy tier uses the real public API under the plugin's string-code-generation
restriction and 256 MiB heap: 5,000/5,001 retained components, a roughly 30 MiB
provider-shaped history, independent raw-call and deadline controls, and seeded
structural mutations starting from valid corpus feeds. It needs a controlled
two-core run. Development-only `test/check-oracles.py` independently checks the
committed recurrence goldens with pinned python-dateutil 2.9.0.post0 and reports
module/fixture hashes. It is not a runtime or workspace dependency. The separate
partial-first-week BYSETPOS case is a literal RFC control because dateutil's
partial-first-week behavior differs from the complete-interval rule.

## Later SDK wiring

- Bind actual handlers to the already merged `calendar.freebusy` schema. The
  pure engine already accepts and returns UTC milliseconds and directly reuses
  its shared validators, types and merge helper.
- Add SDK lifecycle, canonical describe/probe/list handlers and the manifest.
- Fetch only through the broker: one GET of `secret://calendarUrl`, conditional
  headers, no redirects, 32 MiB maximum, `text/calendar` validation and timeout.
  Map 401/403/404 to `AUTH_REVOKED`; network/status/content-type handling is absent here.
- Map typed engine failures to lookup chips, especially too many events and
  Temporal unavailable. Keep raw feeds, URLs, results and cache in memory only;
  discard them on the required consent/lifecycle transitions.
- Ship the untouched upstream library and its license separately, without
  inlining/minification, and add release hash verification.
- Extend the shared corpus with broker failures and downstream canary assertions;
  free-slot rendering, working hours and lookup budgets belong to the hub.

The shared case format and synthetic provider fixtures live in
[`security/ics-corpus`](../../security/ics-corpus/README.md).
