# Finishing the RDBMS, SQLite, Durable Object story

We have completed version 0, and are now working toward version 1 (the first
version I actually want to use in an actual app).

Version 0 was enough to make these example apps work, and to connect the
Tanstack DB collections over a PartyServer on a Durable Object. The DB collection
is the entire API surface for all reads and writes, and the server handles
them transparently with zero code and zero config. That was a good POC.

Next, v1 is meant to work in the same Durable Object/PartyKit environment, but
on a DO that has its own SQLite database that holds the authority on the data,
provides the canonical order for the stream, and enables complete backfill/
catchup -- in other words, it's the first version I actually want to use in a
project!

The major structural outcome here is the completion of this write-confirm-settle
cycle where a couple things are true:

- Tanstack DB collection operations on clients are the entire API
- User performance about as good as the laws of physics currently allow
- DX that handles all server logic, mutations, and realtime connection with less
config than a `queryCollection`: no `queryFns`, no `onUpdate`

v2+ (Postgres-WAL, RPCs, RLS, slicing, (Supabase?)) is **parked**
(bottom); see architecture → Roadmap.

**Where we actually are:** the transport/sync plumbing is built and solid — wire
format, channel multiplexing, `seq`, optimistic → ack → settlement, delta
reconnect, fan-out (this *is* v0). What's *not* built is the v1 persistence model:
the code still does the schema-agnostic `(k, data)` blob upsert. So the work is
making the data real, and making the package testable.

Status tags: ✅ done · 🟡 partial · ❌ missing. Priorities: **P0** blocks "done",
**P1** needed for real use, **P2** polish.

---

## Where we are — conformance to architecture.md

| § | Decision | Status | Note |
| --- | --- | --- | --- |
| 0 | DX: `definePartyCollection` / `PartyDbServer` / `createPartyDb` | ✅ | `src/client/*`, `src/server/party-db-server.ts`, example apps run |
| 1 | One mode: DO-controlled | ✅ | WS down + `POST /write` up, DO SQLite |
| 2 | Wire = `WriteEvent = Omit<ChangeMessage,'key'>` | ✅ | `src/protocol.ts` |
| 3 | Multiplex by `channel` | ✅ | `SyncClient` registry; server keys tables by channel |
| 4 | Shared wire types + apply contract; per-target apply code | ✅ | client applies via `applyBatch` (`src/client/apply.ts`); server via `SqliteAdapter` behind the `PersistenceAdapter` seam |
| 5 | **Persist into structured tables reflecting your schema** | ✅ | `SqliteAdapter.applyStructured` does CRUD against your real columns + `RETURNING`; blob fallback kept for schema-less collections (v0 opt-out). We never DDL your tables — you bring them. |
| 6 | `seq` from `_oplog` AUTOINCREMENT via `RETURNING` | ✅ | `SqliteAdapter.applyOne` (mechanism is independent of the storage model) |
| 7 | optimistic → ack → settlement (`waitForSeq`) | ✅ | settlement + resolved-row swap: the server now streams the **resolved** rows (defaults/generated/serial) and echoes them in `WriteAck.changed`; the client's existing settlement drops the overlay onto them (flicker-free for client-minted keys; serial-PK key change is the documented nuance) |
| 8 | reconnect = delta via `?since` | ✅ | `partyTransport` query + adapter `replaySince`/`snapshot` (oplog stores resolved ops, so the delta replays resolved rows); see oplog-lifecycle gaps |
| 9 | broadcast inline, after commit, before responding | ✅ | `onRequest` |
| 10 | schemas shared by import | ✅ | one `{name,key,schema}` interface in `src/schema.ts`, imported both sides (no `TableDef`); the server reads the column allowlist + value codec from it |
| 11 | `persist` binding; x-collection atomicity via TanStack | ✅ | server commits whole POST atomically + writer settles on all seqs; subscribers receive the writes ordered by `seq` |
| 12 | authority is the database, not TanStack DB | ✅ | server sink is `ctx.storage.sql` (a real DB, not a TanStack cache) |

---

## The list

> Practical ordering: do **item 2 (tooling)** first so you can build item 1 with
> tests. But item 1 is the *point* — it's what "finish the SQLite story" means.

### 1. Structured relational tables — **P0** ✅ (landed; see notes)

- [x] **Use the same client DB schema on the server.** Zod schemas are already used
      on the client to validate inserts and updated in to the Tanstack Collections.
      On the server they are just a very quick validator. Projects come with their
      own database and types, and Zod schemas that could power their Tanstack
      Collections, and we're able to extrapolate the rest. Server and client
      collections **share one interface** — `{ name, key, schema }`, defined once
      and imported on both sides (no separate `TableDef`). They might be distinct
      `clientCollection` / `serverCollection` entities if their fill-in-value rules
      diverge (client optimistic defaults vs server/DB-resolved values), but the
      interface is shared.
