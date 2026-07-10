# Plan 017: Access policies — RLS in the JS layer (cookbooks 5 & 6)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. This plan lands as **two stages / two PRs**
> (A: string policies; B: expression rules) — each stage independently green.
> When done, update the status row in `plans/README.md` — unless a reviewer
> dispatched you and told you they maintain the index.
>
> **Drift check (run first)**: `git diff --stat 558508f..HEAD -- src docs/cookbooks example-react-polyglot`
> Plans 015/016 may have landed (expected drift in `src/server`); the access
> types in `src/schema.ts` and the two cookbooks are this plan's spec — if
> THEY changed, re-read them fully before proceeding.

## Status

- **Priority**: P1
- **Effort**: L (two staged M's)
- **Risk**: MED-HIGH (touches the broadcast hot path and the public type surface)
- **Depends on**: none hard; **coordinate with plan 011** (both extend
  `PartyCollection` generics — whoever lands second threads the other's
  parameters; do not duplicate type work) and with 016 (shared edits to
  `party-db-server.ts` — rebase, don't fork)
- **Category**: feature
- **Planned at**: commit `558508f`, 2026-07-10

## Why this matters

This is the feature that turns party-db from "realtime sync for party-shaped
apps" into a data framework for normal apps: public and private data in one
room, enforced server-side, declared in one field on the collection. The spec
already exists and the maintainer has merged it — **the cookbooks are the
contract**:

- [`docs/cookbooks/05-public-and-private-collections.md`](../docs/cookbooks/05-public-and-private-collections.md)
  — string policies (`public`/`authed`/`owner`/`none`) per verb, deny-by-default
  on the object form, `ownerColumn` equality with auto-stamp, `auth: (req) =>
  uid | null` as the whole identity story. Its "What I changed, flag for
  review" items are **adopted as written** (the maintainer merged them; if
  implementation reveals a contradiction, that's a STOP, not a redesign).
- [`docs/cookbooks/06-friends-only-posts.md`](../docs/cookbooks/06-friends-only-posts.md)
  — `read` as an expression function `(row, viewer) => Expression` over the
  TanStack combinators, lowered twice: SQL `WHERE` for snapshot/backlog, an
  in-memory predicate for per-socket fan-out; `loadViewer`/`refreshViewer` as
  the per-connection context seam.

The type surface for cookbook 5 is already in `src/schema.ts`
(`AccessPolicy`, `Access`, `ownerColumn` — typecheck-only, unenforced). This
plan is the enforcement, plus cookbook 6's widening, plus **one
maintainer-requested extension to the cookbook-5 surface** (2026-07-10):
ownership generalized from "the uid" to **JWT claims** — see "Ownership:
claims, AND, and OR" below. Since the cookbooks are the spec, Stage A's docs
step extends cookbook 5 with the org/team example to keep spec and code in
lockstep.

## Ownership: claims, AND, and OR (the design line)

- **Claims, not just uid.** `auth` may return a string (sugar for
  `{ uid: string }`) or a flat claims record from the verified JWT —
  `{ uid, org }`. `ownerColumn: 'user_id'` keeps meaning "matches `uid`";
  the general form maps columns to claims: `ownerColumns: { org_id: 'org' }`
  for a team/org-scoped table — still the string tier, no expressions.
- **Multiple registered columns are AND (tenancy) — safe as config.**
  `ownerColumns: { user_id: 'uid', org_id: 'org' }`: insert stamps each
  column from its claim (absent → stamped; present-but-mismatched → 403);
  `'owner'` update/delete/read requires the stored row to match **all** of
  them (a row in your org owned by a colleague is still not yours). AND is
  the only combination semantic offered in the string tier.
- **OR is visibility, and it's Stage B's expression form — by design.**
  "`from_id` *or* `to_id` names me" is a read rule:
  `read: (row, v) => or(eq(row.from_id, v.uid), eq(row.to_id, v.uid))`.
  Offering OR in a column map would mean inventing combination syntax — a
  worse expression language than the one Stage B already ships. The DM-table
  decomposition to document: writes `ownerColumn: 'from_id'` (send only as
  yourself, stamped), reads the OR expression — both tiers composing on one
  collection.

## Current state

- `src/schema.ts` — `AccessPolicy`/`Access`/`ownerColumn` shipped as types;
  semantics documented in comments exactly as the cookbook states (omit →
  public; bare `ownerColumn` → owner-on-all; object form denies unnamed verbs).
- `src/server/auth.ts` — `getTokenFromRequest` exported (Bearer / `?token=`
  convention); lobby `authHooks` unchanged and composable on top.
- `src/server/party-db-server.ts` — `onConnect` (serialized with writes, plan
  004) sends snapshot/delta to the socket; `onRequest` validates → serialize →
  `adapter.write` → broadcast loop. Broadcast today serializes ONE string per
  batch for all sockets (§9's cheap loop) — per-viewer filtering changes this;
  see Stage A Step 4.
- `src/client/apply.ts` — `applyBatch` drives TanStack's
  `begin/write/commit/markReady/truncate`. TanStack 0.6.10 throws on a synced
  insert of an existing key (the plan-003 discovery) — Stage B needs
  upsert-tolerant apply.
- Connection identity: partyserver `Connection.serializeAttachment` persists
  across hibernation — but check its size limit against a realistic viewer
  (cookbook 6's `friends: string[]` can be KBs). Fallback design ready: attach
  only `uid`; hold viewers in an in-DO Map keyed by connection id, rebuilt
  lazily via `loadViewer` on first use after a wake.
- Expression prior art (all verified in-repo this cycle): TanStack's `where`
  IR is plain data (`Func`/`PropRef`/`Value`, no closures — per
  `docs/unspecified.md`); `@tanstack/db` exports `compileSingleRowExpression`
  (the JS lowering — used by TanStack's own persistence core) and the
  combinators (`eq`/`or`/`inArray`/…); the persistence core's
  `compileSqlExpression` is a worked example of IR→SQL including chunked
  `IN (…)` past ~900 params. Ours differs in one respect: it binds
  **allowlisted real columns** (`assertIdent` + the plan's column set), not
  JSON paths.
- The oplog stores **resolved ops including `previousValue`** on updates —
  this is what makes Stage B's move-in/move-out computable on both fan-out and
  backlog.
- `example-react-polyglot/` — the runnable cookbook-5 scaffold (typechecks
  today; enforcement pending = this plan). Its migrations/fixtures are the
  natural integration-test shape.

## Commands you will need

| Purpose   | Command                  | Expected on success |
|-----------|--------------------------|---------------------|
| Typecheck | `pnpm typecheck`         | exit 0              |
| Unit      | `pnpm test`              | all pass            |
| Workerd   | `pnpm test:integration`  | all pass            |

## Scope

**In scope**:
- `src/schema.ts` — Stage B type widening only (`read` function form, viewer
  generic `V` defaulting to `{ uid: string | null }`)
- `src/server/party-db-server.ts` — `auth`/`loadViewer`/`refreshViewer`
  fields; write gate; read gates at snapshot / backlog / fan-out
- `src/server/access.ts` (create) — policy resolution, owner checks, stamping
- `src/server/expressions.ts` (create, Stage B) — IR→SQL + IR→predicate
- `src/server/persistence.ts` + adapters — ONLY if the owner check needs a
  `getRow` seam (Stage A Step 2's decision)
- `src/client/apply.ts` — Stage B upsert tolerance
- `test/` unit + `test/integration/access.test.ts` (+ a polyglot-shaped fixture)
- The two cookbooks (flip 🚧 per stage) + `example-react-polyglot` enforcement
  notes; `docs/architecture.md` gains the access-policy decision section when
  Stage A lands (state the architecture; no plan links)

**Out of scope**:
- `report()` / RPC / server actions — the next plan after this one.
- Read-slicing / `subscribe(channels[])` — same compiler, later feature; do
  not generalize prematurely.
- Rate limiting, lobby auth changes, real Postgres RLS.

## Git workflow

- Branches: `advisor/017a-access-policies`, then `advisor/017b-expression-rules`
- Commit style: `feat(server): enforce collection access policies (cookbook 5)` /
  `feat(server): expression read rules + viewer context (cookbook 6)`
- Do NOT push or open a PR unless the operator instructed it.

## Stage A — string policies (`ownerColumn`, cookbook 5)

### Step A1: Identity — `auth` on the class, pinned per socket

`auth?: (req: Request) => string | Claims | null | Promise<…>` where
`Claims = Record<string, string>` and a bare string normalizes to
`{ uid: string }`. Resolve at connect (before the serialized snapshot) and
pin the normalized claims to the connection (attachment — small, flat,
hibernation-safe); resolve per `POST /write` fresh (writes must not trust a
stale pin). No `auth` configured → every policy behaves as today
(back-compat: all-public defaults).

### Step A2: The write gate

In `onRequest`, after body validation, before the serialize/adapter section:
resolve the effective policy per op (`op.type` → verb; collection's resolved
`access`), then:

- `public` → pass; `authed` → require uid (else 401); `none` → 403 always.
- `owner` → requires `ownerColumn` or `ownerColumns` (config error at
  `onStart` if neither; `ownerColumn: 'c'` normalizes to
  `ownerColumns: { c: 'uid' }`; columns validated against the schema
  allowlist, claims are free-form keys).
  - insert: stamp **each** registered column from its claim when absent; 403
    on any mismatch; 401 when the needed claim is missing.
  - update/delete: verify **all** registered columns against the **stored**
    row (AND — tenancy semantics; see the design line above). Decision (make it,
    record it): (a) an adapter `getRow(channel, key)` read inside the
    serialized section — simple, race-free under the write queue, one extra
    read on D1/PG; or (b) push `AND "owner" = ?` into the UPDATE/DELETE WHERE —
    atomic but conflates "not yours" with the documented update-of-missing
    no-op, so a zero-row result needs a follow-up existence check anyway.
    **Lean (a)**; whichever you pick, the 403-vs-no-op distinction from the
    cookbook must hold and be tested.

Rejections are `WriteReject` with 401/403 per the cookbook's table; the whole
POST rejects before any transaction opens (error-sooner, same stance as the
Zod gate design).

### Step A3: Read gates — snapshot, backlog

- `snapshot()` filtering: `read: 'owner'` → `WHERE` every registered owner
  column equals its claim (ANDed; a missing claim → empty batch, still
  `ready`); `authed` → all-or-empty by uid presence; `none` → skip the
  channel. Plumbing decision: pass a
  per-connection filter into the adapter vs. filter in the server. Owner
  equality is expressible as a `(channel → WHERE fragment + binds)` map the
  adapter applies — keep it that narrow; Stage B's compiler will feed the same
  seam.
- `replaySince` deltas: filter per-op in the server (ops carry whole values —
  cheap JS check per the resolved policy), preserving batch/seq structure so
  cursors stay exact.

### Step A4: Read gate — fan-out

Broadcast becomes policy-aware: for collections whose `read` is `'public'`,
keep §9's single-serialization fast path (assert this in review — the common
case must not regress); otherwise, per socket: filter the batch's ops by the
socket's uid, drop empty results, serialize per socket (or per uid-group).
Still synchronous, still inside the serialized section.

### Step A5: Tests + docs (Stage A gate)

- Unit: policy resolution matrix (shorthands, deny-by-default, `write`
  shorthand rejected until Stage B? — no: `write` shorthand is cookbook 6;
  keep A to the four verbs), single- and multi-claim stamping, the AND
  matrix (org matches / user doesn't → 403; both match → pass), 401/403
  mapping.
- Integration (polyglot-shaped fixture: public catalog + owner collections,
  two users + anon): anon reads public only; owner rows reach only their
  owner's sockets (fan-out + snapshot + delta all three asserted); forged
  `user_id` → 403; anon owned-write → 401; `update`/`delete` of another's row
  → 403 and nothing broadcast; auto-stamp round-trips.
- Docs: cookbook 5 🚧 → shipped **and extended** with the claims section — an
  org/team-scoped collection (`ownerColumns: { org_id: 'org' }`), the tenancy
  AND example, and a forward pointer that OR-shaped visibility (from/to) is
  recipe 6's expression form; polyglot README note; architecture gains the
  access-policy decision (the four policies, deny-by-default, claims + the
  AND/OR design line, enforcement at the four choke points, and the
  "roughshod RLS, not a security kernel" honesty from the cookbooks).

**Stage A verify**: full gate green; Stage A is releasable alone.

## Stage B — expression read rules + viewer (cookbook 6)

### Step B1: Spike the two lowerings (no product code)

Confirm in a scratch test: (1) combinators (`eq`/`or`/`inArray`) produce the
plain-data IR outside a query context, over a row-ref shape we can hand the
rule author; (2) `compileSingleRowExpression` evaluates that IR against a raw
row object (this is how TanStack's persistence core uses it); (3) our IR walk
can emit a parameterized SQL `WHERE` restricted to allowlisted columns, with
`inArray` → chunked `IN` past the param limit. Record exact APIs/versions.

### Step B2: Types + seams

`Access['read']` widens to `AccessPolicy | ((row, viewer) => Expression)`;
`PartyCollection<T, V = { uid: string | null }>`; `definePartyCollection<T, V>`.
Server gains `loadViewer?: (uid) => V | Promise<V>` (cached per connection —
attachment if it fits, else the in-DO Map with lazy rebuild after hibernation;
decide by the size check, record it) and `refreshViewer(uid)` whose
implementation is: rebuild viewer, then send the affected sockets a fresh
**reset snapshot** (plan 003's machinery as the revocation hammer — no new
protocol).

### Step B3: `expressions.ts` — one rule, two lowerings

Compile once per (collection, connection) at connect with the viewer baked:
`{ whereSql, binds, predicate }`. SQL lowering feeds A3's snapshot seam;
predicate feeds A3's backlog filter and A4's fan-out. Property-style parity
test: for a grid of rows × rules, SQL verdict (run on the node SQLite lane)
=== predicate verdict.

### Step B4: Move-in / move-out / revocation

The part the cookbooks' review flags missed, using `previousValue`:

- fan-out + backlog, per socket: `visible(prev)` vs `visible(value)` —
  visible→invisible rewrites the op to a **synthetic delete**; invisible→
  visible delivers the row (as its own op; client tolerance handles the rest);
  invisible→invisible drops it.
- `src/client/apply.ts`: upsert-tolerant apply — synced insert-of-existing-key
  applies as update; synced update-of-unknown-key applies as insert. (Also
  retro-hardens D1-report/snapshot-straddle cases; keep it unconditional.)
- `refreshViewer` → reset snapshot covers viewer-side changes (unfriending);
  document the cookbook's own caveat verbatim: eventually-consistent cache,
  "roughshod RLS, not a security kernel."

### Step B5: Tests + docs (Stage B gate)

- Integration: the friends fixture — friend sees a friends-only post live,
  stranger never receives it (assert at the wire, not the UI); visibility
  flip public→friends delivers synthetic deletes to strangers; unfriend +
  `refreshViewer` → stranger gets a reset snapshot without the post; big
  friends list exercises IN-chunking.
- Unit: parity grid (B3), transition matrix (B4), apply tolerance.
- Docs: cookbook 6 🚧 → shipped (including its flag-for-review items as
  resolved); architecture's access section gains the expression form + the
  move-in/move-out decision.

## Test plan

Per stage gates above. Full: `pnpm typecheck && pnpm test &&
pnpm test:integration` green after each stage independently.

## Done criteria

- [ ] Stage A: cookbook 5 runs against the polyglot example with enforcement on — all four choke points tested; public-read collections keep the single-serialization fast path
- [ ] Stage A: claims generalization landed — org-scoped `ownerColumns`, multi-column AND + stamping tested, cookbook 5 extended to match; the DM decomposition (write `ownerColumn` + read OR expression) documented for Stage B
- [ ] Stage B: cookbook 6's friends flow runs end-to-end; SQL/JS lowering parity proven; move-out delivers synthetic deletes; revocation = reset snapshot
- [ ] No-`auth` servers behave byte-identically to today (back-compat suite untouched)
- [ ] Client apply is upsert-tolerant; both cookbooks flipped from 🚧; architecture records the decisions (no plan links)
- [ ] `plans/README.md` updated per stage

## STOP conditions

- A cookbook flag-for-review item turns out unimplementable as written
  (e.g. the combinators cannot build IR outside a query context) — the
  cookbooks are the maintainer's merged spec; report options, don't
  unilaterally change the surface.
- `serializeAttachment` limits make even `{ uid }` problematic (would
  contradict partyserver docs — report).
- The per-socket fan-out path measurably regresses the public-only broadcast
  benchmark (`pnpm bench`) — the fast path is load-bearing.
- Plan 011 lands mid-flight with conflicting `PartyCollection` generics —
  coordinate the threading rather than racing it.

## Maintenance notes

- `expressions.ts` is deliberately the read-slicing compiler too
  (`docs/unspecified.md` → subscription/filtering): when `subscribe(channels,
  where)` happens, it reuses this module — extend, don't fork.
- The `'none'` policy is the seam RPC/`report()` writes will pass through
  (out-of-band writers aren't CRUD; the next plan defines how they announce
  themselves) — keep the write gate's policy check op-level so a future
  server-originated write path can carry its own authority.
- Postgres note for later: these read WHERE fragments must render through
  016's dialect seam when the PG adapter grows access filtering — write A3's
  seam against `Statement`-shaped fragments, not raw strings.
