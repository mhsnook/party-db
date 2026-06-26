import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { SqliteAdapter } from '../src/server/sqlite-adapter.ts'
import { definePartyCollection } from '../src/schema.ts'
import { memoryEngine } from './helpers/sql-engine.ts'

// A schema-less collection keeps these tests focused on the _oplog itself: the
// adapter owns the blob table, so there's no app DDL to stand up.
const collections = [definePartyCollection({ name: 'feed', key: 'id' })]

function setup(oplogRetention?: number) {
  const { engine, db } = memoryEngine()
  const adapter = new SqliteAdapter(engine, collections, { oplogRetention })
  adapter.init()
  const post = (id: string) => adapter.write([{ channel: 'feed', ops: [{ type: 'insert', value: { id } }] }])
  const oplogSeqs = () =>
    db.prepare(`SELECT seq FROM _oplog ORDER BY seq`).all().map((r: any) => r.seq)
  return { adapter, db, post, oplogSeqs }
}

describe('oplog retention / compaction', () => {
  it('does not trim when retention is unset (v0 behavior: grows unbounded)', async () => {
    const { post, oplogSeqs } = setup()
    for (const id of ['a', 'b', 'c', 'd', 'e']) await post(id)
    expect(oplogSeqs()).toEqual([1, 2, 3, 4, 5])
  })

  it('keeps only the most recent N rows after each write', async () => {
    const { post, oplogSeqs } = setup(3)
    for (const id of ['a', 'b', 'c', 'd', 'e']) await post(id)
    expect(oplogSeqs()).toEqual([3, 4, 5]) // the last 3
  })

  it('never reuses a seq after compaction (AUTOINCREMENT, contiguous suffix)', async () => {
    const { post, oplogSeqs } = setup(2)
    for (const id of ['a', 'b', 'c']) await post(id)
    expect(oplogSeqs()).toEqual([2, 3])
    const [batch] = await post('d')
    expect(batch.seq).toBe(4) // not reset to 1; monotonic across compaction
    expect(oplogSeqs()).toEqual([3, 4])
  })

  it('leaves the data tables intact — compaction only touches the _oplog', async () => {
    const { post, adapter } = setup(1)
    for (const id of ['a', 'b', 'c']) await post(id)
    const snap = await adapter.snapshot()
    const feed = snap.find((b) => b.channel === 'feed')!
    expect(feed.ops.map((o) => (o.value as any).id).sort()).toEqual(['a', 'b', 'c'])
  })
})

describe('replaySince — floor fallback after compaction', () => {
  it('serves a normal delta when the cursor is still within the retained window', async () => {
    const { post, adapter } = setup(10)
    for (const id of ['a', 'b', 'c']) await post(id)
    const delta = await adapter.replaySince(1)
    expect(delta).not.toBeNull()
    expect(delta!.map((b) => b.seq)).toEqual([2, 3])
  })

  it('serves a delta starting exactly at the oldest retained seq (boundary)', async () => {
    const { post, adapter } = setup(2)
    for (const id of ['a', 'b', 'c', 'd']) await post(id) // retained: seq 3,4
    // client last saw seq 2 → needs 3,4 → still retained → delta, not snapshot
    const delta = await adapter.replaySince(2)
    expect(delta).not.toBeNull()
    expect(delta!.map((b) => b.seq)).toEqual([3, 4])
  })

  it('returns null (→ snapshot) when the cursor predates the retained window', async () => {
    const { post, adapter } = setup(2)
    for (const id of ['a', 'b', 'c', 'd']) await post(id) // retained: seq 3,4
    // client last saw seq 1 → needs seq 2, which was compacted → gappy → snapshot
    expect(await adapter.replaySince(1)).toBeNull()
    expect(await adapter.replaySince(0)).toBeNull()
  })

  it('treats an empty delta (caught up) as complete, not a floor breach', async () => {
    const { post, adapter } = setup(2)
    for (const id of ['a', 'b']) await post(id)
    const delta = await adapter.replaySince(2) // already at head
    expect(delta).toEqual([])
  })

  it('serves a delta from 0 on an empty oplog (no floor to breach)', async () => {
    const { adapter } = setup(2)
    expect(await adapter.replaySince(0)).toEqual([])
  })
})

describe('snapshot/seq consistency (single-threaded invariant, locked)', () => {
  // The snapshot must be a consistent cut: the rows it returns are EXACTLY the
  // state produced by folding the oplog up to the seq it reports. If a future
  // refactor let a write slip between reading the watermark and reading the rows,
  // this would catch the drift.
  it('the reported seq matches the folded oplog state', async () => {
    const { post, adapter } = setup()
    for (const id of ['a', 'b', 'c']) await post(id)
    const snap = await adapter.snapshot()
    const feed = snap.find((b) => b.channel === 'feed')!

    // fold the full oplog (since 0) and confirm it reconstructs the snapshot's
    // rows, and that the snapshot's seq is the head of that same log.
    const log = (await adapter.replaySince(0))!
    expect(feed.seq).toBe(Math.max(...log.map((b) => Number(b.seq))))
    const folded = new Map<string, unknown>()
    for (const b of log) for (const op of b.ops) folded.set((op.value as any).id, op.value)
    const snapshotRows = new Map(feed.ops.map((o) => [(o.value as any).id, o.value]))
    expect(snapshotRows).toEqual(folded)
  })
})
