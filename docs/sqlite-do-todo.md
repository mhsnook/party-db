# Finish the SQLite Durable Object story — TODO

**Scope:** finish the **controlled** DO-SQLite story — the server committing into
**structured tables that reflect your schema**, with the database as the authority
(real columns, constraints, foreign keys, and the *resolved* row handed back).
That structured-table path is what makes party-db usable for the real apps it's
for — ones that already run an RDBMS — so it is the **spine** of this list, not an
enhancement. Postgres/WAL, slicing, RLS, Supabase, and RPC are **parked** (bottom).

**Where we actually are:** the transport/sync plumbing is built and solid — wire
format, channel multiplexing, `seq`, optimistic → ack → settlement, delta
reconnect, fan-out. What's *not* built is the persistence model: the code ships
the **uncontrolled** fallback (schema-agnostic `(k, data)` blob upsert). So the
work is making the data real, and making the package testable.

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
| 10 | schemas shared by import | 🟡 | client validates + types; **server ignores schemas** (`TableDef` is `{name,key}`) — becomes load-bearing once the server builds DDL / validates |
| 11 | `persist` binding; x-collection atomicity via TanStack | 🟡 | server commits whole POST atomically, but the envelope isn't visible to subscribers — see item 6 |
| 12 | authority is the database, not TanStack DB | ✅ | server sink is `ctx.storage.sql` (a real DB, not a TanStack cache) |

---

## The list

> Practical ordering: do **item 2 (tooling)** first so you can build item 1 with
> tests. But item 1 is the *point* — it's what "finish the SQLite story" means.

### 1. Structured relational tables — **P0** (the spine; not built)

Make the server's storage your real schema instead of an opaque blob.

- [ ] **Schema → table shape.** Derive real columns/types (and a place to declare
      constraints, FKs, indexes) from the collection's Zod schema, so the server
      provisions DO-SQLite tables that match. `TableDef` grows past `{name, key}`.
      (Later, the Postgres target *adapts to* tables that already exist rather than
      provisioning them.)
- [ ] **CRUD against typed columns** in `applyOne` (insert/update/delete into real
      columns), replacing the blob upsert.
- [ ] **The database is the authority.** A write is a genuine transactional commit
      the DB's constraints can reject; rejection fails the POST (client optimistic
      rollback), success *is* the acceptance. Optionally run the Zod schema as a
      fast server-side first-line check before the DB.
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

### 6. Cross-collection transaction visibility — **P2** (decision needed)

- [ ] A cross-collection atomic write commits atomically on the server but goes out
      as **N separate `SequencedBatch`es with N seqs** — a subscriber can't tell they
      were one envelope (only the *writer* awaits all seqs). The README claims the
      envelope "survives… out to all connected clients." Either add a
      transaction/group id so subscribers can apply the set atomically, **or** correct
      the README to "ordered, not atomic, on the receiving side." Pick one.

### 7. DX / packaging polish — **P2**

- [ ] Build story: `exports` point at `.ts` source — fine for a source/monorepo
      consumer, but a published package needs a build step. Decide, or document
      "source-only for now."
- [ ] `package.json` `description` still says "MOCK / PROPOSAL … not wired into
      scenetest-cloud" — update it.
- [ ] Example nit: `todos.toArray as Todo[]` is used as a value — confirm it's the
      getter, not a missing call.

---

## Uncontrolled mode (the tiny fallback — not invested in now)

The current blob path (`(k, data)` upsert, no schema enforcement) becomes an
explicit opt-out, for a pure "party room" with no real database to honor. Client
schemas still exist; the server just ignores them. Keep it working; don't grow it.

## Explicitly parked (NOT part of the SQLite DO story)

Tracked in [`collection-types.md`](./collection-types.md) and
[`unspecified.md`](./unspecified.md):

- Postgres / WAL persistence (logical replication, LSN seq, `pg_logical_emit_message`)
- Read-level slicing (serializable `where` AST) and user-private / RLS shapes
- Supabase Realtime transport
- RPC escape hatch
- Trusting relay mode
- Partial/column-level diffs, offline write queues, schema version-hash handshake,
  `subscribe(channels[])` bandwidth filtering