- [x] **CRUD against typed columns** in `applyOne` (insert/update/delete into real
      columns), replacing the blob upsert. `SqliteAdapter.applyStructured`: distinct
      `INSERT`/`UPDATE`/`DELETE` (not a blanket upsert) so constraints get to judge;
      `INSERT`/`UPDATE` capture the committed row with `RETURNING *`. The blob upsert
      stays only for schema-less collections.
- [x] **Extract a `PersistenceAdapter` seam (embedded DO-SQLite *or* D1).** Pull the
      apply step out of `applyOne` behind an interface — `apply(op, schema) → resolved
      row` — so `onRequest` calls it blind to the target: blob (v0), structured SQL
      (v1), or D1. Design it **async** (not `transactionSync` directly): embedded
      SQLite is sync, D1 is async (`batch()` for the atomic POST). The DO serializes
      its write → `seq` → broadcast section (input-gating / `blockConcurrencyWhile`)
      so concurrent POSTs' awaits can't interleave ordering. Wins: each adapter is
      unit-testable without miniflare, and v0→v1 is "swap the adapter," not "rewrite
      `onRequest`." Both targets capture via `RETURNING` (what `/write` commits), not
      a change feed: changes that never come through `/write` — other services,
      cronjobs, trigger side-effects on rows we didn't return — are the v2 WAL story.
      *Landed:* `PersistenceAdapter` (`src/server/persistence.ts`) with `init`/`write`/
      `snapshot`/`replaySince`, all async; `SqliteAdapter` over a narrow `SqlEngine`
      seam (so it unit-tests against `node:sqlite`, no miniflare); `onRequest` is now
      blind to the target and serializes its write→seq→broadcast section via a promise
      queue (D1-ready). Swap targets by overriding `PartyDbServer.createAdapter()`.
- [x] **The database is the authority.** A write is a genuine transactional commit
      the DB's constraints can reject; rejection fails the POST (client optimistic
      rollback), success *is* the acceptance. The server applies the batch in the
      order given, in one transaction — it does **not** re-derive write-ordering;
      the DB judges. Zod may run server-side as a cheap *error-sooner* gate, never
      as the correctness authority. *Landed:* whole POST in one transaction; a
      rejection rolls the lot back (tested: a valid batch + a failing batch ⇒
      neither survives). Zod is not run server-side yet — noted below as the one
      remaining error-sooner gate.
- [x] **Injection-safe by construction.** Bind every *value* with `?` (the current
      code already does this for keys/data/etc.). Take every *identifier* — table
      and column names — from the schema/config allowlist, validated against
      `^[A-Za-z_][A-Za-z0-9_]*$`, **never** from the client payload's keys (build
      column lists from the Zod schema, not `Object.keys(row)`). Tiny surface — a
      handful of statements. *Landed:* `assertIdent` + `columnsOf` (`src/server/
      columns.ts`); the insert/update column list is the schema allowlist filtered to
      present values, so a smuggled payload key is silently ignored (tested).
- [x] **Resolved-row reconciliation (mandatory).** The committed row can differ
      from the sent row (defaults, generated columns, serials, trigger effects).
      Return the resolved row (`WriteAck.changed` + on the stream) and have the
      client swap its optimistic overlay for it. This is the piece the blob model
      existed to avoid; it is required now (and completes §7). *Landed:* the adapter
      returns resolved ops; `onRequest` broadcasts them and sets `WriteAck.changed`;
      the oplog stores resolved ops so reconnect deltas replay them too. The client's
      existing `waitForSeq` settlement drops the overlay onto the resolved row — clean
      for client-minted keys; for a serial PK the key changes, so the swap-by-key
      nuance is noted (UUIDs stay the easy default).
