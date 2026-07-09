# Plan 014: D1 adapter — the second v1 persistence target (oplog rides the same batch)

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
- **Effort**: M
- **Risk**: MED (new storage target; the resolved-op-JSON-in-SQL builder is the
  one genuinely novel piece)
- **Depends on**: plans/001 (harness), 002 (result-cursor discipline — D1's
  result API is a third dialect), **003 (hard** — the `reset` snapshot is the
  stale-cursor fallback, same as embedded), **004 (hard** — the connect-race
  window becomes a real network round-trip on D1, and snapshot consistency
  depends on connects being serialized with writes), 006 (error split; see
  maintenance notes)
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

- `src/server/sqlite-adapter.ts:91-125` — the shape that does NOT port to D1
  as-is: `write()` wraps `transactionSync`, and inside it each batch's CRUD
  statements run, their `RETURNING` rows are decoded to *resolved ops* in JS,
  and the resolved-ops JSON is then INSERTed into `_oplog` — a
  read-compute-write interleave *inside* one transaction. D1 has **no
  interactive transactions**: its only atomic unit is `batch(stmts)`, a
  statement list built entirely up front. The design below moves the
  "compute the resolved-ops JSON" step *into SQL* so the interleave disappears.
- `src/server/sqlite-adapter.ts:130-185` — the statement *text* and bind logic
  (insert with present-columns + `RETURNING *`, partial-SET update, delete,
  blob upsert) plus `encode`/`decodeRow` and the per-column `kinds` map from
  `columns.ts` — all reusable; the kinds map is also what the SQL-side JSON
  builder consumes.
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
  `isConstraintError` from plan 006); SQLite JSON functions (`json`,
  `json_object`, `json_array`, `json_group_array`) are available in D1's
  SQLite build.

## Prior art: `@tanstack/db-sqlite-persistence-core` (read, borrowed from, not used)

TanStack DB's SQLite persistence family (browser/node/expo/… over one core)
keeps an oplog of its own: an `applied_tx` table
`(collection_id, term, seq, tx_id, row_version, replay_json, …)` whose
`replay_json` stores whole **resolved values** per committed transaction;
`pullSince(cursor)` replays those deltas in order, returns
`requiresFullReload: true` when the cursor predates the pruned floor, and
prunes by max-rows and max-age. That is convergently our `_oplog` design
(resolved ops JSON, seq cursor, compaction floor → fresh snapshot), which is
good evidence the shape is right.

Why we don't *use* it: it is a **client cache journal**, not an authority log
(architecture §13) — it persists collections as `(key, value-JSON)` blobs in
tables it owns, while our data must live in the user's real columns that we
never DDL; its driver contract assumes interactive transactions (awaits
mid-transaction — precisely what D1 lacks); and its `term`/leader machinery
solves browser multi-tab coordination we don't have.

What we borrow: (a) the validation of the replay-log shape we already built;
(b) the **delta-size threshold** idea (`pullSinceReloadThreshold`, default 128
there): past some backlog size, a reset snapshot is cheaper than a delta — see
maintenance notes; (c) optionally, age-based pruning alongside rows-based.

## The design (recorded here, premises confirmed in Step 1)

