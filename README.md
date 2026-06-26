# PartyDB — Tanstack DB meets PartyKit

> v0.0.0, incubating. Design: [`architecture.md`](./docs/architecture.md) · v1 plan
> & roadmap: [`sqlite-do-todo.md`](./docs/sqlite-do-todo.md) · open questions:
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

**As of today** we support a single mode: Durable Object-controlled with SQLite
persistence. This is v0 complete, working on v1.

- **✅ v0 (no-server-schema mode):** Just gets changes from one DB client to the other clients
- **⚡️ v1 (RDBMS, controlled mode):** Supports SQLite on the server, manages global ordering,
  full catchups, server-client transaction parity. Real-time is limited to the changes that come
  through the PartyServer (via PartyDB collection operations, or the `/write` handler).
- **🗓️ v2 (Postgres + global WAL):** Will support Postgres as a server persistence target,
  where we will take advantage of the global WAL, allowing PartyDB to be adopted incrementally
  alongside your other systems and APIs, and unlocking some different ergonomics esp w/r/t
  database triggers and async operations that aren't available with the initial `200 ok`.
- **☁️ v3 (Full codegen):** ... TBD, but if the expectations from v2 work out, it seems possible
  to generate everything just by pointing it at a Postgres DB and letting it codegen the rest.

**See it:** the [React example](./example-react/README.md) (`App.tsx` + `server.ts`,
`useLiveQuery`, zero-config writes) or the [vanilla JS example](./example/README.md).
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

## Files

| File | Role |
| --- | --- |
| `src/protocol.ts` | wire contract: `WriteEvent` / `WriteBatch` / `SequencedBatch` / `WriteAck` |
| `src/client/apply.ts` | `applyBatch(sink, batch)` — the client's batch-apply helper (drives TanStack's `sync`) |
| `src/client/sync-client.ts` | one stream + channel registry + `waitForSeq` settlement |
| `src/client/collection.ts` | `definePartyCollection` + collection wiring |
| `src/client/party-db.ts` | `createPartyDb` / `partyTransport` — the headline API |
| `src/server/party-db-server.ts` | `PartyDbServer` — WS + `/write` + DO SQLite |

Settled decisions and their rationale live in [`architecture.md`](./docs/architecture.md);
open questions and not-yet-built modes in [`unspecified.md`](./docs/unspecified.md).
