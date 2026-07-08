# Plan 007: Close the client-side test gaps (persist rejections, tokens, blob parity) + guard the socket JSON parse

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 3779114..HEAD -- src/client/party-db.ts test/persist.test.ts test/party-transport.test.ts test/sqlite-adapter.test.ts`
> Confirm the excerpts below still match before proceeding (plans 001–006
> should not have touched these paths, except possibly `party-db.ts` — if its
> `subscribe` handler already guards `JSON.parse`, skip Step 4 and say so).

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW (one tiny code change; rest is tests)
- **Depends on**: none (independent of 001–006)
- **Category**: tests
- **Planned at**: commit `3779114`, 2026-07-08

## Why this matters

Four gaps, bundled because they're all small client/adapter unit-test work:

1. **`persist`'s rejection paths are untested.** `makePersist` is the seam that
   makes TanStack roll back optimistic writes when the server rejects — the
   library's headline behavior — yet `test/persist.test.ts` covers only happy
   paths (7 tests, zero rejections).
2. **The client half of auth is untested.** `partyTransport` attaches `?token=` on
   connect and `Authorization: Bearer` on POST, re-reading function tokens per
   use; a regression would break every gated room while CI stays green.
3. **Blob mode has ~1 test vs ~15 for structured.** Blob update-via-upsert,
   delete, and `replaySince` deltas are unverified for a documented shipping mode
   (README Milestone 0).
4. **Unguarded `JSON.parse` in the socket message handler** — a malformed frame
   throws out of the listener. Small defensive fix + test.

## Current state

- `src/client/collection.ts:35-53` — `makePersist` (the function under test):

  ```ts
  export function makePersist(
    client: Pick<SyncClient, 'send' | 'waitForSeq'>,
    channelOf: Map<Collection<any>, string>,
  ) {
    return async ({ transaction }: any) => {
      … group mutations by channel …
      if (!batches.length) return
      const ack = await client.send(batches)
      await Promise.all(ack.accepted.map((a) => client.waitForSeq(a.channel, a.seq)))
    }
  }
  ```

- `test/persist.test.ts:34-38` — the existing mock to extend:

  ```ts
  function mockClient(accepted: { channel: string; seq: number }[]) {
    const send = vi.fn(async (_batches: WriteBatch[]) => ({ accepted }))
    const waitForSeq = vi.fn(async (_channel: string, _seq: number) => {})
    return { client: { send, waitForSeq } as unknown as SyncClient, send, waitForSeq }
  }
  ```

- `src/client/party-db.ts:39-47` — the transport's subscribe handler (Step 4's target):

  ```ts
  subscribe(onBatch) {
    const handler = (e: MessageEvent) => {
      const batch = JSON.parse(e.data) as SequencedBatch
      if (typeof batch.seq === 'number') lastSeq = Math.max(lastSeq ?? 0, batch.seq)
      onBatch(batch)
    }
    socket.addEventListener('message', handler)
    return () => socket.removeEventListener('message', handler)
  },
  ```

- `src/client/party-db.ts:19-36` — token plumbing: `token?: string | (() => string | undefined)`;
  `tokenOf()` re-read inside the socket `query()` closure and inside `send()`.
  `send()` passes `authorization: Bearer ${token}` in `PartySocket.fetch` init
  (`:52-64`).

- `test/party-transport.test.ts:6-51` — `FakePartySocket` (hoisted `vi.mock`) records
  constructor `opts` (so `opts.query()` is callable) and stubs static `fetch`
  (`Fake.fetch.mock.calls[i][1]` is the init object with headers). Model all token
  tests on this file's existing style.

- `src/server/sqlite-adapter.ts:172-185` — blob-mode apply (upsert / delete);
  blob rows round-trip through `_oplog` and `snapshot()` like structured ones.
  Existing blob test: `test/sqlite-adapter.test.ts:186-194` (insert + snapshot only).
  The suite's `setup()` helper at the top of that file builds the adapter over
  `memoryEngine()` with collections including a schema-less `logs` collection —
  read the file's first ~60 lines before adding cases; follow its `ins(channel, row)`
  helper style.

## Commands you will need

| Purpose   | Command                  | Expected on success |
|-----------|--------------------------|---------------------|
| Typecheck | `pnpm typecheck`         | exit 0              |
| Unit tests | `pnpm test`             | all pass            |

## Scope

**In scope**:
- `test/persist.test.ts`, `test/party-transport.test.ts`, `test/sqlite-adapter.test.ts` — new cases
- `src/client/party-db.ts` — the parse guard only (Step 4)

**Out of scope**:
- `src/client/collection.ts`, `src/client/sync-client.ts`, `src/client/seq-tracker.ts` —
  if a new test exposes a real bug in them, STOP and report; don't fix here.
- Integration suite — this plan is unit-level by design.

## Git workflow

- Branch: `advisor/007-client-test-gaps`
- Commit style: `test(client): persist rejections, token attachment, blob parity; guard socket JSON.parse`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: `persist` rejection cases (`test/persist.test.ts`)

Extend `mockClient` (or add variants) so `send`/`waitForSeq` can reject. Add:

1. `send` rejects (e.g. `new Error('409: constraint')`) → `persist({transaction})`
   rejects with **that same error instance**, and `waitForSeq` is never called.
2. `waitForSeq` rejects for one of two accepted seqs (settlement timeout shape) →
   `persist` rejects; both `waitForSeq` calls were made (Promise.all semantics).
3. Partial-managed transaction still awaits **every** accepted seq: ack lists two
   channels, both awaited (tightens the existing settlement test with an
   unmanaged-mutation mix).

**Verify**: `pnpm test -- persist` → all pass (7 existing + 3 new).

### Step 2: Token attachment cases (`test/party-transport.test.ts`)

Using the existing `FakePartySocket`:

1. Static token: `partyTransport({ host, room, token: 'tok-1' })` →
   `lastSocket().opts.query()` includes `{ token: 'tok-1' }`; after
   `transport.send([])`… (note: `send` always POSTs — pass a real one-batch array)
   → `Fake.fetch` called with init whose `headers.authorization === 'Bearer tok-1'`.
2. Function token re-read: a `vi.fn()` token returning `'a'` then `'b'` → first
   `send` uses `Bearer a`, second uses `Bearer b`; `query()` reflects the latest too.
3. No token: `query()` has no `token` key; fetch init has no `authorization` header.
4. Token + since compose: after a batch with `seq: 7` arrives, `query()` equals
   `{ since: '7', token: … }` (extends the existing since tests).

**Verify**: `pnpm test -- party-transport` → all pass.

### Step 3: Blob-mode parity (`test/sqlite-adapter.test.ts`)

In the blob describe block, mirroring the structured cases:

1. Update (blob mode treats any non-delete as upsert): write insert then an
   `update` op for the same key with changed fields → snapshot returns the new
   value; the resolved op echoes the **sent** row (blob mode's documented
   "resolved row equals the sent row").
2. Delete: insert, delete, snapshot → row gone; `_oplog` still carries both ops
   (`replaySince(0)` returns 2 batches in order).
3. `replaySince` mid-stream: three blob writes, `replaySince(1)` → seqs `[2, 3]`
   with the blob values intact.

**Verify**: `pnpm test -- sqlite-adapter` → all pass.

### Step 4: Guard the socket parse (`src/client/party-db.ts`)

Wrap the handler body so a malformed frame is dropped instead of thrown:

```ts
const handler = (e: MessageEvent) => {
  if (typeof e.data !== 'string') return
  let batch: SequencedBatch
  try {
    batch = JSON.parse(e.data)
  } catch {
    return // not ours; a proxy hiccup or foreign frame must not kill the stream
  }
  if (typeof batch.seq === 'number') lastSeq = Math.max(lastSeq ?? 0, batch.seq)
  onBatch(batch)
}
```

Match the file's comment tone. Then add to `test/party-transport.test.ts`:
emit a garbage frame (`{ data: 'not json' }`) and a binary-ish frame
(`{ data: new ArrayBuffer(4) }`) → subscriber not called, no throw; then a valid
batch → delivered, `query()` reflects its seq.

**Verify**: `pnpm test` → whole unit suite green.

## Test plan

The steps *are* the test plan: ~10 new unit cases across three existing files.
Full gate: `pnpm typecheck && pnpm test` → green (integration untouched:
`pnpm test:integration` should be a no-op pass if run).

## Done criteria

- [ ] `persist` rejection propagation covered (send-reject + waitForSeq-reject cases exist and pass)
- [ ] Token attachment covered (query token, bearer header, function re-read, absence)
- [ ] Blob-mode update/delete/replay parity cases exist and pass
- [ ] Malformed socket frames are dropped (code + test)
- [ ] `pnpm typecheck && pnpm test` exit 0; only in-scope files modified; `plans/README.md` updated

## STOP conditions

- Any new test exposes a real behavior bug in `makePersist`, `partyTransport`, or
  `applyBlob` (e.g. `persist` swallows a rejection, blob delete leaves the row) —
  report the failing assertion; the fix belongs in its own change, not this plan.
- `party-db.ts`'s handler already guards the parse (drift) — skip Step 4's code
  edit, still add the tests if missing.

## Maintenance notes

- The strict expectation "persist rejects with the same error instance" is what
  TanStack relies on to surface `WriteError` via `isPersisted.promise` — keep it
  strict in review.
- Blob mode is legacy-but-shipped (v0); these tests are its only regression net —
  don't delete them when v1 work touches the adapter.
