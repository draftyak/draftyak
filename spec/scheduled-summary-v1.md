# Scheduled summary v1

What the tray and the Quit dialog show: the pending approvals and the next scheduled
sends, the answer of [`GET /device/v1/scheduling/outbox`](hub-runtime-v1.md#routes).
It holds no body, subject, statement or credential, and it grants no read or send
authority. Encodings follow [Encodings](README.md).

## Summary

`ScheduledSummary` is `{scheduling, scopeHash, pendingApprovalCount,
pendingApprovalIds, scheduledCount, items}`, with no other member:

- `scheduling` is the [SchedulingStatus](hub-runtime-v1.md#scheduling-status);
- the counts are totals, safe integers from 0;
- `pendingApprovalIds` holds the ULIDs of the first `min(pendingApprovalCount, 20)`
  pending approvals by id, each pair strictly ascending, so the oldest come first;
- `items` holds `min(scheduledCount, 5)` items with distinct `outboxId`s, ordered by
  `schedule.notBefore` and then `outboxId`, each pair strictly ascending.

The answer is at most 8 KiB as received; the largest valid summary is 8,144 bytes as
canonical JSON.

## Items

An item is `{outboxId, accountId, alias, destination, destinationTruncated,
moreRecipients, schedule, deliverBy}`:

- `outboxId` and `accountId` are the frozen snapshot's `outbox` and `account`, and
  `alias` is that account's alias;
- `destination` is the snapshot's first To, Cc or Bcc recipient, in that order, or its
  chat channel name, with each hidden code point replaced by U+FFFD, then cut to the
  longest prefix of whole code points within 512 UTF-8 bytes. `destinationTruncated`
  says whether it was cut, so a cut destination holds at least 509 bytes. It holds no
  hidden code point;
- `moreRecipients` is the email recipients beyond the first across To, Cc and Bcc:
  their total minus one, from 0 to 299, whether or not `destination` was cut. For a
  chat it is 0;
- `schedule` is the snapshot's frozen `at` schedule, never `now`, under the
  snapshot's own schedule rules;
- `deliverBy` is `notBefore + latenessSec × 1000`, a safe integer.

The hidden code points are those a [display name](pairing-v1.md#2-the-payload)
refuses: U+0000–U+001F, U+007F–U+009F, U+00AD, U+034F, U+061C, U+115F–U+1160,
U+17B4–U+17B5, U+180E, U+200B, U+200E–U+200F, U+2028–U+202E, U+2060–U+206F, U+3164,
U+FEFF, U+FFA0, U+FFF0–U+FFFB, U+1BCA0–U+1BCA3, U+1D173–U+1D17A, U+E0000–U+E00FF and
U+E01F0–U+E0FFF. They are the controls, separators, bidi controls and other invisible
code points that would hide or reorder what the tray and the Quit dialog show, since
both show a destination as is. An email address never holds one; a chat channel name
may, since a snapshot refuses only CR and LF in it.

TypeScript's `cutDestination(text)` makes a destination, and
`checkScheduledItemSource(item, snapshot)` checks an item against its snapshot. A
device can't: the summary carries no recipient list or channel kind, so Rust checks
`moreRecipients` for its form and bounds only.

## Scope hash

`scopeHash` is 64 lower-case hex digits: the SHA-256 of the JCS of

```
{hub, owner, epoch, scheduling, pendingApprovalCount, pendingApprovalIds,
 scheduledCount, items}
```

where `hub` is the hub id, `owner` the owner's user id, `epoch` the hub's current
epoch (0 included), `pendingApprovalIds` the summary's ascending list and each item
`{outboxId, contentHash, flagsHash, state}` of a listed item, in the summary's order.
TypeScript's `scopeHash()` refuses any other member and ids out of order. The hub
computes it; a device only compares it between reads and never recomputes it.

The [generated schema](schemas/scheduled-summary-v1.schema.json) holds the strict
shapes; the counts, orders, byte limits and `deliverBy` also need these validators. The
shared [vectors](vectors/scheduled-summary/) pin both languages, except
`scope-hash.json`, which only TypeScript reads.
