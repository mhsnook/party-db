# Plan 016: PostgresAdapter — mode 3, first rung (v1 semantics, oplog beside the data)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 558508f..HEAD -- src/server test/pg test/integration package.json docs/postgres-todo.md`
> Plan 015 is *expected* drift (this plan assumes it landed — read its final
> report for the recorded driver + error-shape facts before starting). Beyond
> that, compare the excerpts below against the live code; on a mismatch, STOP.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: MED (first non-SQLite dialect; connection lifecycle from a DO)
- **Depends on**: **015 (hard — harness, driver choice, recorded facts)**;
  the correctness core (001–006) and 014's `statements.ts` are already landed
- **Category**: feature
- **Planned at**: commit `558508f`, 2026-07-10

## Why this matters

This is the first rung of Postgres support, deliberately split from the WAL:
**mode 3 with v1 semantics**. Same contract as embedded and D1 — `/write`
commits CRUD into your real tables, `RETURNING` captures resolved rows, the
`_oplog` lives beside your data (§6 of `docs/architecture.md`), `?since`
deltas and reset fallbacks behave identically. What you get: party-db on the
database your whole company already runs. What you don't get yet (same caveat
v1 always had, documented): writes that bypass `/write` — cron, other
services, trigger side-effects beyond `RETURNING` — don't sync live until the
WAL rung (`docs/postgres-todo.md`).

Structurally this is a *smaller* port than D1 was: Postgres has real
interactive transactions, so the embedded adapter's shape (apply → decode →
append log, inside one transaction) ports directly — none of D1's
same-batch-JSON gymnastics. The genuinely new work is the dialect (placeholder
style, native types, SQLSTATE errors) and the connection lifecycle from a DO.

## Current state

- `src/server/persistence.ts` — the async `PersistenceAdapter` contract:
  `init` / `write(batches) → SequencedBatch[]` (whole POST atomic, resolved
  ops) / `snapshot` / `replaySince(since) → batches | null`.
- `src/server/statements.ts` — shared builders. `structuredStmt(plan, op)`
  returns `{ sql, binds }` with `?` placeholders and SQLite-flavored encoding
  (`encode`: booleans → 0/1, json → text). `buildPlans` validates identifiers
  once. `resolvedOpJsonExpr`/`oplogInsertStmt` are the D1-only SQL-JSON pieces
  — **not needed here**: with interactive transactions this adapter decodes
  `RETURNING` in JS and inserts the ops JSON directly, like the embedded
  adapter's `applyOne`.
- `src/server/sqlite-adapter.ts` — the transaction shape to mirror:
  per batch: CRUD → `resolveStructured` → `INSERT INTO _oplog … RETURNING seq`;
  `compact()` inside the same transaction; `snapshot()` as a consistent cut;
  `replaySince` with the `MIN(seq)` floor → `null` → the server's reset
  snapshot.
- `src/server/d1-adapter.ts` — the structured-only precedent: blob plans are
  rejected at `init()` with a clear error; `_oplog` is the only library-owned
  table in the user's database.
- `src/server/party-db-server.ts` — `createAdapter()` is the swap seam; the
  catch in `onRequest` classifies constraint errors by the SQLite message
  regex (`isConstraintError` / `constraintOf`). Plan 006's maintenance note
  anticipated this plan's need: **classification must move into the adapter**
  (each engine knows its own phrasing; PG has structured SQLSTATE + constraint
  name, strictly better than any regex).
- Plan 015's report — the recorded facts this plan consumes: chosen driver,
  workerd connectivity verdict, error-object shape, per-kind type round-trips.
- `docs/postgres-todo.md` — the milestone doc. Its §1 ("the write path") is
  what this plan implements; its §2–§3 (WAL, preview/echo settlement) remain
  the second rung. Its `seq = LSN` framing applies to the WAL rung, **not**
  here — this rung's `seq` is the `_oplog`'s own sequence, same as every other
  mode.

## Design notes (settled here, verified by tests)

