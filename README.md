# party-db (MOCK / PROPOSAL)

> Status: **mock package, not wired into scenetest-cloud.** It lives in this repo
> only because this is where the problem-space context is. The intent is to lift
> it into its own monorepo later (a server-side partyserver wrapper + this
> client). Name is a placeholder.

Ship TanStack DB change directives over a single transport and have every
consumer apply them to their own TanStack DB collections. One socket, **many
collections multiplexed** by a `channel` (= table name).

The wire payload is, deliberately, *exactly* what TanStack DB's sync `write()`
accepts — `Omit<ChangeMessage, 'key'>`. So there's almost no translation on
either end, and **client and server run the same interpreter** over the same
bytes. If it applies in one place it applies everywhere.

## The primitives (stable; change sparingly)

| File | Role |
| --- | --- |
| `src/protocol.ts` | the wire contract: `WriteEvent`, `WriteBatch`, `SequencedBatch`, `WriteAck` |
| `src/interpreter.ts` | `applyBatch(sink, batch)` — the shared multiplexing apply |
| `src/client/sync-client.ts` | one down-stream + a registry routing batches per channel |
| `src/client/collection.ts` | `createPartyDb` / `definePartyCollection` — the DX |
| `src/client/transports.ts` | adapters: DO/WS, PostgREST/SSE, trusting WS-only |
| `src/server/relay.ts` | trusting-mode dumb relay |
| `src/server/controlled.ts` | controlled-mode accept-and-ack via a server-side collection |

## Modes

- **Trusting** — permissive pass-through. Server (or no server) just orders and
  fans out; clients trust each other's logic and versions. WS-only, no ack,
  clients mint UUIDs before sending.
- **Controlled** — the server is the authority. It runs the same interpreter
  against its **own** TanStack DB collection backed by real storage; a
  successful commit *is* the accept-and-ack. Clients POST up, stream down.

These are the same primitives with different glue.

## Deploy targets

1. **Durable Object** — down = hibernatable WebSocket (partyserver/partysocket),
   up = `POST /write` to the same room, persistence = DO SQLite.
2. **PostgREST / Supabase Edge** — down = SSE, up = `POST /write` (turns
   `WriteEvent`s into PostgREST POST/PATCH/DELETE, or runs them straight against
   Postgres — which makes Postgres the persistence layer as a side effect).

## Intended DX

```ts
const users = definePartyCollection({ name: 'users', schema: usersSchema, key: 'id' })
const posts = definePartyCollection({ name: 'posts', schema: postsSchema, key: 'id' })

const client = new SyncClient(durableObjectTransport({ socket, writeUrl }))
const { db } = createPartyDb(client, [users, posts])

// db.users / db.posts are normal TanStack DB collections.
// onInsert/onUpdate/onDelete are derived: they emit WriteEvents up the wire.
```

## Open questions

Tracked in [`unspecified.md`](./unspecified.md) — a running design log. Read it
before changing the protocol or the modes.
