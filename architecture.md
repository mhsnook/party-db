# party-db architecture

The decision record. Each section is one settled decision and why. Open
questions and not-yet-built modes live in [`unspecified.md`](./unspecified.md).

party-db makes live TanStack DB collections sync over one Cloudflare Durable
Object room: you `insert()` on the client, it POSTs to the room's `/write`, the
DO records it in its own SQLite and fans it out over a hibernatable WebSocket,
and every listening client applies it to the same collection.

## 1. One mode: DO-controlled

We build exactly one deployment: a Durable Object that is both the authority and
the persistence layer behind an otherwise-transparent partyserver. It owns the
WebSocket (down) and `POST /write` (up) for its room.

Why: a DO is single-threaded and has transactional SQLite, which hands us total
ordering and durability for free. Other shapes (a trusting relay, PostgREST/SSE,
Supabase Realtime) are designs only, parked in `unspecified.md`.

## 2. The wire format is TanStack DB's `write()` argument

Everything on the wire is a `WriteEvent` = `Omit<ChangeMessage, 'key'>` —
`{ type, value }`. The key is derived from `value` by the collection's `getKey`
and never travels.

Why: it is exactly what TanStack hands to a collection's `sync.write()`, so there
is no translation on either end — we ship what we apply.

## 3. Many collections multiplex over one connection

Each batch carries a `channel` (= the table name). One socket serves N
collections; the client's `SyncClient` routes each incoming batch to the matching
collection by channel.

Why: one connection per room, not one per table.

## 4. One interpreter on both sides

`applyBatch(sink, batch)` is identical on client and server. Only the *sink*
differs: a TanStack collection on the client, SQLite on the server.

Why: if a batch applies in one place it applies everywhere — there is a single
definition of "apply".

## 5. Client mints UUIDs; the server stores JSON blobs + an oplog

Rows are stored server-side as `(k TEXT PRIMARY KEY, data TEXT)` per collection,
plus one `_oplog(seq INTEGER PRIMARY KEY AUTOINCREMENT, channel, ops)`. No
per-table DDL, no `RETURNING`, no column constraints.

Why: with client-minted UUID keys the resolved row equals the sent row, so
persistence is a blob upsert and the "resolved vs sent" distinction disappears.
SQLite here is persistence, not a second validation layer.

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
adapter — is a client-side *cache*, not a constraint/RETURNING authority. "Same
interpreter both sides" holds at the protocol level; the sinks differ.

## Layering

| Layer | What |
| --- | --- |
| Theirs (TanStack DB) | `Collection`, `createTransaction`, `mutate`, `isPersisted`, optimistic state |
| Ours (irreducible) | the `sync` down-binding + `persist` up-binding (wire + seq settlement) |
| Sugar | `createPartyDb` — bundles N collections + transport + `isConnecting` |
