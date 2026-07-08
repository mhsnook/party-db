# Plan 004: Serialize `onConnect` against concurrent writes (connect-race)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 3779114..HEAD -- src/server/party-db-server.ts test/integration`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition. Plans 001–003 are expected to have
> landed; their changes to these files are known drift — re-read the live
> `onConnect` and confirm it still matches the *shape* below (unserialized).

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED (touches connection setup timing)
- **Depends on**: plans/001 (test harness), plans/003 (the `reset` marker — see below)
- **Category**: bug
- **Planned at**: commit `3779114`, 2026-07-08

## Why this matters

`onRequest` (writes) runs through a promise queue so write → seq → broadcast stays
totally ordered. `onConnect` does **not**: it awaits the adapter's
`replaySince`/`snapshot` and only then sends the batches. Because those `await`s
yield the event loop, a concurrent `POST /write` can commit and broadcast between
the snapshot *read* and the snapshot *send*. The connecting socket (already
accepted, so included in `broadcast`) can then receive a **newer batch before the
older snapshot** — e.g. an `update` op for a row the client hasn't loaded yet, or a
duplicate of a row the snapshot also carries. The window is a microtask today
(embedded SQLite resolves immediately) but becomes a real network round-trip with
the planned D1 adapter — this is the moment to close it. Serializing the
read-and-send through the same queue as writes makes initial delivery atomic with
respect to writes.

## Current state

- `src/server/party-db-server.ts:36-64` — the queue and its helper (already used by
  writes):

  ```ts
  // serializes the write → seq → broadcast section. …
  private queue: Promise<unknown> = Promise.resolve()
  …
  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn)
    this.queue = run.then(
      () => {},
      () => {},
    )
    return run
  }
  ```

- `src/server/party-db-server.ts:76-81` — the unserialized connect path:

  ```ts
  async onConnect(conn: Connection, ctx: ConnectionContext) {
    const cursor = cursorParam(new URL(ctx.request.url).searchParams.get('since'))
    const delta = cursor === null ? null : await this.adapter.replaySince(cursor)
    const batches = delta ?? (await this.adapter.snapshot())
    for (const b of batches) this.send(conn, b)
  }
  ```

- `src/server/party-db-server.ts:106-126` — `onRequest` wraps its whole
  write+broadcast section in `this.serialize(async () => { … })`.

