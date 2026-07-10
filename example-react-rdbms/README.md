# party-db react example — rdbms (D1) + auth

The same synced todo list as the [React example](../example-react), with the two
things v1 adds wired in:

1. **A structured table in [D1](https://developers.cloudflare.com/d1/).** The server
   owns a `todos` table with typed columns and CRUDs into it (structured writes),
   instead of the schemaless `(key, data)` blob the other examples use. The table
   *and* party-db's `_oplog` both live in your D1 database, so other services, jobs,
   or dashboards can read the same rows directly — the Durable Object stays the room
   server but holds no data of its own. **D1 vs. the DO's own embedded SQLite is a
   config switch, not a code change** — flip it in `wrangler.jsonc` (see
   [Switching persistence](#switching-persistence)).
2. **Auth.** Reads are open to everyone (in this example), but **writing needs a password**
   (`s3cret`). Try to add, toggle, or delete a todo and you'll get an unlock
   prompt; enter the password and the write goes through.

It's the same app you already know — the point is to show *where* you wire these
in, and how little changes. In particular **nothing on the client changes**: the
wire protocol is identical whether the server persists to D1 or embedded SQLite.

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

No D1 setup is needed for local dev: `wrangler dev` simulates the bound D1 database
locally (persisted under `.wrangler/`), and the room creates its `todos` table on
first start. Provisioning a real D1 is only for deploy — see below.

### Server — `src/server.ts`

```ts
export class Main extends PartyDbServer {
  // share the schema so writes CRUD into REAL columns, not a blob
  collections = [definePartyCollection<Todo>({ name: 'todos', key: 'id', schema: todoSchema })]

  // the storage target is a runtime switch: a D1 binding → D1, else embedded SQLite.
  createAdapter(): PersistenceAdapter {
    return this.env.DB
      ? new D1Adapter(this.env.DB, this.collections, { oplogRetention: this.oplogRetention })
      : super.createAdapter() // the DO's own embedded SQLite (the default)
  }

  // apply the migration against whichever engine is active (D1 DDL is async).
  async onStart() {
    const db = this.env.DB
    await migrate(db ? (sql) => db.prepare(sql).run() : (sql) => this.ctx.storage.sql.exec(sql))
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

`createAdapter()` reads `env.DB`: with the `DB` binding configured it returns a
`D1Adapter` (data and the `_oplog` go to D1); with no binding it defers to
`super.createAdapter()`, the DO's embedded SQLite. The DO is still the room's
serializer and socket either way — it just holds no persistent state of its own in
D1 mode. **Scope note:** the fan-out source is the room's own `/write` path, so D1
mode is **one room per D1 database** (D1 has no change feed; cross-room sharing is
the v2 Postgres story).

### Switching persistence

The choice is `env.DB`'s presence, so you flip it in `wrangler.jsonc` — no code
change:

- **D1** (the default here): keep the `d1_databases` binding. `wrangler dev`
  simulates it locally; deploy needs a real database (below).
- **Embedded DO SQLite**: comment the `d1_databases` block out. `env.DB` is then
  `undefined`, `createAdapter()` falls to `super`, and the migration runs against
  `ctx.storage.sql`. Nothing else — client, schema, auth, the wire — changes.

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
| `src/migrations/` | the `todos` DDL you bring; party-db never creates your tables |
| `src/server.ts` | the `PartyDbServer` room: a **D1 table** (`createAdapter`) + `authHooks(authorize)` |
| `src/env.d.ts` | types the `DB` (D1) binding for `this.env.DB` |
| `wrangler.jsonc` | the DO binding + the `DB` D1 database binding |

## Deploy the Example Site

This example's `wrangler.jsonc` points `assets` at the Vite build, so one Worker
serves both the react app from `dist/`, and everything else (`/parties/*`,
including the WebSocket) falls through to the worker/the Durable Object (no CORS).

First provision the D1 database (local dev needs none — `wrangler dev` simulates
it):

```bash
cd example-react-rdbms
wrangler d1 create party-db-example-rdbms   # prints a database_id
# paste that id into wrangler.jsonc → d1_databases[0].database_id
```

The room creates the `todos` table itself on first start (`onStart` → `migrate`
runs the idempotent `CREATE TABLE IF NOT EXISTS`), so no separate migration step is
required. Then:

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