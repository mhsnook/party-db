# Collection types

Two parts: (1) a survey of the collection adapters TanStack DB **already ships**,
scored on the two axes party-db cares about; (2) party-db's own collection
**capabilities** — what the current DO-controlled collection is, and the
read-side shapes we can offer on top of it.

Settled mechanics live in [`architecture.md`](./architecture.md); open mechanics
and not-yet-built persistence targets live in [`unspecified.md`](./unspecified.md).
This file is the map between the two and the prior art.

---

## Part 1 — What TanStack DB already has

The two axes party-db is built around:

1. **Real-time push sync** into the collection?
2. **Hostable entirely inside a Cloudflare Durable Object?**

| Adapter | Real-time push? | Whole backend in one DO? |
| --- | --- | --- |
| `electric-db-collection` (ElectricSQL) | ✅ streams Postgres change-shapes over HTTP | ❌ needs Postgres **+** the Electric sync service |
| `powersync-db-collection` (PowerSync) | ✅ | ❌ needs the PowerSync service + Postgres/MySQL/Mongo |
| `trailbase-db-collection` (TrailBase) | ✅ record subscriptions | ❌ standalone Rust binary; not a Worker/DO |
| `rxdb-db-collection` (RxDB) | ✅ replication protocols | ⚠️ replication target *could* be a DO you write — not provided |
| `supabase/tanstack-db` (Supabase)† | ✅ Supabase Realtime (Postgres Changes — WAL-based) | ❌ needs Supabase: Postgres + PostgREST + Realtime |
| `query-db-collection` (TanStack Query) | ❌ fetch/refetch/poll | ✅ backend-agnostic; endpoint can be a DO (but not realtime on its own) |
| `localStorageCollection` | ➖ cross-tab only | n/a (client-only) |
| `localOnlyCollection` | ➖ in-memory | n/a (client-only) |

**Takeaway:** none of the shipped adapters give *both* realtime sync *and* an
all-in-one-DO backend. The realtime ones each need an external service/DB; the
DO-native piece is persistence-only (next). That gap is exactly what party-db
fills — realtime sync whose whole authority + persistence + fan-out lives in one
Durable Object.

† `supabase/tanstack-db` is published by Supabase, not in the TanStack monorepo —
an official adapter for an external backend, like the others above.

**On `supabase/tanstack-db` specifically.** While we were heads-down on v0,
Supabase published [`supabase/tanstack-db`](https://github.com/supabase/tanstack-db)
— a *complete*, genuinely cool and promising solution for existing Supabase
projects: live queries, optimistic mutations, automatic Realtime sync, fully typed,
all respecting your existing Postgres / RLS / Auth with **no migration**. It reads
via Supabase Realtime (Postgres Changes — i.e. the WAL) and writes straight through
PostgREST, with no middle tier. We're aimed differently: Supabase and Durable
Objects answer different infrastructure questions, and for teams already on the DO
model we're going for something **extremely fast and cheap** — per-room
hibernating-socket broadcast, an ordered `_oplog`, `?since` backfill, rather than
per-row Realtime (which Supabase itself flags as message-heavy). But the headline
is that Supabase is handing developers *basically the same API we are* — TanStack DB
collections as the entire data layer over your real database. That's a good thing,
and a strong signal that the shape is right.

**The Cloudflare package is persistence, not a collection.**
`cloudflare-durable-objects-db-sqlite-persistence` is *thin SQLite persistence for
DOs* — it persists a collection's **materialized state** (one table per
collection, upsert-by-`getKey`) to `ctx.storage`. It does no transport, fan-out,
sequencing, or write-up endpoint. We do **not** use it on the server: see
[`architecture.md`](./architecture.md) §12 — a TanStack collection is a *client
cache*, never the constraint/`RETURNING` authority, so even its DO-SQLite adapter
can't be our server sink. (It remains a fine fit only for the trivial
collection==table, no-constraint, blob-upsert case — which is the current shape
of our own server persistence, but reached directly via `ctx.storage.sql` rather
than through a collection.)

