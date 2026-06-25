# Finish the SQLite Durable Object story — TODO

**Scope:** make the *one shipped mode* — DO-controlled, DO-SQLite persistence —
solid and done. This is a gap analysis of `src/` against
[`architecture.md`](./architecture.md) §0–§12 plus the near-term items in
[`unspecified.md`](./unspecified.md). Everything Postgres/WAL, slicing, RLS,
Supabase, RPC, or trusting-relay is **explicitly parked** (bottom of file) — not
part of this list.

Status tags: ✅ done · 🟡 partial · ❌ missing. Priorities: **P0** blocks calling
the mode "done", **P1** needed for real use, **P2** polish.

---

## Where we are — conformance to architecture.md

The happy path is built. This table is the evidence, not the work; the work is in
the next section.

| § | Decision | Status | Note |
| --- | --- | --- | --- |
| 0 | DX: `definePartyCollection` / `PartyDbServer` / `createPartyDb` | ✅ | `src/client/*`, `src/server/party-db-server.ts`, example app runs |
| 1 | One mode: DO-controlled | ✅ | WS down + `POST /write` up, DO SQLite |
| 2 | Wire = `WriteEvent = Omit<ChangeMessage,'key'>` | ✅ | `src/protocol.ts` |
| 3 | Multiplex by `channel` | ✅ | `SyncClient` registry; server keys tables by channel |
| 4 | Shared wire types + apply contract; per-target apply code | ✅ | framing corrected (was "one interpreter both sides"). Client applies via `applyBatch` (now `src/client/apply.ts`); server applies via `applyOne`/SQL. Shared = wire types + the atomic-in-order contract, not the loop. |
| 5 | Client UUIDs; server blob + `_oplog` | ✅ | `onStart` / `applyOne` |
| 6 | `seq` from `_oplog` AUTOINCREMENT via `RETURNING` | ✅ | `applyOne` |
| 7 | optimistic → ack → settlement (`waitForSeq`) | ✅ | `persist` awaits each seq; see robustness gaps below |
| 8 | reconnect = delta via `?since` | ✅ | `partyTransport` query + `replaySince`/`snapshot`; see oplog-lifecycle gaps |
| 9 | broadcast inline, after commit, before responding | ✅ | `onRequest` |
| 10 | schemas shared by import | 🟡 | client validates; **server never imports/uses schemas** (TableDef is `{name,key}`) |
| 11 | `persist` is the only binding; x-collection atomicity via TanStack | 🟡 | server commits whole POST atomically, but the envelope is **not** visible to subscribers — see item 6 |
| 12 | authority is SQLite, not TanStack DB | ✅ | server sink is `ctx.storage.sql` |

---

## The list

### 1. Project tooling & tests — **P0** (nothing exists yet)

The single biggest gap: you cannot currently typecheck or test the package in
isolation.

- [ ] **Installable dev deps / workspace** so `pnpm typecheck` passes on a clean
      checkout. Today it fails — deps unresolved at root, plus two real
      implicit-`any`s: `collection.ts:63` (`sink`) and `party-db-server.ts:75`
      (`r`).
- [ ] **Test runner** (vitest).
- [ ] **Unit tests:** `applyBatch` (`src/client/apply.ts`); `SyncClient` routing / `pending`
      buffer / `waitForSeq` / high-water mark; `persist` grouping (`toEvent`,
      by-channel split); `partyTransport` `since`/`lastSeq` tracking.
- [ ] **Server tests:** `applyOne` upsert/delete + oplog seq; `onRequest`
      multi-batch atomic commit + broadcast order == seq order; `snapshot` vs
      `replaySince`; unknown-channel → 400.
- [ ] **Integration test** (workers/miniflare pool): full round-trip insert → ack
      → settle → a second client sees it; reconnect delta replays only the gap.
- [ ] **CI** running typecheck + tests on the branch.

### 2. Oplog lifecycle — **P1** (`_oplog` grows forever today)

- [ ] **Retention/compaction** of `_oplog` (tunable by rows/age). Nothing trims it
      now (`party-db-server.ts`).
- [ ] **`since`-floor fallback:** if a client's `since` is older than the oldest
      retained seq, send a **fresh snapshot** instead of a gappy delta.
      `replaySince` has no floor check, so post-compaction it would silently drop
      rows the client needs.
- [ ] Lock the snapshot/seq consistency that single-threaded sync gives us with a
      test (so a future refactor that adds an `await` mid-snapshot can't break it).

### 3. Robustness / input validation — **P1**

- [ ] Validate `since` is a non-negative integer; else snapshot. `Number(since)`
      yields `NaN` on garbage today (`onConnect`).
- [ ] Validate the POST body is actually `WriteBatch[]` before iterating — a
      malformed body currently throws → 500 (`onRequest`).
- [ ] **Settlement can hang forever.** `persist` awaits `waitForSeq`, which only
      resolves when the seq streams back; if it never does (writer's channel not
      registered, or a persistent disconnect) the mutation promise hangs. Bound it
      (timeout → reject/retry) — note §7 deliberately waits on the *stream* not the
      bare ack, so don't "fix" this by resolving on ack (reintroduces flicker);
      reconnect's `?since` is the real re-delivery path.
- [ ] Decide behavior when a row is missing its `key` field (`applyOne` does
      `String(value[key])` → `"undefined"`).

### 4. Auth — **P1** (none today)

- [ ] Auth hook on **socket open** (`onConnect`) and **POST** (`onRequest`):
      bearer/session, reject unauthorized. Make it pluggable so the room owner
      supplies the check. Today any client can read the whole room and write to it.
      (`unspecified.md` → Auth.)

### 5. Server-side validation — **P2** (opt-in)

- [ ] Let a collection optionally validate writes against its schema server-side
      before commit (accept `insertSchema`/`updateSchema`, default to `schema`).
      The blob store works without it; this is defense for untrusted clients.
      (`unspecified.md` → insert/update schemas.)

### 6. Cross-collection transaction visibility — **P2** (decision needed)

- [ ] A cross-collection atomic write is committed atomically on the server, but
      goes out as **N separate `SequencedBatch`es with N seqs** — a subscriber
      can't tell they were one envelope (only the *writer* awaits all seqs). The
      README claims the envelope "survives… out to all connected clients." Either
      add a transaction/group id so subscribers can apply the set atomically, **or**
      correct the README to "ordered, not atomic, on the receiving side" (matches
      the "adjacent, in order, same tick" reality). Pick one.

### 7. DX / packaging polish — **P2**

- [ ] Build story: `exports` point at `.ts` source — fine for a source/monorepo
      consumer, but a published package needs a build step. Decide, or document
      "source-only for now."
- [ ] `package.json` `description` still says "MOCK / PROPOSAL … not wired into
      scenetest-cloud" — update it.
- [ ] Example nit: `todos.toArray as Todo[]` is used as a value — confirm it's the
      getter, not a missing call.

---

## Explicitly parked (NOT part of the SQLite DO story)

Tracked in [`collection-types.md`](./collection-types.md) and
[`unspecified.md`](./unspecified.md). Do not pull these in while finishing the
above:

- Postgres / WAL persistence (logical replication, LSN seq, `pg_logical_emit_message`)
- Read-level slicing (serializable `where` AST) and user-private / RLS shapes
- Supabase Realtime transport
- RPC escape hatch
- Trusting relay mode
- Partial/column-level diffs, offline write queues, serial/db-assigned PKs,
  schema version-hash handshake, `subscribe(channels[])` bandwidth filtering
