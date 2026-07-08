# Finishing the RDBMS, SQLite, Durable Object story

We have completed version 0, and are now working toward version 1 (the first
version I actually want to use in an actual app).

Version 0 was enough to make these example apps work, and to connect the
Tanstack DB collections over a PartyServer on a Durable Object. The DB collection
is the entire API surface for all reads and writes, and the server handles
them transparently with zero code and zero config. That was a good POC.

Next, v1 is meant to work in the same Durable Object/PartyKit environment, but
on a DO that has its own SQLite database that holds the authority on the data,
provides the canonical order for the stream, and enables complete backfill/
catchup -- in other words, it's the first version I actually want to use in a
project!

- Tanstack DB collection operations on clients are the entire API
- User performance about as good as the laws of physics currently allow
- DX that handles all server logic, mutations, and realtime connection with less
config than a `queryCollection`: no `queryFns`, no `onUpdate`


---

## Where we are — conformance to architecture.md

Status tags: ✅ done · 🟡 partial · ❌ missing. Priorities: **P0** blocks "done",
**P1** needed for real use, **P2** polish.

| § | Decision | Status | Note |
| --- | --- | --- | --- |
| 0 | DX: `definePartyCollection` / `PartyDbServer` / `createPartyDb` | ✅ | `src/client/*`, `src/server/party-db-server.ts`, example apps run |
| 1 | One mode: DO-controlled | ✅ | WS down + `POST /write` up, DO SQLite |
| 2 | Wire = `WriteEvent = Omit<ChangeMessage,'key'>` | ✅ | `src/protocol.ts` |
| 3 | Multiplex by `channel` | ✅ | `SyncClient` registry; server keys tables by channel |
| 4 | Shared wire types + apply contract; per-target apply code | ✅ | client applies via `applyBatch` (`src/client/apply.ts`); server via `SqliteAdapter` behind the `PersistenceAdapter` seam |
| 5 | **Persist into structured tables reflecting your schema** | ✅ | `SqliteAdapter.applyStructured` does CRUD against your real columns + `RETURNING`; blob fallback kept for schema-less collections (v0 opt-out). We never DDL your tables — you bring them. |
| 6 | `seq` from `_oplog` AUTOINCREMENT via `RETURNING` | ✅ | `SqliteAdapter.applyOne` (mechanism is independent of the storage model) |
| 7 | optimistic → ack → settlement (`waitForSeq`) | ✅ | settlement + resolved-row swap: the server now streams the **resolved** rows (defaults/generated/serial) and echoes them in `WriteAck.changed`; the client's existing settlement drops the overlay onto them (flicker-free for client-minted keys; serial-PK key change is the documented nuance) |
| 8 | reconnect = delta via `?since` | ✅ | `partyTransport` query + adapter `replaySince`/`snapshot` (oplog stores resolved ops, so the delta replays resolved rows); see oplog-lifecycle gaps |
| 9 | broadcast inline, after commit, before responding | ✅ | `onRequest` |
| 10 | schemas shared by import | ✅ | one `{name,key,schema}` interface in `src/schema.ts`, imported both sides (no `TableDef`); the server reads the column allowlist + value codec from it |
| 11 | `persist` binding; x-collection atomicity via TanStack | ✅ | server commits whole POST atomically + writer settles on all seqs; subscribers receive the writes ordered by `seq` |
| 12 | authority is the database, not TanStack DB | ✅ | server sink is `ctx.storage.sql` (a real DB, not a TanStack cache) |

---

## The list

> Practical ordering: do **item 2 (tooling)** first so you can build item 1 with
> tests. But item 1 is the *point* — it's what "finish the SQLite story" means.

### 1. ✅ Structured RDBMS tables — **P0**

- [x] **Use the same client DB schema on the server.** Zod schemas are already used
      on the client to validate inserts and updated in to the Tanstack Collections.
      On the server they are just a very quick validator. Projects come with their
      own database and types/schemas, we extrapolate the rest. Server and client
      collections **share one interface** — `{ name, key, schema }`, defined once
      and imported on both sides.
