# PartyDB: Realtime Tanstack Collections with DB Persistence

PartyDB is an attempt to solve realtime Tanstack DB collections using Cloudflare Durable Objects.
There are many other implementations out there and many building blocks to work from, so we start
with our favourites and treat them as solid pillars for the rest of the architecture:

- [Tanstack DB](https://tanstack.com/db/latest/docs/overview) is where our "final product" is delivered: userspace receives DB Collections which our library wires up through the back-end, so the dev never has to build the collection's server actions, server's persistence API, or websocket fan-out for realtime echos.
- [Cloudflare Durable Objects](https://developers.cloudflare.com/durable-objects/) manage the Websockets that clients will subscribe to. Specifically, the [PartyKit](https://docs.partykit.io) ecosystem provides a PartyServer and PartySocket, which we extend to make our PartyDbServer.

The core promise we're trying to deliver for users (developers building local-first realtime-sync apps) is this: **the config you need to set up a Tanstack DB collection is already more than enough to set up the full round-trip and fan-out for an API and realtime sync**.

The core philosophy for how we design our human-facing (user-facing/dev-facing) APIs is this: **the Tanstack DB API is the only API you should need to know**. That means that a transaction you open up on the client should be sent to the server and run identically on the server with no new config.

## Architecture: one write, end to end

Every seam a write crosses, in order. Grep the named symbol to land in the right file.

1. `db.todos.insert()` applies optimistically in TanStack DB, which calls the collection's
   `onInsert`. That handler is **`persist`** — `src/client/collection.ts`.
2. `persist` groups the transaction's mutations by channel into `WriteBatch[]`, then POSTs
   them through the transport — **`partyTransport`**, `src/client/party-db.ts`.
3. The **lobby** gate runs in the Worker, before the Durable Object wakes — **`authHooks`**,
   `src/server/auth.ts`. One `authorize(req, ctx)` gates both doors: the WS connect and the POST.
4. **`PartyDbCore.handleWrite`** validates the body and resolves the writer's identity through
   the `auth` hook, then hands the batches to `commit` — `src/server/core.ts`. `PartyDbServer`
   is the thin subclass that forwards `onRequest` to it; a host that can't subclass holds the
   core itself (`docs/architecture.md` §15).
5. **`PartyDbCore.commit`** serializes the write → seq → broadcast section. Host code running
   in the DO calls it directly for a row the server itself authors (`docs/architecture.md` §14).
6. One **`PersistenceAdapter.write()`** commits the whole POST body in one transaction and returns
   each batch's resolved rows plus its `seq` — `src/server/persistence.ts`. `commit` broadcasts each
   `SequencedBatch` on the socket inline, after the commit and before `onRequest` answers the POST
   with a `WriteAck`.
7. **`SyncClient.waitForSeq`** resolves once that `seq` arrives back down the stream, so the
   optimistic overlay drops onto the synced row without a flicker.

The read path is the same pipe backwards. On connect the client sends `?since=<seq>` and
`PartyDbServer.onConnect` replays the `_oplog` delta; with no cursor, or a cursor older than
retention, the server sends a full snapshot marked `reset: true` instead.

Vocabulary, used exactly this way everywhere:

- **channel** — the collection name, which is also your table name. One socket multiplexes N channels.
- **seq** — the authority's own commit-log position (the `_oplog` rowid, or a Postgres `BIGSERIAL`).
  Typed `Cursor = number | string`. We compare it for equality and order; we never do arithmetic on it.
- **mode** — the four persistence modes, in order of increasing control: blob (0), DO-embedded
  SQLite (1), D1 (2), Postgres (3). See `docs/architecture.md` §1.
- **resolved row** — what the database actually committed, read back through `RETURNING`. This is
  what fans out, never the row the client sent.

### Invariants worth not breaking

- **We never create or migrate your tables.** `_oplog` is the only table party-db owns.
- **Every value is bound; every identifier comes from the schema allowlist** (`assertIdent` in
  `src/server/columns.ts`), never from a payload's keys.
- **`access` and `ownerColumn` are declared surface, not enforcement** (issue #33). `warnUnenforcedAccess`
  warns loudly at boot. Do not treat them as security.
- **Anonymous writes fail closed.** If `auth` is set and the POST resolves no identity, the server
  rejects it 401 unless the subclass names an `anonRole`.
- **The wire is mode-invariant.** A client cannot tell which mode its room runs. Changing mode is a
  server-only migration.

### Two kinds of contract — only one binds

Two different things get called "the contract" in review. Keep them apart:

- **The userspace contract** — everything app code touches: the exported API (`createPartyDb`,
  `partyTransport`, `PartyDbServer`, `PartyDbCore` and its options), the TanStack DB behavior,
  and the app's own tables. Preserve it, or flag the break loudly.
- **Lockstep internals** — everything where party-db owns both ends and one package version ships
  them together: the wire frames, the query markers, the seams between our own client pieces.
  Change these freely when both halves change in the same commit. Do not add compatibility shims,
  protocol version fields, or migration paths for them — there is no independently-versioned party
  to protect. The one real skew, a stale browser tab running the old client against a redeployed
  room, is accepted pre-1.0: the tab reloads.

When an issue or plan says "no wire changes", read it as "no userspace-visible changes" unless it
says otherwise. The `?proto=party-db` marker (PR #44) is the model: a wire addition, invisible to
userspace, shipped without ceremony.

## Documentation map

| Read this | For |
| --- | --- |
| `README.md` | the user-facing pitch, both setup snippets, and a per-file table of `src/` |
| `docs/architecture.md` | the decision record — 14 settled decisions, each with its why, plus the roadmap |
| `docs/unspecified.md` | open questions and modes we describe but have not built |
| `docs/postgres-todo.md` | the v2 plan: WAL tailing, RPCs, identity-aware reads |
| `docs/collection-types.md` | TanStack DB's other collection types, and our read-side capabilities |
| `docs/cookbooks/` | 9 worked recipes; ✅ = works today, 🚧 = the seam exists but the use is proposed |
| `plans/README.md` | the plan queue with status, dependencies, and findings already rejected |

Before proposing something, check `plans/README.md` — its "Findings considered and rejected" section
records decisions the maintainer already made, so nobody re-audits them.

## Types to read first

Four files hold the whole contract. Read them before changing anything under `src/`.

- **`src/protocol.ts`** — the wire, and it is deliberately tiny: `WriteEvent` (= TanStack's
  `Omit<ChangeMessage, 'key'>`), `WriteBatch`, `SequencedBatch`, `Cursor`, `WriteAck`, `WriteReject`.
- **`src/schema.ts`** — `PartyCollection<T>` = `{ name, key, schema?, ownerColumn?, access? }`, the one
  collection interface both sides import, plus `definePartyCollection` for inference.
- **`src/server/persistence.ts`** — `PersistenceAdapter` (the storage seam), `WriteIdentity`,
  `WriteRejection`.
- **`src/client/sync-client.ts`** — `Transport` (the two-method down/up seam) and `SyncClientOptions`.

## Functions worth grepping for

**Client**

- `createPartyDb(transport, configs)` / `partyTransport({host, room, token})` — `src/client/party-db.ts`
- `makePersist(client, channelOf)` / `wireCollections(client, configs)` / `toEvent(mutation)` — `src/client/collection.ts`
- `applyBatch(sink, batch)` — `src/client/apply.ts`, the only place a batch reaches a collection
- `SeqTracker.observe` / `.waitFor` / `.rejectAll` — `src/client/seq-tracker.ts`, settlement with no transport attached
- `WriteError` / `TransportError` / `AuthError` / `toWriteReject` — `src/client/errors.ts`

**Server**

- `PartyDbServer.onRequest` / `.commit` / `.onConnect` / `.onStart` / `.createAdapter` — `src/server/party-db-server.ts`, the thin subclass
- `PartyDbCore.init` / `.connect` / `.handleWrite` / `.commit` / `.serialize` / `isPartyDbRequest` — `src/server/core.ts`, the composable core for a host that can't subclass (`docs/architecture.md` §15)
- `authHooks(authorize)` / `bearer(req)` / `getTokenFromRequest(req)` — `src/server/auth.ts`
- `buildPlans` / `structuredStmt` / `blobStmt` / `resolveStructured` / `resolvedOpJsonExpr` / `oplogInsertStmt` / `toPg` — `src/server/statements.ts`
- `assertIdent` / `columnsOf` / `encode` / `decodeRow` / `pgEncode` / `pgDecodeRow` — `src/server/columns.ts`
- `SqliteAdapter` / `D1Adapter` / `PgAdapter` — each implements `init` / `write` / `snapshot` / `replaySince`;
  `PgAdapter` adds `classifyError` and `verifyAnonRole`
- `warnUnenforcedAccess` / `unenforcedAccessCollections` — `src/server/access.ts`

## Commands

| Command | Runs |
| --- | --- |
| `pnpm test` | fast node unit suite (`test/*.test.ts`) — no external service |
| `pnpm test:integration` | the real DO, SQLite, and WebSocket path inside workerd (`test/integration/`) |
| `pnpm test:pg` | Postgres driver lane (`test/pg/`) — skips unless `PG_URL` is set |
| `pnpm typecheck` | three tsconfigs: client, server, integration |
| `pnpm build` | client and server builds into `dist/` |
| `cd <example> && pnpm typecheck` | one example's two halves: browser tsconfig + workers tsconfig |
| `cd <example> && pnpm build` | that example's site (vite) — run before `build:worker`, which needs `dist/` |
| `cd <example> && pnpm build:worker` | bundles that example's worker exactly as a deploy would, without deploying |

There is no lint gate yet (plan 012 is TODO). The `test:pg` lane and `test/integration/pg-connect.test.ts`
need a real Postgres at `PG_URL`; without it they skip, so `pnpm test` stays green with no Docker.
The README's Testing section has the `docker run` line CI uses.

**The examples are the userspace gate.** Nothing in `test/` sits outside the public surface,
so the four example apps are the only thing that compiles party-db the way an app does —
importing it from `../../src`. CI typechecks AND builds all four (the `examples` job);
v0.0.2 shipped a broken `example-react-polyglot` because it did neither. Typecheck catches
the source; the two builds catch what tsc never reads — `vite.config.ts`, `wrangler.jsonc`,
and how a dependency resolves for the browser and for the workers runtime. Two rules when you touch them: run BOTH
installs (root first, then the example — an example resolves its own deps, but the `../../src`
files it imports resolve theirs from the ROOT `node_modules`), and keep every example inside
the library's declared `peerDependencies`. An example pinned outside that range is an example
built against a party-db nobody can install.

## Writing style for Humans

Applies to every string a human reads: chat, commit messages, PR bodies, code
comments, UI copy, errors, docs.

- **One word per meaning.** One action, one verb, everywhere — button, toast, error, docs, commit message.
- **Say which one you mean.** "The Vite build", not "the build" — even when there's only one build.
- **Active voice, simple tense, one claim per sentence.** Under ~25 words. Lists for 3+ steps.
- **Condition before consequence.** "If the deck is empty, the button stays disabled."
- **Name the specific thing.** "Deck saved" beats "Success"; "Keep editing" beats "OK". Cut "please", "simply", "just".
- **Match the channel.** A commit says why. A code comment says only what a cold maintainer needs. UI copy uses the user's words, never the codebase's.
- **No hype, no flattery, no dunking.** State the observation and stop.
- **Hedge honestly.** Say when you don't know. Mark estimates "≈". Report failures with the output.
- **State the options and recommend one** when the decision is mine. Don't settle it silently.
