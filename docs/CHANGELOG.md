# Changes

## 2026-11-24 - v0.2.0

Access policies can name roles. A verb's policy can be a grant, met by the row's
owner or by a signed-in user holding one of its roles.

- **`AccessGrant` on `access`.** `{ owner: true, roles: ['editor'] }` means the row's
  owner or an editor. Either field can stand alone, and a grant can stand for all four
  verbs (`access: { roles: ['editor'] }`). Roles come from the `auth` hook's
  `claims.roles`, and count only beside a `sub`. Boot refuses a grant with an unknown
  key, so `{ role: 'editor' }` fails at startup instead of denying everyone.
- **`PartyDbServer.reconnectUser(uid)`.** It closes that user's sockets with
  `CLOSE_IDENTITY_CHANGED` (4001). The client redials without `?since` and loads a
  fresh snapshot under its new identity. Call it when someone's roles change or they
  are deactivated. It closes nothing in a room whose reads are all public, since those
  sockets are never tagged.
- **Composed hosts: `broadcast` can be handed `{ role }`.** `audienceTag` covers it, so a
  host that looks sockets up by `audienceTag(audience)` needs no change. A collection
  whose read grant names an owner and a role, or several roles, needs the core's
  `connectionsOf(audience)` option, and `init` refuses to start without it. It returns
  one audience's sockets, and the core calls it once per role and per owner.
- **A connection id cannot start with `party-db:`.** A client picks its id (`?_pk=`),
  and partyserver stores it as the socket's first tag, so an id shaped like
  `party-db:uid:<uid>` read as that user. `PartyDbServer` now refuses such a connect.
  A composed host that pins `viewerTags` must call `assertConnectionId(conn.id)` first
  in `getConnectionTags`.
- **A room's read rules name at most `MAX_ROLE_TAGS` (7) roles.** `init` refuses more.
  Roles that only gate writes are not pinned and do not count.
- **`Viewer` gains an optional `roles`.** `viewerOf(identity)` builds one from verified
  claims, and `viewerTags` pins up to `MAX_ROLE_TAGS` (7) roles as tags. Your own
  connection tags share partyserver's 9 with these.

Also in this release, from #65:

- **A slice subscribe with `since` reads less.** `PersistenceAdapter.replaySince` takes
  an optional `channel`. With one, it reads only that channel's entries; with none, it
  leaves out the `sliceBy` collections, the way `snapshot()` already did. A custom
  adapter that ignores the argument still works, because the core filters anyway.
- **`sliceBy` is checked like `ownerColumn` at startup.** A column the schema types as
  anything but a string or a number, such as a date or an enum, is refused instead of
  matching no rows.
- **Adapters no longer mark a slice snapshot with `slice`;** the core does.
- **Fixed: a slice could stop receiving writes.** If a socket held a whole-channel
  subscription and a slice of the same channel, the server recorded only the whole
  channel. Dropping the whole-channel subscription then dropped the slice too.
- **Fixed: a delete is routed by the stored row.** On a sliced collection, a delete
  carrying the wrong slice value deleted the row but never reached that slice's
  watchers. A sliced collection now needs an adapter with `readRows`, as an `owner`
  policy does; all three built-in adapters have it.
- **Fixed: a re-registered collection could hang in `loading`.** If it re-registered
  while the socket was reconnecting, its snapshot request was dropped. It is now
  sent again each time the socket opens, until the snapshot arrives.
- **Fixed: a quick subscribe then unsubscribe** could leave the socket subscribed.
- **A socket's subscriptions stay within its hibernation slot.** The slice cap now
  counts per channel, and a socket whose subscriptions would outgrow the slot folds
  to whole channels.

Breaking:

- **`sliceText` is removed.** Compare slice values with `idOf`, which `ownerColumn`
  already uses: it maps a value that can't be an id (`null`, `''`) to `null` instead
  of the string `"null"`. `subscriptionKey` and `isSliceValue` are exported alongside it.

## 2026-11-14 - v0.1.0

A collection can now load by slice, `db` is typed by collection name, and party-db
moves to TanStack DB 0.15. The example apps now run in a browser in CI.

- **`sliceBy` on a collection.** A collection sliced by one column loads only the slices
  its live queries ask for, and a write reaches only the clients watching its slice.
  The live query's `where` is the subscription: `eq(c.thread_id, id)` loads that
  thread, and `inArray` loads several. The column can't change on a row: an update
  that carries it is a 400 (`docs/architecture.md` §18).
- **`db` is typed by collection name.** `db.todos` is `Collection<Todo, string>`, with
  the row type taken from the schema and the key type from the key column. A name you
  never declared is a type error. To get this, let the schema carry the row type:
  `definePartyCollection({ name, key, schema })`. An explicit
  `definePartyCollection<Todo>(...)` still compiles, and that collection stays
  `Collection<any>` on `db`.
- **`PartyDbCore` takes `connections` and gains `disconnect(id)`** (optional). With
  them, the core routes sliced writes to each slice's watchers itself. `connect` and
  `handleMessage` accept a `PartyDbConnection` in place of the send function. A host
  that passes neither keeps working, and sends every slice to every client.
  `PartyDbServer` does this for you, and keeps each socket's subscriptions in
  `conn.state` under `SUBSCRIPTIONS_KEY`. If your app calls `conn.setState(value)`,
  merge instead of replacing, or that socket gets every sliced collection whole.
- **`PartyDbServer.onClose`** now forgets the socket's subscriptions. If you override
  it, chain `super.onClose(...)`.
- **A refused write no longer crashes the worker under `wrangler dev`.** The lobby's
  401 and the write path's 413 answered without reading the POST body, and workerd
  intermittently ended the isolate, failing the next request with a 503. Both now
  read the body to the end first, keeping none of it.

Breaking:

- **`@tanstack/db` peer range is now `^0.15.2`** (was `^0.6.10`). Apps on React pair
  it with `@tanstack/react-db` `^0.5.12`. Two TanStack changes show up in app code:
  - Rows read from a collection carry virtual props (`$synced`, `$origin`, `$key`,
    `$hasPendingWrites`). What party-db sends to the server is unaffected.
  - Inside a query's `select`, a joined row is a column reference, never `undefined`,
    so a JS default like `card?.status ?? 'new'` no longer applies. Use
    `coalesce(card.status, 'new')`.
- npm's `latest` tag for both TanStack packages points at the 1.0 release candidate.
  A bare `pnpm add @tanstack/db` installs the RC, which is outside the peer range, so
  name the version.
- **`Transport.requestSnapshot(channel)` is now `sendFrame(frame)`**, plus optional
  `isOpen()` and `onOpen(listener)`. Only a custom transport is affected.
  `partyTransport` implements all three. The re-register request is now
  `{ subscribe: channel }` instead of `{ snapshot: channel }`. A stale tab running the
  old client against a redeployed room gets no answer to that request until it
  reloads.
- **`PartyCollection` takes two more type parameters**, `Name` and `Key`, both
  defaulting to their old types. Code that indexes `db` with an arbitrary string, like
  `db[name]`, no longer compiles when every config has a literal name.

## 2026-10-25 - v0.0.6

- **`snapshot: false` on a collection.** A connecting client gets no rows for it and
  tails from there. Reconnects still fill the gap (`docs/architecture.md` §8).

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
