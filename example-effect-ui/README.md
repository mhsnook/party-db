# party-db example: Effect UI

The todo list from [`../example`](../example), rendered with
[Effect UI](https://ui.effect.website) and typed with Effect Schema.

## How to run this example app

From the root of this repo:

```bash
pnpm install
cd example-effect-ui
pnpm install
pnpm dev        # wrangler dev (:8787) + vite (:5173), proxied to one origin
```

Open <http://localhost:5173> in two tabs and watch them sync.

`@effect/ui` is not on npm yet. `package.json` pins a
[pkg.pr.new](https://pkg.pr.new/~/Effect-TS/ui) snapshot by commit. To move to a
newer one, change the SHA and run `pnpm install`.

## Shapes to notice

- `src/domain/Todo.ts` holds the one `Schema.Struct`. The collection takes it
  through `Schema.toStandardSchemaV1`. The server reads the same Struct to find
  the table's columns, so the room writes into `todos (id, text, done)` from
  `./src/migrations`. A boolean `done` goes in as 0/1 and comes back as a boolean.
- `src/services/Todos.ts` is the only file that touches party-db. It wraps the
  TanStack DB collection in a `Context.Service`: `list` is a Stream of the
  collection's rows, and each write is an Effect that settles when the server acks
  it, or fails with `WriteFailed`.
- `src/components/TodoList.ts` reads the rows from a `Query.StreamService`, so the
  list lives in `h.queries`, not in the Model. Each write is a `Command.Service`. A
  write that succeeds sends no message, since its change already arrived through the
  stream. A refused write sends `FailedWriteTodo`, and the view shows the reason.
- The optimistic update is TanStack DB's. The collection applies the write and fires
  its change at once, so the row shows before the POST returns. A refused write rolls
  back the same way.
- `tsconfig.json` sets `exactOptionalPropertyTypes`, which `@effect/ui` requires.
