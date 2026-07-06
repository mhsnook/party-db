# Cross-collection atomic writes

Multiple writes that have to land together use TanStack DB's `createTransaction`,
with party-db's `persist` as the `mutationFn`. One POST, one database commit,
with no back-and-forth between server and the database. ✅

```ts
import { createTransaction } from '@tanstack/db'
import { createPartyDb, definePartyCollection } from 'party-db/client'

const { db, persist } = createPartyDb(transport, [
  definePartyCollection({ name: 'posts', key: 'id', schema: postSchema }),
  definePartyCollection({ name: 'post_tags', key: 'id', schema: postTagSchema }),
])

const postId = crypto.randomUUID()

const tx = createTransaction({ mutationFn: persist })
tx.mutate(() => {
  db.posts.insert({ id: postId, title: 'hello world' })
  db.post_tags.insert({ id: crypto.randomUUID(), post_id: postId, tag: 'intro' })
})

// both writes land in one POST, committed in one DB transaction — or neither does.
// rejects (and rolls back) if either write hits a constraint.
await tx.isPersisted.promise
```

This allows you to orchestrate actions on the client that act like an RPC function
you would usually write on the server, with everything being written in one commit,
accepted or rejected as a single action.
