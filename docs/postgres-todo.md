# Postgres support — the v2 plan

v1 is the SQLite/Durable Object story ([`architecture.md`](./architecture.md),
Roadmap): the DO is the authority, writes commit into structured tables, and realtime covers
exactly the ops that come through `/write`, captured via `RETURNING`. What v1
cannot see — on either the embedded or D1 target — is a change that never came
through `/write`: a cronjob, another service writing the same database, or a
trigger's side-effects on rows our statements didn't return.

v2 removes that blind spot by making Postgres the persistence target and the
**WAL the stream**. Instead of echoing only what `/write` returned, we tail
logical replication and fan out *every* committed change on the watched tables,
whatever its origin. That one shift unlocks the three headline features:

1. **RPC functions** — any Postgres function is callable through the sync
   pipeline, so long as it **yields all its affected rows** (and that's a
   UI-latency nicety, not a correctness requirement — see §4).
2. **WAL tailing** — trigger and cascade effects, cron-written rows, and writes
   made by other systems that aren't on the PartyDB all replicate live, because
   the stream is the database's own commit log, not our write handler's memory
   of what it did.
3. **Simple per-user reads and writes** — a collection-level owner rule (a
   deliberately tiny subset of RLS): one user-id column, one uid from a verified
   JWT, enforced on the write gate and at every read choke point.

Status tags: ✅ done · 🟡 partial · ❌ missing. Priorities: **P0** blocks "done",
**P1** needed for real use, **P2** polish. Settled decisions graduate to
[`architecture.md`](./architecture.md) as they land; genuinely open questions
that outlive this doc go back to [`unspecified.md`](./unspecified.md).

**Sequencing note — two rungs.** Postgres lands in two releasable rungs, and
this doc's sections split across them. **Rung 1** (plans 015–016): the §1
write path with *v1 semantics* — CRUD + `RETURNING`, `_oplog` beside the data,
`?since` deltas — same contract as embedded/D1, on the database your company
already runs; out-of-band writers stay invisible, as in every v1 mode.
**Rung 2** (the rest of this doc): the WAL becomes the stream — §2's tail,
§3's preview/echo settlement — upgrading the same adapter's delivery
guarantees rather than replacing it. §5's per-user rules have meanwhile been
superseded by a simpler, database-agnostic surface: cookbooks 05/06 and plan
017, which run on SQLite/D1 today and carry to Postgres unchanged.

---

## What carries over unchanged

The protocol was built for this. Nothing on the client knows what the authority
is; these seams were left ready on purpose:

- **Wire format** stays `WriteEvent = Omit<ChangeMessage,'key'>` (architecture
  §2). The WAL decoder's job is to produce exactly these.
- **`Cursor` is already `number | string`** (architecture §6) so `seq` can be a
  Postgres **LSN**. We only ever rely on equality and order, never arithmetic —
  both hold for LSNs.
- **`SeqTracker` takes an injectable comparator** (`src/client/seq-tracker.ts`):
  a v2 Postgres LSN is "pass a comparator," nothing else.
- **`PersistenceAdapter` is async** with `init`/`write`/`snapshot`/`replaySince`,
  and `onRequest` already serializes its write → seq → broadcast section behind
  a promise queue (built for D1, reused here).
- **Reconnect delta via `?since`** and the oplog retention/floor-fallback logic
  (`SqliteAdapter.replaySince`) — the DO keeps an oplog of *decoded stream events* keyed by
  LSN, so `?since=<lsn>` replays the gap and a too-old cursor falls back to a
  fresh snapshot, same as today.
- **Lobby auth** (architecture §10) still gates both doors statelessly. v2 adds
  seams *behind* it (per-user rules §5, in-object auth §6), it doesn't replace it.

## What fundamentally changes: write path and stream path decouple

In v1 the echo *is* the write handler's `RETURNING` — one path. On Postgres that
would mis-order under concurrency and miss everything `/write` didn't do, so the
two paths split:

- **Write path (up):** `/write` still applies the batch in order, in one
  transaction, and still captures `RETURNING` rows — but those are now only an
  **optimistic preview** in the ack, not the authoritative echo.
- **Stream path (down):** logical replication decodes the WAL into row-level
  `WriteEvent`s. The WAL is the authoritative, *complete* echo — it carries the
  trigger/cascade/default rows the write never named, and everyone else's
  writes too.

Two properties make the WAL path *more* safely ordered than the raw write
payload, not less:

