# Plan 015: Postgres test harness — a real PG in CI, reachable from workerd

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 558508f..HEAD -- .github/workflows package.json vitest.integration.config.ts test`
> If a Postgres harness already exists in any form, reconcile before
> proceeding.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW (tooling only; the one unknown is workerd → local-TCP reachability)
- **Depends on**: none
- **Category**: tests / dx
- **Planned at**: commit `558508f`, 2026-07-10

## Why this matters

Nothing Postgres ships without a real Postgres to test against — the sqlite
story was built on `node:sqlite` + miniflare, and Postgres has no equivalent
in-process stand-in (PGlite exists but doesn't speak the replication protocol
we'll eventually need, and its SQL surface differs enough to lie to us). This
plan puts a disposable PG in CI and local dev, proves the two access lanes plan
016 needs (node-side for fast adapter tests, workerd-side for the real DO
path), and records the facts 016 must not guess at: driver choice, constraint
error shape, type round-trips.

`wal_level=logical` is on from day one — it costs nothing and the v2 WAL story
(`docs/postgres-todo.md`) needs it; provisioning it now means the eventual
replication work changes no infrastructure.

## Current state

- `.github/workflows/ci.yml` — single `check` job (typecheck/build/test/
  integration/pack dry-run) on Node 22; no service containers.
- `vitest.integration.config.ts` — `cloudflareTest` plugin, miniflare with
  `durableObjects` + `d1Databases` bindings; `nodejs_compat` already enabled.
- `package.json` scripts: `test` (node unit), `test:integration` (workerd).
  Contributors without docker must keep getting green runs from both.
- No PG driver in devDependencies. Candidates, both documented by Cloudflare as
  Workers-compatible under `nodejs_compat`: `postgres` (postgres.js) and `pg`
  (node-postgres). Verify against the *installed* versions' docs during the
  spike, not memory.
- Facts to record for plan 016 (in this plan's final report AND as assertions
  in the smoke tests):
  - constraint-violation error shape from the chosen driver(s): SQLSTATE in
    `code` (`23505` unique, `23503` FK, `23502` not-null, `23514` check) and
    the violated constraint's *name* (pg exposes `constraint`); this replaces
    the sqlite message-regex approach entirely.
  - type round-trips for the column kinds `columns.ts` knows: boolean (native
    bool, not 0/1), json/jsonb (driver may parse for you), integers/serials
    (bigint columns may come back as strings — record what happens).

## Commands you will need

| Purpose   | Command                  | Expected on success |
|-----------|--------------------------|---------------------|
| Unit      | `pnpm test`              | all pass, with or without a PG running |
| Workerd   | `pnpm test:integration`  | all pass, with or without a PG running |
| PG lanes  | `pnpm test:pg` (created here) | all pass when PG is up; clear skip message when not |

## Scope

**In scope**:
- `.github/workflows/ci.yml` — a `postgres` service container
  (`postgres:17-alpine` or current, `wal_level=logical` via command args,
  healthcheck) + a `pnpm test:pg` step
- `package.json` — the PG driver devDependency chosen by the spike; `test:pg`
  script; a documented one-liner for local PG (`docker run …`) in the script
  or a README note
- `test/pg/` (create) — the node-lane smoke tests
- `test/integration/pg-connect.test.ts` (create) — the workerd-lane
  connectivity spike
- `vitest.integration.config.ts` / a new `vitest.pg.config.ts` — whatever
  wiring the two lanes need; keep the existing suites untouched

**Out of scope**:
- `src/**` — no adapter code; that's plan 016. If proving connectivity seems
  to need `src` changes, STOP.
- Hyperdrive — production connection story, documented in 016; tests connect
  directly.
- Any replication/WAL usage beyond setting `wal_level=logical`.

## Git workflow

- Branch: `advisor/015-postgres-harness`
- Commit style: `test(pg): real Postgres harness in CI + workerd connectivity spike`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: CI service + local one-liner

Add the service container to `ci.yml` (command args for `wal_level=logical`,
healthcheck gating the test step) and expose its URL to the suites as
`PG_URL`. Document the local equivalent (one `docker run` line) where a
contributor will find it.

**Verify**: CI config lints; locally, the documented one-liner yields a PG
that `psql`/a driver can reach, and `SHOW wal_level` says `logical`.

### Step 2: The node lane + skip discipline

`test/pg/*.test.ts`, run by `pnpm test:pg` — suites that `describe.skipIf`
(or equivalent) cleanly when `PG_URL` is unset, so `pnpm test` and plain
contributor runs never fail for want of docker. Smoke coverage, chosen to
answer 016's questions rather than to be exhaustive:

1. connect / `SELECT 1`
2. DDL a temp table (serial PK, boolean, jsonb, text with a UNIQUE and a CHECK)
3. `INSERT … RETURNING *` — assert the resolved row's JS types per column kind
   (record what the driver hands back for each)
4. duplicate key → assert `code === '23505'` and the constraint *name* is
   present on the error; likewise one CHECK violation
5. transaction rollback: BEGIN → insert → violate → ROLLBACK → row absent

**Verify**: `pnpm test:pg` green with PG up; skips (not fails) without it;
`pnpm test` unchanged either way.

### Step 3: The workerd lane — can the pool reach PG?

The genuinely uncertain premise: a DO under `@cloudflare/vitest-pool-workers`
opening a TCP connection to the CI/local PG. Write
`test/integration/pg-connect.test.ts`: a test-only endpoint on a fixture
worker that connects with the candidate driver (start with `postgres`;
fall back to `pg`; check each one's Workers guidance for the installed
version) and runs `SELECT 1` + one parameterized `INSERT … RETURNING`.
Pass `PG_URL` through miniflare bindings; `skipIf` unset, same as the node
lane.

Record in your report: which driver worked under workerd, any flags or socket
quirks (TLS off for local, `connect()` behavior), and any difference from the
node lane's error shapes.

**Verify**: `pnpm test:integration` green with and without PG (skip, not
fail); with PG up, the connectivity test passes in CI too.

## Test plan

The smoke tests ARE the deliverable, plus CI proving both lanes. Full gate:
`pnpm typecheck && pnpm test && pnpm test:integration && pnpm test:pg` green
in CI.

## Done criteria

- [ ] CI runs a `wal_level=logical` Postgres and `pnpm test:pg` against it
- [ ] Node lane answers 016's questions: error `code`/`constraint` shape and per-kind type round-trips, asserted in tests
- [ ] Workerd lane proves DO→PG connectivity with a named driver, or STOPped with findings
- [ ] All suites skip cleanly (never fail) when `PG_URL` is unset
- [ ] Only in-scope files modified; `plans/README.md` updated; report records driver choice + facts for 016

## STOP conditions

- Neither candidate driver can open a connection from inside the workers pool
  (report exactly what failed — 016's integration lane depends on this answer;
  its adapter can still proceed on the node lane, but that's a scope decision
  for the maintainer).
- The pool cannot pass `PG_URL` through to the worker under test.
- Constraint errors arrive without SQLSTATE `code` on the error object —
  report the actual shape before 016 designs classification around it.

## Maintenance notes

- Keep the PG version pinned in one place (CI + the local one-liner) so
  recorded facts stay reproducible.
- When the WAL work starts, this same container serves it — slots/publications
  need only `wal_level=logical`, already set.
- If CI minutes suffer, the PG lanes can move to a separate job that runs in
  parallel with `check`.
