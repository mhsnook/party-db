# party-db example site

A todo list synced across browser tabs through one Durable Object room.

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

## Shapes to Notice

This example app is extremely simple, intentionally so. But it may look unfamiliar,
so here are some notes to point you around:

- The client has no front-end framework, it is just using vanilla Tanstack DB
collections with `todos.insert` and `todos.subscribeChanges` to re-render the list,
showing the full end-to-end experience that will work anywhere Tanstack DB works.
For the same app rendered with React's `useLiveQuery`, see
[`../example-react`](../example-react).
- Server setup is just like declaring a PartyServer to deploy on a Durable Object,
except it uses a `PartyDbServer`, which is a thin extension of a `PartyServer`.
- `schema.ts` is also there, same as you would need with any client running
Tanstack DB.

## Bonus: cross-framework sync

This app and the [React example](../example-react) point at the same room
(`demo`), and both dev servers proxy `/parties/*` to a worker on `:8787`. So you
can run them against **one** worker and watch them sync across frameworks:

```bash
pnpm dev                          # here: worker (:8787) + vanilla client (:5173)
(cd ../example-react && pnpm dev:client)   # React client only, proxied to the same :8787
```

Open the vanilla tab (`:5173`) and the React tab (`:5174`) and edit either — the
two stay in sync. Both tabs are just views over the *same* synced TanStack DB
collection in the *same* Durable Object; the wire format is TanStack DB's own
`write()` shape, so the server never knows what's rendering. Same data, same
room, different view layer.