- **FK-ordering guarantee.** Referential validity in Postgres ⇒ causally-safe
  apply order in the WAL: a child can't appear before its parent (Postgres
  wouldn't have let it commit). Apply each WAL transaction atomically so live-
  query joins never see a partial state.
- **Preview ↔ echo correlation without touching user tables.** Emit
  `pg_logical_emit_message(true, 'wid', <writeId>)` *inside* the `/write`
  transaction — it rides in-band in that transaction's WAL block (PG14+
  `pgoutput` streams logical messages), so no `wid` column on user tables. On
  echo the client swaps its overlay for the canonical rows and **drops any
  optimistic row the WAL didn't confirm** (self-heals an over-yield, which is
  always an app bug).

---

## The list

> Practical ordering: **item 0 (tooling)** first — nothing here is testable
> without a real Postgres, and PGlite doesn't speak the replication protocol.
> Then the write path (§1), then the tail (§2), then settlement over the two
> (§3). RPC (§4) and per-user rules (§5) build on that core loop.

### 0. Tooling: a real Postgres in tests — **P0** ✅ (plan 015)

- [x] **Integration harness against real Postgres** (docker in CI, plus a local
      one-liner). `postgres:17-alpine` runs with `wal_level=logical` from day one,
      so the replication slots / `pgoutput` the WAL rung needs change no
      infrastructure. Two lanes: node-side (`pnpm test:pg`) for fast driver checks,
      workerd-side for the real DO→PG path; both skip cleanly without a PG. The WAL
      *decoder* still wants fixture-stream unit tests when §2 starts.
- [x] **Driver + connection story from a DO.** `pg` (node-postgres) connects from a
      DO over `cloudflare:sockets` (via `nodejs_compat`) cleanly; postgres.js also
      connects but leaks an unhandled rejection on teardown. Hyperdrive is the
      idiomatic pooler for production query traffic. The *replication* connection
      is still a different beast (long-lived, `START_REPLICATION`) — see §7.

### 1. `PostgresAdapter` — the write path — **P0** 🟡 (v1 write path landed, plan 016)

Same contract as `SqliteAdapter`, new target — landed as `PgAdapter`
(`src/server/pg-adapter.ts`). The DB-is-the-authority rules from v1 (architecture
§5) apply verbatim. The v1 rung is done; the two WAL-coupled items below stay open
for rung 2.

- [x] **CRUD against typed columns** — distinct `INSERT`/`UPDATE`/`DELETE`, whole
      POST in one `BEGIN…COMMIT`, `RETURNING *` for the resolved rows (decoded in JS
      — interactive transactions, no in-SQL JSON like D1). Injection-safe by
      construction: values bound as `$n` placeholders (`toPg`), identifiers only
      from the schema allowlist (`assertIdent`/`columnsOf` carry over). The `_oplog`
      is `BIGSERIAL`/`JSONB` beside the data; `?since` deltas + floor→reset identical
      to the other modes. Rollback burns but does not emit a seq (gaps are normal).
- [ ] **Emit the `wid` correlation message** (`pg_logical_emit_message`) inside
      every `/write` transaction, so the tail can attribute the echo (§3). *Rung 2 —
      the v1 rung's echo is the `RETURNING` oplog, no `wid` yet.*
- [x] **Constraint-error reporting** — the adapter's `classifyError` maps Postgres
      SQLSTATE class `23…` + the constraint name into the `WriteReject` (409) shape;
      the server consults it ahead of the SQLite-message regex, which embedded/D1
      keep. Classification now lives with the dialect, per plan 006's follow-through.
- [ ] **Cross-target atomicity guard.** A single TanStack transaction spanning
      collections on *different* persistence targets can't be atomic — reject (or
      at minimum warn) rather than half-commit. *Not rung 1 — one adapter per room
      today.*
- [ ] *(variant, P2)* **PostgREST as the write shell.** Where direct SQL isn't
      available (hosted Supabase without a pooler, etc.), `/write` can translate
      WriteEvents → PostgREST calls (`Prefer: return=representation`). Same
      preview semantics; the stream path is unchanged. Not the primary lane.

### 2. Tail the WAL — the stream path — **P0** ❌

- [ ] **Publication = the watched tables.** The server's collection definitions
      declare which tables we watch; the publication lists exactly those. A table
      without a collection isn't watched (and its realtime story is the
      `queryCollection` fallback, §7).
- [ ] **Decode `pgoutput` → `WriteEvent`s.** Relation messages give the column
      names/types; insert/update/delete messages become `{type, value}` per §2 of
      the architecture. Requires `REPLICA IDENTITY` sufficient to build the row
      (default PK identity is fine given whole-`value` events come from the new
      tuple; deletes need the key — document `REPLICA IDENTITY` requirements).