- [x] **Serial / db-assigned PKs.** Falls out of resolved rows — support it instead
      of forbidding it. (Client-minted UUIDs stay the easy default.) *Landed:* a
      column the client omits isn't named in the INSERT, so an `INTEGER PRIMARY KEY
      AUTOINCREMENT` is assigned and comes back via `RETURNING` (tested).
- [x] **Constraint-error reporting.** Surface a DB rejection cleanly to the
      mutating client (which constraint, which row), not a bare 500 — the app can't
      be made to change how it constrains data, so we report its verdict faithfully.
      *Landed:* a rejected commit returns `409` with a `WriteReject` body (`error` +
      best-effort `constraint`/`channel`); the transport already throws on non-ok, so
      TanStack rolls the optimistic mutation back.

### 2. Project tooling & tests — **P0** (nothing exists; the foundation)

You currently cannot typecheck or test the package in isolation.

- [x] **Installable dev deps / workspace** so `pnpm typecheck` passes on a clean
      checkout. Done: `devDependencies` (typescript, vitest, `@cloudflare/workers-types`)
      added; client and server are split into `tsconfig.client.json` (DOM lib) and
      `tsconfig.server.json` (Workers types) since they can't share one lib/types set,
      and `pnpm typecheck` runs both. Fixed the real type errors along the way: the
      `WriteEvent`/`WriteBatch`/`SequencedBatch` generics now carry `ChangeMessage`'s
      `object` constraint, `PartyDbServer`'s `Env` is constrained to `Cloudflare.Env`,
      and the private SQLite getter was renamed `db` so it stops shadowing the base
      `Server.sql` tagged-template helper.
- [x] **Test runner** (vitest). `vitest.config.ts`, `pnpm test` / `pnpm test:watch`.
- [x] **Unit tests:** `applyBatch` (`src/client/apply.ts`); `SyncClient` routing /
      `pending` buffer / `waitForSeq` / high-water mark; `persist` grouping
      (`toEvent`, by-channel split); `partyTransport` `since`/`lastSeq` tracking.
      32 tests in `test/`.
- [x] *(optional enabler)* Export `makePersist(client)` from `collection.ts` — done;
      its `client` param is now `Pick<SyncClient, 'send' | 'waitForSeq'>` so the write
      path tests run against a two-method stub, no transport. `toEvent` exported too.
- [x] **Server tests:** structured CRUD (insert/update/delete + constraint
      rejection + resolved row, incl. defaults/serials/boolean+json round-trip) +
      oplog seq; multi-batch atomic commit (one failing batch rolls back the rest);
      `snapshot` vs `replaySince`; blob fallback; injection safety. 28 tests across
      `test/columns.test.ts` + `test/sqlite-adapter.test.ts`, run against a real
      engine via `node:sqlite` (no miniflare). *(`onRequest`'s HTTP envelope —
      unknown-channel → 400, the 409 reject body, broadcast order == seq order — is
      thin glue over the tested adapter; it's exercised by the integration test below
      since it needs the `Server` harness.)*
- [ ] **Integration test** (workers/miniflare pool): round-trip insert → ack →
      settle → a second client sees the resolved row; reconnect delta replays the gap;
      `onRequest` 400/409 envelope + broadcast order. *(Still deferred: needs the
      `@cloudflare/vitest-pool-workers` harness; the storage/CRUD logic underneath is
      already covered by the node:sqlite adapter tests.)*
- [x] **CI** running typecheck + tests on the branch
      (`.github/workflows/ci.yml`: `pnpm install --frozen-lockfile` → `typecheck`
      → `test`).

### 3. Oplog lifecycle — **P1** (`_oplog` grows forever today)

- [ ] **Retention/compaction** of `_oplog` (tunable by rows/age). Nothing trims it now.
- [ ] **`since`-floor fallback:** if a client's `since` is older than the oldest
      retained seq, send a **fresh snapshot** instead of a gappy delta.
      `replaySince` has no floor check, so post-compaction it would silently drop rows.
- [ ] Lock the snapshot/seq consistency that single-threaded sync gives us with a
      test (so a future refactor that adds an `await` mid-snapshot can't break it).

### 4. Robustness / input validation — **P1**

- [ ] Validate `since` is a non-negative integer; else snapshot (`Number(since)` →
      `NaN` on garbage today, `onConnect`).
- [ ] Validate the POST body is actually `WriteBatch[]` before iterating — malformed
      body currently throws → 500 (`onRequest`).
- [ ] **Settlement can hang forever — extract a `SeqTracker` while fixing it.**
      `persist` awaits `waitForSeq`, which only resolves when the seq streams back; if
      it never does (writer's channel not registered, or a persistent disconnect) the
      mutation promise hangs. Pull settlement (the high-water mark + waiters) out of
      `SyncClient` into a pure `SeqTracker` over `Cursor`: it gives the **timeout**
      (→ reject/retry) a home, makes settlement testable without a transport, and
      fixes the numeric-only watermark that silently drops string cursors (swap one
      comparator for a v2 Postgres LSN). Note §7 deliberately waits on the *stream*
      not the bare ack, so don't "fix" the hang by resolving on ack (reintroduces
      flicker); reconnect's `?since` is the real re-delivery path.

### 5. Auth — **P1** (none today)

- [ ] Auth hook on **socket open** (`onConnect`) and **POST** (`onRequest`):
      bearer/session, reject unauthorized, pluggable so the room owner supplies the
      check. Today any client can read the whole room and write to it.

### 6. Cross-collection transaction visibility — **decided: ordered on receive**

- [x] **Ordered, not atomic, on the receiving side — no group id, no extra fields.**
      A cross-collection write commits atomically on the server, and the *writer*
      settles on all its seqs; subscribers just receive the constituent writes in
      `seq` order and apply them as they arrive (fine for a feed/chat — a reader
      seeing the post and then its tag, in order, is fine). README overclaim
      corrected.

### 7. DX / packaging polish — **P2**

- [ ] Build story: `exports` point at `.ts` source — fine for a source/monorepo
      consumer, but a published package needs a build step. Decide, or document
      "source-only for now."
- [ ] `package.json` `description` still says "MOCK / PROPOSAL … not wired into
      scenetest-cloud" — update it.
- [ ] Example nit: `todos.toArray as Todo[]` is used as a value — confirm it's the
      getter, not a missing call.
