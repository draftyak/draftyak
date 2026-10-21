# Calendar free-slot goldens

This offline package composes synthetic ICS bytes through the real calendar
engine, the shared `calendar.freebusy` wire-result validator and the lookup
core's public `calendar` renderer. Fixed clocks, owner settings and literal UTC
intervals and local labels make the boundary observable. Expected busy intervals
are compared with engine output; they are never substituted for that output.

The corpus covers recurrence additions, exclusions and overrides; all-day and
floating values; transparent, cancelled and tentative events; spring and fall
transitions in New York, London and Lord Howe; a skipped midnight; fractional
offsets; clipping; upward quarter-hour rounding; thirty-minute minimum slots;
the one-hour lead; and the twelve-slot limit. Three explicit working-day cases
use the real 3-, 5- and 10-day window builder before composition.

Malformed, unknown-zone and oversized feeds remain typed calendar errors.
Event-detail canaries must be absent from engine output, validated results and
rendered contexts. The test task is uncached because it reads corpus inputs
outside this package. No external recurrence-oracle file is read.

```text
pnpm --filter @draftyak/calendar-goldens typecheck
pnpm --filter @draftyak/calendar-goldens test
```

This establishes M7b.13's offline composition only. Native fetching, secret
substitution, broker and process integration, account and consent policy,
prompt/log persistence checks, owner sessions and the native integration test
remain separate acceptance under M7b.5/10. No network requests are made.
