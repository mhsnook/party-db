# unspecified.md — running design log

The list of things we know we haven't pinned down. Append, don't prune; move
items into **Decided** when they settle. This is the decision record for
`party-db` while it incubates.

---

## Decided (for now)

- **SCOPE: build only DO-controlled.** Other modes (trusting relay, PostgREST/SSE,
  Supabase ride-along) are kept in this log as designs but are NOT built; their
  code was removed to keep the surface focused. The DO is the authority and its
  SQLite is the persistence layer behind an otherwise-transparent partyserver.
- **Slim DO persistence = JSON blob per row + an `_oplog`.** Client mints UUIDs;
  the server stores `(k TEXT PRIMARY KEY, data TEXT)` per collection — no per-table
  DDL, no `RETURNING`, no column constraints. Resolved row == sent row, always.
  Validation (if any) rides on the shared schema. The `_oplog` AUTOINCREMENT is
  the seq + the replay source.
- **There is always an ack — it's the write's HTTP response.** DO-controlled:
  the `POST /write` reply (carries `seq`). (Supabase ride-along, if ever built:
  the `insert().select()` reply.) "Settlement" is the later arrival on the stream.
- **Reconnect is a delta, not a re-snapshot.** The client tracks its highest
  applied `seq` and sends `?since=<seq>` on every (re)connect (partysocket
  `query` fn, re-evaluated per connect); the server replays `_oplog WHERE seq >
  since`. A fresh client (no `since`) gets a full snapshot + `ready`.
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
  string`), per channel. Properties we actually rely on:
  - **equality** — "have I seen seq N yet?" (this is all settlement/awaitTxId
    needs; works for any opaque token, incl. a Supabase commit_timestamp).
  - **order** — only for backlog/gap logic, and only via a *transport-specific
    comparator*. Do NOT treat seq as a JS number: a PG LSN is 64-bit (> 2^53,
    loses precision) and non-contiguous, so "gap = N+1 missing" is a DO-only
    trick. On PG you trust the replication stream's own continuity instead.
- **Schemas are shared by import. No `/schemas` API.** Define the Zod/Standard
  Schema once, import on client and server. No untyped/dynamic mode, and (per
  the latest call) **no reason left to build the schemas API at all** right now.
  A **schema version-hash handshake** is worth adding *later* for drift
  detection, but not needed yet. (Withholding schemas to save bytes while
  shipping a 100kb+ TanStack DB client is not worth it.)
- **The stream always carries `WriteEvent`s** (`{ type, value }`) with `seq`
  attached — we are NOT inventing a format, we lean on the protocol throughout.
  "Resolved" is *only* about the contents of `value`: post-commit it includes
  DB-generated columns (defaults, `created_at`, serial ids). When the row is
  fully client-authoritative (UUID PK, no generated cols) the resolved value ==
  the sent value, i.e. literally "the same write with a seq." So "resolved row
  vs write message" is a false dichotomy — same shape, the only variable is
  whether `value` carries DB-generated fields.
- **The ack carries the match token (`seq`).** The resolved data arrives via the
  stream like everyone else's; `changed` in the ack is an optional latency
  optimization (e.g. a caller with no stream sub, or to catch a Zod-vs-DB shape
  mismatch early).
- **Server authority = raw SQLite, not TanStack DB.** On the DO the sink is
  `ctx.storage.sql` driven by a small generic `WriteEvent`→SQL adapter (the same
  `{table, key, type, value}` mapping as the PostgREST transport, different
  driver). TanStack DB — including its 0.6 **DO SQLite persistence adapter** — is
  a client-side *cache*, not a constraint/RETURNING authority. The "same
  interpreter both sides" holds at the *protocol* level (both speak WriteEvents);
  the client's sink is a TanStack DB collection, the server's sink is SQL.
- **DO broadcast is synchronous-ish and done inline.** `ws.send()` enqueues to
  the outbound buffer without awaiting client receipt; broadcasting is a sync
  loop over `ctx.getWebSockets()`, cost O(connections in room). Do it **inline
  right after commit, before responding** — that keeps broadcast order == seq
  order trivially (deferring via waitUntil/microtask risks a concurrent /write
  broadcasting a later seq first). It does not wait on the network.

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
- **Strictness probe — now mostly MOOT in the blob model.** We store JSON blobs
  with upsert-by-PK, so there are no column constraints to violate; SQLite is
  persistence, not a second validation line. If we later want server-side
  validation, run the shared Zod schema in `accept()` before the write and 4xx on
  failure. (Revisit only if we move to real typed columns + RETURNING.)
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
- **TODO (Supabase Edge longevity):** Edge Functions are request-scoped; bad host
  for a long-lived replication slot or long SSE. `/write` on Edge is fine; the
  stream wants Supabase Realtime or a separate long-running consumer. Unresolved.

### Supabase ride-along mode (minimal, very attractive)
- Sketched as `supabaseRealtimeTransport`. down = Supabase Realtime (managed
  logical-replication streaming); up = supabase-js / PostgREST writes. `createPartyDb`
  wires it like any other transport — only the Transport changes.
- **No custom server, RLS = real auth/validation.** This is the "skip a lot and
  ride on Supabase" path. The ack is NOT skipped — it's the `insert().select()`
  HTTP response; what's skipped is *building* an ack server.
- **Confirmed constraints (checked the payload + docs):**
  - Realtime payload = `{ schema, table, commit_timestamp, eventType, new, old,
    errors }`. **No lsn/txid.** So settlement matches on **primary key** (the
    client-minted UUID), not seq. We use `commit_timestamp` as the opaque cursor.
  - Realtime **does not replay missed events**. On reconnect: re-snapshot via a
    normal query, then resume the live stream. We trade away durable
    replay-from-cursor (acceptable under "clever non-promises").
- **TODO:** an op that doesn't change a row (no-op update) emits no Realtime
  event → settlement-by-PK could hang. Need a timeout / fallback refetch.
- **TODO:** insert returns the resolved row via `.select()` — feed it back as the
  optional `changed` if a caller wants it without waiting for Realtime.
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

### Cross-channel atomic writes — DONE (via their primitive + our `persist`)
- The capability is TanStack's (`createTransaction` + `tx.mutate` across
  collections); the only thing we add is `persist`, the mutationFn that groups
  `transaction.mutations` by channel → `WriteBatch[]` → POST → await every seq.
- `persist` is the SAME function used for the per-collection handlers
  (onInsert/onUpdate/onDelete), since a single insert is a one-mutation
  transaction. No `write()` sugar, no shadow vocabulary.
- Server commits the WHOLE POST body in one `transactionSync` → cross-channel
  all-or-nothing, broadcast only after commit.
- **PROBE before relying on it:** confirm an explicit `createTransaction` with a
  `mutationFn` BYPASSES the collections' own onInsert/onUpdate/onDelete handlers
  (otherwise a cross-collection write double-POSTs: once per handler + once via
  the mutationFn). Strongly expected, but unverified here.
- **Deferred:** "write to a channel with no local collection loaded" — the only
  thing `write()` would have added that this path can't. Separable niche helper
  if ever wanted; not bundled into the core API.

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
