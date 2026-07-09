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

Why push everything to the edges: the middle tier — server code between the UI and
the database — mostly does abstraction and glue, and it's worse at logic than the
database (constraints, triggers, RPCs, RLS) and worse at experience than the client
(live queries, optimistic transactions). party-db is glue that's *good at being
glue*: it pushes the abstractions into the database and the client and gets out of
the way — you write ordered optimistic ops on the client, and if they apply there
they're POSTed and applied in one DB transaction, no ORM and no middle-tier
round-trips.

## 1. The persistence ratchet: uncontrolled → DO-SQLite → D1 → Postgres

There is one ladder of persistence modes, and it only turns one way. Each rung up
hands the *database* more control over your data — and moves that data somewhere
more consumers can reach:

0. **Uncontrolled (blob).** The server stores rows as opaque `(k, data)` JSON keyed
   by PK and validates nothing (§5a). Zero config; no real schema underneath.
1. **DO-embedded SQLite.** Structured CRUD against your real, typed columns, your
   constraints judging every write — but private to the Durable Object.
2. **D1.** The same structured tables, now in a database your *other* consumers can
   read. "Your database is the global API" stops being a slogan.
3. **Postgres (v2).** Structured tables *plus* a change-feed (WAL), so even writes
   that never came through us fan out (Roadmap).

Two things vary as you climb, and it's worth seeing them as separate axes that
happen to move together:

- **Representation** — opaque blob vs. structured columns — is chosen **per
  collection**, automatically, by whether that collection ships a readable schema
  (`columnsOf` → `null` ⇒ blob). On the embedded adapter the two are mixable in one
  room.
- **Storage target** — where the authority lives (DO SQLite / D1 / Postgres) — is
  chosen **per server**, by the `createAdapter()` override (§4). One adapter serves
  every collection in a room; mixing targets means separate room classes.

The ratchet is the rule that these can't move independently the wrong way: **blob is
rung 0, embedded-only.** The moment you move to a shared, remote target every
collection must be structured — a schemaless collection on a D1 (or Postgres) room
is a configuration error at `init()`, not a supported mode. The reason is the whole
thesis: rung 0's blob table is one *we* `CREATE` and own; in the DO's private,
throwaway SQLite that's invisible, but in your real D1/Postgres it would mean the
library DDL-ing an opaque table into the database whose entire value is that other
consumers read your *structured* rows. That off-diagonal cell is the one the ratchet
forbids.

**What does NOT change as you climb: everything else in this document.** The wire
format (§2), `seq` and the `_oplog` (§6), optimistic→ack→settlement (§7), reconnect
deltas (§8), auth (§10) — all rung-invariant. A client cannot tell which rung its
room is on: the batches, the `seq`s, the reconnect protocol are identical. So
climbing the ratchet is a **server-only migration** — swap the adapter, or give a
collection a schema and a real table — with no client change. (Corollary, genuinely
useful as an on-ramp though not a destination: a collection can start uncontrolled
and become structured later, invisibly to every client.)

**Where v1 starts: rung 1.** Our first real target is a Durable Object that is both
the authority and the SQLite persistence behind an otherwise-transparent
partyserver, owning the WebSocket (down) and `POST /write` (up) for its room. Why a
DO: it is single-threaded and has transactional SQLite, which hands us total
ordering and durability for free. Other shapes (a trusting relay, PostgREST/SSE,
Supabase Realtime) are designs only, in `unspecified.md`. Keeping the library
tightly focused on extending PartyKit, our deployment target is theirs. Rung 2 (D1)
is landed; rung 3 (Postgres) is the v2 story.

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
the server applies into SQLite via the `PersistenceAdapter` seam (`SqliteAdapter`,
inside one transaction over the whole POST); a future D1/Postgres target is another
adapter behind the same interface.

Why not one shared `applyBatch` on both sides: the server also mints `seq` and
wraps the *entire* multi-channel POST in a single transaction (§12) — a coarser
boundary than a per-batch begin/commit. Forcing both through one function would
fight the server's atomicity, not help it. The shared thing is the contract, not
the loop.

## 5. The server persists into structured tables that reflect your schema

Your relational schema is a stakeholder: other parts of your app and ecosystem
rely on its structure, types, performance profile, and the assurances it provides
(§1 rung 2 is where those other consumers start reading it). So
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

