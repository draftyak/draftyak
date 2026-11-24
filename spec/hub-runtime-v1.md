# Hub runtime v1

The hub's mode, its scheduler state and its Pause sync state, as the tray and the
approval window's availability line show them, and the two read-only L2 routes that
answer them. The [scheduled summary](scheduled-summary-v1.md) defines the second
route's answer. Encodings follow [Encodings](README.md).

## Scheduling status

`SchedulingStatus` is `{mode, scheduler, syncPaused}`, with no other member:

- `mode` is `sidecar` or `service`;
- `scheduler` is `running` or `unavailable`;
- `syncPaused` is a boolean: the hub's own Pause sync state, which the device API's
  `POST /device/v1/sync/pause` sets. The hub keeps it, so a restarted app or hub, or a
  device that didn't pause, reads it as it is.

## Routes

`HUB_RUNTIME_ROUTES` gives the same table in TypeScript and Rust:

| ID | Method and path | Caller | Request | Answer / cap |
|---|---|---|---|---|
| scheduling | `GET /device/v1/scheduling` | confirmed `read` device | none | SchedulingStatus / 4 KiB |
| scheduling-outbox | `GET /device/v1/scheduling/outbox` | confirmed `read` device | none | ScheduledSummary / 8 KiB |

- The caller is known, not revoked, of role `device`, confirmed in the current epoch,
  and holds `read`. A pending device holds no capability. The admission check takes the
  device API's peer form.
- A route whose request is none refuses any body, an empty one included.
- An answer's cap applies to the bytes received, before strict JSON parsing; legal
  whitespace counts toward it. Refusals use the device API's `{code}` answers.

These routes are outside the [device API](device-api-v1.md)'s catalogue. The
[generated schema](schemas/hub-runtime-v1.schema.json) describes the status, and the
shared [vectors](vectors/hub-runtime/) pin the catalogue, admission, caps and values in
both languages.
