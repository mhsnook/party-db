# Plan 013: Design the server-side validation gate (Zod error-sooner + insert/update schemas)

> **Executor instructions**: This is a **design/spike plan** — the deliverable is
> a written design plus test skeletons, NOT a merged feature. Follow the steps;
> honor the STOP conditions; the "implementation" step is gated and minimal.
> When done, update the status row in `plans/README.md` — unless a reviewer
> dispatched you and told you they maintain the index.
>
> **Drift check (run first)**: `git diff --stat 3779114..HEAD -- src/schema.ts src/server docs/unspecified.md docs/cookbooks/02-server-validation.md docs/sqlite-do-todo.md`
> If the validation gate has been built since planning (grep `~validate` /
> `safeParse` in `src/server/`), this plan is stale — mark it so in the index.

## Status

- **Priority**: P2
- **Effort**: M (design + skeletons; implementation is a follow-up)
- **Risk**: MED (API design; wrong shape is expensive to walk back post-publish)
- **Depends on**: plans/011-typed-db.md (extends the same `PartyCollection` type — coordinate)
- **Category**: direction
- **Planned at**: commit `3779114`, 2026-07-08

## Why this matters

This is the maintainer's own last unchecked P0: `docs/sqlite-do-todo.md` says
"Zod is not run server-side yet — noted below as the one remaining error-sooner
gate", and `docs/architecture.md` §5 lists it among the remaining edges. The
design intent is settled (Zod is an *error-sooner* gate, never the correctness
authority — the database is); what's unresolved is the API: a full-row `schema`
wrongly rejects legal **update patches** (the adapter deliberately applies partial
updates — `sqlite-adapter.ts:142` filters to sent columns), which is exactly why
`docs/unspecified.md` opens its enhancements list with optional
`insertSchema`/`updateSchema` (insert = full row, update = patch). Building the
gate without that distinction would break partial updates; designing both together
is the point of this plan.

## Current state (inline all of this in the design doc you produce)

