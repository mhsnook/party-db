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
- **Per-channel `seq`**, assigned by the authority; backlog replay on connect,
  terminated by a `ready` sentinel per channel.
- **Batches are atomic windows** (`begin`/`commit`) so "add post + tag it" lands
  together.

## Open

### Two-phase pending (ack vs. stream arrival)
- The gap: in controlled mode a client gets a `WriteAck` (write accepted, seq N)
  *before* seq N comes back down the stream. Risk of a flicker / a brief window
  where a later conflict could "undo" it.
- **Finding:** TanStack DB already models this. Optimistic state is held until
  the handler returns; the idiomatic pattern (Electric's `awaitTxId`) is for the
  handler to **not resolve until the matching write is observed on the sync
  stream**. Our `seq` is the natural match token (Electric uses pg txid).
- **TODO:** does the core lib expose an `awaitTxId`-equivalent for arbitrary
  collections, or is it Electric-collection-only? If the latter, we provide our
  own: handler awaits `seq` appearing via the SyncClient before resolving.
- **TODO:** is a *third* state ("acked but not yet streamed") ever worth
  surfacing in the UI? Hope not — awaiting the stream collapses it. Conflict
  handling that could undo an acked write is **deferred** (clever non-promises).

### Schemas API — is `/schemas` needed?
- Default answer: **no.** Typed apps share the Zod/StandardSchema directly
  (define once, import on client and server). Client knows its tables.
- It becomes useful only for: (a) **dynamic clients** that follow tables they
  don't ship schemas for (`createPartyDb(client, ['users','posts'])`), (b) a
  **version/hash handshake** so client and server can detect schema drift
  (relevant to "trusted versions"), (c) the "build the whole DB client from a
  session + a schemas API + a write API" vision.
- **Constraint:** StandardSchema/Zod refinements don't serialize. We could ship
  JSON-Schema-ish *shape* down the wire, but custom validation logic won't
  travel. So "send validation down the wire" is bounded to structural validation.
- **Decision pending:** keep `/schemas` optional; ship "shared-schema" mode
  first, "discovered-schema" mode later.

### Config derivation — how much can we infer?
- From `{ name, key, schema }` we already derive: `getKey`, `sync` (register on
  client), and `onInsert/onUpdate/onDelete` (emit WriteEvents). Handlers are
  mechanical given the transport — schema mostly adds types + validation.
- **Proposal:** accept `insertSchema` / `updateSchema` (default to `schema`) for
  write-time validation and payload shaping (insert = full row, update = patch).
- **PostgREST mapping is fully generic** from `{ table, key, type, value }`:
  insert→POST, update→PATCH `?{key}=eq.{id}`, delete→DELETE `?{key}=eq.{id}`.
  So the postgrest transport needs no per-table code.
- **TODO:** how much of the TanStack DB `transaction.mutations` shape do we lean
  on? (`.modified` / `.original` / `.type` / `.key`) — confirm against the
  version we target.

### IDs
- **Client mints UUIDs before sending** (so optimistic inserts have a stable key;
  required in trusting mode). With UUID PKs the client id is authoritative and
  there's no id round-trip.
- **TODO:** serial/db-assigned PKs need reconciliation — `WriteAck.changed`
  carries server-resolved rows. How does the optimistic row swap to the real id
  without a flicker? (Probably: prefer UUIDs and sidestep this.)

### Server-side strictness
- Controlled mode rejects by *failing the commit* on its own collection.
- **TODO (noted as non-central):** would a SQLite constraint violation that the
  Zod schema didn't catch actually throw at `commit()` and abort the POST? Or
  does TanStack DB swallow it? Needs a probe. Determines whether SQLite is a real
  second line of validation or just persistence.

### Transport matrix
| mode | down | up | target |
| --- | --- | --- | --- |
| controlled | hibernatable WS | POST /write | Durable Object |
| controlled | SSE | POST /write | PostgREST / Supabase Edge |
| trusting | WS | WS (same socket) | any |
- **TODO:** is POST+SSE strictly better than WS for the Node/Supabase target?
  (Edge functions + SSE down, stateless POST up — leaning yes.)
- **TODO:** auth — bearer/session on both the stream open and the POST. The DO
  already owns a per-room bearer in scenetest-cloud's model; mirror that.

### Subscription / filtering
- v1 broadcasts every channel to everyone; client filters. Wasteful as channels
  grow. **TODO:** a `subscribe(channels[])` control message so the server sends
  only relevant batches + backlog.

### Ordering scope
- Per-channel seq chosen. **TODO:** revisit if collections need cross-collection
  atomicity / total order (would push toward a global seq and couple channels).

### Persistence
- DO: back the per-channel log with DO SQLite so rooms survive eviction.
- PostgREST: Postgres *is* the persistence; the down-stream is derived from
  committed writes (logical replication / NOTIFY / the /write handler echoing).
- **TODO:** how does the down-stream get populated on the Postgres target —
  echo from /write, or tail WAL/logical replication? Echo is simpler; tailing is
  more correct (captures writes from outside our /write).

---

## Deferred (intentionally not now)

- Conflict resolution / CRDT merge. Banking on "clever non-promises" so we don't
  need it until much later.
- Offline write queues.
- Partial/column-level diffs (we ship whole `value`s).
