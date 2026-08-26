# unspecified.md — open questions

Genuinely *open* questions about the current DO mode — things we haven't decided
yet. Keep it to that. When something ships it moves out: settled mechanics to
[`architecture.md`](./architecture.md), the rest into the code that implements it.
Fully-designed *future modes* (other persistence targets) belong in their own plan
doc once that milestone starts; until then a short design note lives at the bottom.

## Open enhancements (would build on the current DO mode)

- **insert/update schemas.** Accept optional `insertSchema`/`updateSchema` (default
  to `schema`) for write-time validation and payload shape (insert = full row,
  update = patch).
  - **Request-context refinements.** Some rules aren't a pure function of the row —
    e.g. `author_id === <the requester's uid>`. Let the write schema be a *function of
    a small per-request context* (`writeSchema: (ctx) => schema.refine(...)`), where
    `ctx.uid` comes from an `auth = (req) => uid` getter on the server that party-db
    resolves once per request (same request it already sees at the lobby). The lib
    stays out of validation — it just hands Zod the one thing the row can't carry: who
    is asking. See [cookbook 2](./cookbooks/02-server-validation.md).
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

## Deferred (intentionally not now)

- **Conflict resolution / CRDT merge.** Banking on "clever non-promises" so we don't
  need it until much later — including any conflict that could *undo* an acked write.
- **Surfacing the "acked-but-not-settled" phase distinctly** in the UI (a side map
  keyed by the minted id). The overlay collapses phases 2+3 today; fine.
- **Serial-PK settlement smoothing.** Serial / db-assigned PKs *work* (a column the
  client omits falls to the DB, and the resolved row carries the assigned key back),
  but the optimistic→resolved swap is keyed by `key` — and a serial PK *changes* key
  on commit, so the swap can flicker. Smoothing means carrying a temp-key →
  resolved-key remap through settlement. Client-minted UUIDs stay the zero-friction
  default, so this waits for someone to actually hit it.
- **Schema version-hash handshake** for drift detection. Cheap to add later; not needed
  while client and server import the same schema.
- **Offline write queues**, and **partial/column-level diffs** (we ship whole `value`s).

## Documented but NOT built (other modes)

Designs for *other persistence targets*, not open questions about the current one.
These graduate into their own plan doc once that milestone starts; the Postgres
design has done exactly that.

- **Postgres (controlled) — graduated.** The full design — decoupled write/stream
  paths, WAL tailing via logical replication (`seq` = LSN), `wid` preview↔echo
  correlation, RPC functions, simple per-user read/write rules — now lives in
  [`postgres-todo.md`](./postgres-todo.md).
- **Trusting relay.** WS-only, no ack, clients trust each other's logic/versions and
  mint UUIDs. The server just orders + fans out. Permissive pass-through.
- **Supabase Realtime ride-along.** On Supabase the WAL stream already exists as
  **Supabase Realtime** — use it as the down-transport, with a thin `/write`
  translating WriteEvents → PostgREST calls (`Prefer: return=representation`),
  since PostgREST is a stateless HTTP shell and cannot emit a stream. Its payload
  carries no LSN/txid, so settle by primary key (the client UUID); and it does not
  replay missed events, so reconnect = re-snapshot. **Supabase Edge** is
  request-scoped — fine for `/write`, a poor host for a long-lived replication
  slot or SSE. Effectively a different lane from `postgres-todo.md`; Supabase's
  own `supabase/tanstack-db` is the reference implementation of it.
