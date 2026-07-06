# Custom server validation logic

Validation comes from the Zod schemas we already know and love — add a `.refine()` and you're set.
There's no new validation API for PartyDB.

```ts
export const todoSchema = z
  .object({
    id: z.string(),
    text: z.string(),
    done: z.boolean(),
  })
  .refine((todo) => todo.text.trim().length > 0, { message: 'a todo needs some text', path: ['text'] })
  .refine((todo) => todo.text.length <= 280, { message: 'keep it under 280 characters', path: ['text'] })

// share it exactly as before — nothing else changes
definePartyCollection({ name: 'todos', key: 'id', schema: todoSchema })
```

The client validates optimistic writes against this today, so a bad row never leaves
the browser. Server-side enforcement of the same schema is roadmap 🚧 — today the
server reads the schema only for its column allowlist/codec
([`../unspecified.md`](../unspecified.md), write-time validation).

## Rules that need the request 🚧

Some rules aren't a function of the row — e.g. "you can only create your own todos"
(`author_id === the requester's uid`). A static schema can't see the uid; it's on the
request, not in the row.

The proposed shape: a write schema that's a function of a small per-request context,
plus an `auth` getter on the server that fills in `ctx.uid`.

```ts
// PROPOSED — not built yet
definePartyCollection({
  name: 'todos',
  key: 'id',
  schema: todoSchema,
  writeSchema: (ctx) =>
    todoSchema.refine((todo) => todo.author_id === ctx.uid, {
      message: 'you can only create your own todos',
      path: ['author_id'],
    }),
})

export class Main extends PartyDbServer {
  auth = (req: Request) => verifyUid(req) // -> string | undefined, becomes ctx.uid
  collections = [todos]
}
```

Still just Zod validating — party-db only hands it the one thing the row can't carry:
who's asking. Weigh in at [`../unspecified.md`](../unspecified.md).
