# Plan 006: Return constraint verdicts faithfully, stop echoing internal errors

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 3779114..HEAD -- src/server/party-db-server.ts test/integration src/client/errors.ts`
> Plans 001–005 are expected drift in these files; confirm the catch block
> below still returns `messageOf(e)` for every failure before proceeding.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: plans/002-fix-one-row-cursor-drift.md (it removes one class of
  spurious throw from this catch; land it first so this plan's tests aren't
  entangled with that bug)
- **Category**: security
- **Planned at**: commit `3779114`, 2026-07-08

## Why this matters

The write handler wraps the entire `adapter.write` call in one catch that returns
`e.message` verbatim to the client as a 409. The decision docs bless reporting the
*database's constraint verdict* faithfully ("which constraint, which row" —
`docs/sqlite-do-todo.md`, constraint-error reporting item). But the un-narrowed
catch also echoes **non-constraint internals** — `no such table: todos`,
`no such column`, adapter bugs — to any writer, leaking schema details, and labels
genuine 500-class faults as 409 "your write was rejected" verdicts that make the
client roll back as if the data were at fault. Narrow it: constraint verdicts keep
their faithful message and 409; everything else becomes a generic 500 with the
detail logged server-side.

## Current state

- `src/server/party-db-server.ts:106-126` — the catch and the helpers below it:

  ```ts
  return this.serialize(async () => {
    let sequenced: SequencedBatch[]
    try {
      sequenced = await this.adapter.write(body)
    } catch (e) {
      // the database rejected the commit (a constraint, a missing table, …).
      // Hand the verdict back so the client can roll back and report it, not a
      // bare 500.
      return Response.json({ error: messageOf(e), ...constraintOf(e) } satisfies WriteReject, { status: 409 })
    }
    …
  ```

  ```ts
  // party-db-server.ts:139-148
  function messageOf(e: unknown): string {
    return e instanceof Error ? e.message : String(e)
  }

  // best-effort: pull the offending constraint out of a SQLite error message like
  // "UNIQUE constraint failed: todos.id". Absent on non-constraint errors.
  function constraintOf(e: unknown): { constraint?: string } {
    const m = /(\w+) constraint failed: ([^\s]+)/i.exec(messageOf(e))
    return m ? { constraint: `${m[1].toUpperCase()}: ${m[2]}` } : {}
  }
  ```

- SQLite constraint failures reliably contain the substring `constraint failed`
  (e.g. `UNIQUE constraint failed: todos.id`, `NOT NULL constraint failed: todos.text`,
  `FOREIGN KEY constraint failed`, `CHECK constraint failed: …`). Also relevant:
  `applyOne` throws plain `Error('unknown channel: …')` (`src/server/sqlite-adapter.ts:114`)
  — but `onRequest` pre-validates channels at `:98-104`, so reaching that from the
  catch means server misconfiguration, i.e. 500 class.

- Existing tests asserting current behavior (they'll guide the split):
  - `test/integration/sync.test.ts:111-119` — duplicate PK → 409, `body.constraint`
    matches `/todos/`, `body.error` truthy. **Must keep passing** (constraint path
    unchanged).
  - Client-side: `WriteError` (`src/client/errors.ts:22-34`) carries any non-ok
    status; `toWriteReject` (`:52-61`) tolerates non-JSON bodies. A 500 with a
    JSON `WriteReject` body needs **no client change**.

- Logging convention: `src/` currently has zero `console.*` calls. Use
  `console.error` for the server-side detail — in Workers this lands in
  `wrangler tail`/observability; it's the platform-idiomatic choice and the first
  intentional log line in the library, so give it a clear prefix, e.g.
  `console.error('party-db write failed:', e)`.

## Commands you will need

| Purpose   | Command                  | Expected on success |
|-----------|--------------------------|---------------------|
| Typecheck | `pnpm typecheck`         | exit 0              |
| Unit tests | `pnpm test`             | all pass            |
| Integration | `pnpm test:integration` | all pass           |

## Scope

**In scope**:
- `src/server/party-db-server.ts` — the catch block + a small `isConstraintError`
  helper next to `constraintOf`
- `test/integration/` — one new test (internal error → 500 generic)

**Out of scope**:
- `src/client/errors.ts` — the client taxonomy already handles any status; don't touch.
- `constraintOf`'s regex — its capture behavior ("NULL" for NOT NULL) is
  best-effort by design; improving it is cosmetic and not this plan.
- Structured server logging / log levels — one `console.error` is the agreed scope.

## Git workflow

- Branch: `advisor/006-narrow-write-errors`
- Commit style: `fix(server): 409 only for constraint verdicts; internals become a generic 500`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Split the catch

Add next to `constraintOf`:

```ts
// SQLite phrases every constraint rejection with this substring; anything else
// coming out of the adapter is an internal fault, not a data verdict.
function isConstraintError(e: unknown): boolean {
  return /constraint failed/i.test(messageOf(e))
}
```

In the catch: constraint errors keep the existing faithful 409 response verbatim;
everything else logs the real error (`console.error('party-db write failed:', e)`)
and returns `Response.json({ error: 'internal error applying write' } satisfies WriteReject, { status: 500 })`.
Update the comment above the catch to describe the split.

**Verify**: `pnpm typecheck && pnpm test` → green;
`pnpm test:integration` → the existing duplicate-PK 409 test still passes.

### Step 2: Test the 500 path

Integration test (model on the rejection block in `sync.test.ts`): the easiest
reliably-internal failure is a write to a structured collection whose table does
not exist. The `Main` worker creates `todos` in `onStart`, so add a second
structured collection to the test worker that has a schema but **no** CREATE TABLE
(e.g. `definePartyCollection({ name: 'untabled', key: 'id', schema: z.object({ id: z.string() }) })`
in `test/integration/worker.ts`), then POST an insert to `untabled` and assert:
- status **500**,
- `body.error` is the generic message — assert it does **not** contain `untabled`
  or `no such table` (that's the leak this plan removes),
- a subsequent write to `todos` still succeeds.

Adding the collection to `worker.ts` is an in-scope-adjacent edit — it's test
fixture, allowed. Check whether any existing test does a full-room snapshot
assertion that the new empty channel would perturb (e.g. counts of snapshot
batches in `sync.test.ts:31-61` — the fresh-connect snapshot will now include an
`untabled` batch)… **it will**: `snapshot()` emits one batch per collection.
Prefer a *separate DO class* (`class Faulty extends PartyDbServer` with only the
untabled collection) plus a binding in `vitest.integration.config.ts`, and route
to it with `partyUrl('faulty', room)` — this keeps `Main`'s snapshot shape stable.
`vitest.integration.config.ts` edit is therefore in scope for the fixture binding.

**Verify**: `pnpm test:integration` → all pass, including the new 500 test and all
pre-existing snapshot-shape tests.

## Test plan

Step 2, plus the untouched 409 constraint test as the regression guard. Full gate:
`pnpm typecheck && pnpm test && pnpm test:integration`.

## Done criteria

- [ ] Constraint violation → 409 with faithful `error` + `constraint` (existing test green, unchanged)
- [ ] Missing-table write → 500 with generic `error` not containing the table name (new test)
- [ ] The real error is `console.error`'d server-side (visible in the diff)
- [ ] All suites green; only in-scope files (+ the two test fixtures) modified; `plans/README.md` updated

## STOP conditions

- The duplicate-PK integration test starts failing — the constraint branch broke.
- workerd's SQLite phrases constraint errors without `constraint failed`
  (evidence: the 409 test passes today with `body.constraint` matching, so this
  should not happen — if it does, report the actual message text).
- You find the client (`toWriteReject`/`WriteError`) mishandling the 500 body —
  client is out of scope; report instead of fixing.

## Maintenance notes

- If a future adapter (D1, Postgres) phrases constraint errors differently,
  `isConstraintError` is the single place to extend — consider moving the
  classification *into* the `PersistenceAdapter` contract at that point (each
  adapter knows its own engine's phrasing).
- Reviewer: check the generic 500 message stays generic — no interpolation of
  channel/table names into it.
