# Plan 011: Deliver "typed end to end" — per-collection types on `db`

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 3779114..HEAD -- src/client/collection.ts src/client/party-db.ts src/schema.ts test example-react example-react-rdbms`
> Compare the excerpts below; plans 001–010 should not have touched these types.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED (public API types; must not break existing consumers/examples)
- **Depends on**: none
- **Category**: dx
- **Planned at**: commit `3779114`, 2026-07-08

## Why this matters

The README promises "Typed end to end — Collections take their types from your Zod
schema, so reads and writes are fully type-safe." Today that's true *per
collection object* but not at the API surface users actually touch:
`createPartyDb` returns `db: Record<string, Collection<any>>`, so `db.todos` is
`Collection<any>` — no property-name checking (`db.tods` compiles) and no row
typing on insert/update. The type-level work to map the configs tuple to a keyed,
typed `db` is self-contained and is the difference between the claim being
marketing and being real.

## Current state

- `src/schema.ts:14-24` — the collection interface; `name: string` currently
  widens, which is why per-name mapping is impossible downstream:

  ```ts
  export type PartyCollection<T extends object = Record<string, unknown>> = {
    name: string // channel === table name
    key: keyof T & string // primary key field → getKey
    schema?: StandardSchemaV1<T> // shared Zod/StandardSchema: types + validation
  }

  export function definePartyCollection<T extends object>(cfg: PartyCollection<T>) {
    return cfg
  }
  ```

- `src/client/collection.ts:57-74` — `wireCollections` builds
  `db: Record<string, Collection<any>>` and returns `{ db, persist }`.
- `src/client/party-db.ts:77-94` — `createPartyDb<C extends PartyCollectionConfig<any>[]>(transport, configs, options?)`
  spreads that straight through. The generic `C` is captured but unused for typing `db`.
- Consumers to keep compiling (these are the compatibility gate):
  - `example-react/src/App.tsx:15-19` — uses `as unknown as Collection<Todo>`
    casts (with a comment calling them a monorepo double-import artifact); after
    this plan those casts should be *removable*, but removing them is optional.
  - `example-react-rdbms/src/App.tsx`, `example/src/client.ts` — same surface.
  - `test/persist.test.ts`, `test/sync-client.test.ts` — construct configs directly.
  - Cookbook 01 (`docs/cookbooks/01-atomic-writes.md`) shows
    `createPartyDb(transport, [definePartyCollection({ name: 'posts', … })])` —
    the target shape must keep this exact call pattern working.
- TypeScript is `^5.7` (`package.json:60`) — `const` type parameters (TS 5.0+) are
  available.
- The repo has no type-assertion test convention yet; vitest 4 supports
  `expectTypeOf` from the `vitest` import (`import { expectTypeOf } from 'vitest'`)
  and typechecking of test files is wired via `tsconfig.client.json`'s
  `"include": [... , "test"]` — type tests in a plain unit file will be checked by
  `pnpm typecheck` and ignored at runtime.

## Target shape (the deliverable)

```ts
// schema.ts — name becomes a literal-preserving parameter with a string default:
export type PartyCollection<T extends object = Record<string, unknown>, Name extends string = string> = {
  name: Name
  key: keyof T & string
  schema?: StandardSchemaV1<T>
}
export function definePartyCollection<T extends object, const Name extends string>(
  cfg: PartyCollection<T, Name>,
): PartyCollection<T, Name> { return cfg }

