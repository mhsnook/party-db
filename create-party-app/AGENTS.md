# Working in this app

The app is one Cloudflare Worker: Hono server functions over D1, better-auth, R2, the Images
binding, and a Durable Object that pushes committed rows to open tabs. The client reads and
writes through TanStack DB collections in `src/app.ts`.

## Add a table, end to end

1. **Migration.** Add `migrations/000N_<name>.sql`. Give every user-owned table a
   `user_id text not null references "user" (id) on delete cascade` column and an index on it.
   Run `pnpm db:migrate`.
2. **Schema.** Add a Zod schema to `shared/schema.ts`, plus insert and patch variants.
3. **Server functions.** Add a Hono sub-app in `worker/api.ts` and mount it with `.route()` on
   the exported `app` chain, or the client loses its types. In every handler:
   - scope every statement with `user_id = ?`, bound to `c.var.user.id`;
   - end every write with `returning <column list>`, never `returning *`;
   - after a write, `await publish(c.env.Realtime, c.var.user.id, { channel, upsert | delete })`
     with the returned row. The channel is the collection name.
4. **Collection.** Add a `createCollection(serverCollectionOptions({ name: <channel>, … }))` in
   `src/app.ts`, and add it to `collections` in `createApp`. Each handler must return the row the
   server sent back.
5. **UI.** Read with `useLiveQuery`; write with `app.db.<name>.insert / update / delete`.

## Rules

- Bind every value with `?`. Never build SQL from request input.
- Do not edit `migrations/0001_auth.sql`. For a better-auth plugin that needs tables, generate a
  new migration with `npx @better-auth/cli generate`.
- After changing `wrangler.jsonc`, run `pnpm cf-typegen`.

## Check your work

| Command | Checks |
| --- | --- |
| `pnpm typecheck` | the browser and Worker projects |
| `pnpm build` | the Vite build of both |
| `pnpm e2e` | with `pnpm dev` running: two tabs, every write, upload, reconnect, sign-out |

## Look at local data

While `pnpm dev` runs, the Local Explorer API at `http://localhost:5173/cdn-cgi/local/explorer/api`
lists D1 databases, R2 buckets and Durable Objects, and it runs SQL against local D1. For a
one-off query, run `npx wrangler d1 execute DB --local --command "select …"`.