- Interleaving analysis (inline this understanding, don't rediscover it):
  - **Write commits *before* the snapshot read, broadcast delivered to the new
    conn**: snapshot already contains the write → client gets it twice. After plan
    003, a `reset` snapshot truncates first, so *snapshot-after-broadcast* is
    self-healing for the reset case — but a plain fresh-connect snapshot
    (`ready`+`reset`) truncating an empty collection is a no-op, and the earlier
    stray broadcast then gets re-written by the snapshot: with `reset` this is
    consistent. Without serialization the *delta* path (no reset) has no such
    healing.
  - **Write commits *after* the snapshot read but its broadcast is sent before the
    snapshot batches** (the awaits in `onConnect` allow this): client receives
    seq N+1 then snapshot at N. If N+1 was an `update`/`delete` for a row the
    client doesn't hold yet, the TanStack sync write can throw; the client's
    `lastSeq` also advances to N+1 so a later `?since=N+1` never re-fetches it.
  - Serializing `onConnect` closes both: no write can commit or broadcast between
    the snapshot/delta read and the sends.

- `ws.send` is a synchronous enqueue (see the §9 comment in
  `docs/architecture.md:197-204`), so holding the queue across the send loop does
  not block on network I/O — the deadlock risk is only in holding it across
  *adapter* awaits, which the write path already does by design.

## Commands you will need

| Purpose   | Command                  | Expected on success |
|-----------|--------------------------|---------------------|
| Typecheck | `pnpm typecheck`         | exit 0              |
| Unit tests | `pnpm test`             | all pass            |
| Integration | `pnpm test:integration` | all pass           |

## Scope

**In scope**:
- `src/server/party-db-server.ts` — `onConnect` only
- `test/integration/reconnect.test.ts` (or a new `connect-race.test.ts`) — one
  interleaving test

**Out of scope**:
- `serialize()` itself — its semantics are correct; don't redesign it.
- The adapter, the client, the protocol.
- Any attempt to buffer/replay broadcasts per-connection (a heavier design that was
  considered; the queue reuse is the chosen fix).

## Git workflow

- Branch: `advisor/004-serialize-connect`
- Commit style: `fix(server): serialize onConnect's snapshot read+send with the write queue`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Route `onConnect` through `serialize`

Wrap the body of `onConnect` in `this.serialize(async () => { … })` (the same
pattern `onRequest` uses), so the cursor parse, adapter read, and send loop happen
with no write interleaved. Keep the method `async` and `await` the serialized run
so partyserver's lifecycle sees completion. Update the §9-adjacent comment above
the method to say connects are ordered with writes and why.

**Verify**: `pnpm typecheck && pnpm test:integration` → all existing tests pass
(ordering of existing single-client tests is unaffected).

### Step 2: Add an interleaving integration test

Deterministically forcing the microtask interleaving from outside is not reliable;
test the *invariant* instead. In the integration suite (conventions per plan 001):
fire a batch of concurrent connects and writes at one room, e.g.:

```ts
const results = await Promise.all([
  post(room, insert('w1', 'a')),
  connect(room),
  post(room, insert('w2', 'b')),
  connect(room),
  post(room, insert('w3', 'c')),
])
```

For each connected client, wait until it has observed all three rows (via snapshot
and/or broadcasts), then assert per-client invariants:
- **Monotonic delivery**: the `seq` values of received batches never decrease.
- **No loss**: the union of snapshot rows + broadcast ops covers w1–w3 exactly once
  per client (a row may legitimately appear in both a broadcast and a later `reset`
  snapshot — assert on final state reconstruction, not raw duplication, for
  `reset` batches; with serialization in place a non-reset batch older than the
  snapshot must NOT arrive after it).

Run the test with `--repeats` if flakiness is suspected (vitest `repeats: 20` on
this one test is acceptable given each run is fast).

**Verify**: `pnpm test:integration` → passes repeatedly
(`pnpm test:integration -- --repeat 5` or set `repeats` in the test options —
check vitest 4's current flag name before using it).

## Test plan

Step 2 is the test plan. Also re-run the whole suite:
`pnpm typecheck && pnpm test && pnpm test:integration` → green.

## Done criteria

- [ ] `onConnect`'s read+send runs inside `this.serialize(...)` (visible in the diff)
- [ ] New integration test asserts per-client monotonic seq delivery under concurrent connect+write
- [ ] All suites green: `pnpm typecheck && pnpm test && pnpm test:integration`
- [ ] No files outside the in-scope list modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

- Serializing `onConnect` deadlocks or times out any existing integration test —
  that means something in the connect path re-enters the queue (report the stack).
- partyserver's `onConnect` contract turns out to require synchronous completion
  before messages can be sent (i.e. sends from inside the serialized closure don't
  reach the socket) — report what you observed.
- The live `onConnect` no longer matches the "unserialized" shape (someone fixed it
  independently).

## Maintenance notes

- The D1 adapter (roadmap) is the real beneficiary: its `replaySince`/`snapshot`
  awaits are network round-trips, turning this race from theoretical to routine.
  When that adapter lands, this test suite is the regression net.
- Reviewer: confirm the serialized closure doesn't hold the queue across anything
  slower than adapter reads + synchronous `ws.send` enqueues.
- Deferred alternative (buffering broadcasts per-connection until snapshot flush)
  is more precise under very high connect churn but adds state; revisit only if
  queue latency shows up in practice.