- [ ] **Apply per-transaction, atomically.** Buffer a WAL transaction's messages
      until its commit, then ingest as one unit: append to the DO's oplog (one
      LSN-keyed entry), broadcast in order. This preserves the FK-ordering
      guarantee downstream.
- [ ] **`seq` = LSN.** The commit LSN keys the oplog and rides the wire as the
      batch cursor. Client-side nothing changes except the comparator.
- [ ] **This is what makes triggers, cron, and other systems first-class.**
      Their effects don't come back with the ack, but they arrive on the stream —
      so the guidance flips from v1's "avoid side-effecting triggers" to
      "fire-and-forget actually works": mock/pend/omit in the UI and let the rows
      flow in.
- [ ] **Slot lifecycle & monitoring.** A lagging slot pins WAL and fills the
      disk. Own the slot's creation, resumption (restart from confirmed LSN), and
      a max-lag safety valve (drop the slot + force re-snapshot rather than take
      down the database). Surface lag as an observable.
- [ ] **Consistent snapshot ↔ LSN handoff.** Creating a slot exports a
      consistent snapshot; use it for the initial table snapshot so the first
      byte of the tail follows the snapshot with no gap and no overlap. Same
      consistency test discipline as v1's snapshot/oplog cut.
- [ ] **Keep it a dumb adapter, not a CDC engine.** The cost driver is
      cross-room *read*-sharing, not the database choice: within-room write+read
      is trivial; a table read by many rooms is what pulls in a central
      WAL-consumer/demux service. Two constraints keep even that tractable:
      **(a)** partition tables so exactly one DO writes each partition — the
      writer stays the serialization authority, no multi-writer conflict
      reconciliation; **(b)** prefer append-only record tables. Start single-
      consumer (one tail per database, demuxing to rooms by table/partition) and
      resist generalizing.

### 3. Settlement over preview + echo — **P0** ❌

- [ ] **Ack = preview, stream = settlement.** `WriteAck` carries the
      best-effort `RETURNING`/yielded rows (instant overlay resolution, as
      today); the write only *settles* when its `wid` message arrives on the
      tail. `waitForSeq` becomes wait-for-`wid` (or the LSN the `wid` resolves
      to) — the existing timeout/rollback semantics carry over.
- [ ] **Drop unconfirmed optimistic rows on echo.** The WAL block for a `wid` is
      the complete truth for that transaction: swap the overlay for the canonical
      rows, discard anything the WAL didn't confirm. "Yield your changed rows"
      stays a UI-latency optimization, never a correctness requirement.
- [ ] **Rows with no `wid`** (cron, triggers on other transactions, other
      services) are plain foreign writes: apply on arrival, no settlement party
      waiting on them.

### 4. RPC functions — **P1** ❌

Any Postgres function becomes callable through the pipeline. The contract: **a
function is syncable so long as it YIELDs all its affected rows** — and because
the WAL is the authoritative echo, even that is soft:

- **Under-yield** → the missing rows still arrive on the stream, just without an
  instant preview. Correct, slightly later UI.
- **Over-yield** → dropped at echo time (§3). Self-healing.

- [ ] **Wire shape.** An RPC call rides the existing `/write` POST as a new op
      kind (e.g. `{ type: 'rpc', name, args }` on a reserved channel), so it
      shares the transaction, the ack, and the `wid` correlation with any CRUD
      ops batched alongside it. Design the exact envelope; keep `WriteEvent`
      untouched for CRUD.
- [ ] **Server registry + arg validation.** Functions are opt-in by name on the
      server (never client-named SQL), args validated by a Zod schema per
      function — the same error-sooner stance as row validation; the database
      stays the authority.
- [ ] **Yield convention.** Decide how a function tags its yielded rows by
      channel — e.g. `RETURNS TABLE(channel text, op text, row jsonb)` or a
      composite type — so the preview can be routed like any other batch.
      Document the `CREATE FUNCTION` recipe (a cookbook).
- [ ] **Client surface.** `db.rpc(name, args)` (or per-collection sugar) returns
      a promise that resolves on settlement, with the yielded rows applied as an
      optimistic overlay in the meantime — same three-phase lifecycle as a CRUD
      write.
- [ ] **The other direction stays true too:** many RPCs collapse to "an insert
      plus some triggers" once trigger effects sync live — prefer that where the
      logic fits in the database's own rules (architecture §5); RPC is for the
      genuinely procedural remainder.

