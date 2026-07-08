import { describe, it, expect } from 'vitest'
import type { SequencedBatch } from '../../src/protocol.ts'
import { connect, insert, post } from './helpers.ts'

// The worker under test sets `oplogRetention = 50` (test/integration/worker.ts).
// Past that floor the _oplog is compacted, so a reconnecting client whose `since`
// predates the retained window must be handed a fresh snapshot — never a gappy
// delta. These tests drive `PartyDbServer.onConnect`'s fallback branches (the
// stale-cursor and garbage-cursor paths) that no other integration test exercises.
const RETENTION = 50

// Fill a fresh room with `n` single-insert writes (seqs 1..n). With n > RETENTION
// this forces compaction, moving the oplog floor above seq 1.
async function seed(room: string, n: number) {
  for (let i = 1; i <= n; i++) {
    const res = await post(room, insert(`r${i}`, `row ${i}`))
    expect(res.status).toBe(200)
  }
}

describe('reconnect falls back to a snapshot when the cursor predates the oplog', () => {
  it('stale ?since (older than the compacted floor) → fresh snapshot with every row', async () => {
    const room = 'reconnect-stale'
    const total = RETENTION + 10 // 60 writes: after compaction the floor sits at seq 11
    await seed(room, total)

    // seq 1 fell out of the retained window (min is now 11), so a delta would drop
    // rows — onConnect must send a full snapshot instead.
    const c = await connect(room, 1)
    await c.waitFor(1)
    const first = c.batches[0] as SequencedBatch
    // snapshot sentinel, not a delta
    expect(first.ready).toBe(true)
    expect(first.seq).toBe(total)
    // the snapshot carries the whole table, not just the tail after the floor
    expect(first.ops).toHaveLength(total)
    const ids = new Set(first.ops.map((op) => (op.value as { id: string }).id))
    expect(ids).toEqual(new Set(Array.from({ length: total }, (_, i) => `r${i + 1}`)))
    c.ws.close()
  })

  it('an in-window ?since just above the compacted floor still gets a delta', async () => {
    const room = 'reconnect-in-window'
    const total = RETENTION + 10 // floor at seq 11; seq 58 is comfortably retained
    await seed(room, total)

    // a client that already applied up to seq total-2 reconnects; it should get
    // only the two batches it missed, not a snapshot.
    const c = await connect(room, total - 2)
    await c.waitFor(2)
    expect(c.batches.map((b) => b.seq)).toEqual([total - 1, total])
    // a delta is not a snapshot: no `ready` sentinel
    expect(c.batches.every((b) => b.ready === undefined)).toBe(true)
    expect((c.batches[1].ops[0].value as { id: string }).id).toBe(`r${total}`)
    c.ws.close()
  })
})

describe('reconnect falls back to a snapshot when ?since is garbage', () => {
  it('non-numeric ?since=abc → fresh snapshot', async () => {
    const room = 'reconnect-garbage-nan'
    await post(room, insert('g1', 'one'))
    // NaN cursor → cursorParam returns null → snapshot
    const c = await connect(room, 'abc' as unknown as number)
    await c.waitFor(1)
    expect(c.batches[0].ready).toBe(true)
    expect((c.batches[0].ops[0].value as { id: string }).id).toBe('g1')
    c.ws.close()
  })

  it('negative ?since=-5 → fresh snapshot', async () => {
    const room = 'reconnect-garbage-neg'
    await post(room, insert('g1', 'one'))
    // negative cursor → cursorParam returns null → snapshot
    const c = await connect(room, -5)
    await c.waitFor(1)
    expect(c.batches[0].ready).toBe(true)
    expect((c.batches[0].ops[0].value as { id: string }).id).toBe('g1')
    c.ws.close()
  })
})
