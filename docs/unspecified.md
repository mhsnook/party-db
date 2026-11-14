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
    `ctx.uid` is the `sub` claim of the identity the server's `auth` hook already
    resolves once per request (same request it already sees at the lobby). That hook —
    `(req) => WriteIdentity | null` — is shipped; only `writeSchema` and its `ctx` are
    open. The lib stays out of validation — it just hands Zod the one thing the row
    can't carry: who is asking. See [cookbook 2](./cookbooks/02-server-validation.md).
- **A bounded backfill for `snapshot: false` collections.** A feed that tails from
  now (architecture §8) often wants "the last 50" first. The room keeps the
  history, so this is a read of the newest `_oplog` entries for that channel,
  `ORDER BY seq DESC LIMIT n`, replayed oldest-first ahead of the ready marker. The
  limit counts batches, not rows: a burst of close-together activity loads a little
  more. Two things to settle first: the per-collection `n` (config, or carried on
  the re-register frame), and how TanStack DB applies a delete for a key the client
  never held, which such a window can contain.
- **Read slicing beyond one immutable column.** Equality on one declared, immutable
  column is built: `sliceBy` (architecture §18). A live query's `where` is the
  subscription, the client owns each slice's cursor, and the room routes writes by
  an in-memory index. What is still open:
  - **Mutable slice columns — the shape-membership problem.** If a row can change
    *out of* a socket's slice (its `lang` is edited), that socket needs a synthetic
    delete it would otherwise never see. This is Electric's move-in/move-out. The
    room already reads the prior row for owner policies (§17 → "A row that changes
    hands"), and the same read could route a leave to the old slice's watchers.
    Today an update that carries the slice column is refused.
  - **Ranges and `orderBy`/`limit`.** A `gt`/`lt` on a column, or "the newest 50",
    loads the whole channel today. Ranges cannot be index lookups the way equality
    is, so fan-out would evaluate a predicate per subscriber. `limit` needs
    TanStack's cursor-based `loadSubset` paging.
  - **Channel filtering for unsliced collections.** Every socket still gets every
    unsliced channel's fan-out. The subscribe frame could carry that filter as well,
    because a subscribe with no `slice` is already the whole-channel form.
  - **A write outside the writer's slices.** It commits, but never streams back to
    the writer, so `waitForSeq` times out and the optimistic row rolls back. The fix
    is to settle from the ack when the written row matches none of the client's
    live subscriptions.
  - **No joins / aggregates.** Cross-collection or rollup slices stay in the
    "abandon realtime → `queryCollection`" bucket (see `collection-types.md`).

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
- **Offline write queues.** Still open.
- **Column-level diffs on the way DOWN.** An update now travels UP as changed columns
  only ([architecture §16](./architecture.md#16-an-update-sends-tanstacks-changes-and-must-hit-a-row)),
  but what fans out is always the full resolved row. Narrowing the down-stream to
  changed columns would need the client to merge rather than replace; not needed while
  rows are small.

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
