# Plan 003: Make a fallback snapshot reset client state (wire `truncate`)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 3779114..HEAD -- src/protocol.ts src/client/apply.ts src/server/sqlite-adapter.ts test/apply.test.ts test/integration docs/architecture.md`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED (wire-protocol addition + client apply change)
- **Depends on**: plans/001-integration-typecheck-and-reconnect-tests.md
- **Category**: bug
- **Planned at**: commit `3779114`, 2026-07-08

## Why this matters

When a reconnecting client's `?since` cursor predates the compacted oplog, the server
falls back to a **full snapshot** (`replaySince` → `null` → `adapter.snapshot()`).
But the client applies that snapshot as ordinary insert batches on top of whatever
state it already has. Two failure modes follow:

1. Every row the client already holds is re-inserted. TanStack DB 0.6.10 throws
   `DuplicateKeySyncError` for a synced insert whose key already exists — the sync
   stream breaks.
2. Rows deleted on the server while the client was away are never removed — ghost
   rows persist even if (1) were tolerated.

TanStack's sync API already provides the tool for exactly this: `truncate()`
(present in `@tanstack/db` 0.6.10, `dist/esm/types.d.ts:263`, alongside
`begin/write/commit/markReady`). party-db's `ChannelSink` simply never wired it.
The fix: mark snapshot batches on the wire, and have the client truncate before
applying a marked batch. This also becomes load-bearing for plan 005 (which turns
on oplog retention by default — making the fallback snapshot path *common*) and
softens plan 004's connect race (a snapshot that resets state supersedes any
stray earlier broadcast).

## Current state

- `src/protocol.ts:33-37` — `SequencedBatch` today:

  ```ts
  export type SequencedBatch<T extends object = Record<string, unknown>> = WriteBatch<T> & {
    seq: Cursor
    // sentinel: this channel's backlog has been fully replayed to you.
    ready?: boolean
  }
  ```

- `src/client/apply.ts` (entire file is 32 lines) — the sink and apply loop:

  ```ts
  export type ChannelSink = {
    begin: () => void
    write: (op: WriteEvent) => void
    commit: () => void
    markReady: () => void
  }

  export function applyBatch(sink: ChannelSink, batch: SequencedBatch) {
    if (batch.ops.length) {
      sink.begin()
      for (const op of batch.ops) sink.write(op)
      sink.commit()
    }
    if (batch.ready) sink.markReady()
  }
  ```

  The sink object handed to `client.register(cfg.name, sink)` in
  `src/client/collection.ts:65` is TanStack's own sync params object — it already
  *has* a `truncate` method at runtime; only the `ChannelSink` type omits it.

- `src/server/sqlite-adapter.ts:187-205` — `snapshot()` builds the batches that need
  the marker:

  ```ts
  out.push({ channel: plan.name, seq, ops: rows.map((value) => ({ type: 'insert', value })), ready: true })
  ```

- `src/server/party-db-server.ts:76-81` — `onConnect` sends whatever
  `snapshot()`/`replaySince()` return; it needs no change (the marker rides in the
  batch objects).

- TanStack truncate semantics — **verify before coding** (Step 1): how
  `truncate()` interacts with `begin()/commit()`. Inspect
  `node_modules/@tanstack/db/dist/esm/` (e.g. how `local-storage.ts` or the
  collection sync implementation orders truncate vs begin/write/commit; grep for
  `truncate` usages). The expected pattern (used by Electric-style collections) is
  `begin(); truncate(); …writes…; commit()` so the clear + reload land atomically —
  confirm that's valid in 0.6.10.

- `docs/architecture.md` §8 ("Reconnect is a delta, not a re-snapshot") documents the
  `?since` delta; the fallback-snapshot reset semantics belong there once built.

- Existing unit tests for the apply loop: `test/apply.test.ts` (sink as a plain
  object of `vi.fn()`s) — model new cases on it.

## Commands you will need

| Purpose   | Command                  | Expected on success |
|-----------|--------------------------|---------------------|
| Typecheck | `pnpm typecheck`         | exit 0              |
| Unit tests | `pnpm test`             | all pass            |
| Integration | `pnpm test:integration` | all pass           |

## Scope

**In scope**:
- `src/protocol.ts` — add the snapshot marker field
- `src/client/apply.ts` — `ChannelSink.truncate` + apply-loop handling
- `src/server/sqlite-adapter.ts` — set the marker in `snapshot()`
- `test/apply.test.ts` — unit cases
- `test/integration/reconnect.test.ts` (from plan 001) — end-to-end case
- `docs/architecture.md` — one short paragraph in §8 documenting the reset

**Out of scope**:
- `src/server/party-db-server.ts` — no change needed; if you find one is needed,
  re-read the batch flow first and STOP if it still seems necessary.
- `src/client/sync-client.ts` routing/buffering — untouched; batches for
  unregistered channels still buffer as-is.
