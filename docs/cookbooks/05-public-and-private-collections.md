# Public catalog + per-user collections (roughshod RLS) 🚧

A language-learning app has two kinds of data living in the same room:

- **A public catalog** everyone reads — `public_languages`, `public_phrases`. Anyone
  signed in can *add* to it; nobody edits or deletes through the app (curation is an
  admin/back-office job, not a CRUD button).
- **Per-user records** only you can read or write — `user_decks` (your settings for
  learning a language) and `user_flashcards` (your status on each phrase).

The whole access model is one field per collection — `access` — over one idea: `auth`
on the server turns a request into a uid, and each collection says who may read, insert,
update, and delete. No `authorize`, no per-row callbacks, no second copy of the truth.
That's a deliberately tiny subset of RLS ([`postgres-todo.md`](../postgres-todo.md) §5),
but it's enough to run this whole app — even on SQLite in a Durable Object.

> 🚧 **Proposed, not shipped.** This is API-first: the userspace code below is the
> target, and the framework is written backwards from it. It also proposes a
> *simpler* model than `postgres-todo.md` §5 — see **[What I changed, flag for
> review](#what-i-changed-flag-for-review)** at the bottom. A runnable scaffold
> (typechecks today; server-side enforcement still pending) lives in
> [`example-react-polyglot`](../../example-react-polyglot/).

## The collections — one file, shared both sides

Define the schemas and the collection list **once**, in a file both the client and the
server import. Flattening them into a single `collections` array is all the wiring there
is; the `access` rule and the `user_id` column on the private two are the only new ideas.

```ts
// collections.ts — the single source of truth, imported by client AND server
import { z } from 'zod'
import { definePartyCollection } from 'party-db'

// public catalog — everyone reads, any signed-in member adds, nobody CRUD-edits
const languageSchema = z.object({ id: z.string(), name: z.string(), flag: z.string() }) // 🇪🇸
const phraseSchema = z.object({
  id: z.string(),
  language_id: z.string(), // → public_languages.id
  text: z.string(),
  translation: z.string(),
})

// per-user — the `user_id` column is the only new idea.
// (No z.default() on the settings below: a default makes zod's INPUT type optional
// while z.infer stays required, which breaks the single-T StandardSchema match. These
// are app settings, so the defaults live in the table DDL instead — see migrations.)
const deckSchema = z.object({
  id: z.string(),
  user_id: z.string(), // ← the owner column
  language_id: z.string(),
  daily_goal: z.number().int(),
  direction: z.enum(['recognize', 'produce']),
})
const flashcardSchema = z.object({
  id: z.string(),
  user_id: z.string(), // ← the owner column
  phrase_id: z.string(), // → public_phrases.id
  status: z.enum(['new', 'learning', 'known']),
  due_at: z.number().int(), // epoch ms
})

export const collections = [
  // public read, members-only insert, no edits/deletes (unnamed verbs deny by default)
  definePartyCollection<Language>({ name: 'public_languages', key: 'id', schema: languageSchema, access: { read: 'public', insert: 'authed' } }),
  definePartyCollection<Phrase>({ name: 'public_phrases', key: 'id', schema: phraseSchema, access: { read: 'public', insert: 'authed' } }),
  // per-user — `ownerColumn` alone is sugar for fully-private (owner read + owner write)
  definePartyCollection<Deck>({ name: 'user_decks', key: 'id', schema: deckSchema, ownerColumn: 'user_id' }),
  definePartyCollection<Flashcard>({ name: 'user_flashcards', key: 'id', schema: flashcardSchema, ownerColumn: 'user_id' }),
]

// … Language / Phrase / Deck / Flashcard = z.infer<typeof …Schema>, exported here too
```

### The `access` model in one table

Every collection answers four questions — who may `read`, `insert`, `update`, `delete` —
with one of four policies:

| policy | who |
| --- | --- |
| `'public'` | anyone, signed in or not |
| `'authed'` | any request carrying a verified uid — no ownership tie |
| `'owner'` | only the row's owner (needs `ownerColumn`, matched to the uid) |
| `'none'` | no one through CRUD — managed out-of-band (admin tools, jobs, RPC) |

Two shorthands cover the everyday cases, so you rarely spell out the object:

- **omit `access`** → `'public'` on all four verbs — the default collection.
- **`ownerColumn: 'user_id'`** (and omit `access`) → `'owner'` on all four — fully private.

Reach for the object form when you want a mix, and remember the one rule that makes it
safe: **any verb you don't name is `'none'`.** So the catalog's `{ read: 'public', insert:
'authed' }` is, in full, "everyone reads, any member adds, and edit/delete are closed" —
the append-only public catalog you wanted, in one line, with no way to *forget* to lock a
verb down.

## The server — `auth` on the class

Import the shared `collections`, and add the one thing the server owns: how to turn a
request into a stable user id.

```ts
// server.ts
import { routePartykitRequest } from 'partyserver'
import { PartyDbServer } from 'party-db/server'
import { jwtVerify, createRemoteJWKSet } from 'jose'
import { getTokenFromRequest } from 'party-db/server' // reads our Bearer-header / ?token= convention; you still verify the JWT
import { collections } from './collections.ts'
import { migrate } from './migrations/index.ts'

const JWKS = createRemoteJWKSet(new URL('https://issuer.example.com/.well-known/jwks.json'))

export class Main extends PartyDbServer {
  collections = collections

  // The entire auth model: turn a request into a stable user id (or null for anon).
  // party-db resolves this ONCE at connect (pins the uid to the socket) and once per
  // write, then enforces `owner === uid` at the three read choke points — snapshot,
  // `?since` backlog, per-socket fan-out — and at the write gate. That's the RLS.
  auth = async (req: Request) => {
    const token = getTokenFromRequest(req)
    if (!token) return null // anon: sees public rows, owns nothing
    try {
      const { payload } = await jwtVerify(token, JWKS)
      return payload.sub ?? null // your uid
    } catch {
      return null
    }
  }

  onStart() {
    migrate(this.ctx.storage.sql) // your tables + FKs; party-db only CRUDs over them
    return super.onStart()
  }
}

export default {
  fetch: (req: Request, env: unknown) =>
    routePartykitRequest(req, env as never).then((r) => r ?? new Response('not found', { status: 404 })),
}
```

Notice what's **not** here: no `authHooks`, no `authorize`, no `if (kind === …)`. The
catalog is public because it has no `ownerColumn`; the deck and flashcards are private
because they do. Connect stays open — an anon socket simply receives the public rows and none of
anyone's private ones. (Want "must be logged in to even watch"? Add `authHooks` from
[recipe 4](./04-public-read-private-write.md) on top — the two seams compose.)

