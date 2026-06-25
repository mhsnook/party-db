# party-db

> Status: This is a version 0.0.0, just kind of incubating the idea.
> The design is not really settled — see [`architecture.md`](./docs/architecture.md)
> and [`unspecified.md`](./docs/unspecified.md).

**party-db connects your TanStack DB collections to the relational database you
already run** — over PartyKit, with near-zero config. You write `todos.insert()`
on one client; every other client's collection receives the row and re-renders.
party-db is everything in between: the `POST`, the durable commit into your real
tables, the acknowledgement, the ordering, and the fan-out — conforming to your
database's structure, types, and auth as it goes.

**TanStack DB becomes your entire API.** Instead of writing API handlers on the
server and `onInsert/onUpdate/onDelete` on the client, you glue them together with
this. Your database still enforces its constraints; your `todos.insert()` still
POSTs to the server and is acknowledged before it fans out to the live sync. You
just don't write anything in between: make your database enforce the constraints
you need, make your Zod schemas match, and that's the connective tissue.

**Server setup is as easy as defining TanStack DB collections.** The same Zod
schemas that already power TanStack DB now drive your production database too,
replicating writes up and back out to every consumer. ("Near-zero config" is
literal — you pass Zod schemas, but you already needed those for TanStack DB.)

The quickest way to get a sense for how to use this library is to check the
[react example app](./example-react/README.md), and its minimal `App.tsx` and
`server.ts`, easy setup, working `useLiveQuery`, and zero-config writes with
`todos.insert` and `todos.update`. There is also a [vanilla JS example
app](./example/README.md), showing that PartyDB works anywhere you can use a
Tanstack DB and a websocket.


The transport is handled mostly by PartyKit's _PartyServer_ (server) and
_PartySocket_ (client), with a bit of extra logic on the server to ensure
ordering, backfill, and acknowledged writes, and on the client to make the DX
buttery smooth: just pass it your PartySocket connection and the schemas/tables
you want to pull off the wire, and it returns a map of all your Tanstack
Collections, pre-wired for onInsert/onUpdate/onDelete, optimistic and confirmed
writes, and a utility function to give you cross-collection transactions whose
bundling survives the entire trip to the server and out to all connected clients
(not possible without our batch/unroll logic).

Clients create their collections all at once using `createPartyDb()`, passing in
the Zod schemas for their collections and the connection info for the PartyServer
that's serving them.

When the server makes edits, it fans them out to clients running PartySocket in
the exact format of Tanstack DB's `write()` interface (the final step in making
any change inside a collection). That lets us keep a simple SQLite interpreter of
the write format on the server and apply the very same payload on every client.

So the whole loop is: you `insert()` on the client, it POSTs to the room's
`/write` channel using the same data format as Tanstack DB's `write()` function;
the DO records it with its own persistence layer (SQLite by default), then
party-fans-it-out over a hibernatable WebSocket; and every listening client
applies that same exact `write` to its own copy of the collection.

Scope is deliberately **one mode**: **DO-controlled**. The DO is the authority
(its SQLite is the persistence layer) and an otherwise-transparent partyserver.
Other modes (trusting relay, PostgREST/SSE, Supabase Realtime ride-along) are
*documented but not built* — see [`unspecified.md`](./docs/unspecified.md).

## The deal

- **Wire format = TanStack DB's `write()` arg** (`{ type, value }`), multiplexed
  by `channel` (= table name), so one socket carries every collection.
- **Persisted into your real tables.** The server commits into structured tables
  that reflect your schema — honoring your constraints, types, and other consumers
  — and hands back the *resolved* row the database actually wrote. (Today's code
  ships an uncontrolled blob fallback; structured tables are the active work — see
  [`sqlite-do-todo.md`](./docs/sqlite-do-todo.md).)
- **Client mints UUIDs** for stable optimistic keys.
- **`seq`** comes from the DO's `_oplog` AUTOINCREMENT (a clean total order,
  because a DO is single-threaded). The write's HTTP response is the **ack**
  (carries `seq`); the same batch arriving on the socket is **settlement**.
- **Optimistic, flicker-free.** `insert()` applies optimistically; the handler
  awaits its `seq` on the stream before resolving, so the overlay drops straight
  onto the synced row.

## Client

```ts
import { createPartyDb, partyTransport, definePartyCollection } from 'party-db/client'
import { z } from 'zod'

const todoSchema = z.object({ id: z.string(), text: z.string(), done: z.boolean() })

const transport = partyTransport({ host: 'my-app.partykit.dev', room: 'team-42' })
const { db, isConnecting } = createPartyDb(transport, [
  definePartyCollection({ name: 'todos', key: 'id', schema: todoSchema }),
  definePartyCollection({ name: 'lists', key: 'id' }),
])

// db.todos is a normal TanStack DB collection.
db.todos.insert({ id: crypto.randomUUID(), text: 'ship it', done: false })
// -> optimistic locally -> POST /write -> ack(seq) -> arrives on socket -> settled.
// every other client in 'team-42' sees it land too.
```

That's the surface: a transport + some collection configs.

## Server (Cloudflare Worker)

```ts
import { PartyDbServer } from 'party-db/server'
import { routePartykitRequest } from 'partyserver'

// one room class serves BOTH the WebSocket and POST /write.
export class Main extends PartyDbServer {
  collections = [
    { name: 'todos', key: 'id' },
    { name: 'lists', key: 'id' },
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
writes use TanStack's own `createTransaction`. But if you want to do multi-table
transactions whose Transaction Envelope survives the entire round trip to the
server and out to subscribers, you can use this `persist` function as your
mutationFn. It sends your array of writes through the same steps: `/write` + seq
+ acknowledge + settle, the same as with any `collection.update`, allowing the
transaction envelope to keep its shape from client -> server -> subscribers.

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
