# unspecified.md — open questions

What is *not* settled. Settled decisions live in [`architecture.md`](./architecture.md).
Append, don't prune; promote an item to `architecture.md` once it's decided.

## Open enhancements (would build on the current DO mode)

- **insert/update schemas.** Accept optional `insertSchema`/`updateSchema` (default
  to `schema`) for write-time validation and payload shape (insert = full row,
  update = patch).
- **Subscription / filtering.** Today the server broadcasts every channel and the
  client ignores unknowns. A `subscribe(channels[])` control message would let the
  server send only relevant batches + backlog. Matters as channel count grows.
  - **Read-level slicing (Electric-style shapes, the tractable subset).** TanStack
    DB's `where` clauses compile to a **plain-data, serializable AST** — `Func {
    name, args }`, `PropRef { path }`, `Value { value }`, *no closures* (verified in
    `@tanstack/db` `query/ir.ts`) — and the lib ships `parseWhereExpression(expr,
    handlers)` to walk it with per-operator handlers. So a client can ship its slice
    predicate up (in the `subscribe` / reconnect query), and the server turns the
    same AST into **(a)** a SQL `WHERE` for the snapshot + `?since` backlog and
    **(b)** an in-memory predicate for per-socket fan-out. Changing a slice = a new
    `since` + `where` → a fresh delta. Gets us Electric-style read slicing without
    much new machinery — *for the row-local subset*. Boundaries:
    - **Allow-list the sliceable columns/operators.** A client-supplied `WHERE` run
      raw is an injection / over-exposure vector; restrict to declared columns and
      parameterize the `Value`s. Only `eq/gt/gte/lt/in/and/or`-shaped predicates over
      columns + literals serialize; arbitrary JS predicates don't (they aren't in the
      IR).
    - **Immutable slice column = easy; mutable = the shape-membership problem.** If a
      row can change *out of* a socket's slice (its `lang` is edited), that socket
      needs a synthetic "leave"/delete it would otherwise never see — the classic
      Electric move-in/move-out. Trivial for immutable slice keys (a post's language,
      a created-at date); real work otherwise. Start with immutable-keyed slices.
    - **No joins / aggregates.** Cross-collection or rollup slices stay in the
      "abandon realtime → `queryCollection`" bucket (see `collection-types.md`).
    - **The client owns its per-slice `since`.** A slice's cursor belongs to the
      *client*, not the room: when you stop watching a slice you remember the `seq`
      at which you dropped it, so re-subscribing is `?since=<that seq>` + the slice
      `where` — a delta, never a re-snapshot. This is also what makes the mutable
      move-out tractable from the client's side: it knows exactly the window it
      missed and asks only for that. (Server still has to be able to *answer* "what
      changed in this slice since N", which is the move-in/move-out work above; the
      client side of it is just bookkeeping.)
- **Auth.** Bearer/session on both the stream open and the POST. scenetest-cloud's
  model already gives each room a bearer; mirror that.
- **Ordering scope.** `seq` is global per room (one `_oplog`). Fine today. Revisit
  only if collections need a cross-collection *total order* guarantee beyond the
  single-POST atomicity we already have.
- **Write to a channel with no local collection loaded.** The one thing a `write()`
  wrapper would add that `createTransaction({ mutationFn: persist })` can't (optimism
  needs a loaded collection). Separable niche helper if ever wanted; not core.

## Deferred (intentionally not now)

- **Conflict resolution / CRDT merge.** Banking on "clever non-promises" so we don't
  need it until much later — including any conflict that could *undo* an acked write.
- **Surfacing the "acked-but-not-settled" phase distinctly** in the UI (a side map
  keyed by the minted id). The overlay collapses phases 2+3 today; fine.
- **Serial / db-assigned PKs.** Would need resolved-row reconciliation; prefer client
  UUIDs and sidestep it.
- **Schema version-hash handshake** for drift detection. Cheap to add later; not needed
  while client and server import the same schema.
- **Offline write queues**, and **partial/column-level diffs** (we ship whole `value`s).

## Documented but NOT built (other modes)

Kept as designs so the protocol stays honest about where it could go.

- **Trusting relay.** WS-only, no ack, clients trust each other's logic/versions and
  mint UUIDs. The server just orders + fans out. Permissive pass-through.
- **PostgREST / Supabase (controlled).** Write path and stream path must be
  *decoupled* — PostgREST is a stateless HTTP shell and cannot emit a stream, and
  echoing from `/write` mis-orders under concurrency. The correct stream source is
  Postgres **logical replication** (decode the WAL → row-level WriteEvents, `seq` =
  LSN), i.e. what Electric does. Write path = thin `/write` translating WriteEvents →
  PostgREST calls (`Prefer: return=representation`).
  - On **Supabase**, that stream already exists as **Supabase Realtime** — use it as
    the down-transport. Its payload carries no LSN/txid, so settle by primary key (the
    client UUID); and it does not replay missed events, so reconnect = re-snapshot.
  - **Supabase Edge** is request-scoped — fine for `/write`, a poor host for a
    long-lived replication slot or SSE. Stream wants Realtime or a separate consumer.
  - **`@supabase/server` as the `/write` host (public beta, May 2026).** A DX/
    boilerplate package, *not* persistent compute: `withSupabase({ auth }, handler)`
    returns a standard `(Request) => Promise<Response>` with a pre-wired RLS-scoped
    `ctx.supabase`, an admin `ctx.supabaseAdmin`, verified JWT claims, and CORS —
    and the same handler runs on Edge Functions, Vercel, **Cloudflare Workers**, Hono,
    and Bun. So our `/write` becomes *another `PersistenceAdapter` (§4) behind the same
    interface*: the handler shape is identical to the Worker/DO `fetch` we already write;
    only the sink moves from `ctx.storage.sql` / `transactionSync` to a Supabase client
    call. This is the write *half* only — the stream stays decoupled (Realtime or a WAL
    consumer, per the points above); a stateless ack is fine precisely because the
    authoritative, ordered echo (`seq` = LSN, settle-by-PK) comes off that separate
    stream, so `/write` returns an optimistic preview, not the order authority.
    - **It closes the "auth on the POST" open-item for free.** `withSupabase({ auth:
      'user' })` verifies the bearer before the handler runs, and because `ctx.supabase`
      is RLS-scoped the database judges the write — exactly our "the database is the
      authority on the server" stance (architecture §5). Write through `ctx.supabase`,
      not `ctx.supabaseAdmin`, so RLS applies.
    - **The one wrinkle: §11 atomicity doesn't survive a naive port.** supabase-js issues
      one PostgREST request per `.from(x).insert()`, each its own transaction. A single-
      mutation write maps perfectly — `.insert().select()` with `Prefer: return=
      representation` gives the resolved row in one txn. But the multi-collection
      `createTransaction` guarantee (architecture §11: the whole POST body commits in one
      `transactionSync`, all-or-nothing) has no PostgREST equivalent. To keep it, ship the
      grouped batch to a **Postgres RPC** — `ctx.supabase.rpc('apply_writes', { batch })`,
      `security invoker` so RLS still bites — that loops the ordered ops in one transaction
      and `RETURNING`s the resolved rows. That RPC *is* the Supabase persistence adapter.
      So: simple writes → one PostgREST call; transactional writes → one RPC call; either
      way the handler stays `withSupabase`-thin and portable from the Worker/DO `/write`.
  - **Preview ↔ echo correlation without touching user tables.** When the echo is the
    WAL, the `/write` ack is only an *optimistic preview* (best-effort yielded rows);
    the WAL is the authoritative, complete echo (it carries trigger/cascade/default
    rows the write never named). Correlate the two with
    `pg_logical_emit_message(true, 'wid', <writeId>)` *inside* the `/write`
    transaction — it rides in-band in that transaction's WAL block (PG14+ `pgoutput`
    streams logical messages), so no `wid` column on user tables. On echo the client
    swaps its overlay for the canonical rows and **drops any optimistic row the WAL
    didn't confirm** (self-heals an over-yield, which is always an app bug). So
    "yield your changed rows" is a UI-latency optimization, not a correctness
    requirement.
  - **FK-ordering guarantee.** Referential validity in Postgres ⇒ causally-safe apply
    order in the WAL: a child can't appear before its parent (Postgres wouldn't have
    let it commit). Apply each WAL transaction atomically so live-query joins never
    see a partial state. This makes the WAL path *more* safely-ordered than the raw
    write-payload, not less.
  - **What keeps this a dumb adapter, not a CDC engine.** The cost driver is
    cross-room *read*-sharing, not the database choice: within-room write+read (even
    on Postgres) is trivial (write synchronously, ack, echo from own log); a table
    *read by many rooms* is what pulls in a central WAL-consumer/demux service (slot
    management — a lagging slot pins WAL and fills disk — + LSN↔`wid` correlation +
    consistent snapshot↔LSN handoff). Two constraints keep even that tractable:
    (a) partition tables so exactly one DO writes each partition (the writer stays the
    serialization authority — no multi-writer conflict reconciliation); (b) prefer
    append-only record tables. A single transaction spanning collections on
    *different* persistence targets can't be atomic → reject/warn.