- [x] **CRUD against typed columns** in `applyOne` (insert/update/delete into real
      columns), replacing the blob upsert. `SqliteAdapter.applyStructured`: distinct
      `INSERT`/`UPDATE`/`DELETE` (not a blanket upsert) so constraints get to judge;
      `INSERT`/`UPDATE` capture the committed row with `RETURNING *`.
- [x] **Extract a `PersistenceAdapter` seam (embedded DO-SQLite or D1).** Pull the
      apply step out of `applyOne` behind an interface — `apply(op, schema) → resolved
      row` — so `onRequest` calls it blind to the target, whether it's the v0 blob
		(v0), SQLite on the Durable Object (v1), or a call over the network to another
		database (D1 and Postgres, coming up soon). `batch()` for the atomic POST. The
		DO serializes its write → `seq` → broadcast section to maintain ordering.
		**Limitation:** Both targets capture via `RETURNING` (what `/write` commits), not
      a change feed: changes that come in via cronjobs, trigger effects, or other APIs
		can't be captured yet — stay tuned for v2's WAL story.
      *Landed:* `PersistenceAdapter` (`src/server/persistence.ts`) with `init`/`write`/
      `snapshot`/`replaySince`, all async; `SqliteAdapter` over a narrow `SqlEngine`
      seam (so it unit-tests against `node:sqlite`, no miniflare); `onRequest` is now
      blind to the target and serializes its write→seq→broadcast section via a promise
      queue (D1-ready). Swap targets by overriding `PartyDbServer.createAdapter()`.
- [x] **The database is the authority.** A write is a genuine transactional commit
      the DB's constraints can reject; rejection fails the POST (client optimistic
      rollback), success *is* the acceptance. The server applies the batch in the
      order given, in one transaction. Zod may run server-side as a cheap *error-
		sooner* gate, but the commit authority is still the database itself. *Landed:*
		whole POST in one transaction; a rejection rolls the lot back (tested: a valid
		batch + a failing batch ⇒ neither survives). Zod is not run server-side yet —
		noted below as the one remaining error-sooner gate.
- [x] **Injection-safe by construction.** Bind every *value* with `?` (the current
      code already does this for keys/data/etc.). Take every *identifier* — table
      and column names — from the schema/config allowlist, validated against
      `^[A-Za-z_][A-Za-z0-9_]*$`, **never** from the client payload's keys (build
      column lists from the Zod schema, not `Object.keys(row)`). Tiny surface — a
      handful of statements. *Landed:* `assertIdent` + `columnsOf` (`src/server/
      columns.ts`); the insert/update column list is the schema allowlist filtered to
      present values, so a smuggled payload key is silently ignored (tested).
- [x] **Resolved-row reconciliation (mandatory).** The committed row can differ
      from the sent row (defaults, generated columns, serials, trigger effects).
      Return the resolved row (`WriteAck.changed` + on the stream) and have the
      client swap its optimistic overlay for it, completing §7. *Landed:* the adapter
      returns resolved ops; `onRequest` broadcasts them and sets `WriteAck.changed`;
      the oplog stores resolved ops so reconnect deltas replay them too. The client's
      existing `waitForSeq` settlement drops the overlay onto the resolved row — clean
      for client-minted keys; for a serial PK the key changes, so the swap-by-key
      nuance is noted (UUIDs stay the easy default).
