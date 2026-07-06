# party-db react example — rdbms + auth

The same synced todo list as the [React example](../example-react), with the two
things v1 adds wired in:

1. **SQLite table on the server.** The server owns a `todos` table with typed columns
   and CRUDs into it (structured writes), instead of the schemaless `(key, data)`
   blob the other examples use.
2. **Auth.** Reads are open to everyone (in this example), but **writing needs a password**
   (`s3cret`). Try to add, toggle, or delete a todo and you'll get an unlock
   prompt; enter the password and the write goes through.

It's the same app you already know — the point is to show *where* you wire these
in, and how little changes.

## How to run

From the root of this repo:

```bash
pnpm install
cd example-react-rdbms
pnpm install
pnpm dev        # wrangler dev (:8787) + vite (:5173), proxied to one origin
```

Open <http://localhost:5173>. The list loads with no password (reads are open).
Type a todo and hit **add** — you'll be asked to enter `s3cret` to continue. Once
unlocked, writes persist and sync to every other tab.

### Server — `src/server.ts`

```ts
export class Main extends PartyDbServer {
  // share the schema so writes CRUD into REAL columns, not a blob
  collections = [definePartyCollection<Todo>({ name: 'todos', key: 'id', schema: todoSchema })]

  // bring your own DB
  onStart() {
    migrate(this.ctx.storage.sql)
    return super.onStart()
  }
}

// one check, gating at the lobby. `kind` makes reads open, writes gated.
const authorize = (req: Request, { kind }: AuthContext) => {
  if (kind === 'connect') return true
  return bearer(req) === 's3cret' ? true : { ok: false, status: 401, error: 'enter "s3cret" to write' }
}

export default {
  fetch: (req, env) =>
    // authHooks(authorize) is the third arg (the other example passes nothing)
    routePartykitRequest(req, env, authHooks(authorize))
      .then((r) => r ?? new Response('not found', { status: 404 })),
}
```

The auth runs in the worker before the request reaches the Durable Object, so
a rejected connect is refused before the WebSocket upgrade and a rejected write
never wakes the DO. `authorize` also receives `{ party, room }` if you want to
gate per-room.

### Client — `src/App.tsx` + `src/auth.tsx`

A tiny `auth.tsx` context tracks logged-in state and holds the token; the app
hands that token to the transport and otherwise mutates `todos` like normal:

```ts
// the transport just sends whatever token the auth context holds
const transport = partyTransport({ host: location.host, room: 'rdbms', token: getToken })
```

The login button reads `loggedIn` and toggles between **log in** (stash the
password) and **log out**. Writes go out transparently — `todos.insert()` /
`.update()` / `.delete()` directly — and a write the server rejects surfaces as
an error, rather than a silent rollback. The transport throws a **`WriteError`**
carrying the HTTP status and the server's reason, so the app can manage failures
by kind:

```tsx
function run(tx) {
  tx.isPersisted.promise.catch((e) => {
    if (e instanceof WriteError && e.status === 401) setError('Log in to edit.')
    else setError(e instanceof Error ? e.message : 'Write failed.') // 409 constraint, etc.
  })
}
```

So the flow is the ordinary one: the UI owns the login state, mutations are
transparent, and a rejected write arrives as a structured error the app handles.

## Files

| File | Role |
| --- | --- |
| `src/main.tsx` | React entry point (identical to the other example) |
| `src/App.tsx` | an ordinary todo app: login bar, list, and direct `todos` mutations |
| `src/auth.tsx` | the tiny auth context: `loggedIn` + the token the transport sends |
| `src/schema.ts` | shared zod schema — now also used **server-side** for structured CRUD |
| `src/server.ts` | the `PartyDbServer` room: a **real table** + `authHooks(authorize)` |

## Deploy the Example Site

This example's `wrangler.jsonc` points `assets` at the Vite build, so one Worker
serves both the react app from `dist/`, and everything else (`/parties/*`,
including the WebSocket) falls through to the worker/the Durable Object (no CORS).

```bash
pnpm install                # root install — the worker bundle resolves
cd example-react-rdbms      # partyserver/@tanstack/db from ../../node_modules
pnpm install
pnpm deploy:cf              # vite build && wrangler deploy
```

Wrangler prints your `*.workers.dev` URL when it's done (first run will walk you
through `wrangler login`).

To deploy on every push instead, connect the repo in the Cloudflare dashboard as
a **Worker** (Workers & Pages → Create → Workers → import repository — not a
Pages project) with:

- **Root directory**: `example-react-rdbms`
- **Build command**: `pnpm install --dir ../.. && pnpm install && pnpm build`
- **Deploy command**: `pnpm exec wrangler deploy`