### 5. Per-user reads and writes — simple owner rules — **P1** ❌

A deliberately tiny subset of RLS, defined **at the collection level**: one
user-id column, one uid from the verified JWT, equality — that's the whole
model. (This is *our* enforcement in the sync layer, not Postgres RLS; real RLS
as defense-in-depth is a P2 note below.)

- [ ] **Collection config.** A collection declares its owner column (a getter,
      analogous to `key` — e.g. `userId: (row) => row.user_id`) plus its rule:
      `read: 'public' | 'owner'`, `write: 'owner'` (public-global and team-wide
      stay the no-config defaults; see `collection-types.md` part 2).
- [ ] **Resolving `uid`.** The server takes an `auth: (req) => uid | null`
      getter (the request-context idea from `unspecified.md` — resolved once per
      request); typically "verify the JWT, read the subject claim". The lobby
      already verified the token; the DO re-derives the uid from the same
      credential (stateless, no lobby→DO trust channel needed).
- [ ] **Write gate.** Every op on an owner-write collection must satisfy
      `userId(row) === uid` — inserts and the *new* value of updates carry your
      own uid; updates/deletes must target a row you own (check the stored row,
      not just the payload). Violations are a `WriteReject`, rolled back like any
      constraint failure. RPC args get no free pass: the function itself must
      enforce ownership (it runs in the database; document the pattern).
- [ ] **Read gate at all three choke points** (the design already sketched in
      `collection-types.md`): snapshot load, `?since` backlog, and per-socket
      fan-out all apply `owner_col = :uid`. Each socket's identity attaches at
      connect and survives hibernation via `serializeAttachment`. Crucially the
      fan-out filter applies to **WAL-sourced rows too** — a cron-written
      user-private row goes only to that user's sockets.
- [ ] **Filtered reconnect cursors.** A `?since` delta on an owner-read
      collection replays only your rows; the oplog replay path grows a per-op
      filter (cheap: the events carry whole `value`s, so the owner column is
      right there).
- [ ] *(P2)* **Belt-and-braces with real RLS.** Nothing stops you enabling
      Postgres RLS on the same tables; our `/write` connection would then need to
      set the user context (e.g. a `set_config('request.jwt.claim.sub', …)`
      convention) per transaction. Deferred until someone needs it — the simple
      rule is the product; RLS compatibility is insurance.

### 6. In-object (stateful) auth — **P1** ❌

Authorization that depends on the room's *own* DO state — membership/roles
stored in the room, per-row rules beyond the §5 owner column, rate limits/ban
lists — can't be done at the lobby (it runs before the DO, with no
`ctx.storage`). It needs a *second* seam: an in-object hook (e.g.
`authorizeInObject`) consulted in `onConnect`/`onRequest` with
`this.ctx.storage` access, which *does* wake the DO (a different perf/security
profile from the lobby gate).

It sits in the Postgres milestone because §5 builds the machinery it wants —
per-request identity resolution and per-socket identity attachments — and
because owner-rules will surface the first real "role, not owner" demands. Still
gated on an actual need; the seam design shouldn't run ahead of a use case.

### 7. Deployment shape & open questions — **P1/P2**

- [ ] **Who holds the replication connection?** The tail is a long-lived
      exclusive TCP session. Candidates: a dedicated singleton DO (raw
      `connect()` + alarms to survive eviction, demuxing to room DOs), or a small
      external consumer (container) pushing into rooms. Decide by operational
      simplicity; the demux boundary is the same either way (§2's dumb-adapter
      constraints).
- [ ] **Query-path connections.** `/write` transactions via Hyperdrive (or
      driver-over-`connect()`); measure the DO→Postgres round-trip and document
      the latency profile vs v1's embedded SQLite (the ack gets slower; the
      stream doesn't).
- [ ] **Non-realtime `queryCollection` fallback** for tables we can't or won't
      tail — same write API, weaker read guarantee (`collection-types.md`, "where
      realtime has to be given up").
- [ ] **Supabase Realtime ride-along** stays a separate lane (its payload has no
      LSN, no replay → settle by PK, reconnect = re-snapshot); Supabase's own
      `supabase/tanstack-db` is the reference implementation there. Parked in
      `unspecified.md`, not this milestone.
- [ ] **Composing databases** — a `db` mixing collections from the DO-SQLite
      target and the Postgres target (each collection picking its transport),
      with the cross-target atomicity guard from §1. Design after the single-
      target story works.
