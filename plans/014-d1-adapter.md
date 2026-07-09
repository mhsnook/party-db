# Plan 014: D1 adapter — the second v1 persistence target

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 7fea950..HEAD -- src/server test/integration vitest.integration.config.ts src/protocol.ts`
> Plans 001–006 are *expected* drift in these files — this plan assumes they
> have landed (see Depends on). Beyond that, compare the "Current state"
> excerpts against the live code; on a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: MED (new storage target; one real design decision inside)
- **Depends on**: plans/001 (harness), 002 (result-cursor discipline — D1's
  result API is a third dialect), 003+005 (reset marker + retention default —
  the reconnect paths D1's latency stresses), **004 (hard** — the connect-race
  window becomes a real network round-trip on D1), 006 (error split; see
  maintenance notes on classification)
- **Category**: feature
- **Planned at**: commit `7fea950`, 2026-07-09

## Why this matters

This is the headline of v1 and of the first publish: "embedded *or* D1"
(`docs/architecture.md`, Roadmap). D1 is the first target other consumers can
actually read — the moment "your database is the global API" stops being a
slogan. The seam was built for it in advance: `PersistenceAdapter` is async,
`onRequest` serializes its write → seq → broadcast section behind a promise
queue, and capture is via `RETURNING`. What's missing is the adapter itself.

## Current state

- `src/server/persistence.ts` — the contract the adapter must satisfy:
  `init()` / `write(batches) → SequencedBatch[]` (whole POST atomic, resolved
  rows) / `snapshot()` / `replaySince(since) → batches | null`. All async by
  design; the header comment names D1 as the reason.
- `src/server/party-db-server.ts:43-49` — the swap point:

  ```ts
  // Override to swap the storage target (e.g. a D1 adapter). Default: the DO's
  // own embedded SQLite.
  protected createAdapter(): PersistenceAdapter {
    const engine: SqlEngine = {
      exec: (query, ...bindings) => this.ctx.storage.sql.exec(query, ...bindings),
      transaction: (fn) => this.ctx.storage.transactionSync(fn),
    }
    return new SqliteAdapter(engine, this.collections, { oplogRetention: this.oplogRetention })
  }
  ```

- `src/server/sqlite-adapter.ts:91-125` — the shape that does NOT port to D1:
  `write()` wraps `transactionSync`, and inside it each batch's CRUD statements
  run, their `RETURNING` rows are decoded to *resolved ops* in JS, and the
  resolved-ops JSON is then INSERTed into `_oplog` — a read-compute-write
  interleave *inside* one transaction. D1 has **no interactive transactions**:
  its only atomic unit is `batch(stmts)`, a statement list built entirely up
  front. You cannot compute the oplog JSON between statements of one batch.
- `src/server/sqlite-adapter.ts:130-185` — the statement *text* and bind logic
  (insert with present-columns + `RETURNING *`, partial-SET update, delete,
  blob upsert) plus `encode`/`decodeRow` from `columns.ts` — all reusable
  verbatim; only the transaction shape isn't.
- `vitest.integration.config.ts` — miniflare config with `durableObjects`
  bindings; `@cloudflare/vitest-pool-workers` also supports **D1 bindings**
  (`d1Databases`) — check the installed pool's docs for the exact option shape.
- `test/integration/worker.ts` — `Main` (todos table in `onStart`) and
  `Guarded`; new fixtures follow this pattern.
- D1 API facts to verify in Step 1 (do not code against memory):
  `prepare(sql).bind(...)` with `?` placeholders; `batch(stmts)` runs as one
  implicit transaction, rolls back entirely on any failure, and returns one
  `D1Result` per statement whose `results` carry that statement's rows
  (including `RETURNING` rows); `exec()` for DDL; per-statement bound-parameter
  and per-batch size limits exist — record the current numbers; constraint
  failures surface with a message containing `constraint failed` (needed by
  `isConstraintError` from plan 006).

## The design decision (recorded here, confirmed in Step 1)

Two shapes were considered for where the `_oplog` lives:

- **Option A — everything in D1.** The oplog rows must then be written in a
  *second* `batch()` (their JSON depends on the first batch's `RETURNING`
  results), so data-commit and oplog-append are no longer atomic — a crash
  between them leaves committed rows no delta will ever replay. It also makes
  every `replaySince` (every reconnect) a network round-trip. Rejected.
- **Option B — data in D1, oplog in the DO (chosen).** User tables (and the
  blob tables we own) live in D1; `_oplog` and seq-minting stay in the DO's
  embedded SQLite. The write path, inside the server's existing `serialize`
  queue: build all statements across all batches → one `d1.batch()` (the whole
  POST stays all-or-nothing, constraints judge, §5) → decode `RETURNING` rows
  to resolved ops → append per-batch oplog entries locally (synchronous) →
  return sequenced batches. `seq` remains the authority's commit-log position
  (§6) minted by the single serialization authority (the DO); `replaySince`
  stays local and fast; `snapshot()` reads the watermark locally and the tables
  from D1, and is consistent because connects are serialized with writes
  (plan 004 — this is why it's a hard dependency).

  The accepted edge: a crash *between* the D1 commit and the local oplog
  append means committed rows that never fan out or replay (they do appear in
  fresh/reset snapshots, which read D1). The POST never acked, so the writer's
  optimistic state rolled back — but a retry of the same insert will 409 on
  the already-committed PK. Document this as a known v0.1 limitation (Step 6);
  the WAL story (docs/postgres-todo.md) is the real fix for
  authority-log-vs-data divergence, not more machinery here.

  Scope constraint, also documented: **one room per D1 database** (or strictly
  disjoint per-room row partitions). Rooms don't see each other's writes — the
  fan-out source is the room's own oplog, not a D1 change feed (D1 has none;
  that's the v2 Postgres/WAL story). A D1 database written by several rooms or
  by anything that isn't this room's `/write` will serve stale-looking rooms.

## Commands you will need

| Purpose   | Command                  | Expected on success |
|-----------|--------------------------|---------------------|
| Typecheck | `pnpm typecheck`         | exit 0              |
| Unit tests | `pnpm test`             | all pass            |
| Integration | `pnpm test:integration` | all pass           |

## Scope

**In scope**:
- `src/server/statements.ts` (create — shared statement builders)
- `src/server/sqlite-adapter.ts` (refactor to use the builders; no behavior change)
- `src/server/d1-adapter.ts` (create)
- `src/server/index.ts` (export)
- `test/integration/worker.ts`, `vitest.integration.config.ts` (D1 fixture + binding)
- `test/integration/d1.test.ts` (create)
- `test/statements.test.ts` (create, if the extraction warrants direct cases)
- `docs/architecture.md` — flip the v1 D1 status line when done; add the
  limitations sentence (Step 6)
- `README.md` — milestone line only

**Out of scope**:
- `src/server/party-db-server.ts` — `createAdapter()` is already the override
  seam; the default stays embedded SQLite. If you find a server change is
  needed, STOP and report.
- The client — nothing changes on the wire.
- Cross-room D1 sharing, D1 read replicas, any change-feed emulation.
- Hyperdrive/external Postgres — that's `docs/postgres-todo.md`.

## Git workflow

- Branch: `advisor/014-d1-adapter`
- Commit style: `feat(server): D1 adapter — data in D1, oplog in the DO`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Spike — verify D1 semantics inside the harness

Add the D1 binding to `vitest.integration.config.ts` (check the installed
`@cloudflare/vitest-pool-workers` docs for the `d1Databases` option shape) and
write a small `test/integration/d1-semantics.test.ts` against the **raw
binding** (no adapter yet): `batch()` of two inserts where the second violates
a PK → assert the first did NOT commit (atomicity) and the thrown message
contains `constraint failed`; a `batch()` of `INSERT … RETURNING *` statements
→ assert each `D1Result.results` carries that statement's resolved row.
Record the bound-parameter / batch-size limits you find in the pool's D1.

**Verify**: the semantics tests pass and confirm the design's premises. If any
premise fails, that's a STOP condition (listed below).

### Step 2: Extract shared statement builders

Pull the SQL-text + bind construction out of `SqliteAdapter.applyStructured`/
`applyBlob` into `src/server/statements.ts`: given a plan and a `WriteEvent`,
return `{ sql, binds }` (and the decode recipe) without executing anything.
Refactor `SqliteAdapter` to consume them. Pure refactor — byte-identical SQL.

**Verify**: `pnpm test` → the full unit suite passes **unmodified** (the
existing adapter tests are the proof of no behavior change).

### Step 3: Implement `D1Adapter`

`src/server/d1-adapter.ts`, constructor
`(d1: D1Database, local: SqlEngine, collections, opts)` — `local` is the DO's
embedded engine for the oplog (same `SqlEngine` seam, so the oplog logic stays
unit-testable against `node:sqlite`):

- `init()`: `_oplog` table via `local`; blob tables via `d1.exec` (we own
  those; structured tables stay the user's, we never DDL them).
- `write(batches)`: build every statement via the Step-2 builders; one
  `d1.batch(all)`; map each statement's `D1Result` back to its op and decode
  resolved rows (update-of-missing falls back to the sent value — read result
  arrays, never a `.one()`-style single-row assumption; plan 002's rule);
  then, per batch, append the resolved-ops JSON to the local `_oplog`
  (+ `compact()`), exactly as `SqliteAdapter.applyOne` does today — consider
  extracting that small oplog append/compact/replay unit into a shared helper
  rather than duplicating it (implementer's choice; keep it boring).
- `snapshot()`: watermark from the local oplog, rows from D1
  (`SELECT * FROM "<table>"` per structured plan; blob tables likewise),
  `ready: true` + the plan-003 `reset` marker, same shape as the SQLite path.
- `replaySince()`: local, unchanged semantics (null past the floor).

**Verify**: `pnpm typecheck` → exit 0. Unit-test what's unit-testable (the
result-mapping given faked `D1Result[]`s; the oplog helper against the node
shim) in `test/` — the real engine is covered by Step 5.

### Step 4: Wire the fixture

In `test/integration/worker.ts`, add a `D1Room extends PartyDbServer` that
overrides `createAdapter()` to return the `D1Adapter` over `this.env.DB`, and
creates its `todos` table in D1 in `onStart` (D1 DDL is async — await it
before `super.onStart()`). Bind the class + database in
`vitest.integration.config.ts`.

**Verify**: `pnpm test:integration` → existing suites still green (the new
party is additive; don't touch `Main`'s shape — plan 006's lesson).

### Step 5: The D1 integration suite

`test/integration/d1.test.ts`, mirroring the core `sync.test.ts` cases against
the `D1Room` party:

1. Round-trip: insert → 200 ack with the **resolved** row (D1 defaults
   applied) → broadcast → fresh client's snapshot has it.
2. Atomicity: a two-batch POST where the second batch violates a constraint →
   409, and **neither** batch's rows exist in D1 or the oplog.
3. Reconnect delta (`?since` mid-stream) and stale-cursor reset snapshot
   (retention fallback) — the plan-001/003 cases, on D1.
4. Broadcast order == seq order under concurrent POSTs (the serialize queue's
   guarantee, now with real awaits in the middle).
5. Update-of-missing-row → 200 no-op with the sent value (plan 002 parity).

**Verify**: `pnpm test:integration` → all pass, repeatedly (run the suite a
few times; the async adapter is where interleaving flakes would surface).

### Step 6: Documentation

- `docs/architecture.md`: flip the Roadmap v1 status line (embedded **and** D1
  landed); one short sentence on the D1 trade-offs where the roadmap already
  discusses them, naming the two documented limitations: the
  crash-between-commit-and-oplog edge, and one-room-per-database scope.
- `README.md`: milestone line only.

**Verify**: read back; keep the decision-record voice.

## Test plan

Steps 1, 3 and 5 are the test plan (semantics spike, unit mapping tests, D1
integration lane). Full gate:
`pnpm typecheck && pnpm test && pnpm test:integration` → green.

## Done criteria

- [ ] `D1Adapter` implements `PersistenceAdapter`; swap-in is a `createAdapter()` override, server untouched
- [ ] `SqliteAdapter` and `D1Adapter` share one statement-builder module; unit suite passed the refactor unmodified
- [ ] D1 integration suite covers: resolved-row round-trip, whole-POST atomicity, delta + reset reconnect, order under concurrency, update-of-missing
- [ ] The two documented limitations are in `docs/architecture.md` (crash edge, one-room-per-database)
- [ ] All suites green; only in-scope files modified; `plans/README.md` updated

## STOP conditions

- Step 1 disproves a premise: `batch()` is not atomic, or its results don't
  carry `RETURNING` rows per statement, or constraint failures lack a
  `constraint failed` substring (then error classification must move into the
  adapter contract first — see maintenance notes), or the pool can't bind D1
  alongside the DO classes.
- The statement-builder extraction (Step 2) cannot be made behavior-identical
  (any existing adapter test needs its assertion changed).
- Plan 004 has not landed (check `plans/README.md`) — do not proceed; the
  snapshot-consistency argument in the design depends on it.
- A batch/parameter limit found in Step 1 is low enough that a plan-005-sized
  write (`maxWriteOps`) can't fit in one `batch()` — report the numbers; the
  fix (lower the cap vs. chunk the batch) is an operator decision because
  chunking breaks whole-POST atomicity.

## Maintenance notes

- Plan 006's `isConstraintError` lives in the server and matches SQLite
  phrasing. If D1's phrasing differs even slightly, do what 006's maintenance
  note anticipated: move classification into the `PersistenceAdapter` contract
  (each adapter knows its engine) rather than growing the regex.
- The chosen shape — authority log local to the serialization authority, data
  in a remote database — is deliberately the same split `docs/postgres-todo.md`
  builds on (DO-held oplog keyed by LSN, data in Postgres). The Postgres
  adapter should reuse the oplog helper and the statement builders' dialect
  seam; keep both free of SQLite-isms where cheap.
- Snapshot chunking (one WS frame per table) was deferred at audit time
  ("revisit when D1 lands") — D1 has now landed when this plan is done;
  re-evaluate against real room sizes before closing the loop on it.