// collection.ts / party-db.ts — map the tuple to a keyed record:
export type DbOf<C extends readonly PartyCollection<any, string>[]> = {
  [K in C[number] as K['name']]: K extends PartyCollection<infer T, string> ? Collection<T> : never
}
export function createPartyDb<const C extends readonly PartyCollection<any, string>[]>(
  transport: Transport,
  configs: C,
  options?: SyncClientOptions,
): { db: DbOf<C>; persist: …; client: SyncClient; readonly isConnecting: boolean }
```

Runtime code does not change — only signatures and one `as DbOf<C>` at the
`wireCollections` return (or a generic `wireCollections` — implementer's choice,
but keep `wireCollections`'s internals untyped-simple as they are today).

Watch out for: `Collection`'s own generic arity in `@tanstack/db` 0.6.10
(`createCollection` may return `Collection<T, TKey, …>` with defaults — inspect
`node_modules/@tanstack/db/dist/esm/collection/index.d.ts` and match whatever
single-parameter usage `Collection<Todo>` the examples already use); and configs
built *without* `definePartyCollection` (plain object literals, as in the README
server snippet and `test/persist.test.ts`) — the `const C` inference must still
accept them, falling back gracefully (a plain `{ name: 'todos', … }` literal in a
`const`-inferred position keeps its literal name — verify with a type test).

## Commands you will need

| Purpose   | Command                  | Expected on success |
|-----------|--------------------------|---------------------|
| Typecheck | `pnpm typecheck`         | exit 0              |
| Unit tests | `pnpm test`             | all pass            |
| Examples compile | `pnpm --dir example-react typecheck` (check script name in its package.json; likewise example-react-rdbms) | exit 0 |

## Scope

**In scope**:
- `src/schema.ts`, `src/client/collection.ts`, `src/client/party-db.ts` — types only
- `test/typed-db.test-d.ts` or type assertions inside a new `test/typed-db.test.ts` — new
- `README.md` — no change needed (the claim becomes true); do not edit

**Out of scope**:
- Any runtime behavior change (the JS emitted/executed must be identical).
- `src/server/**` — the server consumes `PartyCollection<any>[]`; the widened
  default (`Name extends string = string`) must keep it compiling *without* edits.
- Removing the examples' `as unknown as Collection<Todo>` casts (allowed as a
  bonus only if the example typechecks stay green; note it in the report).

## Git workflow

- Branch: `advisor/011-typed-db`
- Commit style: `feat(client): type db by collection name (typed end to end, for real)`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Literal-preserving `PartyCollection`

Apply the `schema.ts` change from "Target shape". Immediately verify nothing
downstream widens or errors: `pnpm typecheck` (server side especially —
`PartyDbServer.collections: PartyCollection<any>[]` must still accept
`definePartyCollection(...)` results).

**Verify**: `pnpm typecheck` → exit 0.

### Step 2: `DbOf` mapping + `createPartyDb`/`wireCollections` signatures

Apply the mapping. Keep `wireCollections`'s body as-is (it builds a
`Record<string, Collection<any>>` and casts on return).

**Verify**: `pnpm typecheck && pnpm test` → green.

### Step 3: Type tests

New test file with `expectTypeOf` assertions (they run under `pnpm typecheck`
via the client tsconfig; the runtime file can be a `describe` of trivial passes):

- `db.todos` is `Collection<Todo>` (not `any`) for a two-collection setup built
  with `definePartyCollection` + a Zod schema.
- `db.lists` similarly; access to an undeclared name (`db.nope`) is a type error
  (`// @ts-expect-error`).
- A config passed as a plain object literal (no helper) still yields a keyed `db`.
- `persist` and `client` keep their existing types.

**Verify**: `pnpm typecheck` fails if any `@ts-expect-error` stops erroring; both
commands green.

### Step 4: Examples still compile

Run each example's typecheck (find the script names in their package.json files;
`example-react` has one — commit `aa4297f` added it). If the casts in
`example-react/src/App.tsx:15-19` are now unnecessary, removing them is optional;
if you remove them, its typecheck must stay green.

**Verify**: both example typechecks exit 0.

## Test plan

Step 3's type tests are the core; the full gate is
`pnpm typecheck && pnpm test && pnpm test:integration` plus the example
typechecks. No runtime tests change.

## Done criteria

- [ ] `db.<name>` is the schema-typed `Collection<T>`; undeclared names are type errors (type tests prove both)
- [ ] Zero runtime diff: `git diff -- src | grep -v "^[+-].*\(type \|Type\|<\|>\|:\)"` — eyeball that only type-level lines changed; `pnpm test` green with no test edits
- [ ] Server side compiles unmodified
- [ ] Both examples typecheck
- [ ] `plans/README.md` status row updated

## STOP conditions

- `@tanstack/db`'s `Collection` generic can't be instantiated as `Collection<T>`
  in this mapping without runtime-affecting changes to `createCollection` calls.
- Preserving literal names breaks the *server*'s `collections` field typing in a
  way that needs `src/server` edits.
- Plain-literal configs (no `definePartyCollection`) lose their name literals and
  the fallback `Record`-style behavior can't be preserved — report the tradeoff
  options instead of picking one (this is a public-API judgment call).

## Maintenance notes

- Future `insertSchema`/`updateSchema` fields (plan 013) extend `PartyCollection` —
  they must thread the same `<T, Name>` parameters.
- Reviewer: check `.d.ts` output (`pnpm build`, inspect `dist/client/party-db.d.ts`)
  — the mapped type must survive declaration emit, not collapse to `Record<string, …>`.