- [x] **Serial / db-assigned PKs.** Falls out of resolved rows — support it instead
      of forbidding it. (Client-minted UUIDs stay the easy default.) *Landed:* a
      column the client omits isn't named in the INSERT, so an `INTEGER PRIMARY KEY
      AUTOINCREMENT` is assigned and comes back via `RETURNING` (tested).
- [x] **Constraint-error reporting.** Surface a DB rejection cleanly to the
      mutating client (which constraint, which row), not a bare 500 — the app can't
      be made to change how it constrains data, so we report its verdict faithfully.
      *Landed:* a rejected commit returns `409` with a `WriteReject` body (`error` +
      best-effort `constraint`/`channel`); the transport already throws on non-ok, so
      TanStack rolls the optimistic mutation back.

### 2. Project tooling & tests — **P0** (nothing exists; the foundation)

You currently cannot typecheck or test the package in isolation.

- [x] **Installable dev deps / workspace** so `pnpm typecheck` passes on a clean
      checkout. Done: `devDependencies` (typescript, vitest, `@cloudflare/workers-types`)
      added; client and server are split into `tsconfig.client.json` (DOM lib) and
      `tsconfig.server.json` (Workers types) since they can't share one lib/types set,
      and `pnpm typecheck` runs both. Fixed the real type errors along the way: the
      `WriteEvent`/`WriteBatch`/`SequencedBatch` generics now carry `ChangeMessage`'s
      `object` constraint, `PartyDbServer`'s `Env` is constrained to `Cloudflare.Env`,
      and the private SQLite getter was renamed `db` so it stops shadowing the base
      `Server.sql` tagged-template helper.
- [x] **Test runner** (vitest). `vitest.config.ts`, `pnpm test` / `pnpm test:watch`.
- [x] **Unit tests:** `applyBatch` (`src/client/apply.ts`); `SyncClient` routing /
      `pending` buffer / `waitForSeq` / high-water mark; `persist` grouping
      (`toEvent`, by-channel split); `partyTransport` `since`/`lastSeq` tracking.
      32 tests in `test/`.
- [x] *(optional enabler)* Export `makePersist(client)` from `collection.ts` — done;
      its `client` param is now `Pick<SyncClient, 'send' | 'waitForSeq'>` so the write
      path tests run against a two-method stub, no transport. `toEvent` exported too.
- [x] **Server tests:** structured CRUD (insert/update/delete + constraint
      rejection + resolved row, incl. defaults/serials/boolean+json round-trip) +
      oplog seq; multi-batch atomic commit (one failing batch rolls back the rest);
      `snapshot` vs `replaySince`; blob fallback; injection safety. 28 tests across
      `test/columns.test.ts` + `test/sqlite-adapter.test.ts`, run against a real
      engine via `node:sqlite` (no miniflare). The `onRequest` HTTP envelope is
      covered end-to-end by the integration test below.
- [x] **Integration test** (workers/miniflare pool): a real PartyDbServer on a real
      SQLite Durable Object, driven over HTTP + WebSocket. Covers round-trip insert →
      ack (with the **resolved** row) → broadcast → a fresh client seeing the resolved
      row in its snapshot; reconnect delta (`?since=N` replays exactly the gap, no
      `ready`); broadcast order == seq order under concurrent POSTs; and the POST
      envelope (unknown-channel 400, constraint 409, malformed-body 400, non-POST 404).
      7 tests in `test/integration/sync.test.ts` via `@cloudflare/vitest-pool-workers`
      (`pnpm test:integration`, wired into CI). On vitest 4 + pool `0.16`, configured
      with the `cloudflareTest` Vite plugin (the `defineWorkersConfig`/`poolOptions`
      shape is gone). Note: under miniflare `ctx.id.name` isn't exposed, so the tests
      pass partyserver's `x-partykit-room` fallback header.
- [x] **CI** running typecheck + node tests + the workers integration suite
      (`.github/workflows/ci.yml`: `pnpm install --frozen-lockfile` → `typecheck`
      → `test` → `test:integration`).

### 3. Oplog lifecycle — **P1** ✅ (landed)

- [x] **Retention/compaction** of `_oplog`. `SqliteAdapter` takes an `oplogRetention`
      (rows) option — surfaced as `PartyDbServer.oplogRetention` — and compacts to the
      most recent N rows inside the write transaction (so the floor is never torn).
      Unset → unbounded (v0 behavior). Rows-based, not age: `since` is a seq cursor, so
      a row count is the natural, deterministic knob; age would need a `ts` column +
      migration for no real gain here. AUTOINCREMENT keeps seqs monotonic across
      compaction (never reused), so the survivors stay a contiguous suffix.
- [x] **`since`-floor fallback:** `replaySince` now returns `null` when the cursor
      predates the oldest retained seq (the entries between are gone); `onConnect` then
      sends a **fresh snapshot** instead of a gappy delta. An empty array stays a
      *complete* delta (caught up), distinct from `null` (too old). Boundary tested:
      a cursor at exactly `oldest − 1` still gets a delta.
- [x] Lock the snapshot/seq consistency with a test: `snapshot` now reads the
      watermark + every table inside one transaction (a consistent cut), and a test
      asserts the reported `seq` is the head of the same oplog whose fold reconstructs
      the snapshot's rows — so a future `await` slipped mid-snapshot would be caught.

> *Tests:* 10 in `test/oplog-lifecycle.test.ts` (compaction, monotonic seq, floor
> fallback + boundary, empty-delta vs null, snapshot/oplog consistency).

### 4. Robustness / input validation — **P1** ✅ (landed)

- [x] Validate `since` is a non-negative integer; else snapshot. *(Landed alongside
      item 3: `onConnect`'s `cursorParam` rejects `NaN`/negative/non-integer → snapshot
      rather than a `seq > NaN` query that silently returns nothing.)*
- [x] Validate the POST body is actually `WriteBatch[]` before iterating. *(Landed
      with item 1: `onRequest` guards the `JSON.parse` and rejects a non-array body with
      `400` + a `WriteReject`, instead of throwing → 500. Covered by the integration
      test.)*
- [x] **Settlement can hang forever — extract a `SeqTracker` while fixing it.**
      Settlement (the per-channel high-water mark + waiters) is now a pure
      `SeqTracker` (`src/client/seq-tracker.ts`); `SyncClient` holds one and delegates.
      `waitForSeq` takes a **timeout** (`SyncClientOptions.settleTimeoutMs`, default
      30 s, `Infinity` to disable) → a never-arriving seq **rejects** so the mutation
      can roll back/retry instead of hanging; `close()` `rejectAll`s in-flight waiters
      too. The tracker compares **`Cursor`s** through an injectable comparator
      (`compareCursor` default), so string cursors are tracked, not silently dropped —
      a v2 Postgres LSN is "pass a comparator," nothing else. Still waits on the
      *stream*, not the ack (no flicker); reconnect's `?since` remains the real
      re-delivery path, which is what makes the timeout safe.

> *Tests:* 12 in `test/seq-tracker.test.ts` (settlement, high-water vs equality,
> monotonic straggler, per-channel, timeout reject / settle-before-timeout / no-timeout,
> `rejectAll`, default + injected comparator); `SyncClient` string-cursor test updated.

### 5. Auth — **P1** ✅ (landed)

- [x] Auth hook on **socket open** and **POST**: bearer/session, reject
      unauthorized, pluggable so the room owner supplies the check. *Landed:* gated
      at partyserver's **lobby** — the idiomatic Cloudflare/PartyKit layer — not
      inside the DO. `authHooks(authorize)` (`src/server/auth.ts`) builds the
      `onBeforeConnect` / `onBeforeRequest` hooks for `routePartykitRequest` from
      **one** check that gates both doors: `kind: 'connect'` (who can read) and
      `kind: 'write'` (who can POST). Because the hooks run **in the worker before
      the request reaches the DO**, a rejected connect gets a clean **HTTP `401`
      before the WS upgrade** (not an accepted-then-closed socket) and **never
      wakes the object**; a rejected POST returns the owner's status (default
      `401`) + a `WriteReject`, so TanStack rolls the optimistic mutation back like
      any other rejection. `authorize` returns a bare boolean or a rich `{ ok,
      status?, error? }`; a `bearer(req)` convenience is exported. `authorize`
      gets the raw `Request` (so the credential can come from an `Authorization`
      header on the POST or `?token=…` on the WS upgrade, which can't set headers)
      plus an `AuthContext` of partyserver's already-resolved `{ kind, party, room }`
      — so it branches on the structured `party`/`room`, not URL string-matching,
      to gate some parties and leave others open. Client side: `partyTransport({
      token })` carries it — header on the POST, query on the connect. (Auth that
      needs per-room DO *state* is a separate, in-object concern; this seam is for
      stateless credential checks, which is item 5.)

> *Tests:* 8 in `test/auth.test.ts` (`bearer` parsing, and `authHooks` pass/refuse
> on each door, party/room forwarding, decision-shape normalization, non-POST
> fall-through) and 6 in
> `test/integration/auth.test.ts` against a real lobby-gated `guarded` party:
> connect denied → `401` *before* the upgrade (no socket); connect allowed →
> snapshot; POST denied (missing / wrong token) → `401`; POST allowed → `200`; the
> open `main` party still accepts an unauthenticated POST.

### 6. Cross-collection transaction visibility — **decided: ordered on receive**

- [x] **Ordered, not atomic, on the receiving side — no group id, no extra fields.**
      A cross-collection write commits atomically on the server, and the *writer*
      settles on all its seqs; subscribers just receive the constituent writes in
      `seq` order and apply them as they arrive (fine for a feed/chat — a reader
      seeing the post and then its tag, in order, is fine). README overclaim
      corrected.

### 7. DX / packaging polish — **P2** ✅ (landed)

- [x] **Build story: the library now builds to `dist/`.** `exports` point at the
      built output (`./dist/**/*.js` + `.d.ts`), not `.ts` source. `pnpm build`
      runs two `tsc` passes mirroring the existing client(DOM)/server(workers-types)
      split — `tsconfig.build.client.json` + `tsconfig.build.server.json` — emitting
      JS, `.d.ts`, and source/declaration maps. The `.ts` import specifiers are
      rewritten to `.js` in the output via TS 5.7+ `rewriteRelativeImportExtensions`,
      so the source can keep its explicit-extension imports. `main`/`types`/`files`
      added; `prepack` builds before publish; CI runs `pnpm build`. The **examples
      stay source-only** — they import the library by relative path
      (`../../src/client/index.ts`), bypassing the `exports` map, so they don't need
      and don't get a build step.

### 8. Deferred — in scope, not yet built

The v1 transport + persistence story is done; these are the next slice, logged
here (not pushed into the parked v2 WAL/RPC/RLS/slicing story at the top).

- [ ] **D1 adapter — P1.** The seam is already built *for* it: `PersistenceAdapter`
      is async, `onRequest` serializes its write→seq→broadcast section behind a
      promise queue, and capture is via `RETURNING`. What's missing is the
      `D1Adapter` itself — the atomic POST over D1's async `batch()` instead of
      `transactionSync`. This completes v1's "embedded *or* D1," and D1 is the
      first target other consumers can read directly. Swap it in by overriding
      `PartyDbServer.createAdapter()`. *(Benchmarked the async contract this rides
      on: `pnpm bench` — overhead is at/below noise on the embedded path.)*
- [ ] **Server-side Zod gate — P2.** Run each row's shared Zod schema in
      `onRequest` as a cheap *error-sooner* gate — reject malformed writes before
      the DB does — **never** as the correctness authority (the database still
      judges; §1). Today nothing Zod runs server-side; the DB is the only gate.
      *(architecture.md's v1 paragraph currently overclaims this as shipped — fix
      that wording when this lands.)*
- [ ] **Serial / db-assigned PK reconciliation — P2.** The optimistic→resolved
      swap is keyed by `key`; a serial/identity PK *changes* on commit (client
      temp id → db-assigned id), so that path has a documented rough edge (the key
      changes, so the swap-by-key can flicker). UUIDs stay the zero-friction
      default; smooth the serial case by carrying a temp-key → resolved-key remap
      through settlement.
- [ ] **Publish the package — P2.** The build landed (§7); actually shipping it is
      still undone — flip `private: true`, set a real version, publish to a registry.
- [ ] **Name & document the lobby permission surface — P2 (docs/DX).** What
      `authHooks` + `AuthContext` already do (§5) deserves a first-class
      "customize room permissions" / "lobby options" story, not to be left buried
      in the auth source. One stateless `authorize(req, ctx)` at the lobby (in the
      worker, before the DO) already lets you do per-room decisions by *identity*:
      - gate by `kind` — reads open, writes token-gated (the rdbms example);
      - gate by `party` — lock down `PrivateRoom`, leave `main` open;
      - gate by `room` name — e.g. rooms named `private-*` require a token;
      - and the check can be **async and call out** — verify a JWT, hit an auth
        API, or look up membership in an *external* database.
