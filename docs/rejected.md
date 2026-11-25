# Findings considered and rejected

Decisions the maintainer already made, recorded so nobody re-audits them. Check
this list before proposing a change. Open work lives in
[GitHub issues](https://github.com/mhsnook/party-db/issues).

- **`PersistenceAdapter` as a "premature abstraction".** The seam's async contract
  and the write queue exist for the D1 and Postgres targets
  ([architecture §4](./architecture.md)). Three adapters now implement it.
- **Example-app scaffolding repeated across `example*/`** (identical schemas,
  migrations, tsconfigs). Rejected 2026-07-08: examples and cookbooks are showcases,
  not maintained apps, and cross-example reuse is a non-goal. Elide boilerplate in
  docs instead (`// ... same setup as …`).
- **Snapshot chunking or pagination.** A whole-table snapshot goes out in one
  WebSocket frame. Deferred, not planned: real, but premature at v0 room sizes.
  Revisit when a room-size complaint arrives. The retention default bounds the
  `_oplog`, not snapshots.
- **`constraintOf` captures "NULL" for NOT NULL violations.** Cosmetic. The field
  is best-effort by design.
- **The demo password printed on the example page.** Intentional
  (`example-react-rdbms/src/server.ts`). Only the echo in the 401 body and the
  compare pattern were worth fixing, and both are fixed.
- **Dependency currency.** Reviewed 2026-07-08: devDependencies current, `pnpm audit`
  clean, no migration warranted.
- **Auth is open by default when no `authorize` is configured.** Documented v0
  posture ([architecture §10](./architecture.md)): the library validates nothing
  about your auth.
- **Adopting TanStack DB 0.8 (the SSR release).** Reviewed 2026-08-31: nothing
  blocking, nothing urgent. Its `exportSyncMeta` / `importSyncMeta` and `hydrate`
  hooks are a sanctioned client-side home for our `seq` cursor: render rows on the
  server, then connect with `?since` instead of taking a full `reset` snapshot. The
  server side already exists, so adopt the hooks when something else forces the peer
  range past `^0.6.10`. The bump is not worth it alone. `loadSubset` maturing
  (0.8.4–0.8.5) shaves only the client half of the read-slicing design in
  [`unspecified.md`](./unspecified.md). 0.8.6 fixes Workers module evaluation, which
  we do not hit: the Durable Object imports types only.
