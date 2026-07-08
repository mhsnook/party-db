# Plan 002: Make the update-of-a-missing-row path work on real DO SQLite (`.one()` drift)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 3779114..HEAD -- src/server/sqlite-adapter.ts test/helpers/sql-engine.ts test/sqlite-adapter.test.ts test/integration`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: plans/001-integration-typecheck-and-reconnect-tests.md (integration test conventions)
- **Category**: bug
- **Planned at**: commit `3779114`, 2026-07-08

## Why this matters

`SqliteAdapter.applyStructured` documents that an update of a row that no longer
exists is a **no-op that returns the sent value**. That works in unit tests — but
only because the test shim's `.one()` returns `undefined` on zero rows, while
Cloudflare's real `SqlStorageCursor.one()` **throws** when the result is not exactly
one row. In production, a client updating a row another client just deleted gets a
thrown error → caught in `onRequest` → a `409` that rolls back the client's whole
optimistic transaction, instead of the documented no-op. The unit test
(`test/sqlite-adapter.test.ts:112-119`, "treats an update of a nonexistent row as a
no-op") asserts semantics production doesn't have. This plan fixes the adapter to
not depend on `.one()`'s zero-row behavior, makes the test shim mirror the real
cursor (so this class of drift can't recur), and locks the behavior in with a real
workerd integration test.

## Current state

- `src/server/sqlite-adapter.ts:139-159` — the update path:

  ```ts
  if (op.type === 'update') {
    // SET only the columns the client actually sent (from the allowlist, not
    // the payload keys), keyed by the PK. Untouched columns keep their value.
    const set = plan.cols.filter((c) => c.name !== plan.key && row[c.name] !== undefined)
    const result = set.length
      ? this.engine.exec(
          `UPDATE "${table}" SET ${set.map((c) => `"${c.name}" = ?`).join(', ')} WHERE "${plan.key}" = ? RETURNING *`,
          ...set.map((c) => encode(row[c.name])),
          encode(row[plan.key]),
        )
      : // a no-op update (only the key present): just read the current row back.
        this.engine.exec(`SELECT * FROM "${table}" WHERE "${plan.key}" = ?`, encode(row[plan.key]))
    // if the row didn't exist (UPDATE matched nothing), fall back to the sent
    // value rather than crash — the DB simply applied a no-op.
    const resolved = result.one()
    return {
      type: 'update',
      value: resolved ? decodeRow(resolved, plan.kinds) : row,
      previousValue: op.previousValue,
    }
  }
  ```

  The `resolved ? … : row` fallback is dead code on the real runtime because
  `result.one()` throws first when the UPDATE/SELECT matched zero rows.

- `src/server/sqlite-adapter.ts:23-26` — the `SqlResult` seam:

  ```ts
  export interface SqlResult {
    toArray(): Record<string, unknown>[]
    one(): Record<string, unknown>
  }
  ```

- `test/helpers/sql-engine.ts:12-15` — the shim whose `.one()` is too lenient:

  ```ts
  exec(query: string, ...bindings: unknown[]): SqlResult {
    const rows = db.prepare(query).all(...(bindings as any[])) as Record<string, unknown>[]
    return { toArray: () => rows, one: () => rows[0] }
  }
  ```

- Other `.one()` call sites in the adapter (all guaranteed exactly-one-row —
  aggregates or `INSERT … RETURNING` — and therefore safe to leave on `.one()`):
  - `sqlite-adapter.ts:119-123` — `INSERT INTO _oplog … RETURNING seq`
  - `sqlite-adapter.ts:194` — `SELECT COALESCE(MAX(seq), 0) AS s FROM _oplog`
  - `sqlite-adapter.ts:213` — `SELECT MIN(seq) AS m FROM _oplog`
  - The structured **insert** path at `:163-168` uses `result.one()` after
    `INSERT … RETURNING *` — a successful insert always returns exactly one row
    (a failed one throws from the DB first), so it may stay on `.one()`.

- Reference for the real cursor semantics: Cloudflare Workers `SqlStorageCursor.one()`
  "returns the only row, or throws if the query returned zero or more than one row".
  Confirm the exact behavior in `node_modules/@cloudflare/workers-types` (grep for
  `one()` in the `SqlStorageCursor` interface docs) before relying on the message text.

- Integration test conventions: `test/integration/sync.test.ts` + `helpers.ts`
  (see plan 001). The integration worker's table is `todos (id TEXT PRIMARY KEY, text TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0, rev INTEGER NOT NULL DEFAULT 1)`.

## Commands you will need

| Purpose   | Command                  | Expected on success |
|-----------|--------------------------|---------------------|
| Typecheck | `pnpm typecheck`         | exit 0              |
| Unit tests | `pnpm test`             | all pass            |
| Integration | `pnpm test:integration` | all pass           |

## Scope

**In scope**:
- `src/server/sqlite-adapter.ts` (the update branch only)
- `test/helpers/sql-engine.ts` (strict `.one()`)
- `test/sqlite-adapter.test.ts` (only if a test needs its assertion adjusted — the
  ghost-update test's *asserted behavior* must stay: no-op, sent value returned)
- `test/integration/sync.test.ts` or a new `test/integration/update-missing.test.ts` (one new test)

**Out of scope**:
- `src/server/party-db-server.ts` — the 409 error envelope is plan 006's territory.
- The insert/delete/blob paths in the adapter — they don't read possibly-empty cursors.
- Any change to the `SqlResult` interface shape.

## Git workflow

- Branch: `advisor/002-one-row-cursor-drift`
- Commit style: `fix(server): don't rely on one()'s zero-row behavior in the update path`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Read the possibly-empty result via `toArray()`

In `applyStructured`'s update branch, replace `const resolved = result.one()` with a
zero-row-tolerant read, e.g.:

```ts
const resolved = result.toArray()[0]
```

Keep the existing comment's *intent* but correct it (it currently implies `.one()`
can return undefined). Match the file's narrative comment style.

**Verify**: `pnpm test` → all pass, including the existing
"treats an update of a nonexistent row as a no-op" test.

### Step 2: Make the shim's `.one()` mirror the real cursor

In `test/helpers/sql-engine.ts`, make `one()` throw unless exactly one row:

```ts
one: () => {
  if (rows.length !== 1) throw new Error(`one(): expected exactly one row, got ${rows.length}`)
  return rows[0]
},
```

This makes the unit suite catch any future `.one()`-on-maybe-empty call.

**Verify**: `pnpm test` → all pass. If any test now fails, the failure is a real
latent `.one()` misuse — examine it; if it's in a file outside this plan's scope, STOP.

### Step 3: Lock it in with a workerd integration test

Add one integration test (follow the conventions from plan 001 / `sync.test.ts`):
POST an update for a row id that was never inserted, e.g.
`[{ channel: 'todos', ops: [{ type: 'update', value: { id: 'ghost', text: 'x' }, previousValue: { id: 'ghost' } }] }]`.
Assert:
- response status is **200** (not 409),
- the ack's `changed[0].ops[0]` is `{ type: 'update', value: { id: 'ghost', text: 'x' }, previousValue: { id: 'ghost' } }` (the sent value),
- a subsequent snapshot connect does **not** contain a `ghost` row (nothing was created).

**Verify**: `pnpm test:integration` → all pass including the new test. Before the
Step-1 fix this test would 409 on real workerd; you can optionally confirm by
stashing the fix once — not required.

## Test plan

- Existing unit test `test/sqlite-adapter.test.ts:112-119` keeps passing (now
  against a strict shim, so it actually proves the fix).
- New integration test per Step 3, modeled on `sync.test.ts`'s
  "the POST envelope reports the database verdict" describe block.
- Full: `pnpm typecheck && pnpm test && pnpm test:integration` → green.

## Done criteria

- [ ] `grep -n "result.one()" src/server/sqlite-adapter.ts` shows no hit in the update branch (lines ~139-159)
- [ ] `test/helpers/sql-engine.ts` `one()` throws on 0 or >1 rows
- [ ] New integration test for update-of-missing-row passes (status 200, sent value echoed, no row created)
- [ ] `pnpm typecheck && pnpm test && pnpm test:integration` all exit 0
- [ ] No files outside the in-scope list modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

- The excerpts above don't match the live code (drift).
- Making the shim strict breaks a test that exercises a `.one()` call site NOT
  listed in "Current state" — that's an unmapped latent bug; report it.
- `@cloudflare/workers-types` documents `one()` as returning `undefined`/null on
  zero rows (i.e. my premise is wrong) — report before changing anything.
- The new integration test returns 409 **after** the fix.

## Maintenance notes

- Any future adapter code reading a cursor that can be empty must use `toArray()`;
  the strict shim now enforces this in unit tests.
- Reviewer: confirm the no-op update semantics (return sent value, create nothing)
  are actually the desired product behavior — the alternative (404-style reject) was
  considered and rejected because the docs and unit test both specify the no-op.
- A D1 adapter (roadmap) will need the same discipline — D1's result API differs again.
