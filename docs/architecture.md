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
   collection definitions), committing into the structured tables your app already
   uses.
3. The client passes a PartySocket connection and its schemas to `createPartyDb()`
   — live queries, optimistic writes, and confirmed sync all work.

## 1. Starting with One mode: DO-controlled SQLite for v1

After the v0 proof-ofconcenpt, our first real deployment target is the same as
PartyServer: a Durable Object that is both the authority and the SQLite
persistence behind an otherwise-transparent partyserver. It owns the WebSocket
(down) and `POST /write` (up) for its room.

Why: a DO is single-threaded and has transactional SQLite, which hands us total
ordering and durability for free. Other shapes (a trusting relay, PostgREST/SSE,
Supabase Realtime) are designs only, parked in `unspecified.md`.

For the moment, we are wanting to keep this library tightly focused on extending
PartyKit, so our deployment target is their deployment target.

## 2. The wire format is TanStack DB's `write()` argument

Everything on the wire is a `WriteEvent` = `Omit<ChangeMessage, 'key'>` —
`{ type, value }`. The key is derived from `value` by the collection's `getKey`
and never travels.

Why: it is exactly what TanStack hands to a collection's `sync.write()`, so there
is no translation on either end — we ship what we apply.

This means that every consumer of the stream simply has to accept this `write`
payload format, pass the same tests, produce the same results, etc. This package
is meant to have the write-confirm-settle cycle land, at its terminus, in
Tanstack DB collections.

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

Your relational schema is a stakeholder in this whole thing; you may have a ton
of other parts of your app and ecosystem that rely on its current structure,
format, performance profile, infrastructure options, and the assurances it
provides. A PartyDB replicates that shape and content to its consumers, without
requiring the data take any particular shape.

Why: your database is your app's global API, with masters beyond this library. So
the server completes a write the way a web application does — a genuine
transactional commit the database's own constraints can accept or reject — and
hands back the **resolved** row the database actually wrote (defaults, generated
columns, serials, trigger effects), which is what fans out to everyone. Zod is
your first-line validation and your types on the client; the database is the
authority on the server. You keep the two in agreement by defining schemas that
match your tables — that agreement is the entire contract. In practice it's *one
collection interface* — `{ name, key, schema }` — defined once and imported on both
client and server; they may be distinct `clientCollection` / `serverCollection`
entities if their fill-in-value rules differ, but the interface is shared.

This ability to maintain transactional integrity means that what you currently
implement as RPC functions, where you write one table, and then another, and
another, in a specific order, that matters for the integrity checks in the
database -- these can be implemented with the same specificity on the client,
using Tanstack DB transactions. In the old way, the complexity was mixed on
the RPC handler and the DB rules; now we're encouraging you to move it into
the DB rules, and then write transactions that follow them.

The complexity it getting a little bit clarified, and a little bit just moved
from one place to another: from your RPC handler into the order in which you call
your TanStack DB operations (a `createTransaction`
for atomic grouping is an *optional* optimization) instead of in a bespoke RPC
handler. The server doesn't recompute or pre-judge it — it applies your batch in
order, in one transaction, and the database's constraints decide whether your
assumptions held. So the middle layer stays thin: Zod runs server-side only as a
cheap *error-sooner* gate (nicer messages, don't open a doomed transaction), never
as the correctness authority. Correctness is the database's — it always was the
real source of truth, even when something upstream pretended to be.

**Status:** the shipped code is **v0** — the uncontrolled fallback (§5a). This
section is **v1**, the active work — see the Roadmap below and
[`sqlite-do-todo.md`](./sqlite-do-todo.md).

### 5a. Uncontrolled mode — v0 (the shipped baseline)

This is what runs today. A collection can opt out of all of the above: the server
stores rows as opaque `(k TEXT PRIMARY KEY, data TEXT)` blobs keyed by PK (plus the
`_oplog(seq INTEGER PRIMARY KEY AUTOINCREMENT, channel, ops)`) and validates
nothing — client schemas still exist (you always need them for TanStack DB), the
server just doesn't care what they are. With client-minted UUID keys the resolved
row equals the sent row, so there's no reconciliation. It's real and shipped — a
zero-config realtime collection store — over the same controlled transport (ack,
`seq`, fan-out) as v1; it just doesn't control the *data*. We don't extend it; v1
above is where the work goes.

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

## Roadmap

**v0 — uncontrolled sync (shipped, done).** A PartyServer fills your TanStack DB
collections with zero config: the client mints UUIDs, the server stores rows as
opaque blobs (§5a) and validates nothing, and writes fan out to every subscriber.
The *data* is uncontrolled — there's no real database underneath — but the
transport is the same controlled DO-authority sync as v1 (ack, `seq`, fan-out,
delta reconnect). Not the goal, but a real thing: a zero-config realtime
collection store.

**v1 — controlled by your RDBMS (SQLite first; this repo's active work).** The
server persists into structured tables, validates each row against its Zod schema
server-side, lets the database validate (constraints/FKs), and returns the full
ack → echo of the *resolved* row — still zero config. Transactions live in your
TanStack DB transactions: we represent them in order and apply them in order, each
row Zod-checked, then committed to the database. You still reason about write order
— but only once, and it never forces you into RPCs where ordered CRUD would do,
into request waterfalls, or into loosening referential integrity: the write
transaction applies *inside the database*, where it always belonged, not at a
middle layer.

**v2 — swappable persistence sinks, and what they pull in.** Optional D1 or
Postgres alongside DO-SQLite. D1 is mostly "handle a farther-away box." Postgres is
the bigger bite: RPC support, RLS conventions, the per-user (and other partitioned)
collection types, possibly the serializable read-slicing sketched in
[`unspecified.md`](./unspecified.md) / [`collection-types.md`](./collection-types.md),
and maybe a non-realtime `queryCollection` fallback for tables we can't tail. And
once two or three databases coexist, a `db` may compose tables from different
places — or just conventions for running two side by side (one realtime + global,
one not), where each collection picks its transport and the transport knows which
loading strategies are valid for it. Lots to design; not yet.

**v3 (horizon, not planned) — generate everything.** Point at your database, mark
tables public / per-user / per-team, and codegen a fully-typed `db` of typed
collections with typed insert/update, typed live queries, and RPCs. Change the
Postgres structure, re-run codegen, hover over `db`, and the new tables / columns /
functions are just there — maybe including cross-schema-version client/server
sync. The *only* place the "generate schemas/DDL" question lives; not in scope
before then.
