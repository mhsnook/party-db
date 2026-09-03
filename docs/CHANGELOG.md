# Changes

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
