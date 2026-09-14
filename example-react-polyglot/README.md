# party-db react example — polyglot (public catalog + per-user collections)

The companion app for [cookbook 05](../docs/cookbooks/05-public-and-private-collections.md).
A tiny language-learning app with **two kinds of data in one room**:

- **Public catalog** — `public_languages`, `public_phrases`. Everyone reads; any
  signed-in member can *add* a phrase; nobody edits or deletes through the app
  (`access: { read: 'public', insert: 'authed' }`).
- **Per-user** — `user_decks` (your settings for a language) and `user_flashcards`
  (your status on each phrase). Owner-only read and write (`owner: 'user_id'`).

The whole point is the **userspace shape**: schemas + collections defined once in
[`src/collections.ts`](./src/collections.ts), the server is `collections = [...]` plus
one `auth` hook, and the client imports the exact same array.

## Access is enforced

`access` and `ownerColumn` are enforced by the server
([cookbook 05](../docs/cookbooks/05-public-and-private-collections.md), architecture §17).
Switch identity and another learner's decks and flashcards disappear. Logging in or out
reloads the tab, because a socket keeps the user it connected as; the new socket's
snapshot, its `?since` backlog, and every live fan-out carry only your own rows. The
catalog stays public to read and open to any signed-in member to add to. Log out and
every write to your own collections comes back `401`; touch someone else's row and it
comes back `403`.

The server's `auth` hook is the one seam that drives all of it. It returns a
`WriteIdentity`, and the uid the policies compare against is its `sub` claim. See
[cookbook 08](../docs/cookbooks/08-postgres-rls.md) for the Postgres-native alternative.

## How to run

From the root of this repo:

```bash
pnpm install
cd example-react-polyglot
pnpm install
pnpm dev        # wrangler dev (:8787) + vite (:5173), proxied to one origin
```

Open <http://localhost:5173>. Pick a language, type a name to "log in" (your name
becomes your uid), add phrases to your deck, mark them known, and tweak your deck
settings. Every write persists to the DO's SQLite and syncs to other tabs.

## Files

| File | Role |
| --- | --- |
| `src/collections.ts` | **the one source of truth** — schemas + the `collections` array (with `access`/`owner`), imported by both halves |
| `src/server.ts` | the `PartyDbServer` room: `collections = collections` + the `auth` hook, which returns a `WriteIdentity` (`getTokenFromRequest` comes from `party-db/server`) |
| `src/auth.tsx` | demo identity: typing a name sets your uid/token |
| `src/App.tsx` | the app: language picker, public phrases + your status overlay, deck settings, add-a-phrase |
| `src/migrations/` | your tables + FKs + a seeded catalog, applied on DO start |

## Typecheck

```bash
pnpm typecheck   # tsc for the client half and the worker half
```

`access` / `owner` come from party-db's shared `PartyCollection` type, so the collection
definitions are checked against your row types (e.g. `owner: 'user_id'` only compiles on a
collection whose schema has a `user_id` column).
