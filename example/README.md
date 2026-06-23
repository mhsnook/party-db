# party-db example

A todo list synced across browser tabs through one Durable Object room.

```bash
pnpm install
pnpm dev        # wrangler dev (:8787) + vite (:5173), proxied to one origin
```

Open <http://localhost:5173> in two tabs. Add/check/delete a todo in one — it
appears in the other. Stop a tab, add items in the other, reopen: the returning
tab receives only what it missed (`?since=<seq>` delta reconnect).

## Shape

- `src/server.ts` — the Worker. `Main extends PartyDbServer` declaring one
  collection; `routePartykitRequest` sends both the WebSocket and `POST /write`
  to the room DO, which persists to its own SQLite.
- `src/client.ts` — `createPartyDb(partyTransport(...), [todos])`, then plain
  DOM. `todos.insert/update/delete` is all the app calls.
- `src/schema.ts` — the Zod schema, shared by both sides.
- `vite.config.ts` — proxies `/parties/*` (HTTP + WS) to the worker so the
  browser sees a single origin (no CORS).

> Note: this example is illustrative and was not executed in the authoring
> environment. The reactive read in `render()` uses `todos.toArray` +
> `subscribeChanges`; if your installed `@tanstack/db` version exposes a
> different read API, adjust that one line.
