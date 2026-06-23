# party-db (MOCK / PROPOSAL)

> Status: **mock package, not wired into scenetest-cloud.** It lives here for the
> problem-space context; destined for its own monorepo later. Name is a placeholder.

Live TanStack DB collections over a single PartyKit/Durable Object room. You
`insert()` on the client, it POSTs to the room's `/write`, the DO records it in
its own SQLite and party-fans-it-out over a hibernatable WebSocket, and every
listening client applies it to the same collection.

Scope is deliberately **one mode**: **DO-controlled**. The DO is the authority
(its SQLite is the persistence layer) and an otherwise-transparent partyserver.
Other modes (trusting relay, PostgREST/SSE, Supabase Realtime ride-along) are
*documented but not built* — see [`unspecified.md`](./unspecified.md).

## The deal

- **Wire format = TanStack DB's `write()` arg** (`{ type, value }`), multiplexed
  by `channel` (= table name), so one socket carries every collection.
- **Client mints UUIDs.** Rows are stored server-side as JSON blobs keyed by PK,
  so the resolved row always equals the sent row — no DDL, no `RETURNING`, no
  reconciliation.
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

## Files

| File | Role |
| --- | --- |
| `src/protocol.ts` | wire contract: `WriteEvent` / `WriteBatch` / `SequencedBatch` / `WriteAck` |
| `src/interpreter.ts` | `applyBatch(sink, batch)` — shared apply (client + server) |
| `src/client/sync-client.ts` | one stream + channel registry + `waitForSeq` settlement |
| `src/client/collection.ts` | `definePartyCollection` + collection wiring |
| `src/client/party-db.ts` | `createPartyDb` / `partyTransport` — the headline API |
| `src/server/party-db-server.ts` | `PartyDbServer` — WS + `/write` + DO SQLite |

Open questions live in [`unspecified.md`](./unspecified.md).
