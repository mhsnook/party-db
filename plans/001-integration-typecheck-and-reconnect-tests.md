# Plan 001: Typecheck the integration suite and cover the reconnect fallback branches

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 3779114..HEAD -- tsconfig.client.json tsconfig.json package.json .github/workflows/ci.yml test/integration src/server/party-db-server.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW
- **Depends on**: none
- **Category**: tests / dx
- **Planned at**: commit `3779114`, 2026-07-08

## Why this matters

The integration tests (`test/integration/*.ts`) are real Durable Object + WebSocket
code, but they are never typechecked: `pnpm typecheck` runs only the client and server
tsconfigs, and a comment in `tsconfig.client.json` claims the integration suite "is
typechecked by its own tsconfig" — **no such tsconfig exists**. Separately, two
correctness-critical reconnect branches in `PartyDbServer.onConnect` never execute in
any test: the "your `?since` cursor predates the compacted oplog → send a fresh
snapshot" fallback, and the "garbage `?since` → snapshot" guard. This plan fixes the
typecheck gap and adds integration tests for those branches. Later plans (002, 003,
004) add integration tests of their own and rely on this scaffolding being sound.

## Current state

- `tsconfig.client.json` — excludes the integration suite with a false comment:

  ```jsonc
  // tsconfig.client.json:7-12
  "include": ["src/client", "src/protocol.ts", "src/schema.ts", "src/index.ts", "test"],
  // the integration suite targets the workers runtime (cloudflare:test, DO types)
  // which clashes with this DOM/node config; it's typechecked by its own tsconfig.
  // the benchmarks use node APIs (node:sqlite, process) absent from this DOM/no-types
  // config; they're run, not typechecked (`pnpm bench`).
  "exclude": ["test/integration", "test/bench"]
  ```

- `tsconfig.json` — project references list only client + server:

  ```json
  { "files": [], "references": [{ "path": "./tsconfig.client.json" }, { "path": "./tsconfig.server.json" }] }
  ```

- `tsconfig.server.json` — the pattern to model the new config on:

  ```json
  {
    "extends": "./tsconfig.base.json",
    "compilerOptions": { "lib": ["ES2022"], "types": ["@cloudflare/workers-types"] },
    "include": ["src/server", "src/protocol.ts", "src/schema.ts"]
  }
  ```

- `package.json:51` — `"typecheck": "tsc -p tsconfig.client.json && tsc -p tsconfig.server.json"`
- `.github/workflows/ci.yml` — runs `pnpm typecheck`, `pnpm build`, `pnpm test`, `pnpm test:integration` on Node 22.
- `test/integration/worker.ts:19-35` — the worker under test declares `oplogRetention = 50`
  and a structured `todos` collection with a `CREATE TABLE IF NOT EXISTS todos (...)` in
  `onStart`. No existing test writes more than a handful of rows, so compaction never
  triggers and the snapshot-fallback branch never runs.
- `src/server/party-db-server.ts:76-81` — the branches to cover:

  ```ts
  async onConnect(conn: Connection, ctx: ConnectionContext) {
    const cursor = cursorParam(new URL(ctx.request.url).searchParams.get('since'))
    const delta = cursor === null ? null : await this.adapter.replaySince(cursor)
    const batches = delta ?? (await this.adapter.snapshot())
    for (const b of batches) this.send(conn, b)
  }
  ```

  and `cursorParam` at `:133-137` maps missing/NaN/negative/non-integer → `null` → snapshot.

- `src/server/sqlite-adapter.ts:212-221` — `replaySince` returns `null` when
  `min > 0 && since + 1 < min` (cursor fell off the retained window). The adapter-level
  behavior is unit-tested in `test/oplog-lifecycle.test.ts`; the `onConnect` wiring is not.
- Integration test conventions: model new tests on `test/integration/sync.test.ts`
  (uses `SELF.fetch`, the `connect(room, since?)`/`post(room, body)` helpers, distinct
  room name per test so each DO starts empty, `vi.waitFor` for batch arrival).
  Shared fixtures live in `test/integration/helpers.ts` (`partyUrl`, `roomHeader`, `insert`).
- Repo conventions: comment-rich narrative style; commit messages like
  `test(integration): …` / `chore: …` (see `git log --oneline`).

## Commands you will need

| Purpose   | Command                  | Expected on success |
|-----------|--------------------------|---------------------|
| Install   | `pnpm install --frozen-lockfile` | exit 0      |
| Typecheck | `pnpm typecheck`         | exit 0, no errors   |
| Unit tests | `pnpm test`             | all pass (100 today) |
| Integration | `pnpm test:integration` | all pass           |

## Scope

**In scope** (the only files you should modify/create):
- `tsconfig.integration.json` (create)
- `tsconfig.json` (add reference)
- `tsconfig.client.json` (fix the stale comment only)
- `tsconfig.build.client.json` (fix the same stale comment if present there)
- `package.json` (extend the `typecheck` script)
- `test/integration/reconnect.test.ts` (create)

**Out of scope** (do NOT touch, even though they look related):
- `src/**` — no production code changes in this plan. If typechecking the integration
  suite surfaces errors in `src/`, that is a STOP condition, not a license to fix them.