- **`_oplog` DDL**: `seq BIGSERIAL PRIMARY KEY, channel TEXT NOT NULL, ops JSONB NOT NULL`.
  PG sequences burn numbers on rollback, so *gaps inside the retained window
  are normal* — harmless: cursors only ever come from delivered seqs, ordering
  and the floor check (`since + 1 < min`) never assume contiguity. Note it in
  a comment so nobody "fixes" it. `Number(seq)` is fine (2^53 is not a real
  room's oplog); the `Cursor` type already tolerates strings if that ever
  changes.
- **Dialect seam, not a fork**: `structuredStmt`'s SQL is placeholder-`?` +
  quoted identifiers; add a small renderer (`toPg(sql)` → `$1…$n`) plus a PG
  codec beside `columns.ts`'s (`pgEncode`/`pgDecode` per `ColumnKind`:
  booleans native, json/jsonb per the driver behavior 015 recorded, numbers
  per its bigint findings). Do NOT edit the SQLite `encode`/`decode`.
- **Error classification moves into the adapter**: extend `PersistenceAdapter`
  with an optional `classifyError?(e: unknown): WriteReject | null`. The
  server's catch consults it first and falls back to the existing regex
  (embedded + D1 keep today's behavior unchanged); the PG adapter maps
  SQLSTATE class `23…` → 409 with the *named* constraint, everything else →
  the generic-500 path. This is the plan-006 follow-through, kept minimal.
- **Connection lifecycle**: the adapter takes a lazily-connected client (or
  factory) for the chosen driver. In production the connection string comes
  from a Hyperdrive binding or env var — document, don't abstract. One
  in-flight transaction at a time is already guaranteed by the server's
  serialize queue; on connection failure, fail the POST (client rolls back,
  retries) and reconnect on next use — no retry loops inside the adapter.
- **Consistency**: `write()` = one `BEGIN…COMMIT` around the whole POST
  (+ compaction). `snapshot()` = one transaction reading the watermark and
  every table (a consistent cut, same as embedded). `replaySince` = the same
  two queries over PG.
- **Structured-only, one room per database/partition** — both exactly as D1
  (same init error, same documented scope constraint).

## Commands you will need

| Purpose   | Command                  | Expected on success |
|-----------|--------------------------|---------------------|
| Typecheck | `pnpm typecheck`         | exit 0              |
| Unit      | `pnpm test`              | all pass            |
| PG lanes  | `pnpm test:pg`           | all pass (PG up)    |
| Workerd   | `pnpm test:integration`  | all pass            |

## Scope

**In scope**:
- `src/server/pg-adapter.ts` (create)
- `src/server/statements.ts` — the `toPg` renderer only (additive)
- `src/server/columns.ts` or a sibling — the PG codec (additive)
- `src/server/persistence.ts` — optional `classifyError` on the contract
- `src/server/party-db-server.ts` — consult `classifyError` in the catch (fallback unchanged)
- `src/server/index.ts` (export)
- `test/pg/pg-adapter.test.ts` (create — node lane, the bulk of coverage)
- `test/integration/pg.test.ts` (create — workerd lane, if 015 proved connectivity)
- `docs/architecture.md` — mode 3 status line when done; `docs/postgres-todo.md` —
  mark §1 landed via this plan, two-rung sequencing note; `README.md` milestone line

**Out of scope**:
- WAL / logical replication / `pg_logical_emit_message` — rung 2, all of it.
- RPC, access policies (plan 017), Supabase/PostgREST variants.
- Editing the SQLite/D1 adapters beyond the additive seams named above.

## Git workflow

- Branch: `advisor/016-postgres-adapter`
- Commit style: `feat(server): PostgresAdapter — mode 3 write path, oplog beside the data`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Dialect pieces, test-first on the node lane

`toPg` renderer + PG codec, unit-tested against the real PG from 015's
harness: for each `ColumnKind`, round-trip a row through
`INSERT … RETURNING *` → `pgDecode` and assert deep-equality with what the
SQLite path's `decodeRow` would produce for the same logical row — the wire
must not care which database resolved it.

**Verify**: `pnpm test:pg` green; parity assertions explicit.

### Step 2: `PgAdapter`

Mirror `SqliteAdapter`'s structure over the driver's async transaction API:
`init` (create `_oplog`; reject blob plans), `write` (one transaction:
per-batch CRUD via `toPg(structuredStmt(…))` → `resolveStructured` with the
PG codec → oplog insert `RETURNING seq` → compact), `snapshot`, `replaySince`
(floor → `null`), `classifyError` (SQLSTATE → `WriteReject` with named
constraint).

**Verify**: `pnpm test:pg` — port the adapter suite cases: resolved rows
(defaults/serials/boolean/jsonb round-trip), whole-POST atomicity (failing
second batch rolls back the first *and* the oplog *and* burns-but-doesn't-emit
a seq), compaction + floor fallback, injection safety (smuggled payload keys
ignored), update-of-missing no-op, constraint rejection carrying the
constraint's real name.

### Step 3: Server consults the adapter's classifier

Wire `classifyError` into `onRequest`'s catch ahead of the regex fallback.

**Verify**: `pnpm test && pnpm test:integration` — embedded + D1 behavior
byte-identical (existing 409/500 tests untouched); a PG-lane test asserts the
409 body's `constraint` is the PG constraint name.

### Step 4: Workerd integration lane

If 015 proved pool connectivity: a `PgRoom` fixture (createAdapter override,
`PG_URL` via bindings, tables created in `onStart` through the driver),
`test/integration/pg.test.ts` mirroring the D1 suite — round-trip with
resolved row, atomic multi-batch rollback, `?since` delta + stale-cursor reset,
order under concurrent POSTs. `skipIf` no `PG_URL`, like every PG lane.

**Verify**: `pnpm test:integration` green with PG up, skips without.

### Step 5: Documentation

- `docs/architecture.md` §1 ratchet: mode 3 status — landed, write-path rung;
  one sentence on what stays invisible until the WAL (out-of-band writers).
- `docs/postgres-todo.md`: mark §1 done via this plan; add the two-rung
  sequencing note (rung 1 = this adapter, oplog echo; rung 2 = WAL as the
  stream, §§2–3) so the doc stops reading as all-or-nothing.
- `README.md`: milestone 2 line — Postgres write path shipped, WAL pending.

**Verify**: read back; decision-record voice; no plans/* links in
architecture.md.

## Test plan

Steps 1–4. Full gate: `pnpm typecheck && pnpm test && pnpm test:pg &&
pnpm test:integration` green in CI.

## Done criteria

- [ ] `PgAdapter` implements the contract; swap-in is a `createAdapter()` override; server untouched except the classifier seam
- [ ] Whole-POST atomicity incl. oplog proven on real PG; seq gaps documented as normal
- [ ] Wire parity: same logical write resolves to deep-equal ops on SQLite and PG (Step 1 assertions)
- [ ] Constraint rejections carry SQLSTATE-derived names; embedded/D1 error behavior unchanged
- [ ] `?since` delta + floor→reset behave identically to the other modes (integration-tested if the pool lane exists)
- [ ] Docs updated (ratchet status, postgres-todo §1 + two-rung note, README); only in-scope files modified; `plans/README.md` updated

## STOP conditions

- 015's report says workerd cannot reach PG — Step 4 becomes a maintainer
  scope decision (node-lane-only coverage vs. blocking); do not silently skip.
- The driver's transaction API can't express one-transaction-per-POST with
  mid-transaction reads (it can — but if the chosen driver's Workers build
  differs, report).
- SQLSTATE/constraint fields are absent from driver errors in practice
  (contradicts 015's recorded facts — reconcile before building classification).
- Any existing embedded/D1 test needs its assertion changed — this plan is
  additive; that's a regression.

## Maintenance notes

- Rung 2 (WAL) replaces this adapter's *echo*, not the adapter: `/write` and
  the oplog stay; the ack becomes a preview and the tail becomes the
  authoritative stream (`docs/postgres-todo.md` §§2–3). Design nothing here
  that assumes the oplog is forever the only stream source.
- `classifyError` is the pattern for any future engine (MySQL, whatever):
  classification lives with the dialect, never in server regexes.
- If per-room databases multiply, the one-room-per-database constraint is the
  first thing users will push on — the answer is rung 2's demux story, not a
  room column hack here.
