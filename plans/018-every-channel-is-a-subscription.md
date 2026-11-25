# Plan 018: Every channel is a subscription

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED (the connect path and the client's apply loop)
- **Depends on**: none. Builds on v0.2.0's `reset()` and the client-owned cursor.
- **Category**: architecture, lockstep internals only

## Why this matters

v0.2.0 made a reset a clean two-step: drop everything (new collections), then load
fresh. The load side still has two paths. A non-sliced channel loads from the
connect's push, behind one room-wide cursor. A sliced channel loads by subscribe
frame, behind a cursor per slice. The room-wide cursor has a known gap, and the two
paths need special cases to meet.

## The gap this closes

**A drop partway through the connect's snapshot can keep a channel stale.** Every
snapshot frame carries the same head seq, so after the first frame the room cursor
reads "up to N". If the socket drops before the last frame, the redial asks for a
delta from N, and the channels whose snapshot never arrived never get one. It
predates v0.2.0. A channel that had registered before a reset is covered: its fresh
collection asks for its snapshot by frame, on every open until one arrives. A
channel whose collection registers for the first time relies on the connect's push,
so it can stay empty and `loading`, on a first connect as well as after a reset.

## The design

1. **A cursor per scope.** A scope is a channel, or a channel's slice. Each one
   advances only on frames for that scope. A scope whose snapshot never arrived has
   no cursor, so the next connect asks it for a snapshot. Nothing has to know when
   a snapshot is "complete".
2. **Every channel is a subscription.** A non-sliced collection is a whole-channel
   subscription, which the slice code already supports as `target: null`. On open
   the client sends one subscribe per scope it wants, with that scope's cursor or
   none. That removes the connect-time replay, the `awaitingSnapshot` re-ask (#47),
   and the sliced/non-sliced split in `SyncClient`.
3. **Apply as an upsert everywhere.** Today only sliced collections write inserts as
   updates. Making every apply idempotent turns overlap into bandwidth instead of a
   `DuplicateKeySyncError`, so a cursor only has to be a lower bound. This is the
   direction §18 already takes: fail toward sending too much.

`snapshot: false` channels need nothing new: the server already answers a subscribe
with no `since` with an empty `reset` batch at the head seq, which means "live from
now".

## Tech debt this introduces: one extra half round trip

If the connect stops pushing snapshots, the first load waits for the client's
subscribe frames after open: about half a round trip more than today. The PR that
introduces it must say so in a comment on the PR, as a "fix later" item. Two ways
to win it back:

- carry the per-scope cursor map in the connect URL, so the server can answer at
  connect as it does today (a lockstep internal, free to change);
- or keep the connect push as an optimization, and let the subscribe frames be the
  correctness path.

## Smaller items found on the way (v0.2.0 review)

- **Duplicate snapshots.** A fresh or re-registered collection asks for its snapshot
  on open, and a connect with no cursor already pushes one. Bandwidth only. Item 2
  removes it.
- **A reset ignores the commit receipts** of the deletes it writes. They apply
  immediately in every case found so far; TanStack rejects a receipt only for an
  aborted signal or an invalidation error, and a reset passes neither.
- **A deactivated user's client redials forever.** The lobby refuses the upgrade
  with an HTTP 401, which a browser reports as 1006, so PartySocket backs off and
  retries. The reset already emptied everything, so nothing leaks; the app calls
  `close()` from its own auth state. A terminal close code from the room would let
  the client stop by itself.

- **A 4001 reset shows the replaced collections empty for about 3 seconds.** The
  client empties them on the close, and the redial is PartySocket's ordinary one,
  which waits `minReconnectionDelay` (3000 ms) after a socket that had opened.
  `socket.reconnect()` from the close handler does not skip a wait already scheduled.
  An app-called `reset()` has no delay. Public collections keep their rows meanwhile.
- **`loadSubset` on a retired sliced collection returns a rejected promise**
  (`ChannelSlices.acquire`). Nobody has confirmed that TanStack DB catches it. If it
  does not, a query nobody rebuilt raises an unhandled `DroppedError`.
- **A reset drops in-flight writes to kept public collections too.** The settle
  waiters are room-wide. Per-scope cursors (item 1) would let those writes settle.

## STOP conditions

- If a stored `_oplog` op would need a new shape, stop: that is durable state
  (CLAUDE.md, "Three kinds of contract").
- If a userspace API would change, stop and flag it. This plan is lockstep only.