Everything lives in D1 — user tables, blob tables, **and the `_oplog`** — and
the whole POST is still ONE `batch()`. The trick that makes the oplog append
buildable up front: instead of computing the resolved-ops JSON in JS between
statements (the embedded adapter's interleave), the oplog INSERT assembles it
*in SQL*, reading back the rows the earlier statements in the same batch just
wrote:

```sql
-- per channel-batch, after its CRUD statements:
INSERT INTO _oplog (channel, ops) VALUES (?, json_array(
  -- one expression per op, in op order:
  json(COALESCE(
    (SELECT json_object('type', 'insert', 'value',
       json_object('id', id, 'text', text,
                    'done', json(CASE done WHEN 1 THEN 'true' ELSE 'false' END),
                    'meta', json(meta)))
     FROM "todos" WHERE "id" = ?),
    ?  -- fallback: the sent op, pre-serialized (update-of-missing → no-op echo)
  )),
  json(?)  -- a delete op: value is the sent row, known up front
)) RETURNING seq
```

- The `json_object` column list is generated from the collection's `kinds`
  map — the SQL mirror of `decodeRow` (booleans via CASE → `json('true')`,
  json columns via `json(col)`, numbers/text/null pass through). One builder
  function owns this; a parity test pins it to the embedded adapter's output.
- `json(…)` wrapping is load-bearing: SQLite's JSON subtype does not survive
  scalar subquery boundaries, so each element is re-parsed explicitly.
- Statement order per POST: batch₁ CRUD…, batch₁ oplog INSERT, batch₂ CRUD…,
  batch₂ oplog INSERT, …, compaction DELETE. All one `batch()` → the data,
  the log, and the `seq`s (AUTOINCREMENT via `RETURNING seq`) commit
  atomically or not at all. Nothing can tear, and `?since` deltas work
  **identically to embedded**: `replaySince` is the same query over D1
  (`null` past the compaction floor → the server's plan-003 reset snapshot),
  `snapshot()` is a consistent read batch (watermark + tables), and
  `oplogRetention` keeps its meaning.
- The DO remains the room server and the serialization authority (queue,
  socket, broadcast) — that part is invariant across every mode; it just holds
  no persistent state of its own for this adapter.

Rejected alternatives, for the record: a DO-side mirror of the oplog (second,
non-atomic write per POST — a torn-log edge bought for nothing once the
same-batch append exists); dropping the oplog and `?since` entirely (works,
but degrades every reconnect to a full snapshot — rejected by the maintainer);
and adopting the TanStack persistence package (wrong side of the authority
line, see Prior art).

The remaining inherent edge (any remote database has it, v2 Postgres
included): D1 commits and the DO dies before the ack — the writer rolled back
a row that exists, and retrying the same insert 409s on its own PK. Document
it (Step 6); every other client converges via broadcast-less oplog replay on
reconnect.

Scope constraint, also documented: **one room per D1 database** (or strictly
disjoint per-room row partitions). Rooms don't see each other's writes — the
fan-out source is the room's own `/write` path and `_oplog`, not a D1 change
feed (D1 has none; that's the v2 Postgres/WAL story).

## Commands you will need

| Purpose   | Command                  | Expected on success |
|-----------|--------------------------|---------------------|
| Typecheck | `pnpm typecheck`         | exit 0              |
| Unit tests | `pnpm test`             | all pass            |
| Integration | `pnpm test:integration` | all pass           |

## Scope

**In scope**:
- `src/server/statements.ts` (create — shared statement builders + the
  resolved-op-JSON expression builder)
- `src/server/sqlite-adapter.ts` (refactor to use the builders; no behavior change)
- `src/server/d1-adapter.ts` (create)
- `src/server/index.ts` (export)
- `test/integration/worker.ts`, `vitest.integration.config.ts` (D1 fixture + binding)
- `test/integration/d1.test.ts` (create)
- `test/statements.test.ts` (create — incl. the oplog-JSON parity cases)
- `docs/architecture.md` — flip the v1 D1 status line when done; the
  limitations sentence (Step 6)
- `README.md` — milestone line only

**Out of scope**:
- `src/server/party-db-server.ts` — `createAdapter()` is already the override
  seam; the default stays embedded SQLite. If you find a server change is
  needed, STOP and report.
- The client — nothing changes on the wire.
- Cross-room D1 sharing, D1 read replicas, any change-feed emulation.
- The delta-size threshold knob (maintenance note, not this plan).
- Hyperdrive/external Postgres — that's `docs/postgres-todo.md`.

## Git workflow

- Branch: `advisor/014-d1-adapter`
- Commit style: `feat(server): D1 adapter — one batch() commits data + oplog + seq`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Spike — verify D1 semantics inside the harness

Add the D1 binding to `vitest.integration.config.ts` (check the installed
`@cloudflare/vitest-pool-workers` docs for the `d1Databases` option shape) and
write a small `test/integration/d1-semantics.test.ts` against the **raw
binding** (no adapter yet):

1. `batch()` of two inserts where the second violates a PK → the first did NOT
   commit (atomicity) and the thrown message contains `constraint failed`.
2. A `batch()` of `INSERT … RETURNING *` statements → each `D1Result.results`
   carries that statement's resolved row.
3. The design's JSON premise: in one `batch()`, insert a row into a table with
   integer/boolean-ish/json-text columns, then
   `INSERT INTO probe_log (ops) VALUES (json_array(json(COALESCE((SELECT json_object(…) FROM t WHERE id = ?), ?)))) RETURNING rowid`
   → the stored `ops` string parses to exactly the expected JSON (booleans as
   `true`/`false`, json column as an object, not a double-encoded string).
4. Record the bound-parameter / batch-size limits you find in the pool's D1.

**Verify**: the semantics tests pass and confirm the premises. If any premise
fails, that's a STOP condition.

### Step 2: Extract shared statement builders

Pull the SQL-text + bind construction out of `SqliteAdapter.applyStructured`/
`applyBlob` into `src/server/statements.ts`: given a plan and a `WriteEvent`,
return `{ sql, binds }` (and the decode recipe) without executing anything.
Add the new piece: `resolvedOpJsonExpr(plan, op)` — the per-op SQL expression
from the design sketch, generated from the `kinds` map. Refactor
`SqliteAdapter` to consume the CRUD builders (byte-identical SQL; it does NOT
need the JSON builder — its JS-side `decodeRow` path stays).

**Verify**: `pnpm test` → the full unit suite passes **unmodified** (the
existing adapter tests are the proof of no behavior change). New
`test/statements.test.ts` covers `resolvedOpJsonExpr` output shape per column
kind, plus the **parity case**: run the same write through the embedded
adapter and through the JSON expression evaluated on `node:sqlite` — the two
oplog `ops` strings parse to deep-equal values.

### Step 3: Implement `D1Adapter`

`src/server/d1-adapter.ts`, constructor
`(d1: D1Database, collections, opts: { oplogRetention? })`:

- `init()`: create `_oplog`, the blob tables, and nothing else, via `d1.exec`
  (we own those; structured tables stay the user's, we never DDL them).
- `write(batches)`: build the full statement list — per channel-batch its CRUD
  statements then its oplog INSERT (Step 2's builders), then the compaction
  DELETE (same `retention` logic as embedded) — ONE `d1.batch(all)`; map each
  CRUD statement's `D1Result` back to its op and decode resolved rows for the
  *returned* `SequencedBatch[]` (update-of-missing falls back to the sent
  value — read result arrays, never a `.one()`-style single-row assumption;
  plan 002's rule); each batch's `seq` comes from its oplog statement's
  `RETURNING seq`.
- `snapshot()`: one read `batch()` — `MAX(seq)` watermark + every table —
  which D1 runs transactionally, so the cut is consistent; `ready: true` on
  each batch (the fresh-connect path; `reset` continues to ride on the
  fallback path exactly as the embedded adapter does it — mirror its
  behavior, don't invent).
- `replaySince(since)`: same two queries as embedded (`MIN(seq)` floor check →
  `null` past the floor; else `SELECT … WHERE seq > ? ORDER BY seq`), just
  over D1.

**Verify**: `pnpm typecheck` → exit 0. Unit-test the statement-list assembly
and result-mapping against faked `D1Result[]`s in `test/` — the real engine is
covered by Step 5.

### Step 4: Wire the fixture

In `test/integration/worker.ts`, add a `D1Room extends PartyDbServer` that
overrides `createAdapter()` to return the `D1Adapter` over `this.env.DB`
(forwarding `oplogRetention`), and creates its `todos` table in D1 in
`onStart` (D1 DDL is async — await it before `super.onStart()`). Bind the
class + database in `vitest.integration.config.ts`.

**Verify**: `pnpm test:integration` → existing suites still green (the new
party is additive; don't touch `Main`'s shape — plan 006's lesson).

### Step 5: The D1 integration suite

`test/integration/d1.test.ts`, mirroring the core `sync.test.ts` +
`reconnect.test.ts` cases against the `D1Room` party:

1. Round-trip: insert → 200 ack with the **resolved** row (D1 defaults
   applied) → broadcast → fresh client's snapshot has it.
2. Atomicity: a two-batch POST where the second batch violates a constraint →
   409, neither batch's rows exist in D1, **and `_oplog` gained no entries**
   (the log rolled back with the data — the design's core claim).
3. Reconnect delta: `?since` mid-stream replays exactly the gap, with the
   **resolved** rows (the SQL-assembled oplog JSON round-trips the wire).
4. Stale cursor past the compaction floor → `reset: true` fresh snapshot
   (retention configured small on the fixture, as `Main` does).
5. Broadcast order == seq order under concurrent POSTs (the serialize queue's
   guarantee, now with real awaits in the middle).
6. Update-of-missing-row → 200 no-op with the sent value (plan 002 parity),
   and its oplog entry carries the sent value (the `COALESCE` fallback).

**Verify**: `pnpm test:integration` → all pass, repeatedly (run the suite a
few times; the async adapter is where interleaving flakes would surface).

### Step 6: Documentation

- `docs/architecture.md`: flip the Roadmap v1 status line (embedded **and** D1
  landed); one short sentence on the D1 trade-offs where the roadmap already
  discusses them, naming the documented limitations: one room per D1 database,
  and the committed-but-unacked retry edge.
- `README.md`: milestone line only.

**Verify**: read back; keep the decision-record voice.

## Test plan

Steps 1, 2 (parity), 3 and 5 are the test plan. Full gate:
`pnpm typecheck && pnpm test && pnpm test:integration` → green.

## Done criteria

- [ ] `D1Adapter` implements `PersistenceAdapter`; swap-in is a `createAdapter()` override, server untouched
- [ ] ONE `d1.batch()` per POST carries CRUD + oplog appends + compaction; no second write anywhere (visible in the diff)
- [ ] `?since` deltas on D1 behave identically to embedded (delta, floor → reset snapshot) — integration-tested
- [ ] Oplog-JSON parity test: embedded adapter and SQL-assembled JSON produce deep-equal ops for the same write
- [ ] `SqliteAdapter` and `D1Adapter` share one statement-builder module; unit suite passed the refactor unmodified
- [ ] The documented limitations are in `docs/architecture.md` (one-room-per-database, unacked-commit retry edge)
- [ ] All suites green; only in-scope files modified; `plans/README.md` updated

## STOP conditions

- Step 1 disproves a premise: `batch()` is not atomic, or its results don't
  carry `RETURNING` rows per statement, or the JSON-assembly probe produces
  double-encoded/wrong-typed values that `json()` wrapping cannot fix, or
  constraint failures lack a `constraint failed` substring (then error
  classification must move into the adapter contract first — see maintenance
  notes), or the pool can't bind D1 alongside the DO classes.
- The statement-builder extraction (Step 2) cannot be made behavior-identical
  (any existing adapter test needs its assertion changed).
- The parity test finds a column kind the SQL builder cannot reproduce
  faithfully — report the kind and the divergence; do not ship a
  silently-different oplog encoding.
- Plan 004 has not landed (check `plans/README.md`) — do not proceed; the
  snapshot-consistency argument depends on it.
- A batch/parameter limit found in Step 1 is low enough that a plan-005-sized
  write (`maxWriteOps`) plus its oplog statements can't fit in one `batch()` —
  report the numbers; the fix (lower the cap vs. chunk the batch) is an
  operator decision because chunking breaks whole-POST atomicity.

## Maintenance notes

- Plan 006's `isConstraintError` lives in the server and matches SQLite
  phrasing. If D1's phrasing differs even slightly, do what 006's maintenance
  note anticipated: move classification into the `PersistenceAdapter` contract
  (each adapter knows its engine) rather than growing the regex.
- Borrowed-but-deferred from `@tanstack/db-sqlite-persistence-core`: a
  **delta-size threshold** (their `pullSinceReloadThreshold`, default 128) —
  past some backlog size a reset snapshot is cheaper than replaying the delta.
  Applies to the embedded adapter too; add as one `replaySince` guard + knob
  when someone hits a slow reconnect, not before.
- The statement builders (CRUD + the resolved-op JSON expression) are the
  pieces the v2 Postgres adapter revisits — Postgres gets its resolved rows
  from the WAL instead, but the CRUD dialect seam should stay free of
  SQLite-isms where cheap.
- Snapshot chunking (one WS frame per table) was deferred at audit time
  ("revisit when D1 lands") — re-evaluate against real room sizes once this
  plan is done.
