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
| 4 | Shared wire types + apply contract; per-target apply code | ✅ | client applies via `applyBatch` (`src/client/apply.ts`); server via `applyOne`/SQL |
| 5 | **Persist into structured tables reflecting your schema** | ❌ | code ships the *uncontrolled* blob fallback (`onStart`/`applyOne`: `(k,data)` upsert). **Structured tables = the core work below.** |
| 6 | `seq` from `_oplog` AUTOINCREMENT via `RETURNING` | ✅ | `applyOne` (mechanism is independent of the storage model) |
| 7 | optimistic → ack → settlement (`waitForSeq`) | 🟡 | settlement works; **resolved-row swap not implemented** (blob makes resolved==sent) — see item 1 |
| 8 | reconnect = delta via `?since` | ✅ | `partyTransport` query + `replaySince`/`snapshot`; see oplog-lifecycle gaps |
| 9 | broadcast inline, after commit, before responding | ✅ | `onRequest` |
| 10 | schemas shared by import | 🟡 | client validates + types; **server ignores schemas** (`TableDef` is `{name,key}`) — becomes load-bearing once server & client share one collection interface (`{name,key,schema}`) and the server reads the column set + validates rows |
| 11 | `persist` binding; x-collection atomicity via TanStack | ✅ | server commits whole POST atomically + writer settles on all seqs; subscribers receive the writes ordered by `seq` |
| 12 | authority is the database, not TanStack DB | ✅ | server sink is `ctx.storage.sql` (a real DB, not a TanStack cache) |

---

## The list

> Practical ordering: do **item 2 (tooling)** first so you can build item 1 with
> tests. But item 1 is the *point* — it's what "finish the SQLite story" means.

### 1. Structured relational tables — **P0**

- [ ] **Use the same client DB schema on the server.** Zod schemas are already used
      on the client to validate inserts and updated in to the Tanstack Collections.
      On the server they are just a very quick validator. Projects come with their
      own database and types, and Zod schemas that could power their Tanstack
      Collections, and we're able to extrapolate the rest. Server and client
      collections **share one interface** — `{ name, key, schema }`, defined once
      and imported on both sides (no separate `TableDef`). They might be distinct
      `clientCollection` / `serverCollection` entities if their fill-in-value rules
      diverge (client optimistic defaults vs server/DB-resolved values), but the
      interface is shared.
- [ ] **CRUD against typed columns** in `applyOne` (insert/update/delete into real
      columns), replacing the blob upsert.
- [ ] **Pluggable async persistence sink (embedded DO-SQLite *or* D1).** Design
      `applyOne`/`onRequest` against an async sink, not `transactionSync` directly:
      embedded SQLite is sync, D1 is async (`batch()` for the atomic POST). Either
      DO serializes its write → `seq` → broadcast critical section (input-gating /
      `blockConcurrencyWhile`) so concurrent POSTs' awaits can't interleave ordering.
      Both targets capture via `RETURNING` (what the `/write` handler commits), not
      a change feed: changes that never come through `/write` — other services,
      cronjobs, trigger side-effects on rows we didn't return — are the v2 WAL story.
- [ ] **The database is the authority.** A write is a genuine transactional commit
      the DB's constraints can reject; rejection fails the POST (client optimistic
      rollback), success *is* the acceptance. The server applies the batch in the
      order given, in one transaction — it does **not** re-derive write-ordering;
      the DB judges. Zod may run server-side as a cheap *error-sooner* gate, never
      as the correctness authority.
- [ ] **Injection-safe by construction.** Bind every *value* with `?` (the current
      code already does this for keys/data/etc.). Take every *identifier* — table
      and column names — from the schema/config allowlist, validated against
      `^[A-Za-z_][A-Za-z0-9_]*$`, **never** from the client payload's keys (build
      column lists from the Zod schema, not `Object.keys(row)`). Tiny surface — a
      handful of statements.
- [ ] **Resolved-row reconciliation (mandatory).** The committed row can differ
      from the sent row (defaults, generated columns, serials, trigger effects).
      Return the resolved row (`WriteAck.changed` + on the stream) and have the
      client swap its optimistic overlay for it. This is the piece the blob model
      existed to avoid; it is required now (and completes §7).
- [ ] **Serial / db-assigned PKs.** Falls out of resolved rows — support it instead
      of forbidding it. (Client-minted UUIDs stay the easy default.)
- [ ] **Constraint-error reporting.** Surface a DB rejection cleanly to the
      mutating client (which constraint, which row), not a bare 500 — the app can't
      be made to change how it constrains data, so we report its verdict faithfully.

### 2. Project tooling & tests — **P0** (nothing exists; the foundation)

You currently cannot typecheck or test the package in isolation.

- [ ] **Installable dev deps / workspace** so `pnpm typecheck` passes on a clean
      checkout. Today it fails — deps unresolved at root, plus two real
      implicit-`any`s: `collection.ts:63` (`sink`) and `party-db-server.ts:75` (`r`).
- [ ] **Test runner** (vitest).
- [ ] **Unit tests:** `applyBatch` (`src/client/apply.ts`); `SyncClient` routing /
      `pending` buffer / `waitForSeq` / high-water mark; `persist` grouping
      (`toEvent`, by-channel split); `partyTransport` `since`/`lastSeq` tracking.
- [ ] **Server tests:** structured `applyOne` (insert/update/delete + constraint
      rejection + resolved row) + oplog seq; `onRequest` multi-batch atomic commit +
      broadcast order == seq order; `snapshot` vs `replaySince`; unknown-channel → 400.
      Write these against the **structured** path as it lands — don't entrench the
      blob placeholder.
- [ ] **Integration test** (workers/miniflare pool): round-trip insert → ack →
      settle → a second client sees the resolved row; reconnect delta replays the gap.
- [ ] **CI** running typecheck + tests on the branch.

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
- [ ] **Settlement can hang forever.** `persist` awaits `waitForSeq`, which only
      resolves when the seq streams back; if it never does (writer's channel not
      registered, or a persistent disconnect) the mutation promise hangs. Bound it
      (timeout → reject/retry) — note §7 deliberately waits on the *stream* not the
      bare ack, so don't "fix" this by resolving on ack (reintroduces flicker);
      reconnect's `?since` is the real re-delivery path.

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
