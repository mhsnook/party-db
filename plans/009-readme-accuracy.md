# Plan 009: Make the README accurate for first publish

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 3779114..HEAD -- README.md package.json src/server/party-db-server.ts`
> If README.md changed since planning, compare against the excerpts below.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW (docs only)
- **Depends on**: none
- **Category**: docs
- **Planned at**: commit `3779114`, 2026-07-08

## Why this matters

The README is the package's front page on npm and GitHub, and it currently: links
its most advanced example through a path that 404s on case-sensitive hosts;
declares "v0.0.0" while the manifest says 0.0.1; shows a headline server example
that, copy-pasted, fails with `no such table: todos` on the first write (it passes
a schema — structured mode — but never creates the table, contradicting the
"near-zero config, it just works" pitch); and its Files table omits shipped
modules (`auth.ts`, `errors.ts`) a reader is sent looking for by the auth-heavy
architecture doc. All four are minutes to fix and first-impression-critical.

House style (from the maintainer): the library is the main character — keep
boilerplate minimal and elide setup that isn't the point.

## Current state

- `README.md:3` — `> v0.0.0, incubating. …` ; `package.json:3` — `"version": "0.0.1"`.
- `README.md:67` — `- [React + SQLite](./example-react-RDBMS/README.md)` — actual
  directory is `example-react-rdbms` (lowercase). The other two example links are correct.
- `README.md:96-118` — the Server section:

  ```ts
  export class Main extends PartyDbServer {
    collections = [
      { name: 'todos', key: 'id', schema: todoSchema },
      { name: 'lists', key: 'id', schema: listSchema },
    ]
  }
  ```

  Passing `schema` routes these to structured CRUD against real `todos`/`lists`
  tables (`src/server/sqlite-adapter.ts:60-71` builds a structured plan whenever
  the Zod shape is readable), and the library never creates user tables. Every
  runnable example creates its own table in `onStart` — e.g.
  `example-react-rdbms/src/server.ts:19-22`:

  ```ts
  onStart() {
    migrate(this.ctx.storage.sql)
    return super.onStart()
  }
  ```

  and the class docstring in `src/server/party-db-server.ts:12-18` shows the
  inline variant (`this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS todos (...)')`).

- `README.md:154-169` — the Files table lists 11 rows (`protocol.ts`, `apply.ts`,
  `sync-client.ts`, `seq-tracker.ts`, `collection.ts`, `party-db.ts`, `schema.ts`,
  `party-db-server.ts`, `persistence.ts`, `sqlite-adapter.ts`, `columns.ts`) but
  not `src/server/auth.ts` (public `authHooks`/`bearer`/`Authorize` — the §10 auth
  seam) or `src/client/errors.ts` (public `WriteError`/`TransportError`).

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Link check | `ls example-react-rdbms/README.md` | file exists |
| Grep guards | see Done criteria | as stated |

## Scope

**In scope**: `README.md` only.

**Out of scope**:
- `docs/**` (cookbook fixes are plan 010; architecture doc untouched).
- Any code file. If the README's claims can only be fixed by changing code, STOP.
- Restructuring/rewriting README sections beyond the four fixes — no editorializing.

## Git workflow

- Branch: `advisor/009-readme-accuracy`
- Commit style: `docs: fix README example link, version banner, server snippet, files table`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Version banner and link case

- Line 3: `v0.0.0` → `v0.0.1` (or drop the number entirely — prefer dropping so it
  can't drift again: `> incubating. Cookbooks: …`).
- Line 67: `./example-react-RDBMS/README.md` → `./example-react-rdbms/README.md`.

**Verify**: `grep -n "v0.0.0\|RDBMS/README" README.md` → no matches.

### Step 2: Fix the headline server snippet

Add the minimal table-creation note to the `Main` class in the Server section,
matching the docstring style in `src/server/party-db-server.ts:12-18` — keep it
elided, the library stays the main character:

```ts
export class Main extends PartyDbServer {
  collections = [
    { name: 'todos', key: 'id', schema: todoSchema },
    { name: 'lists', key: 'id', schema: listSchema },
  ]
  // your tables, your DDL — party-db only CRUDs over them:
  onStart() {
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS todos (...)`) // and lists
    return super.onStart()
  }
}
```

Keep the surrounding prose intact; if a sentence nearby claims the class shown is
"the whole server", make sure it still reads truthfully with the added lines.

**Verify**: the snippet in README contains `onStart` and `super.onStart()`.

### Step 3: Complete the Files table

Add two rows, matching the table's terse role-description voice:

| File | Role |
| --- | --- |
| `src/server/auth.ts` | `authHooks(authorize)` — the lobby auth seam (connect + write) |
| `src/client/errors.ts` | `WriteError` / `TransportError` — classified write failures |

**Verify**: `grep -c "auth.ts\|errors.ts" README.md` ≥ 2.

## Test plan

Docs-only; the greps above are the gate. Optionally render locally
(`pnpm dlx markdownlint-cli README.md` is NOT required — don't add tooling here).

## Done criteria

- [ ] `grep -n "example-react-RDBMS" README.md` → no matches; the lowercase link target exists on disk
- [ ] `grep -n "v0.0.0" README.md` → no matches
- [ ] README server snippet includes `onStart` table creation
- [ ] Files table includes `auth.ts` and `errors.ts`
- [ ] `git status` shows only README.md modified; `plans/README.md` updated

## STOP conditions

- README.md has been substantially rewritten since `3779114` (drift check) — the
  four fixes may no longer map; report what you find instead of guessing.
- You believe a README claim is wrong in a way not listed here — note it in your
  report; do not expand scope.

## Maintenance notes

- The version banner is why "drop the number" is preferred; if the number is kept,
  add it to the release checklist (plan 008's workflow) mentally — it will drift.
- Reviewer: read the modified Server section top to bottom once — the added
  `onStart` must not contradict the "near-zero config" prose around it (the config
  being added is the *user's own database*, which the architecture doc §5
  explicitly frames as theirs).
