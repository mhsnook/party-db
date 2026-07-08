# Plan 005: Cap `POST /write` payloads and ship a default oplog retention

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 3779114..HEAD -- src/server/party-db-server.ts src/server/sqlite-adapter.ts src/protocol.ts test/integration docs/architecture.md README.md`
> Plans 001–004 are expected drift in these files; confirm the excerpts below
> still describe the live behavior (no size cap; retention default 0) before
> proceeding. On a mismatch beyond that, STOP.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW (additive limits; one default change gated on plan 003)
- **Depends on**: plans/003-snapshot-reset-truncate.md — **hard dependency**, see below
- **Category**: security
- **Planned at**: commit `3779114`, 2026-07-08

## Why this matters

`onRequest` reads the entire POST body with no size ceiling and applies it in one
transaction; `oplogRetention` defaults to unbounded, so `_oplog` grows one row per
batch forever unless a subclass opts in. Any writer — and in the documented
public-write configurations, *anyone* — can drive unbounded DO memory per request
and unbounded per-room SQLite growth up to the Durable Object storage ceiling.
Neither bound is a settled tradeoff in the decision docs (the robustness checklist
in `docs/sqlite-do-todo.md` covers `since`, body-is-array, and unknown-channel, not
volume). Generous defaults cost legitimate users nothing and remove the trivial
abuse path before first publish.

**Why the dependency on plan 003 is hard:** shipping a default retention makes the
"cursor fell off the retained window → fresh snapshot" path *routine*. Before plan
003, that snapshot corrupts a stateful reconnecting client (duplicate-key throw,
ghost rows). Do not land this plan first.

## Current state

- `src/server/party-db-server.ts:86-104` — the unbounded read:

  ```ts
  async onRequest(req: Request): Promise<Response> {
    if (req.method !== 'POST') return new Response('not found', { status: 404 })

    let body: WriteBatch[]
    try {
      body = (await req.json()) as WriteBatch[]
    } catch {
      return Response.json({ error: 'invalid JSON body' } satisfies WriteReject, { status: 400 })
    }
    if (!Array.isArray(body)) { … 400 … }
    for (const batch of body) {
      if (!this.channels.has(batch?.channel)) { … 400 … }
    }
    ```

- `src/server/party-db-server.ts:29-32` — the existing knob pattern to follow:

  ```ts
  // keep at most this many _oplog rows per room …. Undefined → unbounded.
  // Override in your subclass to tune it.
  oplogRetention?: number
  ```

- `src/server/sqlite-adapter.ts:59` — `this.retention = opts.oplogRetention && opts.oplogRetention > 0 ? Math.floor(opts.oplogRetention) : 0`
  (0 = unbounded), and `compact()` at `:105-108` trims after each write inside the
  same transaction.

- `WriteReject` (`src/protocol.ts:57-61`) is `{ error, channel?, constraint? }` —
  the shape every rejection uses; the client maps non-ok responses to `WriteError`
  (`src/client/errors.ts:22`), which carries `status`.

- Existing rejection tests to model on: `test/integration/sync.test.ts:102-131`
  ("the POST envelope reports the database verdict").

## Commands you will need

| Purpose   | Command                  | Expected on success |
|-----------|--------------------------|---------------------|
| Typecheck | `pnpm typecheck`         | exit 0              |
| Unit tests | `pnpm test`             | all pass            |
| Integration | `pnpm test:integration` | all pass           |

## Scope

**In scope**:
- `src/server/party-db-server.ts` — size checks + new class fields + default retention
- `test/integration/` — limit tests (new file `limits.test.ts` or extend `sync.test.ts`)
- `docs/architecture.md` — one sentence where retention is discussed (§8 area) noting the default
- `README.md` — only if it documents `oplogRetention` (it doesn't today; skip unless drifted)

**Out of scope**:
- `src/server/sqlite-adapter.ts` — its retention plumbing already works; only the
  *default* passed from the server class changes.
- Rate limiting / per-identity quotas — out of scope by design (that's the app's
  auth seam's job; note it in the docs sentence if natural).
- The client (`src/client/**`) — a 413 already surfaces as a `WriteError`.

## Git workflow

- Branch: `advisor/005-write-limits`
- Commit style: `feat(server): bound POST /write size + default oplog retention`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Add the knobs and the checks

In `PartyDbServer`, following the `oplogRetention` field pattern (doc comment,
override-in-subclass):

```ts
// reject a POST /write whose body exceeds this many bytes (413). Bounds DO
// memory per request. Override to tune; 0 disables the check.
maxWriteBytes = 1_048_576 // 1 MiB
// reject a POST /write carrying more than this many ops across all batches (413).
maxWriteOps = 1_000
```

In `onRequest`, before `req.json()`:
- If `maxWriteBytes > 0`: check the `content-length` header when present; if it
  exceeds the cap, return 413 with
  `{ error: 'write too large (…' } satisfies WriteReject`. Additionally guard
  bodies without a content-length by reading text first
  (`const text = await req.text()`) and checking `text.length` before
  `JSON.parse(text)` — this replaces the `req.json()` call (keep the invalid-JSON
  400 behavior in the same try/catch).
- After the array/channel validation: count `body.reduce((n, b) => n + (b?.ops?.length ?? 0), 0)`;
  if it exceeds `maxWriteOps > 0`, return 413 with a `WriteReject`.

Note `ops` may be missing/malformed on a hostile batch — the reduce above must not
throw (`b?.ops?.length ?? 0`), and a batch whose `ops` is not an array should get
the existing 400 treatment (add that check alongside the unknown-channel loop).

### Step 2: Default the retention

Change the field to a defaulted value, keeping override semantics and updating its
comment (`0` → unbounded stays available as an explicit opt-out):

```ts
// keep at most this many _oplog rows per room …; a client whose `since`
// predates the retained window gets a fresh reset snapshot (see §8).
// Override in your subclass; set 0 for unbounded (the pre-1.0 behavior).
oplogRetention = 10_000
```

`createAdapter()` already forwards it. Confirm `test/integration/worker.ts` still
sets its own `oplogRetention = 50` (tests unaffected).

**Verify (steps 1–2)**: `pnpm typecheck && pnpm test` → green.

### Step 3: Tests

Integration (model on the existing rejection describe block):
- POST with more than `maxWriteOps` ops (set a small override on a test worker
  class, or POST 1001 tiny ops if fast enough — prefer a small override: add e.g.
  `class Limited extends Main { maxWriteOps = 5 }`… **note**: adding a DO class
  requires a binding in `vitest.integration.config.ts`; simpler and acceptable is
  POSTing >1000 no-op-sized ops to `Main` if runtime stays reasonable, or
  overriding `Main`'s field via a static — choose the cheapest working option and
  say which you chose) → 413, `WriteReject.error` mentions the limit, and a
  subsequent normal write still succeeds (the DO isn't wedged).
- POST a body larger than `maxWriteBytes` (a single op with a long string) → 413.
- Sanity: an ordinary write still returns 200 (existing tests already cover this).

**Verify**: `pnpm test:integration` → all pass.

### Step 4: Document

One or two sentences in `docs/architecture.md` near the §8 retention discussion:
default retention is 10k rows with reset-snapshot fallback; write size/op caps
exist and are class-field overridable; per-identity rate limiting stays in the
app's auth seam.

## Test plan

Step 3. Full gate: `pnpm typecheck && pnpm test && pnpm test:integration` → green.

## Done criteria

- [ ] Oversized-bytes POST → 413 `WriteReject`; oversized-ops POST → 413 `WriteReject` (integration-tested)
- [ ] A normal write after a 413 succeeds (DO not wedged)
- [ ] `oplogRetention` defaults to `10_000`; `0` still means unbounded; comment updated
- [ ] `docs/architecture.md` mentions the defaults
- [ ] All suites green; no files outside scope modified; `plans/README.md` updated

## STOP conditions

- Plan 003 has not landed (check `git log --oneline` / plans/README.md status) —
  do not proceed.
- Reading the body as text-then-parse changes any existing test's observed
  behavior (the 400 invalid-JSON case must stay a 400 with the same message).
- The 413 status leaks through the client as something other than `WriteError`
  in `test/errors.test.ts` expectations — reconcile with the errors taxonomy
  before changing any client file (client is out of scope; report instead).

## Maintenance notes

- The caps are per-POST; a determined writer can still loop requests — per-identity
  quotas belong in the `authorize` seam and were deliberately left out.
- If a legitimate use case hits `maxWriteOps` (bulk import), the documented answer
  is chunked transactions or a subclass override; watch for that in issues.
- The 10k retention default was sized for "typical room" oplogs (each row is one
  JSON-encoded batch); revisit when D1 lands (different storage economics).
