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
one `auth` getter, and the client imports the exact same array.

## 🚧 Speculative — enforcement is not built yet

This example is **API-first**: it's the target userspace code, written before the
framework that backs it. `access`, `owner`, and the server's `auth` getter are declared
and they **typecheck**, but the current `PartyDbServer` does **not** enforce them — so in
the running demo *every collection syncs publicly* and switching identity does not hide
another learner's rows. What the framework still owes this app (owner-stamping on insert,
the read filter at snapshot / `?since` / fan-out, the write gate) is spelled out in
[cookbook 05](../docs/cookbooks/05-public-and-private-collections.md) and
[`postgres-todo.md`](../docs/postgres-todo.md) §5.

What *does* run today: the full sync + optimistic writes, the shared-once collections, the
public-catalog + your-overlay UI, and deck settings — all of it is ordinary party-db CRUD.

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
| `src/server.ts` | the `PartyDbServer` room: `collections = collections` + the `auth` getter (`getTokenFromRequest` comes from `party-db/server`) |
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