## The client — the same collections, it just sends a real token

```ts
// App.tsx — the client imports the SAME `collections`; `ownerColumn`/`auth` are
// server-enforced, so the client half is byte-for-byte a normal party-db app.
import { createPartyDb, partyTransport } from 'party-db/client'
import { collections } from './collections.ts'
import { getAccessToken } from './auth.ts'

const transport = partyTransport({
  host: location.host,
  room: 'polyglot', // one shared room; privacy is per-collection, not per-room
  token: getAccessToken, // a function → re-read on every reconnect, so refresh just works
})

export const { db } = createPartyDb(transport, collections)
```

## Joins live where they're used — not on the wire

Here's the quietly clever part. Flattening four schemas into one `collections` array
throws the foreign keys away *at the transport level* — `phrases.language_id`,
`flashcards.phrase_id`, the whole relational graph. The wire doesn't know these tables
relate at all; it ferries sequenced row-ops (and batch errors) and nothing else. That's
the point of an **ignorant transport**: nothing to configure, nothing to keep in sync,
no relational schema to version across the socket.

The relationships don't vanish — they live exactly where they're needed. Your SQLite
tables keep their real FKs on the server. And on the client, **TanStack DB builds join
indexes lazily, the moment a live query uses them** — so a `leftJoin` of `public_phrases`
onto `user_flashcards` gets indexed on the client the first time it runs, and *never* for
the columns or tables a query never touches. That's strictly cheaper than shipping every
index over the wire and rebuilding all of them eagerly, most of which any given client
would never use. Indexes on the server where writes are validated, indexes on the client
where queries run, and a transport in the middle blissfully unaware of both:

```tsx
import { useLiveQuery } from '@tanstack/react-db'
import { eq } from '@tanstack/db'

function Study({ languageId }: { languageId: string }) {
  // public phrases + YOUR status, overlaid. Anon users just get status: 'new' everywhere.
  const { data: cards } = useLiveQuery((q) =>
    q
      .from({ phrase: db.public_phrases })
      .where(({ phrase }) => eq(phrase.language_id, languageId))
      .leftJoin({ card: db.user_flashcards }, ({ phrase, card }) => eq(card.phrase_id, phrase.id))
      .select(({ phrase, card }) => ({
        id: phrase.id,
        text: phrase.text,
        translation: phrase.translation,
        status: card?.status ?? 'new',
      })),
  )

  // your deck for this language — your settings, only ever visible to you
  const { data: decks } = useLiveQuery((q) =>
    q.from({ deck: db.user_decks }).where(({ deck }) => eq(deck.language_id, languageId)),
  )
  const deck = decks[0]

  // start learning a phrase → an owned write. You don't pass user_id; party-db
  // stamps it from your verified uid (see note below). Optimistic, then settles.
  const learn = (phraseId: string) =>
    db.user_flashcards.insert({ id: crypto.randomUUID(), phrase_id: phraseId, status: 'learning', due_at: Date.now() })

  const promote = (cardId: string) =>
    db.user_flashcards.update(cardId, (c) => void (c.status = 'known'))

  return (
    <ul>
      {cards.map((c) => (
        <li key={c.id} data-status={c.status}>
          <b>{c.text}</b> — {c.translation}
          {c.status === 'new' ? (
            <button onClick={() => learn(c.id)}>+ deck</button>
          ) : (
            <button onClick={() => promote(c.id)}>✓ known</button>
          )}
        </li>
      ))}
    </ul>
  )
}
```

