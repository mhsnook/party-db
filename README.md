# PartyDB — Tanstack DB meets PartyKit

> incubating. Cookbooks: [`docs/cookbooks`](./docs/cookbooks/) · Design:
> [`architecture.md`](./docs/architecture.md) · active plans:
> [`plans/`](./plans/) · open questions:
> [`unspecified.md`](./docs/unspecified.md).

**PartyDB connects your TanStack DB collections to your Database with
optimistic updates and realtime sync — and near-zero config — over a
Cloudflare Durable Object via PartyKit.** Your tables, constraints, and auth
work unchanged; no migration, no second copy of the truth.

If you're already familiar with Tanstack DB, you don't need to learn
anything else; PartyDB handles everything after your `todos.insert()`
and up until your `useLiveQuery(todos)` receives the updated data.

**Our Goals / Offerings for the Developer**

- **Near-zero config** — You bring your database, set up one little PartyServer
  and pass it your schemas — this is all the config you need.
- **Tanstack Performance** — Tanstack DB's live queries already provide best-
  in-class performance and fine-grained reactivity; data flows seamlessly from
  the server to your components.
- **Optimistic writes** — Collection updates like `todos.insert` (and `update`
  / `delete`) land instantly on your client, then settle on the server's
  confirmation, (or roll back if it's rejected); you don't have to configure
  the Tanstack Collection's `onUpdate` functions, they just work.
- **Typed end to end** — Collections take their types from your Zod schema, so
  reads and writes are fully type-safe.
- **Composable and bail-out-able** — You don't have to limit your app to just
  single CRUD operations; you can compose them with the Collection's
  transactions pattern, and those transactions are applied faithfully as an
  atomic commit on the database before confirmation; you can call RPCs on the
  server too, and as long as you yield back the changed rows, it *just works*.
- **Seamless snapshot + backfill** — When a client connects, it loads a snapshot
  of the published tables, notices the age of this snapshot (maybe each table
  has different cache settings), and then loads up all the change operations
  since that time and replays them, for optimal load-and-catchup performance,
  and, as always, zero config.


**Write → Confirm → Settle:** You (the developer, building a cool
app with modern/realtime UX) will write `coll.insert()` in one place, and read
`const { data } = useLiveQuery(...)` in another place — another component or
another machine entirely!

**As of today** we support the first two modes plus the Postgres write path:
transparent, RDBMS, and Postgres CRUD.

 - Milestone 0: **Transparent mode:** clients hold collection schemas but the server passes write
   messages through transparently; no auth
 - Milestone 1: **RDBMS mode:** server and client share collection schemas and the server keeps
   the authoritative and historical copy of the database in SQLite — embedded in the
   Durable Object **or** in D1. Includes
	auth, global seq, transactions, snapshot+backfill.
 - Milestone 2a: **Postgres write path (shipped):** the same RDBMS mode, now against a
   real Postgres — CRUD + `RETURNING`, the `_oplog` beside your data, `?since` deltas,
   SQLSTATE constraint errors, identical wire contract. What's *not* yet live: writes
   that bypass `/write` (cron, other services, trigger side-effects) — those need the WAL.
 - Milestone 2a′: **Postgres-native RLS on writes (shipped):** an `auth` hook injects the
   caller's verified JWT claims into the write transaction (`SET LOCAL`), so your *own*
   Row-Level Security policies enforce per-user/per-tenant writes — a forged write comes
   back `403`. See [cookbook 08](./docs/cookbooks/08-postgres-rls.md).

**Future**

- Milestone 2b: **Postgres, all DB ops:** everything above, plus the global WAL as the
  stream (out-of-band writes fan out live), RPCs, RLS-enabled *reads* (identity-aware
  snapshot / backlog / fan-out), table-sharing config, user-protected tables.
- Milestone 3: **Not just a party anymore:** query slicing, RLS-in-JS -- most apps
  don't work as parties, you need to filter content by more than just public-or-userID.
- Far Future: **Codegen mode:** build the entire system from a DB string or schemas, live
  codegen, send schema changes over the wire, etc.


**Examples:**

- [React + RDBMS](./example-react-rdbms/README.md) (structured SQLite/D1 + auth, from Milestone 1)
- [React · Polyglot](./example-react-polyglot/README.md) (🚧 public catalog + per-user
collections — the API-first scaffold for [cookbook 05](./docs/cookbooks/05-public-and-private-collections.md))
- [React](./example-react/README.md) (`App.tsx` + `server.ts`,
`useLiveQuery`, zero-config writes, Milestone 0)
 - [vanilla JS](./example/README.md)

(Yes, it really is that simple; we're not messing around about "near-zero config".)

## Client

```ts
import { createPartyDb, partyTransport, definePartyCollection } from 'party-db/client'
import { z } from 'zod'
import { todoSchema, listSchema } from './my-schemas'

// ✅ This is the entire PartyDB setup right here
const transport = partyTransport({ host: 'my-app.partykit.dev', room: 'team-42' })
const { db, isConnecting } = createPartyDb(transport, [
  definePartyCollection({ name: 'todos', key: 'id', schema: todoSchema }),
  definePartyCollection({ name: 'lists', key: 'id', schema: listSchema }),
])

// db.todos is a normal TanStack DB collection.
db.todos.insert({ id: crypto.randomUUID(), text: 'ship it', done: false, list_id })
// -> optimistic locally -> POST /write -> ack(seq) -> arrives on socket -> settled.
// every other client in 'team-42' sees it land too.
```

That's the surface: a transport + some collection configs.

## Server (Cloudflare Worker + PartyServer)

```ts
import { PartyDbServer } from 'party-db/server'
import { routePartykitRequest } from 'partyserver'
// ✅ Same schemas you use on the client
import { todoSchema, listSchema } from './my-schemas'

// one room class serves BOTH the WebSocket and POST /write
// broadcasts these tables to everyone in the shared room
export class Main extends PartyDbServer {
  collections = [
    { name: 'todos', key: 'id', schema: todoSchema },
    { name: 'lists', key: 'id', schema: listSchema },
  ]
  // your tables, your DDL — party-db only CRUDs over them:
  onStart() {
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS todos (...)`) // and lists
    return super.onStart()
  }
}

