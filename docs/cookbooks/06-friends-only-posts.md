# Friends-only posts (per-viewer read rules) 🚧

A microblog where each post is either **public** or **friends-only**: you can read a
friends-only post if you wrote it, or if you're friends with whoever did. The friends
graph populates some other way (a sync job, a webhook, another service) — this recipe
just needs to *read* it.

[Recipe 5](./05-public-and-private-collections.md) gave every collection a `read` policy,
but the policies were strings — `'public'`, `'authed'`, `'owner'`. This is the case a
string can't state: **whether a viewer may see a row depends on data that's neither in
the row nor equal to the viewer's id** — it's the friend graph. So `read` grows exactly
one new form — a serializable **expression** built from the query combinators you already
use. Returning an expression (not a raw boolean) is the whole trick: it lets one rule
compile down to a SQL `WHERE` for bulk reads *and* an in-memory predicate for fan-out.
Everything else from recipe 5 stands unchanged.

> 🚧 **Proposed, not shipped.** Realizes the "beyond `column === uid`" note recipe 5 left
> open. It needs a small type-surface widening and one new server seam — both spelled out
> in **[Flag for review](#flag-for-review)**.

## The rule lives on the collection

```ts
// collections.ts
import { z } from 'zod'
import { definePartyCollection } from 'party-db'
import { eq, or, inArray } from '@tanstack/db' // the same expression builders your live queries use

const postSchema = z.object({
  id: z.string(),
  author_id: z.string(),
  body: z.string(),
  visibility: z.enum(['public', 'friends']),
  created_at: z.number().int(),
})
export type Post = z.infer<typeof postSchema>

// The per-connection read context (built in server.ts): who's looking, and who
// they know. Shared by the rule below and the server that fills it. `friends` is a
// list so it can drop straight into a SQL `IN (…)`.
export type Viewer = { uid: string | null; friends: string[] }

export const collections = [
  definePartyCollection<Post, Viewer>({
    name: 'posts',
    key: 'id',
    schema: postSchema,
    ownerColumn: 'author_id', // writes: your own posts only
    access: {
      // reads: public to everyone; friends-only to the author and their friends.
      // Return a serializable EXPRESSION, not a raw boolean — that's what lets the
      // one rule compile to a SQL WHERE (snapshot/backlog) and an in-memory predicate
      // (fan-out). `post` is the row's columns; `viewer` is your cached context.
      read: (post, viewer) =>
        or(
          eq(post.visibility, 'public'),
          eq(post.author_id, viewer.uid),
          inArray(post.author_id, viewer.friends),
        ),
      write: 'owner', // insert + update + delete, all owner-gated
    },
  }),
]
```

That predicate **is** the access rule — four lines that read like the sentence you'd say
out loud, and not one line of it lives in a server permissions layer.

## How this extends recipe 5

Recipe 5's `access` object is untouched; this adds two conveniences and one seam:

- **`read` may be an expression function** `(row, viewer) => Expression`, built from the
  same `eq`/`and`/`or`/`inArray` combinators live queries use — not only a policy string.
  Returning an expression rather than a plain boolean is deliberate: it's serializable, so
  party-db lowers the one rule to both SQL and an in-memory predicate (see
  [One rule, two lowerings](#one-rule-two-lowerings)). The string forms still work everywhere.
- **`write: 'owner'` is shorthand** for setting `insert`/`update`/`delete` to the same
  policy at once (here `'owner'`, resolved against `ownerColumn: 'author_id'`).
  Deny-by-default still applies to any verb left unnamed.
- **The `Viewer`** is the new seam: a per-connection context the predicate reads.
  `ownerColumn` was recipe 5's string-equality fast path; `Viewer` is the general form it
  pointed at — the rule can now consult anything you can load for a user, not just their id.

## The server builds the viewer — and party-db caches it

The predicate reads `viewer.friends`; something has to load it. That's the *only* new
server code: one function that turns a uid into a `Viewer`. party-db calls it once when a
socket connects and **caches the result on the connection** (surviving hibernation), so
fan-out never reloads the graph per message.

```ts
// server.ts
import { PartyDbServer, getTokenFromRequest } from 'party-db/server'
import { verifyJwt } from './jwt.ts'
import { collections, type Viewer } from './collections.ts'

export class Main extends PartyDbServer {
  collections = collections

  // who is this request? (recipe 5, unchanged) — gates owner writes, seeds the viewer
  auth = (req: Request) => verifyJwt(getTokenFromRequest(req))?.sub ?? null

  // what may they see? the ONE place the friends list is fetched. Cached per
  // connection; the read predicate just consumes `viewer.friends`.
  loadViewer = async (uid: string | null): Promise<Viewer> => ({
    uid,
    friends: uid ? await this.friendsOf(uid) : [],
  })

  // the friend graph — assumed populated some other way. Here it's a local table
  // read; swap in a fetch() to your social service if it lives elsewhere.
  private async friendsOf(uid: string): Promise<string[]> {
    return this.ctx.storage.sql
      .exec('SELECT friend_id FROM friendships WHERE user_id = ?', uid)
      .toArray()
      .map((r) => r.friend_id as string)
  }
}
```

Two getters, cleanly split: **`auth`** answers *who are you* (cheap, on every write, to gate
owner rules), **`loadViewer`** answers *what may you see* (loaded once, cached, for the read
predicate). The collection declares the rule; the server declares how to feed it.

## Keeping the cache fresh

party-db caches each viewer on its connection, so fan-out never reloads the graph. The
friends list itself is maintained elsewhere (a sync job, a webhook — not shown here); when
it changes, that code calls `this.refreshViewer(uid)` to rebuild the viewer and re-filter
their live sockets — no reconnect, no client involvement. A TTL on the cache is a fine
stand-in when the graph moves rarely.

## The client doesn't change at all

There's no read-auth code on the client — there *can't* be, since the filtering is
server-side. Compose your feed from `db.posts` like any collection and you get exactly the
posts you're allowed to see:

```tsx
const { data: feed } = useLiveQuery((q) =>
  q.from({ post: db.posts }).orderBy(({ post }) => post.created_at, 'desc'),
)

// publish — author_id is stamped from your uid (recipe 5), so you just choose the reach
const post = (body: string, visibility: 'public' | 'friends') =>
  db.posts.insert({ id: crypto.randomUUID(), body, visibility, created_at: Date.now() })
```

Your friend's socket receives your friends-only post the instant it lands; a stranger's
socket never sees it. Same optimistic write, same live query — the predicate does the rest.

## One rule, two lowerings

You write the rule once; party-db lowers it to whatever each read path needs, with the
viewer's concrete `uid` and `friends` baked in (compiled once per connect, reused for the
life of the socket):

- **snapshot load** and **`?since` backlog** — the expression becomes a SQL `WHERE`:
  `visibility = 'public' OR author_id = :uid OR author_id IN (:friends)`. The database does
  the filtering against its indexes; you never `SELECT *` and sift in JS. **This is the
  whole reason `read` returns an expression instead of a closure** — a closure can't cross
  into SQL, an expression can.
- **per-socket fan-out** — the same expression becomes an in-memory predicate over each
  broadcast row, including WAL/cron-sourced rows: a friends-only post written by *any* path
  reaches only sockets whose viewer satisfies it.

Same rule, same verdict on both paths, and the bulk read stays a single indexed query. A
row a viewer can't see never leaves the server for that socket — the client can't leak what
it never received.

## Flag for review

Three trade-offs, pull them back if you'd rather:

1. **The rule must stay expressible.** Because `read` compiles to SQL, it's bounded by what
   the combinators can say — equality, `and`/`or`, `inArray`, ranges — over the row's own
   columns and injected viewer values. That fits the friends rule exactly, but not arbitrary
   JS, joins, or aggregates. A rule that truly needs those abandons the SQL path and falls
   back to in-memory filtering over a bounded candidate set (or a non-realtime
   `queryCollection`, per [`collection-types.md`](../collection-types.md)). And the one
   scale edge: a *very* large friends list becomes a very large `IN (…)`; past a few
   thousand, lower it to a temp-table join rather than inline params.
2. **Type surface this needs.** `Access.read` widens to `AccessPolicy | ((row: Refs<T>,
   viewer: V) => Expression)` — a function returning a serializable expression, over the
   same ref/combinator types the query builder already exports — and `PartyCollection<T>`
   gains a second generic `V` for the viewer (defaulting to `{ uid: string | null }` so
   recipe-5 collections don't notice). `loadViewer`/`refreshViewer` are new on
   `PartyDbServer`. None of this is in the shipped types yet — unlike recipe 5 I left them
   alone, because the viewer generic touches the common path and I'd want your call first.
3. **Freshness is eventually-consistent.** The per-connection cache lags a graph change
   until `refreshViewer` (or a TTL) catches it. Fine for "see a friend's posts"; **not** fine
   where a *removed* friend must lose access instantly — for that, gate those reads on a live
   check instead of the cache. Roughshod RLS, not a security kernel.
