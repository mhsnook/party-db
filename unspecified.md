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