**Status:** **landed.** The server persists into your structured tables via the
`PersistenceAdapter` seam (`SqliteAdapter`): CRUD against your real columns,
`RETURNING` for the resolved row, your constraints judge, and a `{name,key,schema}`
interface shared by import. The schema-agnostic blob fallback (§5a) remains for
collections that ship no schema. We do **not** create or migrate your tables — you
bring them. Remaining edges: the server-side Zod error-sooner gate and the
serial-PK overlay-swap smoothing (both in [`unspecified.md`](./unspecified.md)).

### 5a. Uncontrolled mode — rung 0 (the shipped baseline)

Rung 0 of the ratchet (§1), and what shipped first. A collection opts out of
structure by shipping no readable schema: the server stores its rows as opaque
`(k TEXT PRIMARY KEY, data TEXT)` blobs keyed by PK (alongside the
`_oplog(seq INTEGER PRIMARY KEY AUTOINCREMENT, channel, ops)`) and validates
nothing — the client schemas still exist (TanStack DB needs them), the server just
doesn't read them. With client-minted UUID keys the resolved row equals the sent
row, so there's no reconciliation. Embedded-only by design (§1): we don't extend it,
and it's a configuration error on a remote target.

## 6. `seq` is the authority's commit-log position

`seq` comes from the `_oplog` AUTOINCREMENT. Because the DO is single-threaded
and the write is transactional, that rowid is a clean total order — read back in
the same transaction via `RETURNING seq`. It is typed as `Cursor`
(`number | string`) so another authority's position (e.g. a Postgres LSN) fits
later.

Why: we never invent a separate counter, and we only ever rely on `seq`
*equality* (settlement) and *order* (backlog) — never arithmetic.

**The `_oplog` lives beside your data — in the same database, wherever that rung
puts it (§1).** It is one table we own, auto-created, and the *only* footprint we
leave in your database — your own tables are never created, migrated, or altered.
Why co-located rather than tucked away inside the DO: the log indexes the data, so
they must commit atomically and can never be allowed to diverge — a log the
data's own transaction can't reach is a log that can tear (a commit the log
missed) or outlive a wipe the data didn't have (a `seq` that regresses under
live cursors). Keeping log and data in one transactional store makes both
failure modes impossible rather than handled. We also considered asking you to
shape your tables so the log could be *derived* (a write-stamp column on every
table, plus tombstones for deletes) — strictly more intrusion into your schema
for a weaker replay, so the side table wins.

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

Compaction (see `oplogRetention`) bounds how far back a delta can reach. A cursor
older than the retained floor cannot be served as a delta — the rows in the gap are
gone from the oplog — so the server serves a *re-snapshot* instead: `replaySince`
returns `null` and `onConnect` sends `snapshot()`.

Retention defaults to 10,000 rows so a room's oplog can't grow unbounded; set
`oplogRetention = 0` for the old keep-everything behavior. Each `POST /write` is
likewise bounded by `maxWriteBytes` (1 MiB) and `maxWriteOps` (1,000) — both
class-field overridable, both answered with a 413 `WriteReject`. Per-identity
rate limiting is deliberately not here: that belongs in your `authorize` seam (§10).

A delta and a re-snapshot are different kinds of message, and the wire says which:
a delta **appends** to the client's state; a re-snapshot **replaces** it, sending a
`reset: true` causing the client collection to `truncate()` before marking `ready`.

Prior art: TanStack DB's own SQLite persistence family
(`@tanstack/db-sqlite-persistence-core`, behind `browser-db-sqlite-persistence`
et al.) converged on the same design for its client-side cache — an `applied_tx`
log of resolved-value replay JSON keyed by a monotonic `seq`, pruned with a floor
below which `pullSince` answers "full reload required." Same log shape, same
cursor semantics, same fallback. We don't *use* it — it's a client cache journal,
not an authority log (§13): it owns `(key, JSON)` blob tables where our rows must
live in your real columns, and its driver assumes interactive transactions. But
the convergence is good evidence the shape is right, and its extra move — bail to
a re-snapshot when the delta itself is *large*, not just when it's gone — is worth
adopting someday.