- Changing the default `oplogRetention` (that's plan 005).
- TanStack DB version bumps.

## Git workflow

- Branch: `advisor/003-snapshot-reset`
- Commit style: `feat(protocol): snapshot batches reset the collection (truncate) on apply`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Confirm TanStack truncate ordering

Grep `node_modules/@tanstack/db/dist/esm/` for `truncate` and read how the library
itself sequences it relative to `begin`/`commit`. Record the answer in your final
report. If truncate must NOT be called inside a begin/commit window, adapt Step 3's
ordering accordingly (truncate first, then begin/write/commit); if truncate's
semantics are unclear or it is documented as unsupported during sync, STOP.

**Verify**: you can cite the file/line in `@tanstack/db` that shows the valid ordering.

### Step 2: Add the wire marker

In `src/protocol.ts`, extend `SequencedBatch` with:

```ts
// this batch is a full snapshot of the channel: the consumer must clear its
// state before applying (reconnect fell back past the retained oplog).
reset?: boolean
```

In `src/server/sqlite-adapter.ts` `snapshot()`, add `reset: true` to the pushed
batch (alongside `ready: true`). Old clients ignore unknown fields — the change is
backward-compatible in both directions (a server without `reset` simply never
triggers the new client path).

**Verify**: `pnpm typecheck` → exit 0.

### Step 3: Honor the marker in the client apply loop

In `src/client/apply.ts`:
- Add `truncate: () => void` to `ChannelSink`.
- In `applyBatch`, when `batch.reset` is set, clear before applying, using the
  ordering confirmed in Step 1 (expected shape):

```ts
export function applyBatch(sink: ChannelSink, batch: SequencedBatch) {
  if (batch.reset || batch.ops.length) {
    sink.begin()
    if (batch.reset) sink.truncate()
    for (const op of batch.ops) sink.write(op)
    sink.commit()
  }
  if (batch.ready) sink.markReady()
}
```

Note the guard change: a `reset` batch with zero ops (empty room after the client
had rows) must still truncate — that's the ghost-row case. Preserve the existing
"skip empty non-reset batches" behavior.

**Verify**: `pnpm typecheck && pnpm test` → existing apply tests pass (they don't
set `reset`, so behavior is unchanged for them).

### Step 4: Unit tests

In `test/apply.test.ts` (match its existing style — sinks of `vi.fn()`s, call-order
assertions):
- `reset` batch: `truncate` called once, inside the begin/commit window (assert
  call order: begin → truncate → write× → commit), then `markReady` when `ready`.
- `reset` batch with zero ops: begin → truncate → commit still happen.
- non-`reset` batch: `truncate` never called (regression guard).

**Verify**: `pnpm test` → all pass including 3 new cases.

### Step 5: Integration test — the stale client heals

Extend `test/integration/reconnect.test.ts` (plan 001; worker retention = 50):
1. Connect client A; write rows `a` and `b`; A sees them.
2. Simulate A going away (close A's socket). Delete row `a` via a POST, then write
   >50 more rows so the oplog compacts past A's cursor.
3. Reconnect with A's old `?since` cursor. Assert the first batch has
   `ready: true` **and** `reset: true`, contains row `b` and the new rows, and does
   NOT contain row `a`.

(The integration harness observes raw batches, not a TanStack collection, so the
assertion is on the wire contract: `reset` present ⇒ the client-side truncate path
is what unit tests cover.)

**Verify**: `pnpm test:integration` → all pass.

### Step 6: Document

Add 2–4 sentences to `docs/architecture.md` §8: the fallback snapshot carries
`reset`, the client truncates before applying, and why (duplicate keys + ghost
rows). Match the doc's decision-record voice.

**Verify**: none beyond reading it back; keep it short.

## Test plan

Steps 4–5 are the test plan: three unit cases on `applyBatch` ordering plus one
end-to-end stale-reconnect case. Full gate:
`pnpm typecheck && pnpm test && pnpm test:integration` → green.

## Done criteria

- [ ] `SequencedBatch` has `reset?: boolean`; `snapshot()` sets it; `applyBatch` truncates on it
- [ ] Unit tests assert begin→truncate→write→commit ordering and the zero-ops reset case
- [ ] Integration test proves a stale cursor gets `reset: true` and no ghost rows on the wire
- [ ] `docs/architecture.md` §8 mentions the reset semantics
- [ ] `pnpm typecheck && pnpm test && pnpm test:integration` all exit 0
- [ ] No files outside the in-scope list modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

- TanStack 0.6.10's `truncate` cannot be called in the ordering this plan assumes
  (Step 1 finding contradicts Step 3's shape) — report the actual contract.
- The sink object TanStack passes to `sync.sync()` at runtime has **no** `truncate`
  method (check with the existing integration/example wiring or a quick unit probe) —
  the premise is wrong; report.
- You find yourself needing to modify `sync-client.ts` or `party-db-server.ts`.
- Existing apply tests fail after Step 3 for reasons other than an assertion you
  were told to update.

## Maintenance notes

- Plan 005 (default oplog retention) makes this path routine rather than rare —
  it must not land before this plan.
- Plan 004 (connect race) leans on `reset` batches superseding stray pre-snapshot
  broadcasts; if you change the marker's name or semantics, update that plan.
- Future `subscribe(channels[])`/read-slicing work (docs/unspecified.md) will need
  per-slice resets; the `reset` marker was deliberately kept per-batch (per-channel)
  to allow that.
- Reviewer: scrutinize the empty-`ops` reset case — it's the easy one to regress.