Every learner in our sample _Polyglot_ app learns from the same library of phrases; each
one sees only their own flashcards laid over them — a join across a public collection and
a private one, where the private side is filtered to your uid at the socket, so it *can't*
leak someone else's progress. That split is the whole reason the two collection kinds
exist.

As with any other collection or table PartyDB manages, changing how you learn a language
is just a write to your local collection:

```tsx
db.user_decks.update(deck.id, (d) => {
  d.daily_goal = 50
  d.direction = 'produce'
})
```

## What a rejected write looks like

An owned write only makes sense with a uid. An anon user (or an expired token) writing to
`user_flashcards` is rejected by the framework the same way any bad write is — a typed
`WriteError`, optimistic row rolled back:

```tsx
import { WriteError } from 'party-db/client'

tx.isPersisted.promise.catch((e) => {
  if (e instanceof WriteError && e.status === 401) setError('Log in to save your progress.')
  else if (e instanceof WriteError && e.status === 403) setError("That's not yours to edit.")
  else setError(e instanceof Error ? e.message : 'Write failed.')
})
```

- **401** — no/invalid uid, so an owner-write is impossible.
- **403** — a valid uid, but the row's `user_id` isn't yours (you tried to touch someone
  else's flashcard, or forged a mismatched `user_id`).

## How `ownerColumn` behaves

`ownerColumn: 'user_id'` names the column that must equal your uid — the simple
string-equality case, and the only ownership shape this recipe needs. Given that:

- **Insert** — you may **omit** `user_id`; party-db stamps it from your verified uid.
  Include it and it must match, or it's a 403. (That's why `learn()` above never mentions
  it — the slick default is "don't hand-carry your own id.")
- **Update / delete** — checked against the **stored** row, not just your payload, so you
  can only mutate rows you already own.
- **Read** — `user_id = :uid` is applied at snapshot, `?since` backlog, and per-socket
  fan-out, so a private row is only ever delivered to its owner's sockets.

`ownerColumn` and `access` stay separate fields on purpose: the column says *who owns a
row*, the policy says *which verbs consult that*. They can't collapse into one — an
`'owner'` policy is meaningless without a column to match it against. That pairing is
exactly what a hybrid needs — a public feed you can only add *and edit* your own rows to,
with deletes closed for soft-delete:

```ts
ownerColumn: 'user_id',
access: { read: 'public', insert: 'owner', update: 'owner' }, // delete unnamed → 'none'
```

For the catalog, `insert: 'authed'` gates the same way but ties nothing to you: any
verified uid may add a phrase, the row has no owner, and `update`/`delete` are `'none'`
so no CRUD path can change it after the fact. Reference data that shouldn't move once
seeded is just `access: { read: 'public' }` — read-only to everyone, writable by no one
(the DDL/seed is the only writer).

> **Beyond `column === uid`.** Ownership that isn't a plain column match — "a *friend* of
> the owner can read," with the friend set cached in the room — can't be a string. That's a
> later, function-based form (`access: { read: (row, ctx) => ctx.friends.has(row.user_id) }`),
> and it's why the equality case is `ownerColumn` and not `owner`: the word's left free for
> it. `ownerColumn` stays the cheap, common fast path. Flagged, not built.

## What I changed, flag for review

I went **simpler than [`postgres-todo.md`](../postgres-todo.md) §5** on purpose. Flagging
the deltas so you can pull them back toward the plan if you'd rather:

1. **Kept §5's full read/write matrix, but as a per-verb `access` object with great
   defaults.** §5 has `read: 'public' | 'owner'` and `write: 'owner'`. I widened `write`
   to the four real verbs (`insert`/`update`/`delete` separately, plus `read`) because
   this app needs the split — the catalog is `insert: 'authed'` but `update`/`delete`
   `'none'`, which a single `write` knob can't say. Deny-by-default keeps that verbose form
   safe. The two shorthands (omit → public; bare `ownerColumn` → fully private) mean the common
   collections still cost zero or one word, so the matrix only shows up where you actually
   need it. **This is the one to sanity-check** — it's the biggest departure from §5's
   `read`/`write` shape, and the place I'd expect you to have an opinion.
2. **`auth` returns `uid | null`, and that's the whole identity story** — no separate
   `authorize` needed for the public/private split. §5 keeps the lobby gate and adds owner
   rules behind it; I let the owner rule *be* the read filter so anon connect is fine (you
   just see public data). The lobby `authHooks` still composes on top when you want a
   coarse "logged-in to connect at all" gate — it's additive, not replaced.
3. **Auto-stamp the owner column on insert** (§5 says "inserts carry your own uid" but has
   you write it). Stamping it from the verified uid removes the client's ability to forge
   it *and* removes a boilerplate field from every insert. It does mean the owner column is
   **optional on the insert type** but required on the stored row — a small type nicety the
   framework owes userspace. If you'd rather keep inserts explicit, drop this and the only
   change above is `learn()` passing `user_id: me.id`.

Everything else (three read choke points, write gate checks the stored row, `WriteError`
status codes) is straight from §5 — I only simplified the *surface*, not the enforcement.