export default {
  fetch(req: Request, env: Env) {
    return routePartykitRequest(req, env) ?? new Response('not found', { status: 404 })
  },
}
```

```jsonc
// wrangler.jsonc — the DO + SQLite binding
{
  "durable_objects": { "bindings": [{ "name": "Main", "class_name": "Main" }] },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["Main"] }],
}
```

Host it, point clients at `host`/`room`, and the DOs spin up on demand — each one
serving its room's socket and `/write`, persisting to its own SQLite.

## Cross-collection atomic writes

`db.todos` are first-class TanStack DB collections, so cross-collection atomic
writes use TanStack's own `createTransaction` with this `persist` function as the
mutationFn. It sends your whole transaction as one `/write` POST that the server
commits **all-or-nothing**, and `isPersisted` resolves only once every assigned
`seq` has settled — so the *write* is atomic from client to server, and then then
subscribers receive the constituent writes **in order** (by `seq`) and apply them
as they arrive.

```ts
import { createTransaction } from '@tanstack/db'

const { db, persist } = createPartyDb(transport, [posts, postTags])

const tx = createTransaction({ mutationFn: persist })
tx.mutate(() => {
  db.posts.insert({ id: pid, title: 'hi' })
  db.post_tags.insert({ id: crypto.randomUUID(), postId: pid, tag: 'intro' })
})
await tx.isPersisted.promise // both land in one POST, or neither does
```

## Rows your server writes itself

Not every row comes from a client. When the code writing it is your own — a job,
an agent, a webhook handler running inside the room's Durable Object — call
`this.commit()` instead of your own `INSERT`, and the row syncs like any other
write: a `seq`, an `_oplog` entry, and fan-out to every socket in the room.

```ts
export class Article extends PartyDbServer {
  collections = [{ name: 'notes', key: 'id', schema: noteSchema }]

  async review(articleId: string) {
    for await (const note of runTheModel(articleId)) {
      // returns the resolved rows + their seq; throws if the database rejects
      await this.commit([{ channel: 'notes', ops: [{ type: 'insert', value: note }] }])
    }
  }
}
```

Every client watching the room sees each note appear as it commits — no new
endpoint, no polling. Writing the same row with raw SQL instead would reach a
freshly-connecting client (through the snapshot) and *never* an already-connected
one, because only the oplog feeds the stream. See
[cookbook 9](./docs/cookbooks/09-server-originated-writes.md).

## A Server that can't subclass holds the core instead

`PartyDbServer` is a thin subclass over `PartyDbCore`. If your Durable Object
already extends another partyserver `Server` — an agents-SDK `AIChatAgent`, say —
you can't subclass `PartyDbServer` too. Hold the core instead: construct it in
`onStart`, call `init()`, and forward `onConnect` / `onRequest` to it.

The party-db client marks every connect and write POST with `?proto=party-db`,
and the server exports `isPartyDbRequest`, so your server can route party-db
traffic beside its own without any configuration:

```ts
import { PartyDbCore, SqliteAdapter, isPartyDbRequest } from 'party-db/server'

export class ArticleAgent extends AIChatAgent<Env> {
  db!: PartyDbCore

