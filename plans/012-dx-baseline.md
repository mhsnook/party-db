# Plan 012: DX baseline — `check` script, CLAUDE.md, lint/format gate

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 3779114..HEAD -- package.json .github/workflows/ci.yml`
> Reconcile with any `check`/lint scripts plans 001–008 may have added (none
> are expected to).

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW
- **Depends on**: best after 001–008 (so the lint baseline covers their changes), but not blocked by them
- **Category**: dx
- **Planned at**: commit `3779114`, 2026-07-08

## Why this matters

Three onboarding/verification gaps for a package about to take external
contributors: there is no single command that answers "is the repo green?" (five
separate scripts; CI chains four by hand); there is no `CLAUDE.md`/`AGENTS.md`
capturing the conventions that currently live in tsconfig comments and doc
cross-references (agents executing the other plans in this directory benefit
directly); and there is no linter or formatter at all — style is consistent today
purely by one author's discipline, and lint-catchable bug classes (floating
promises, unused vars) have no gate.

## Current state

- `package.json:48-56` — scripts: `build`, `prepack`, `typecheck`, `test`,
  `test:watch`, `test:integration`, `bench`. No `check`, no `lint`, no `format`.
- `.github/workflows/ci.yml` — runs `pnpm typecheck`, `pnpm build`, `pnpm test`,
  `pnpm test:integration` as four steps (plus plan 008's dry-run, if landed).
- No `CLAUDE.md`, `AGENTS.md`, `.editorconfig`, or any lint/format config
  (verified at planning time).
- Observed code style (the formatter must be configured to match, NOT the code
  reformatted to match a tool): no semicolons; single quotes; trailing commas;
  2-space indent; print width visually ~100–110 (several comment blocks and SQL
  template literals run long — do not hard-wrap SQL strings); comment-rich
  narrative style.
- Conventions worth writing down (sources: tsconfig comments, docs, this audit):
  - Three tsconfigs typecheck three worlds: client (DOM), server (workers types),
    integration (workers + pool types; added by plan 001); `test/bench` is
    deliberately run-not-typechecked (`pnpm bench`, Node 22 experimental flags).
  - Two storage modes: structured (collection has a readable Zod schema → CRUD
    into user-owned tables) vs blob (no schema → `(k, data)` table the library owns).
  - The server never creates/migrates user tables; examples do it in `onStart`.
  - Wire contract lives in `src/protocol.ts`; decision record in
    `docs/architecture.md`; open questions in `docs/unspecified.md`.
  - Unit tests are pure Node (`pnpm test`, node:sqlite shim); integration is
    workerd (`pnpm test:integration`).
  - Docs house style: cookbooks/examples stay minimal; the library is the main
    character; boilerplate elided with `// ... same setup as …`.

## Commands you will need

| Purpose   | Command                  | Expected on success |
|-----------|--------------------------|---------------------|
| All gates | `pnpm check` (created here) | exit 0            |
| Lint      | `pnpm lint` (created here)  | exit 0            |

## Scope

**In scope**:
- `package.json` — `check`, `lint`, `format` scripts + the chosen tool as a devDependency
- `biome.json` (or the chosen tool's config; create)
- `CLAUDE.md` (create)
- `.github/workflows/ci.yml` — replace the four chained steps with `pnpm check` + add `pnpm lint`
- Mechanical fixes the linter demands, **within reason** (see STOP conditions)

**Out of scope**:
- Reformatting the codebase wholesale. The formatter is configured to match the
  existing style; a compliant run should produce a *small* diff (target: near-zero
  formatting churn — tune config, don't churn code).
- Pre-commit hooks (husky etc.) — deliberately not added; CI is the gate.
- Example apps' own lint setup.

## Git workflow

- Branch: `advisor/012-dx-baseline`
- Commit style: `chore: add check script, CLAUDE.md, and a biome lint gate`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: `check` script + CI

```json
"check": "pnpm typecheck && pnpm build && pnpm test && pnpm test:integration"
```

Update `ci.yml` to call `pnpm check` in place of the four separate steps (keep
plan 008's pack dry-run step if present).

**Verify**: `pnpm check` → exit 0 locally.

### Step 2: Biome (lint first, format second)

Add `@biomejs/biome` as a devDependency. Configure `biome.json`:
- **Formatter**: `formatWithErrors` off; semicolons `asNeeded`; quotes single;
  trailing commas; indent 2 spaces; line width 110. Scope to `src` and `test`
  (exclude `dist`, `node_modules`, `example*`, `docs`, `plans`).
- **Linter**: recommended set; ensure the floating-promises-class rules Biome
  offers in the installed version are on (check the installed Biome's rule names —
  e.g. `nursery`/`suspicious` groups move between versions; pick what exists).
  Disable rules that fight the codebase's deliberate patterns (`any` in the thin
  type-glue spots like `toEvent(m: any)` — prefer targeted
  `// biome-ignore` comments over globally disabling `noExplicitAny`, unless the
  count is prohibitive; report the count either way).

Add scripts: `"lint": "biome check src test"`, `"format": "biome format --write src test"`.
Run `pnpm format` — **expected: a near-empty diff**. If the diff is large, tune
the config until it's small; the config serves the code, not vice versa.
Then `pnpm lint` and fix/annotate what it raises.

**Verify**: `pnpm lint` → exit 0; `git diff --stat src test` shows only small,
explainable changes; `pnpm check` still green.

### Step 3: CI lint step

Add `- run: pnpm lint` to `ci.yml` (before `pnpm check` — fail fast).

**Verify**: workflow YAML still valid (see plan 008's YAML-check options).

### Step 4: CLAUDE.md

Create `CLAUDE.md` (~40–60 lines) covering, tersely: what the package is (one
sentence + pointer to `docs/architecture.md`); the commands (`check`, `typecheck`,
`test`, `test:integration`, `bench`, `lint`); the module map (mirror the README
Files table, one line each); the conventions bulleted in "Current state" above
(three-tsconfig split, structured-vs-blob, user-owns-tables, unit-vs-integration,
docs house style); and where decisions/open questions live. Do not duplicate
architecture content — point at it.

**Verify**: every command named in CLAUDE.md exists in `package.json`
(`grep`-check each).

## Test plan

No behavior changes intended. Gate: `pnpm lint && pnpm check` green; if Step 2's
lint fixes touched code, the full suite re-proves them.

## Done criteria

- [ ] `pnpm check` runs all four gates; CI uses it
- [ ] `pnpm lint` exists, passes, and runs in CI
- [ ] Formatting diff from Step 2 was near-zero (state the line count in your report)
- [ ] `CLAUDE.md` exists; every command it names exists
- [ ] Only in-scope files (+ mechanical lint fixes) modified; `plans/README.md` updated

## STOP conditions

- Matching the existing style requires more than ~30 changed lines of formatting
  churn in `src/` — stop and report the irreconcilable rules instead of committing
  a reformat.
- A lint rule flags a *real* bug (not style) — report it; the fix may belong in a
  scoped change, not buried in a tooling commit.
- Biome's installed version lacks a floating-promise rule entirely — note it and
  proceed (don't switch to ESLint unilaterally; that's an operator decision).

## Maintenance notes

- The `check` script is now the thing plans/CI/humans all share — keep it the
  single source of "green".
- CLAUDE.md's module map will drift like the README's did; reviewers should treat
  "new src file" PRs as also touching CLAUDE.md.
- If example apps later get lint coverage, extend `biome.json` includes rather
  than adding per-app configs.
