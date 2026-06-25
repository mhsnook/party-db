# party-db example site

A todo list synced across browser tabs through one Durable Object room.

## How to run this example app

From the root of this repo:

```bash
pnpm install
cd example
pnpm install
pnpm dev        # wrangler dev (:8787) + vite (:5173), proxied to one origin
```

Open <http://localhost:5173> in two tabs and watch things sync!
Stop a tab, add items in the other, reopen: the returning
tab receives only what it missed (`?since=<seq>` delta reconnect).

You can also run the example react app in another tab and the two
will sync via the same stream. 🤓

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
