# party-db architecture

The decision record. Each section is one settled decision and why. Open
questions and not-yet-built modes live in [`unspecified.md`](./unspecified.md); a
survey of TanStack DB's other collection types and party-db's read-side
capabilities lives in [`collection-types.md`](./collection-types.md).

## 0. Goal: connect your TanStack DB collections to the database you already run

party-db is the connective tissue between a TanStack DB collection on the client
and your real relational database. You write `todos.insert()` on one client; every
other client's collection receives the row and re-renders. Everything in between —
the `POST`, the durable commit into your tables, the acknowledgement, the
ordering, and the fan-out — is ours, and it conforms to your database's structure,
its types, and its auth as it goes. Those are transparent to us: as long as we can
run CRUD (and, later, RPC) against your tables end to end, you keep TanStack DB as
both the first mile (`insert()`) and the last mile (the synced re-render), and we
fill in the middle.

**TanStack DB becomes your entire API.** Instead of writing API handlers on the
server and `onInsert/onUpdate/onDelete` on the client, you glue them together with
this. Your database still enforces its constraints; your `todos.insert()` still
goes to the server over a `POST` and is acknowledged before it fans out to the live
sync. You just don't write anything in between — you make your database enforce the
constraints you need, you make your Zod schemas match, and that is the connective
tissue.

**Server setup is as easy as defining TanStack DB collections.** The same Zod
schemas that already power TanStack DB now drive your production database too,
replicating writes up and back out to every consumer. "Near-zero config" is
literal: you pass Zod schemas, but you already needed those for TanStack DB.

The shape of it:

1. The client defines collections exactly as it would for any TanStack DB app
   (`definePartyCollection`) — minus the `onInsert/onUpdate/onDelete` plumbing,
   which is what we provide.
2. The server runs `PartyDbServer` on a Durable Object (a `PartyServer` plus the
   collection definitions), committing into structured tables that reflect those
   schemas.
3. The client passes a PartySocket connection and its schemas to `createPartyDb()`
   — live queries, optimistic writes, and confirmed sync all work.

## 1. Starting with One mode: DO-controlled

Our initial deployment target is the same as PartyServer: a Durable Object that
is both the authority and the SQLite persistence behind an otherwise-transparent
partyserver. It owns the WebSocket (down) and `POST /write` (up) for its room.

Why: a DO is single-threaded and has transactional SQLite, which hands us total
ordering and durability for free. Other shapes (a trusting relay, PostgREST/SSE,
Supabase Realtime) are designs only, parked in `unspecified.md`.

For the moment, we are wanting to keep this library tightly focused on extending
PartyKit, so our deployment target is their deployment target. (However, the
structure of the thing seems to be able to travel; it could be that PartyKit
becomes just one supported transport, and/or SQLite becomes just one supported
persistence layer.)

## 2. The wire format is TanStack DB's `write()` argument

Everything on the wire is a `WriteEvent` = `Omit<ChangeMessage, 'key'>` —
`{ type, value }`. The key is derived from `value` by the collection's `getKey`
and never travels.

Why: it is exactly what TanStack hands to a collection's `sync.write()`, so there
is no translation on either end — we ship what we apply.

This means that every consumer of the stream simply has to accept this `write`
payload format, pass the same tests, produce the same results, etc. This package
is meant to be a Tanstack DB tool.

## 3. Many collections multiplex over one connection

Each batch carries a `channel` (= the table name). One socket serves N
collections; the client's `SyncClient` routes each incoming batch to the matching
collection by channel.

Why: one connection per room, not one per table.

## 4. Shared wire types + apply contract; per-target apply code

