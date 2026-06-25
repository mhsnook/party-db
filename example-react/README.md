# party-db react example

The same synced todo list as the [vanilla example](../example), but rendered
with React and [`useLiveQuery`](https://tanstack.com/db/latest/docs/reference/react)
from `@tanstack/react-db`.

## How to run this example app

```bash
# This example imports party-db straight from the repo's /src folder,
# instead of the built npm package, so we have to install there first.
(cd .. && pnpm install)

pnpm install
pnpm dev        # wrangler dev (:8787) + vite (:5173), proxied to one origin
```

Open <http://localhost:5173> in two tabs. Add/check/delete a todo in one — it
appears in the other. Stop a tab, add items in the other, reopen: the returning
tab receives only what it missed (`?since=<seq>` delta reconnect).

## The one thing to notice: `useLiveQuery`

The vanilla example wires up the list by hand with
`todos.subscribeChanges(render)`. React doesn't need that. `db.todos` is a plain
TanStack DB collection, so you hand it to `useLiveQuery` and the component is
reactive — full stop:

```tsx
import { useLiveQuery } from '@tanstack/react-db'
import { todos } from './db.ts'

const { data, isLoading } = useLiveQuery((q) =>
  q.from({ todo: todos }).orderBy(({ todo }) => todo.text, 'asc'),
)
```

`data` is a live, sorted array. It re-renders on **every** committed change to
the collection, whatever the source:

- your own optimistic `todos.insert(...)`, the instant you call it,
- the server's `seq` ack settling that optimistic row, and
- a write that arrived over the socket from **another tab / client**.

No `useState` mirror, no `useEffect`, no manual subscription teardown. You can
also filter, sort, join, and project right in the query — `useLiveQuery` only
re-renders when *its* result actually changes.

## Bonus: cross-framework sync

This app and the [vanilla example](../example) point at the same room
(`demo`), and both dev servers proxy `/parties/*` to a worker on `:8787`. So you
can run them against **one** worker and watch them sync across frameworks:

```bash
pnpm dev                      # in example-react: worker (:8787) + React client (:5173)
(cd ../example && pnpm dev:client)   # vanilla client only, proxied to the same :8787
```

Open the React tab (`:5173`) and the vanilla tab (`:5174`) and edit either — the
two stay in sync. There's no React-vs-vanilla bridge doing this: both tabs are
just views over the *same* synced TanStack DB collection in the *same* Durable
Object, and the wire format is TanStack DB's own `write()` shape, so the server
never knows (or cares) what's rendering. Same data, same room, different view
layer.

## Files

| File | Role |
| --- | --- |
| `src/db.ts` | builds the party-db client once and exports the live `todos` collection |
| `src/App.tsx` | the UI — one `useLiveQuery` call drives the whole render |
| `src/main.tsx` | React entry point |
| `src/schema.ts` | shared zod schema (same as the vanilla example) |
| `src/server.ts` | the `PartyDbServer` room (identical to the vanilla example) |

The server is byte-for-byte the same idea as the vanilla example: party-db
doesn't care what's rendering the collection, so the only real difference here
is the client.