## 9. Broadcast inline, after commit, before responding

`ws.send()` enqueues to the outbound buffer without awaiting receipt, so
broadcasting is a cheap synchronous loop over `ctx.getWebSockets()`. We do it
inline after the commit and before sending the HTTP response.

Why: deferring it (e.g. `waitUntil`) would let a concurrent `/write` broadcast a
later `seq` first; inline keeps broadcast order == seq order.

## 10. Auth: one check at the lobby, gating both doors

Auth is a single `authorize(req, ctx)` the room owner supplies, run at partyserver's
*lobby* (`onBeforeConnect` / `onBeforeRequest`, wired by `authHooks`) — in the Worker,
before the request reaches the Durable Object. It gates both doors into a room: the
socket open (`kind: 'connect'`, a read) and the POST (`kind: 'write'`). A rejected
connect is a plain 401 before the WebSocket upgrade; a rejected write is a
`WriteReject` the client rolls back like any other POST failure. Neither wakes the DO.

`authorize` returns a bare boolean, or `{ ok, status?, error? }` to choose the HTTP
status and a reason the client sees. `ctx` carries the resolved `{ kind, party, room }`,
so one check can branch per party or per room. A browser can't set headers on a WS
upgrade, so a connect token rides in `?token=` while the POST uses
`Authorization: Bearer`; `partyTransport({ token })` sends both and re-reads a function
token on every (re)connect.

Because the seam takes the raw `Request` and returns a verdict, *what* the auth is is
entirely yours. Verifying an external provider's JWT — here WorkOS AuthKit — is the
whole integration:

```ts
import { routePartykitRequest } from 'partyserver'
import { authHooks, bearer, type Authorize } from 'party-db/server'
import { jwtVerify, createRemoteJWKSet } from 'jose'

const JWKS = createRemoteJWKSet(new URL(jwksUrl)) // WorkOS's public keys; jose caches them
// jwksUrl comes from env, resolved inside fetch (bindings don't exist at module scope) — see cookbook 03

const authorize: Authorize = async (req, { room }) => {
  const token = bearer(req) ?? new URL(req.url).searchParams.get('token')
  if (!token) return { ok: false, status: 401 }
  try {
    const { payload } = await jwtVerify(token, JWKS) // local signature check, no per-request round-trip
    // the room IS the org id: you're in iff your token says you're in this org
    return payload.org_id === room ? true : { ok: false, status: 403, error: 'not your board' }
  } catch {
    return { ok: false, status: 401 } // bad or expired token
  }
}

export default {
  async fetch(req: Request, env: unknown): Promise<Response> {
    const response = await routePartykitRequest(req, env as never, authHooks(authorize))
    return response ?? new Response('not found', { status: 404 })
  },
}
```

Public-read/private-write is the same seam with a simpler body — `if (kind === 'connect')
return true`, then gate the write. Worked recipes for both are in
[`cookbooks`](./cookbooks/) (recipes 3–4).

Why the lobby, not the DO: it's the idiomatic Cloudflare/PartyKit place for *stateless*
credential auth. Running in the Worker means a reject costs nothing on the storage side
(no DO wake) and both doors share one check. Authorization that needs per-room DO
*state* is a separate, in-object concern; this seam is for verify-a-token / compare-a-
claim. The library validates nothing about your auth — it hands you the `Request` and
believes your verdict.

## 11. Schemas are shared by import

Define the Zod/StandardSchema once and import it on both client and server. There
is no `/schemas` API, no version handshake, and no untyped/dynamic mode.

Why: a typed app already ships the TanStack DB client; withholding a few schemas
to save bytes is false economy. (A schema version-hash for drift detection is a
possible *later* addition — noted in `unspecified.md`.)

## 12. `persist` is the only binding; cross-collection atomicity is TanStack's

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

## 13. The authority is SQLite, not TanStack DB

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

**v0 — uncontrolled sync (shipped, done).** Rung 0 of the ratchet (§1): the client
mints UUIDs, the server stores rows as opaque blobs (§5a) and validates nothing, and
writes fan out to every subscriber over the same controlled transport as every
higher rung. The *data* is uncontrolled — no real database underneath — but it's a
real thing: a zero-config realtime collection store.

