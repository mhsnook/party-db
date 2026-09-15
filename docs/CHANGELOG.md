# Changes

## 2026-09-15 - v0.0.5

Access policies are enforced. `access` and `ownerColumn` shipped as declared-but-inert
surface in v0.0.2; setting them changed nothing except a startup warning. They now
decide who may read, insert, update and delete each collection, on every adapter
(#33, #59). The recipe is unchanged from what cookbook 5 always showed:

```ts
definePartyCollection({ name: 'cards', key: 'id', schema, ownerColumn: 'user_id' })
auth = (req) => ({ claims: { sub: uid } })
```

Breaking:

- **A room that already declares `access` or `ownerColumn` now enforces it.** Before
  this release those rooms served every row to everyone. If you declared a policy to
  try it out, check it says what you meant before upgrading.
- **`PartyDbCore`'s `broadcast` option takes an audience**: `broadcast(message,
  audience)`, where `audience` is `'all'`, `'authed'`, or `{ uid }`. A composed host
  (`docs/architecture.md` §15) sends to `getConnections(audienceTag(audience))` for
  anything but `'all'`. `PartyDbServer` subclasses are untouched. This replaces the
  optional second callback the feature first shipped with, so a private row cannot be
  fanned out to everyone by an option nobody set.
- **`ownerColumn` is typed `UidColumn<T>`**: a string or number column. A column the
  schema types as anything else no longer compiles, and is refused at boot.
- **A room with an `'owner'` policy needs an adapter with `readRows`**, or it refuses
  to start. All three shipped adapters have it.

Added:

- The four policies (`'public'`, `'authed'`, `'owner'`, `'none'`) and both shorthands,
  enforced at four choke points: the write gate, the snapshot, the `?since` delta, and
  the fan-out. An `'owner'` insert stamps the owner column from your verified uid; a
  forged one is a 403. An `'owner'` update or delete is checked against the stored row,
  not the payload. A socket reads only its own user's rows. How it works and what it
  costs: `docs/architecture.md` §17.
- **A row can change hands.** Reassign an owner column with `commit()` and the new
  owner is sent the row while the old owner is sent a delete — live, and in any later
  `?since` replay. Nothing in the row as it stands after a write can say it left
  someone's reach, so the write reads the row as it stood before and routes by both.
- **A user id can be an integer.** `users.id` is a `SERIAL` as often as it is a uuid,
  and party-db never asks you to change your tables. The `sub` claim is a string by the
  JWT spec, so owners compare as text: `user_id` 1 owns what `sub` `"1"` owns.
- `PersistenceAdapter.readRows?(channel, keys)` — the prior-row read, on all three
  adapters.
- `PartyDbCore.resolveViewer(req)`, and `PartyDbServer.getConnectionTags`, which pins a
  socket's user to it as partyserver tags that survive hibernation.
- `viewerTags`, `viewerFromTags`, `audienceTag`, and the `Viewer` and `Audience` types,
  exported from `party-db/server` so a composed host can reuse the same scheme.
- A malformed op in a write body is a 400 naming the problem, rather than an error out
  of the statement builder.

Known gaps, all named in `docs/architecture.md` §17:

- A socket keeps the uid it connected with. Signing in or out takes effect on
  reconnect; `example-react-polyglot` reloads the tab to get one.
- The prior-row read and the write are two statements, made atomic by the room's write
  queue. That covers the Durable Object's own SQLite, where the room is the only
  writer. On D1 or Postgres another writer can still move a row in between.
- Snapshots still read whole tables and filter in JavaScript.
- Cookbook 6's expression rules, ownership by a claim other than `sub`, and a
  client-side predictor are not built.

## 2026-09-03 - v0.0.4

Fixed:

- A collection that registers a second time reopened blank (#47, #58). TanStack DB
  garbage-collects a collection once its last subscriber leaves, and restarts sync on
  the next access. That second `register` landed on an empty collection which nothing
  replayed: the socket never dropped, so the client's `?since` cursor was current and
  a delta from it was empty. The panel stayed blank, `isReady` never fired, and only
  future writes arrived. The client now asks the room for that channel's snapshot.

Added:

- `Transport.requestSnapshot?(channel)`, the optional seam the re-register snapshot
  goes out through. `partyTransport` implements it as a `{ snapshot: <channel> }`
  socket send — the one frame a client writes UP the WebSocket. The room replies with
  an ordinary snapshot batch marked `reset: true`, to the requesting connection alone.
  A custom transport without the hook keeps today's behavior, and `?since` connect
  behavior is untouched.
- `PersistenceAdapter.snapshot()` takes an optional channel, so the room reads one
  table instead of all of them.

## 2026-09-01 - v0.0.3

Breaking:

- Require Zod v4 (#57). The column classifier reads `_zod.def`, the one spelling
  shared by `zod`, `zod/mini`, and `zod/v4/core`. A v3 schema has no `_zod`, so it
  falls through as an opaque StandardSchema and drops the collection into the blob
  store. `zod` is now an optional peerDependency at `^4.0.0`, so a v3 user is warned
  at install time. `columnsOf` takes the collection name.
- An update sends only the columns it changed, and must hit a row (#54). A
  one-column update no longer writes every other column back from the writer's copy.
  An update whose key matches no row is a 409 `code: 'missing-row'`, not a silent
  success. A delete of a row already gone stays a no-op.

Added:

- `close()` on the client (#56). `createPartyDb(...)` returns `close()`, which hangs
  up the socket through the new `Transport.close?()` seam and stops the re-dial. A
  room-per-document app no longer leaks a live socket per room the user visits. A
  write after close rejects with `ClosedError` (new, exported).

Fixed:

- Boolean and json columns decoded wrong under Zod v4 (#51). `kindOf` read
  `_def.typeName`, which v4 renamed, so every field fell through to `scalar`: a
  client got its boolean column as 0/1 and its json column as unparsed text.
- The client drops a socket frame it cannot route (#50), instead of advancing the
  cursor on it.
- `example-react-polyglot` returned a bare uid from `auth` where v0.0.2 wants a
  `WriteIdentity`, so the room answered every write 401 (#52). CI now typechecks and
  builds all four examples, both halves.

## 2026-08-26 - v0.0.2

- Extract PartyDbCore for DOs that can't subclass (like an agents-SDK `AIChatAgent`)
