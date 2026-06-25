# party-db react example

The same synced todo list as the [vanilla example](../example), but rendered
with React and [`useLiveQuery`](https://tanstack.com/db/latest/docs/reference/react)
from `@tanstack/react-db`.

## How to run this example app

From the root of this repo:

```bash
pnpm install
cd example-react
pnpm install
pnpm dev        # wrangler dev (:8787) + vite (:5173), proxied to one origin
```

Open <http://localhost:5173> in two tabs and watch things sync!
Stop a tab, add items in the other, reopen: the returning
tab receives only what it missed (`?since=<seq>` delta reconnect).

## Inspect the code

Have a look at `App.tsx`, and `server.ts`. If you're used to using Tanstack DB
collections, you know you already need to set up Zod schemas, so we hid that
away in `schema.ts`, but otherwise, you can see everything right there:

```ts
/// 📁 App.tsx
// ✅ 1. Connect to your PartyServer w/ a thin wrapper on PartySocket
const transport = partyTransport({ host: location.host, room: 'demo' })

// ✅ 2. Pass that connection to the constructor, and you're done!
export const { db } = createPartyDb(transport, [
  definePartyCollection<Todo>({ name: 'todos', key: 'id', schema: todoSchema }),
])
```

This is _the entire client configuration_. With `onInsert, onEdit, onDelete` all
handled for you, and the `db.todos` is a Tanstack DB collection. Now the server,
nearly identical to a PartyServer config:

```ts
/// 📁 server.ts
export class Main extends PartyDbServer {
  collections = [{ name: 'todos', key: 'id' }]
}

export default {
  async fetch(req: Request, env: unknown): Promise<Response> {
    return (
      (await routePartykitRequest(req, env as never)) ??
      new Response('not found', { status: 404 })
    )
  },
}
```

This config will grow a little as we fold in other things like Auth and multi-
step relays, but for the most part it is the same config as a stock PartyServer
config; just tell it which tables to replicate, and it goes.

## The pay-off for React apps: `useLiveQuery`

The vanilla example wires up the list by hand with
`todos.subscribeChanges(render)`. React doesn't need that, and `useLiveQuery`
is the powerful hook/primitive that we all know and love to build on.

```tsx
import { useLiveQuery } from '@tanstack/react-db'
import { db } from './db.ts'

const { data, isLoading } = useLiveQuery((q) =>
  q.from({ todo: db.todos }).orderBy(({ todo }) => todo.text, 'asc'),
)
```

Because the PartyDB transport client handles backlog and buffering, you can
initialize and export/import your DB just like any other API client, and the
collections it creates are available immediately, remaining in an `isLoading`
state while they:

- Connect to the PartyServer and start buffering the incoming logs
- Fetch table snapshots or event backlog and apply them to your client collections
- Run the catch-ups from the log to get back to 'present' and mark themselves ready

## Bonus: cross-framework sync

This app and the [vanilla example](../example) are both configured to point to
the same room (`demo`), and both dev servers proxy `/parties/*` to a
worker on `:8787`. So if you run *both* apps on the same machine, you'll get
two separate apps that share the same realtime sync.

```bash
pnpm dev                      # in example-react: worker (:8787) + React client (:5173)
(cd ../example && pnpm dev)   # client on :5174, will route to the same worker on :8787
```

Open the React tab (`:5173`) and the vanilla tab (`:5174`) and edit either -- the
two stay in sync. There's no bridge happening here, it's just that the connection
PartyDB sets up between your Tanstack DB and your PartyServer makes this cross-
platform sync work anywhere you can make use of a Tanstack DB collection.

(Note: The second worker will run on `:8788` but it will be quietly ignored. You
can change this behavior by un-hard-coding the port in `vite.config.ts`.)


## Files

| File | Role |
| --- | --- |
| `src/main.tsx` | React entry point |
| `src/App.tsx` | Builds the PartyDB transport and DB, renders the app via useLiveQuery() |
| `src/schema.ts` | shared zod schema (same as the vanilla example) |
| `src/server.ts` | the `PartyDbServer` room (identical to the vanilla example) |
