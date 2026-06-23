# unspecified.md — running design log

The list of things we know we haven't pinned down. Append, don't prune; move
items into **Decided** when they settle. This is the decision record for
`party-db` while it incubates.

---

## Decided (for now)

- **Wire format = TanStack DB's `write()` arg.** `WriteEvent = Omit<ChangeMessage, 'key'>`.
  Key is derived from `value` via getKey, never sent.
- **Multiplex by `channel`** (= table name). One transport, N collections. The
  `SyncClient` registry routes; unknown channels buffer until registered.
- **One interpreter, both sides.** `applyBatch` runs identically on client and
  server; the server differs only in that its sink is storage-backed.
- **Two modes, same primitives:** trusting (pass-through) vs controlled
  (server-authoritative, accept-and-ack by applying to its own collection).
- **Batches are atomic windows** (`begin`/`commit`) so "add post + tag it" lands
  together.
- **`seq` = the authority's own commit-log position** (NOT a free-standing
  counter we invent). DO → `_oplog` AUTOINCREMENT rowid; Postgres → WAL LSN.
  Therefore `seq` is an opaque, monotonically-comparable **cursor** (`number |
  string`), per channel. Backlog replayed on connect, terminated by a `ready`
  sentinel per channel.
- **Schemas are shared by import. No `/schemas` API.** Define the Zod/Standard
  Schema once, import on client and server. No version-hash handshake, no
  untyped/dynamic mode. (Withholding schemas to save bytes while shipping a
  100kb+ TanStack DB client is not worth it.)
- **The stream carries resolved rows; the ack carries the match token.** The
  authority resolves a write once (at commit, via `RETURNING`); that resolved op
  flows to the oplog, the stream, and optionally the ack. The ack's required job
  is to return `seq` so the caller's handler can await settlement.

## Open

### Optimistic phases (pre-ack / acked-not-settled / settled)
- Three real phases: (1) pre-ack, (2) acked but seq not yet seen on the stream,
  (3) settled (seq observed, overlay drops, authoritative value shows).
- TanStack DB's overlay is **binary** — present until the handler resolves. So
  resolving the handler is the only lever. Resolve-on-settled (await the seq on
  the stream, Electric's `awaitTxId` pattern) keeps the overlay through phase 2.
  Easy for us since we mint the id before returning; the match token is our `seq`.
- **Accepted tradeoff:** this collapses the *visible* distinction between phases
  2 and 3. The overlay alone can't render "saved, syncing…" vs "pending…".
- **TODO (later, maybe never):** if we ever want phase 2 surfaced distinctly,
  track it in a side map keyed by the minted id. Not now.
- **TODO:** does the lib expose a generic `awaitTxId` for non-Electric
  collections, or do we implement our own via the SyncClient ("seq N seen on
  channel X")? Assume we provide our own.

### Controlled mode — DO SQLite chain (mostly settled, needs a probe)
- Flow per batch, one transaction: apply each op with `RETURNING *` → resolved
  row; insert resolved op into `_oplog` → AUTOINCREMENT seq; COMMIT; broadcast
  resolved batch to `ctx.getWebSockets()`; ack `{ seq }`.
- `_oplog` stores **resolved** ops so backlog replay reproduces authoritative
  state. It is also the per-channel ordering.
- **TODO (the strictness probe, was "non-central"):** does a SQLite constraint
  the Zod schema missed actually throw at `commit()` and abort the POST, or does
  TanStack DB swallow it? Decides whether SQLite is a real second validation
  line or just persistence.
- **TODO:** broadcast-before-ack vs after — either is fine (client matches by
  seq), confirm no ordering surprise for the posting client (it gets its own
  write on the stream too).

### Controlled mode — Postgres / PostgREST
- **Resolved:** write path and stream path are DECOUPLED. The stream is sourced
  from Postgres, NOT from the write handler.
  - PostgREST cannot emit a stream (stateless HTTP shell) → "make PostgREST also
    push SSE" is impossible.
  - "POST then also emit" (echo from /write) is wrong under concurrency (orders
    outside Postgres's commit order; misses non-/write writers) → rejected.
  - **Stream = logical replication.** Decode the WAL (`pgoutput`/`wal2json`) into
    row-level WriteEvents ordered by **LSN (= seq)**. This is what Electric does.
    (Irony: the correct stream source for the PG target is tailing the WAL —
    logically decoded, not raw pages. Physical log, logical projection.)
  - Write path = thin `/write` translating WriteEvents → PostgREST calls with
    `Prefer: return=representation` (insert→POST, update→PATCH `?{key}=eq.{id}`,
    delete→DELETE `?{key}=eq.{id}`). PostgREST gives RLS/auth for free. (Could
    also write directly to PG; doesn't affect the stream.)
- **TODO (Supabase):** Supabase Realtime IS logical-replication row streaming —
  probably use it as the down-transport instead of running our own slot.
- **TODO (Supabase Edge longevity):** Edge Functions are request-scoped; bad host
  for a long-lived replication slot or long SSE. `/write` on Edge is fine; the
  stream wants Supabase Realtime or a separate long-running consumer. Unresolved.
- **TODO:** generated/serial PKs on PG need the resolved row to swap the
  optimistic id without a flicker — prefer client UUIDs to sidestep (see IDs).

### IDs
- **Client mints UUIDs before sending** (stable optimistic key; required in
  trusting mode). With UUID PKs the client id is authoritative — no id round-trip,
  only generated columns (timestamps/computed) differ in the resolved row.
- **TODO:** serial/db-assigned PKs → reconcile via the resolved row on the
  stream; how to swap optimistic→real id without a flicker. Probably: prefer
  UUIDs and don't.

### Config derivation
- From `{ name, key, schema }` we derive getKey, sync, and
  onInsert/onUpdate/onDelete (mechanical given the transport).
- **Proposal:** `insertSchema`/`updateSchema` (default to `schema`) for
  write-time validation + payload shape (insert = full row, update = patch).
- PostgREST request mapping is fully generic from `{ table, key, type, value }` —
  no per-table code.
- **TODO:** pin the `transaction.mutations` shape (`.modified`/`.original`/
  `.type`/`.key`) against the TanStack DB version we target.

### Transport matrix
| mode | down | up | target |
| --- | --- | --- | --- |
| controlled | hibernatable WS | POST /write | Durable Object |
| controlled | SSE (or Supabase Realtime) | POST /write | PostgREST / Supabase |
| trusting | WS | WS (same socket) | any |
- **TODO:** auth — bearer/session on both stream-open and POST. The DO already
  owns a per-room bearer in scenetest-cloud's model; mirror that.

### Subscription / filtering
- v1 broadcasts every channel to everyone; client filters. **TODO:** a
  `subscribe(channels[])` control message so the server sends only relevant
  batches + backlog. Matters as channel count grows.

### Ordering scope
- Per-channel seq chosen. **TODO:** revisit if collections need cross-collection
  atomicity / total order (would push toward a global seq and couple channels).

---

## Deferred (intentionally not now)

- Conflict resolution / CRDT merge. Banking on "clever non-promises" so we don't
  need it until much later. A conflict that could *undo* an acked write lives here.
- Offline write queues.
- Partial/column-level diffs (we ship whole `value`s).
- Surfacing phase 2 ("acked-not-settled") distinctly in the UI.