What every consumer shares is the wire format (§2) and the *contract* of applying
a batch: do its ops atomically, in order. The apply *code* differs per target, by
design — the client applies into a TanStack DB collection (`applyBatch` in
`src/client/apply.ts`, driving TanStack's `sync({begin,write,commit,markReady})`);
the server applies into SQLite directly (`applyOne`, inside one `transactionSync`
over the whole POST); a future Postgres target translates to its own SQL.

Why not one shared `applyBatch` on both sides: the server also mints `seq` and
wraps the *entire* multi-channel POST in a single transaction (§11) — a coarser
boundary than a per-batch begin/commit. Forcing both through one function would
fight the server's atomicity, not help it. The shared thing is the contract, not
the loop.

## 5. The server persists into structured tables that reflect your schema

The server's storage *is* your relational schema: real tables, real columns, real
constraints and foreign keys — the shape your app already depends on and that your
other consumers (reports, admin, jobs, other services) already read and write. We
conform to that shape; we never ask the data to become something else.

Why: your database is your app's global API, with masters beyond this library. So
the server completes a write the way a web application does — a genuine
transactional commit the database's own constraints can accept or reject — and
hands back the **resolved** row the database actually wrote (defaults, generated
columns, serials, trigger effects), which is what fans out to everyone. Zod is
your first-line validation and your types on the client; the database is the
authority on the server. You keep the two in agreement by defining schemas that
match your tables — that agreement is the entire contract.

This is what makes resolved-row reconciliation load-bearing (`WriteAck.changed`
plus the resolved row on the stream): when the committed row differs from the sent
row, the resolved row is the truth, and the client swaps its optimistic overlay
for it.

**Status:** the shipped code is the *uncontrolled* fallback (5a), not this.
Building the structured-table path is the active work — see
[`sqlite-do-todo.md`](./sqlite-do-todo.md).

### 5a. Uncontrolled mode (the small fallback)

A collection can opt out of all of the above: the server stores rows as opaque
`(k TEXT PRIMARY KEY, data TEXT)` blobs keyed by PK (plus the
`_oplog(seq INTEGER PRIMARY KEY AUTOINCREMENT, channel, ops)`) and validates
nothing — client schemas still exist (you always need them for TanStack DB), the
server just doesn't care what they are. With client-minted UUID keys the resolved
row equals the sent row, so there's no reconciliation. Fine for a pure "party
room" with no real database behind it; a deliberately tiny corner we don't intend
to invest in for now.

## 6. `seq` is the authority's commit-log position

`seq` comes from the `_oplog` AUTOINCREMENT. Because the DO is single-threaded
and the write is transactional, that rowid is a clean total order — read back in
the same transaction via `RETURNING seq`. It is typed as `Cursor`
(`number | string`) so another authority's position (e.g. a Postgres LSN) fits
later.

Why: we never invent a separate counter, and we only ever rely on `seq`
*equality* (settlement) and *order* (backlog) — never arithmetic.

## 7. Optimistic → ack → settlement, flicker-free

A write moves through three phases: optimistic apply (instant), **ack** (the
`POST /write` HTTP response, carrying the assigned `seq`), and **settlement**
(the same batch arriving back on the stream). The write handler awaits its `seq`
on the stream (`SyncClient.waitForSeq`) before resolving, so the optimistic
overlay survives the ack→stream gap and then drops straight onto the synced row.

Why: resolving on the bare ack would drop the overlay before the authoritative
row arrived — a flicker. Electric calls this `awaitTxId`; we implement our own,
keyed on `seq`.

## 8. Reconnect is a delta, not a re-snapshot

The client tracks its highest applied `seq` and sends `?since=<seq>` on every
(re)connect (a partysocket `query` function, re-evaluated per connect). The
server replays `_oplog WHERE seq > since`. A fresh client (no `since`) gets a
full snapshot followed by a `ready` sentinel.

Why: a returning tab should receive only what it missed, not the whole room.

## 9. Broadcast inline, after commit, before responding

`ws.send()` enqueues to the outbound buffer without awaiting receipt, so
broadcasting is a cheap synchronous loop over `ctx.getWebSockets()`. We do it
inline after the commit and before sending the HTTP response.

Why: deferring it (e.g. `waitUntil`) would let a concurrent `/write` broadcast a
later `seq` first; inline keeps broadcast order == seq order.

## 10. Schemas are shared by import

Define the Zod/StandardSchema once and import it on both client and server. There
is no `/schemas` API, no version handshake, and no untyped/dynamic mode.

Why: a typed app already ships the TanStack DB client; withholding a few schemas
to save bytes is false economy. (A schema version-hash for drift detection is a
possible *later* addition — noted in `unspecified.md`.)

## 11. `persist` is the only binding; cross-collection atomicity is TanStack's

The one thing party-db adds beyond TanStack DB is `persist`: a `mutationFn` that
groups a transaction's `mutations` by channel into one `/write` POST and awaits
every assigned `seq`. The per-collection `onInsert`/`onUpdate`/`onDelete` handlers
*are* `persist` — a single `insert` is just a one-mutation transaction.

Cross-collection atomic writes therefore use TanStack's own
`createTransaction({ mutationFn: persist })`; there is no bespoke `write()`
function. The server commits the whole POST body in one `transactionSync`, so a
multi-collection write is all-or-nothing.

Verified on `@tanstack/db@0.6.10`: an explicit transaction bypasses the
collection handlers and delivers all mutations to the `mutationFn` in one call —
so there is no double-write.

## 12. The authority is SQLite, not TanStack DB

On the server the sink is `ctx.storage.sql` driven by a small generic
`WriteEvent`→SQL adapter. TanStack DB — including its 0.6 DO SQLite persistence
adapter — is a **client cache**: even when it runs *on the server*, it is a client
*of* some upstream authority, not the authority itself. That is precisely why it
cannot be the constraint/`RETURNING` authority or the persistence layer — and so
why we skip trying to use it as the server sink, reaching for `ctx.storage.sql`
(or a real database) directly. What's shared across sides is the wire protocol and
the apply contract (§4), not the apply code — the sinks differ.

## Layering

| Layer | What |
| --- | --- |
| Theirs (TanStack DB) | `Collection`, `createTransaction`, `mutate`, `isPersisted`, optimistic state |
| Ours (irreducible) | the `sync` down-binding + `persist` up-binding (wire + seq settlement) |
| Sugar | `createPartyDb` — bundles N collections + transport + `isConnecting` |