**Lineage (so we cite it correctly).** TanStack DB is built on its own
differential-dataflow engine (`@tanstack/db-ivm` / `d2ts`), developed *in
collaboration with ElectricSQL*. It is **not** based on RxDB, and neither is
Electric — RxDB is an independent offline-first reactive database, and
`rxdb-db-collection` is just an adapter. Our shared `write()` / `ChangeMessage`
vocabulary comes from TanStack DB itself. (Worth reading anyway: RxDB's
**replication protocol** — checkpoint iteration, push/pull handlers — is good
prior art for our snapshot + delta-reconnect design.)

---

## Part 2 — party-db's collection capabilities

On the client these are all the *same* collection — each just receives sequenced
`WriteEvent`s over the socket and applies them. The differences are server-side:
where writes are persisted, where the echo comes from, and which rows a given
socket is allowed to receive. So "collection type" here mostly means a
**per-collection server config**, not a different client class.

### Shipped: the DO-controlled party collection

The one mode that exists today (see `architecture.md` in full): the DO is the
authority and the SQLite persistence; down = hibernatable WebSocket, up =
`POST /write`; `seq` from the `_oplog` AUTOINCREMENT; optimistic → ack →
settlement; delta reconnect via `?since=<seq>`.

### Read-side shapes we can layer on it

All realtime, all within one room/DO:

- **Public-global** — anything on a global DO/socket; fully public within that
  scope.
- **Team-wide** — the team DO's data-access scope *is* the privacy boundary;
  everything inside it is public to the team. (This is the PartyServer "room"
  model and the default today.)
- **User-private (rides along)** — a collection declares a user-id column (a
  getter, analogous to `key`) and the server is handed an auth interface in the
  same place. One `user_id = :authed` predicate is applied at three choke points —
  snapshot load, `?since` backlog, and socket fan-out. Each socket's identity is
  known (attached at connect, persisted across hibernation via
  `serializeAttachment`), so fan-out sends a user-private row only to matching
  sockets. ~free, because it reuses the existing pipeline + one filter.

- **Read-level slicing ("I care about these languages / this date range").** A
  promising near-term enhancement, *not the team model but adjacent to it*:
  TanStack DB's `where` clauses compile to a **plain-data, serializable AST**
  (`Func{name,args}` / `PropRef{path}` / `Value{value}` — no closures), and the
  library ships `parseWhereExpression(expr, handlers)` to walk it. So a client can
  send its slice predicate up (in the `subscribe`/reconnect headers), and the
  server can turn it into both a SQL `WHERE` for the backlog/snapshot and an
  in-memory predicate for per-socket fan-out. This gets us Electric-style read
  slicing for the **single-partition, row-local** subset (equality / ranges over a
  column) without much new machinery. The open mechanics and the boundaries
  (column allow-listing, immutable vs mutable slice column, no joins/aggregates)
  are in [`unspecified.md`](./unspecified.md) → *Subscription / filtering*.

### Where realtime has to be given up

Slices that need joins/aggregates, or RLS predicates the broadcast scope can't
express, **abandon realtime** and degrade to a non-realtime query collection: we
still generate the `insert/update/delete` write path, but reads come from
`queryCollection` (TanStack Query), where `refetchOnWindowFocus` and staleness
genuinely matter. Same write API, weaker read guarantee.

### Future persistence targets

These change *where* the authority + echo live, not the client. Mechanics and
trade-offs in [`unspecified.md`](./unspecified.md) → *Documented but NOT built*:

- **Postgres-backed (controlled).** Writes execute as real SQL; the stream comes
  from **logical replication** (decode the WAL → `WriteEvent`s, `seq` = LSN). This
  is where "complete the commit the way a web app does" (architecture §5 note)
  becomes literal — real constraints, triggers, cascades — and where the WAL is
  the authoritative, complete echo.
- **Supabase Realtime ride-along.** Use Supabase's existing replication stream as
  the down-transport; settle by primary key (no LSN in its payload). Effectively a
  different project; filed, not focus. Supabase's own
  [`supabase/tanstack-db`](https://github.com/supabase/tanstack-db) is the reference
  implementation of this lane — see Part 1.