**v1 — controlled by your RDBMS (rungs 1–2 of the ratchet, §1: DO-embedded SQLite
*and* D1; both landed).** The server persists into structured tables, lets the
database validate
(constraints/FKs), and returns the full ack → echo of the *resolved* row — still
zero config. (A server-side Zod *error-sooner* gate is designed but not yet
shipped; the database is the only gate today.) Transactions live in your
TanStack DB transactions: we represent them in order, apply them in order, and
commit them to the database. You still reason about write order
— but only once, and it never forces you into RPCs where ordered CRUD would do,
into request waterfalls, or into loosening referential integrity: the write
transaction applies *inside the database*, where it always belonged, not at a
middle layer.

**v1 realtime covers the ops that come through us** — the collection ops the
`/write` handler commits. We capture their effect via **`RETURNING`**: on commit the
database hands back the *resolved* rows (defaults, serials, same-row trigger edits)
and those fan out. This holds on both rung-1 and rung-2 targets (§1); D1, being a
farther-away box, just makes persistence async — the atomic POST moves from
`transactionSync` to D1's `batch()`, and the DO serializes its write → `seq` →
broadcast section so concurrent POSTs don't interleave (10 people editing at once is
fine — the DO orders them). What v1 *can't* see, on either target, is a change that
never came through `/write`: a cronjob, another service, or a trigger's side-effects
on rows our statements didn't return. So avoid side-effecting triggers in v1, or
accept they won't sync live — until v2. **Status:** both v1 targets are landed —
embedded DO-SQLite *and* D1. The D1 shape: the whole POST — CRUD, `_oplog` append,
compaction — commits as one atomic `batch()`, with the resolved-op JSON assembled
by SQLite itself (so nothing needs a second write), `seq` from the oplog's
`RETURNING`, and `?since` deltas identical to embedded. The DO stays the room's
serializer and holds no adapter state of its own. Three documented D1 trade-offs:
it serves **one room per D1 database** (rooms don't see each other's writes — the
fan-out is the room's own `/write` path, and D1 has no change feed; cross-room
sharing is the v2 Postgres/WAL story); it is **structured-only** (a schema-less
collection is a configuration error at `init()` — blob/uncontrolled mode is rung 0,
embedded-only, §1); and, as with any remote database, a POST
that D1 commits just before the DO dies leaves a committed-but-unacked row that a
retry of the same insert will 409 on — every other client still converges via
oplog replay on reconnect.

**v2 — all DB ops, via the WAL.** The real shift: instead of covering only what
comes through `/write`, we tail Postgres's logical replication and fan out *every*
committed change, whatever its origin — another service, a cronjob, and crucially
your own writes' **trigger/cascade side-effects**. That makes triggers
first-class: their effects don't come back with the ACK, but you know they'll arrive
on the stream, so you mock/pend/omit them in the UI and let them flow in —
fire-and-forget that actually works, and many RPCs collapse to "an insert plus some
triggers." (A shared database written by several services wants this too; a shared
D1 has no WAL to tail, so it's a Postgres story.) The rest of the bite: RPC support,
RLS conventions, the per-user (and other partitioned) collection types, the
serializable read-slicing sketched in
[`unspecified.md`](./unspecified.md) / [`collection-types.md`](./collection-types.md),
a non-realtime `queryCollection` fallback for tables we can't tail, and — once two
or three databases coexist — a `db` that composes tables from different places, or
conventions for running two side by side (one realtime + global, one not), each
collection picking its transport. The plan for all of this is
[`postgres-todo.md`](./postgres-todo.md).

**v3 (horizon, not planned) — generate everything.** Point at your database, mark
tables public / per-user / per-team, and codegen a fully-typed `db` of typed
collections with typed insert/update, typed live queries, and RPCs. Change the
Postgres structure, re-run codegen, hover over `db`, and the new tables / columns /
functions are just there — maybe including cross-schema-version client/server
sync. The *only* place the "generate schemas/DDL" question lives; not in scope
before then.

**Along the way (v1.x / v2.x) — composing custom logic into these steps.** Where a
step genuinely needs more than CRUD-plus-triggers: a tRPC or Supabase adapter,
first-class prepared statements, server functions. Escape hatches that compose with
the pipeline rather than reintroducing a fat middle tier.