- Decision constraints, quoted:
  - `docs/architecture.md:139-142` — "Zod runs server-side only as a cheap
    *error-sooner* gate (nicer messages, don't open a doomed transaction), never as
    the correctness authority."
  - `docs/unspecified.md:11-20` — "**insert/update schemas.** Accept optional
    `insertSchema`/`updateSchema` (default to `schema`) for write-time validation
    and payload shape (insert = full row, update = patch)." Plus the
    request-context refinement sketch (`writeSchema: (ctx) => schema.refine(...)`,
    `ctx.uid` from an `auth = (req) => uid` getter) — explicitly a *later* layer;
    design so it can bolt on, don't build it.
  - `docs/cookbooks/02-server-validation.md` — user-facing story: "add a
    `.refine()` and you're set"; marks server enforcement 🚧 and shows the proposed
    `writeSchema` shape. The design must keep this cookbook's promise
    (`.refine()`s on `schema` start being enforced server-side with zero new API).
- Where the gate goes: `PartyDbServer.onRequest` validates after the
  channel-allowlist loop and **before** `this.serialize(...)`/`adapter.write`
  (`src/server/party-db-server.ts:98-106`) — rejects never open a transaction or
  enter the write queue. Per-op validation errors map to a 400 `WriteReject`
  (`src/protocol.ts:57-61`) — decide and document whether `WriteReject` grows an
  optional field-errors payload (e.g. `issues?: { channel, index, path, message }[]`)
  or flattens into `error`; the client's `WriteError` (`src/client/errors.ts:22-34`)
  carries the parsed body either way.
- Validation API: schemas are `StandardSchemaV1` (`src/schema.ts:17`) — the
  spec-portable way to validate is `schema['~standard'].validate(value)`
  (sync-or-async result with `issues`). The repo already introspects Zod
  internals for columns (`src/server/columns.ts:43-48`) but *validation* should go
  through the standard interface, not Zod internals. Note: async validation
  results would make the gate async — fine (it's before the queue), but say so.
- Blob-mode collections (no schema) skip the gate by definition.
- Update-patch semantics to honor: an update op's `value` may contain only the key
  plus changed columns (see `applyStructured`'s partial-SET, and
  `test/sqlite-adapter.test.ts:101-110`). A derived-partial default (e.g. Zod
  `.partial()`) is Zod-specific — the design must say what the *default* update
  validation is when only `schema` is provided: candidate options (evaluate, pick,
  justify):
  1. Validate updates only when `updateSchema` is provided (default: updates
     un-gated; inserts gated by `schema`). Simplest, honest, zero surprise.
  2. Best-effort derive a partial from Zod when introspectable (mirrors the
     `columnsOf` precedent), fall back to un-gated. More magic, more Zod coupling.
  3. Validate the *merged* row (read current row, merge patch, validate full) —
     rejected in advance: reads inside the request path before the transaction,
     races the queue; do not pick this one (record why in the doc).
- Type threading: `PartyCollection` gains optional `insertSchema?` / `updateSchema?`
  — after plan 011 it carries `<T, Name>`; the new fields must not disturb name
  inference. `definePartyCollection`'s inference should keep working with all
  three schemas present.

## Commands you will need

| Purpose   | Command                  | Expected on success |
|-----------|--------------------------|---------------------|
| Typecheck | `pnpm typecheck`         | exit 0              |
| Unit tests | `pnpm test`             | all pass            |

## Scope

**In scope**:
- `docs/design/server-validation.md` — the design doc (create the `docs/design/` directory).
- Test skeletons: `test/validation.test.ts` with `describe`/`it.todo` cases.
- OPTIONAL, gated (Step 4): the minimal insert-gate implementation.

**Out of scope**:
- The request-context `writeSchema(ctx)` layer (design a seam for it; don't build).
- Client-side changes.
- Cookbook 02 updates (do that when the feature ships, not at design time).

## Git workflow

- Branch: `advisor/013-validation-design`
- Commit style: `docs(design): server-side validation gate (error-sooner + insert/update schemas)`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Write the design doc

`docs/design/server-validation.md`, covering: the decided constraints (quoted
above), the API surface (`insertSchema`/`updateSchema` defaulting rules — pick
among the candidate options with justification), the gate's location and error
shape (exact `WriteReject` extension, with a wire example), blob-mode behavior,
async-validation note, the bolt-on seam for `writeSchema(ctx)`, and an explicit
"what this is not" (never the correctness authority; DB still judges). Match the
voice of `docs/architecture.md`.

**Verify**: the doc answers every "decide and document" item in "Current state"
(checklist them at the bottom of the doc).

### Step 2: Test skeletons

`test/validation.test.ts` with `it.todo` cases derived from the design: insert
rejected by refine (400, issues point at channel+index+path); update patch passes
under the chosen default; update rejected when `updateSchema` provided and
violated; blob collection unaffected; a rejected POST leaves no oplog entry
(error-sooner = no transaction opened).

**Verify**: `pnpm test` → suite green (todos don't fail).

### Step 3: Maintainer review gate

Present the design doc (and any unresolved judgment calls) for review. **Do not
proceed to Step 4 without explicit approval** — this is a published-API decision.

### Step 4 (gated): Minimal implementation

If — and only if — approved: implement the insert gate + explicit
`insertSchema`/`updateSchema` per the approved design, converting the `it.todo`s
to real tests. Keep it to the approved shape; anything that grew during
implementation goes back to Step 3.

**Verify**: `pnpm typecheck && pnpm test && pnpm test:integration` → green.

## Test plan

Step 2's skeletons become the feature's spec; the design doc's checklist is the
design's own done-test.

## Done criteria

- [ ] `docs/design/server-validation.md` exists and closes every open question listed above
- [ ] `test/validation.test.ts` skeletons exist; suite green
- [ ] Maintainer reviewed (Step 3) — recorded in the plan's status row (`BLOCKED: awaiting review` is a valid terminal state for this plan)
- [ ] If Step 4 ran: gate implemented per approved design, tests real, all suites green
- [ ] `plans/README.md` status row updated

## STOP conditions

- Step 3 is not a formality — stopping there IS the expected path when no
  reviewer is available.
- `@standard-schema/spec`'s validate interface can't express what the design
  needs (e.g. no sync path where one is required) — surface it in the doc, don't
  hack around it.
- Plan 011 hasn't landed and the type threading conflicts — coordinate ordering
  rather than duplicating type work.

## Maintenance notes

- The request-context refinement (`writeSchema(ctx)`, `auth` getter) is the
  designed-for next step — its seam must be visible in the design doc.
- When this ships, update cookbook 02 (flip 🚧 → ✅ for static-schema enforcement)
  and `docs/sqlite-do-todo.md`'s "Zod is not run server-side yet" line — list both
  in the design doc's rollout section so they aren't forgotten.