  async onStart() {
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS notes (...)`) // your tables, as ever
    const engine = {
      exec: (q, ...b) => this.ctx.storage.sql.exec(q, ...b),
      transaction: (fn) => this.ctx.storage.transactionSync(fn),
    }
    this.db = new PartyDbCore({
      collections,
      adapter: new SqliteAdapter(engine, collections),
      // you own the sockets: fan out only to the connections tagged party-db
      broadcast: (msg) => {
        for (const conn of this.getConnections('party-db')) conn.send(msg)
      },
    })
    await this.db.init()
  }

  // tag party-db connects so the broadcast above finds them after hibernation
  getConnectionTags(conn, ctx) {
    return isPartyDbRequest(ctx.request) ? ['party-db'] : []
  }

  onConnect(conn, ctx) {
    if (isPartyDbRequest(ctx.request)) return this.db.connect((m) => conn.send(m), ctx.request.url)
    // ...your own socket traffic
  }

  onRequest(req) {
    if (isPartyDbRequest(req)) return this.db.handleWrite(req)
    // ...your own routes
  }
}
```

The core sends the same wire frames a `PartyDbServer` room sends, on the
connections you route to it — nothing is namespaced onto a shared socket
([architecture §15](./docs/architecture.md)). `commit()` works the same way
here: `this.db.commit(batches)`. The tested copy of this pattern is `Composed`
in `test/integration/worker.ts`.

## onAuthError callback

If a client connection makes it past the initial worker check (stateless auth check)
into the durable object room, and _then_ gets rejected, the socket closes with a
**1008** (policy violation). This is the one kind of disconnect that the PartySocket
client _should not_ try to reconnect from. Client code may wish to notice this kind
of close event and do something with it, such as showing a login challenge.

Every other close code (1006 network, 1011 server, normal) keeps the default reconnect.

```ts
const { db, onAuthError } = createPartyDb(transport, [todos])
onAuthError((err) => {
  // err instanceof AuthError, err.code === 1008 — the socket is down for good.
  redirectToLogin()
})
```

The write (up) path already surfaces its own verdict: `transport.send` throws a
`WriteError` carrying the `401` on a rejected POST.

## Testing

| Command | Runs |
| --- | --- |
| `pnpm test` | fast node unit suite — no external services |
| `pnpm test:integration` | the real DO/WebSocket path inside workerd (miniflare) |
| `pnpm test:pg` | Postgres driver checks (node + workerd lanes) — needs a Postgres |

The `pnpm test:pg` lane (and the `pg-connect` integration test) talk to a **real
Postgres** over `PG_URL`. Without it they **skip**, so a plain `pnpm test` /
`pnpm test:integration` never fails for want of Docker. To run them locally, start
the same pinned Postgres CI uses and point `PG_URL` at it:

```sh
docker run --rm -d --name party-db-pg \
  -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=party_db_test \
  -p 5432:5432 postgres:17-alpine -c wal_level=logical

export PG_URL=postgres://postgres:postgres@localhost:5432/party_db_test
pnpm test:pg && pnpm test:integration
```

`wal_level=logical` is set from day one — it costs nothing and the v2 WAL story
([`postgres-todo.md`](./docs/postgres-todo.md)) needs it.

## Files

| File | Role |
| --- | --- |
| `src/protocol.ts` | wire contract: `WriteEvent` / `WriteBatch` / `SequencedBatch` / `WriteAck` |
| `src/client/apply.ts` | `applyBatch(sink, batch)` — the client's batch-apply helper (drives TanStack's `sync`) |
| `src/client/sync-client.ts` | one stream + channel registry + `waitForSeq` settlement |
| `src/client/seq-tracker.ts` | pure settlement: per-channel high-water mark, waiters, timeout |
| `src/client/collection.ts` | `definePartyCollection` + collection wiring |
| `src/client/party-db.ts` | `createPartyDb` / `partyTransport` — the headline API |
| `src/client/errors.ts` | `WriteError` / `TransportError` / `AuthError` — classified write & auth failures |
| `src/schema.ts` | the shared `{ name, key, schema }` collection interface (both sides) |
| `src/server/party-db-server.ts` | `PartyDbServer` — WS + `/write` + `commit()`; the thin subclass over the core |
| `src/server/core.ts` | `PartyDbCore` — the room's core functionality, for hosts that compose instead of subclass |
| `src/server/auth.ts` | `authHooks(authorize)` — the lobby auth seam (connect + write) |
| `src/server/persistence.ts` | `PersistenceAdapter` seam (swap embedded SQLite ↔ D1 ↔ Postgres) |
| `src/server/sqlite-adapter.ts` | `SqliteAdapter` — structured CRUD + `RETURNING`; blob fallback |
| `src/server/d1-adapter.ts` | `D1Adapter` — the same, in your D1 (one atomic `batch()`) |
| `src/server/pg-adapter.ts` | `PgAdapter` — the same, in your Postgres (one `BEGIN…COMMIT`) |
| `src/server/statements.ts` | shared SQL builders; `toPg` renders `?` → `$n` for Postgres |
| `src/server/columns.ts` | schema → injection-safe column allowlist + value codec (SQLite + PG) |

Settled decisions and their rationale live in [`architecture.md`](./docs/architecture.md);
open questions and not-yet-built modes in [`unspecified.md`](./docs/unspecified.md).