- `test/bench` — deliberately run-not-typechecked; leave its exclusion alone.
- `vitest.integration.config.ts` — the pool wiring works; don't restructure it.

## Git workflow

- Branch: `advisor/001-integration-typecheck`
- Commit style: match the repo's conventional prefixes, e.g.
  `test(integration): typecheck the suite + cover reconnect fallbacks`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Create `tsconfig.integration.json`

Model it on `tsconfig.server.json` (shown above). It must cover
`test/integration` and the `src` files the suite imports, with workers types.
The suite imports `cloudflare:test`, whose types come from
`@cloudflare/vitest-pool-workers` — check what that package documents
(`node_modules/@cloudflare/vitest-pool-workers/README.md` or its `types` folder;
the conventional value is `"types": ["@cloudflare/workers-types", "@cloudflare/vitest-pool-workers"]`).
Include `vitest` importable types via moduleResolution Bundler (already inherited
from `tsconfig.base.json`). A starting shape:

```jsonc
{
  "extends": "./tsconfig.base.json",
  "compilerOptions": {
    "lib": ["ES2022"],
    "types": ["@cloudflare/workers-types", "@cloudflare/vitest-pool-workers"]
  },
  "include": ["test/integration", "src/server", "src/protocol.ts", "src/schema.ts"]
}
```

**Verify**: `pnpm exec tsc -p tsconfig.integration.json` → exit 0. If it reports
errors *inside `test/integration/*.ts`*, fix the test files' types (that's the
point of this plan). If it reports errors inside `src/`, STOP.

### Step 2: Wire it into `typecheck`, the root project, and fix the stale comments

- `package.json`: `"typecheck": "tsc -p tsconfig.client.json && tsc -p tsconfig.server.json && tsc -p tsconfig.integration.json"`
- `tsconfig.json`: add `{ "path": "./tsconfig.integration.json" }` to `references`.
- `tsconfig.client.json` (and `tsconfig.build.client.json` if it carries the same
  comment): the comment currently says the integration suite "is typechecked by its
  own tsconfig" — now it actually is; reword so it names `tsconfig.integration.json`.

**Verify**: `pnpm typecheck` → exit 0. CI needs no change (it already calls `pnpm typecheck`).

### Step 3: Add `test/integration/reconnect.test.ts`

Model the file on `test/integration/sync.test.ts` (same imports, same
`connect`/`post` helper shape — either import from `./helpers.ts` and copy the
small `connect` helper, or extract `connect` into `helpers.ts` and update
`sync.test.ts` imports; prefer the extraction so the two files share it).
The worker's retention is 50 (`test/integration/worker.ts:21`). Cover:

1. **Stale cursor → fresh snapshot, not a gappy delta.** In one room, POST >50
   writes (e.g. 60 single-insert batches via the `insert(id, text)` helper — a
   plain `for` loop with `await post(...)` is fine). Then connect with
   `?since=1` (a cursor that predates the retained floor). Assert the first
   received batch has `ready: true` (snapshot marker) and its `ops` contain all
   60 rows — not a delta starting mid-stream.
2. **In-window cursor still gets a delta.** Same room (or a fresh one with a few
   writes): connect with `since` = (max seq − 2) and assert exactly the missed
   batches arrive, with `ready` undefined (mirrors `sync.test.ts`'s existing
   delta test — keep both; this one exercises the boundary just above the floor).
3. **Garbage `?since` → snapshot.** Connect with `?since=abc` and with
   `?since=-5`; in both cases assert the first batch is `ready: true`.

**Verify**: `pnpm test:integration` → all pass, including 3+ new tests.

## Test plan

Covered by Step 3 — the new tests are the deliverable. Also run the full suite:
`pnpm test && pnpm test:integration` → everything green, no existing test modified
except (optionally) `sync.test.ts`'s import line if you extracted `connect`.

## Done criteria

- [ ] `tsconfig.integration.json` exists; `pnpm typecheck` runs it and exits 0
- [ ] `grep -n "its own tsconfig" tsconfig.client.json` names `tsconfig.integration.json` (comment no longer false)
- [ ] `pnpm test:integration` exits 0 and includes tests for: stale-cursor snapshot fallback, garbage `?since`, in-window delta
- [ ] `pnpm test` exits 0 (unit suite untouched)
- [ ] `git status` shows no modified files outside the in-scope list
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- Typechecking `test/integration` surfaces type errors in `src/` files.
- `@cloudflare/vitest-pool-workers` provides no usable ambient types for
  `cloudflare:test` and the import cannot be typed without `any`-casts.
- The stale-cursor test receives a **delta** (not `ready: true`) after 60 writes
  with retention 50 — that would mean the compaction floor logic differs from the
  excerpt above (drift or a live bug); report what you observed.
- A step's verification fails twice after a reasonable fix attempt.

## Maintenance notes

- Plans 002/003/004 add more integration tests; they assume `connect` lives in
  `test/integration/helpers.ts` after this plan (or copy it — check before assuming).
- Reviewers: check the new tsconfig doesn't accidentally pull `test/*.test.ts`
  (unit files) into the workers config — `include` must stay scoped to `test/integration`.
- Deferred: unit tests for `party-db-server.ts` routing logic (no unit test file
  exists for it) — integration coverage was judged sufficient for now.
