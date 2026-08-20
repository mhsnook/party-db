# Rows your server writes itself

Not every row comes from a client. A job finishes, an agent settles, a webhook
lands — and the code that writes the row is your own, running inside the room's
Durable Object. Call `this.commit()` and it syncs like any other write. ✅

```ts
import { PartyDbServer, definePartyCollection } from 'party-db/server'

export class Article extends PartyDbServer {
  collections = [definePartyCollection({ name: 'notes', key: 'id', schema: noteSchema })]

  // your own endpoint: answer now, write the notes as the model settles.
  async onRequest(req: Request) {
    const url = new URL(req.url)
    if (url.pathname.endsWith('/review')) {
      this.ctx.waitUntil(this.review(url.searchParams.get('article')!))
      return Response.json({ started: true }, { status: 202 })
    }
    return super.onRequest(req) // POST /write, unchanged
  }

  private async review(article: string) {
    for await (const note of runTheModel(article)) {
      // one commit per note: it gets a seq, an _oplog entry, and fan-out to every
      // socket in the room — the same trip a client's POST takes.
      await this.commit([{ channel: 'notes', ops: [{ type: 'insert', value: note }] }])
    }
  }
}
```

Every client watching the room sees each note appear as it commits. No new
endpoint on the client, no polling, no `refetch` — `db.notes` is already
subscribed.

## Why not just `INSERT`

Because the room would split in two. A fresh client reads your real tables (the
snapshot); an already-connected or reconnecting one reads the `_oplog` (the
delta). A row written around the oplog therefore reaches the first and never
reaches the other — two clients on one room, diverged by connection history,
until the next full snapshot.

`commit()` is the write → `seq` → broadcast section `POST /write` runs. Going
through it is what puts the row in both places.

## What you get back, and what you don't

`commit()` returns the sequenced batches: the rows the database actually
committed (defaults, serials, generated columns), each with its `seq`.

```ts
const [batch] = await this.commit([{ channel: 'notes', ops: [{ type: 'insert', value: note }] }])
batch.seq // 42
batch.ops[0].value // the resolved row, not the one you sent
```

A database rejection **throws** — a constraint violation, an RLS denial. It is
your own code calling, so you handle it the way you handle your other failures;
there is no `Response` to hand back. The whole call is one transaction, so pass
several batches when they have to land together:

```ts
await this.commit([
  { channel: 'rounds', ops: [{ type: 'insert', value: round }] },
  { channel: 'notes', ops: notes.map((value) => ({ type: 'insert', value })) },
]) // both commit, or neither does
```

## Ordering and auth

`commit()` shares the queue `POST /write` uses, so a host write and a client
write racing each other still broadcast in seq order. Nothing to coordinate.

It also sits **below** the HTTP path's size, shape and token checks — right for a
write the server itself authors: the caller is your own privileged code, and
`/write` keeps its own checks for clients. On Postgres you can still have the
database judge it, by passing the identity to write as:

```ts
await this.commit(batches, { role: 'party_rls', claims: { sub: userId } })
```

Then the row is written under that role and your RLS policies apply, exactly as
they do for a client POST ([cookbook 8](./08-postgres-rls.md)).

## The limit

This covers code running **inside the room's own Durable Object**. A write from
somewhere else — another worker, a cronjob, `psql` — still never reaches the
oplog, and still won't sync live. That one waits for the Postgres WAL work
([`postgres-todo.md`](../postgres-todo.md)).
