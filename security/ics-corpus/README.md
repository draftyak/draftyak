# Synthetic iCalendar corpus

Every feed here is synthetic. Provider names describe representative export
shapes, not captured account data. Private event fields contain `ICS_CANARY_`
markers; assertions must check that neither results nor errors expose them.

Each root-level `*.json` is an independent case:

```json
{
  "feed": "fixtures/example.ics",
  "window": {
    "start": "2026-10-12T00:00:00.000Z",
    "end": "2026-10-13T00:00:00.000Z"
  },
  "timeZone": "America/Chicago",
  "expected": {
    "busy": [
      {
        "start": 1791813600000,
        "end": 1791817200000,
        "status": "busy"
      }
    ]
  }
}
```

`feed` is relative to this directory. Fixture window timestamps are readable UTC
ISO strings; the corpus test converts those input bounds to UTC milliseconds.
Output timestamps are numeric UTC milliseconds in the merged tool-v1
`CalendarFreebusyResult`; `expected` is the entire public result, checked against
that shared result validator. The `.ics` fixtures and the represented instants
are unchanged from the original engine corpus.
A failure case replaces `expected` with `"expectedError": "ERROR_CODE"`; compare
the typed error's code and check its message for private canaries. Cases must not
depend on execution order or timezone registrations from another feed.

Intervals use half-open bounds, are clipped to the window, sorted, and merged
when they overlap or touch. A merged interval is busy if any part is busy;
otherwise it is tentative. Transparent and cancelled events contribute nothing.
A cancelled recurrence override removes its original occurrence. Overrides are
identified by their original recurrence time, including when moved elsewhere.

Date-only events occupy owner-local calendar days. `DTEND` is exclusive; when
missing, the event occupies one local day. Floating date-times use the owner's
zone. A date-time without an end or duration has zero length and is omitted.
For IANA gaps and folds these cases use Temporal's `compatible` disambiguation:
shift nonexistent local times forward by the gap and choose the earlier instant
for repeated times. Embedded `VTIMEZONE` definitions take priority over IANA
data. An unknown TZID without a definition fails with `UNKNOWN_TIME_ZONE`.

| Cases | Coverage |
| --- | --- |
| `provider-google` | Daily RRULE, RDATE, EXDATE, moved and cancelled RECURRENCE-ID, New York DST, tentative override |
| `provider-outlook` | Embedded fixed-offset VTIMEZONE overriding an IANA name; touching busy and tentative events; transparent and cancelled events |
| `provider-fastmail` | Exclusive all-day range crossing London DST, default one-day duration, floating time and DURATION |
| `dst-new-york-{gap,fold}` | One-hour spring gap and autumn repeated local time |
| `dst-london-{gap,fold}` | One-hour spring gap and autumn repeated local time |
| `dst-lord-howe-{gap,fold}` | Half-hour spring gap and autumn repeated local time |
| `window-merge` | Window clipping, touching intervals, busy precedence, standalone tentative interval, DURATION, zero-duration omission |
| `unknown-tzid` | Fail closed rather than guessing an unmapped zone |
| `alias-{utc,gmt}` | Temporal UTC/GMT aliases without a feed definition |
| `alias-{utc,gmt}-feed` | Feed definitions take precedence over those aliases |

All three provider feeds include canaries in summary, description, location,
attendee, organizer, URL, and attachment fields. Add future cases as separate
JSON files with synthetic `.ics` fixtures. The package additionally injects
Google-style (1970) and Outlook-style (1601) definitions into all six DST feeds
and compares the same independent goldens. Input, component, recurrence and
output ceilings use generated unit/heavy fixtures so this corpus remains small.
Fetch status, redirects and MIME type belong to later broker/SDK tests.
