// D1Adapter unit tests: statement-list assembly and result-mapping, run against a
// node:sqlite-backed D1 shim (test/helpers/fake-d1.ts) so the actual assembled SQL
// executes — the oplog's in-SQL json_array builder included. The real workerd D1
// engine is exercised by the integration suite (d1.test.ts); this is the fast,
// white-box layer.

import { describe, it, expect, beforeEach } from 'vitest'
import { z } from 'zod'
import { D1Adapter } from '../src/server/d1-adapter.ts'
import { definePartyCollection } from '../src/schema.ts'
import type { WriteBatch } from '../src/protocol.ts'
import { FakeD1, asD1 } from './helpers/fake-d1.ts'

const todoSchema = z.object({
  id: z.string(),
  text: z.string(),
  done: z.boolean().optional(),
  rev: z.number().optional(),
  meta: z.object({}).passthrough().nullable().optional(),
})
const todos = definePartyCollection({ name: 'todos', key: 'id', schema: todoSchema })
const TODOS_DDL = `CREATE TABLE todos (id TEXT PRIMARY KEY, text TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0, rev INTEGER NOT NULL DEFAULT 1, meta TEXT)`

const ins = (value: Record<string, unknown>): WriteBatch => ({ channel: 'todos', ops: [{ type: 'insert', value }] })

async function setup(opts: { oplogRetention?: number } = {}) {
  const fake = new FakeD1()
  fake.db.exec(TODOS_DDL) // the app's table (we never DDL it)
  const adapter = new D1Adapter(asD1(fake), [todos], opts)
  await adapter.init()
  return { fake, adapter }
}

describe('D1Adapter — init', () => {
  it('creates the _oplog (and only the _oplog — never the app table)', async () => {
    const { fake } = await setup()
    const tables = fake.rows(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`).map((r) => r.name)
    expect(tables).toContain('_oplog')
    expect(tables).toContain('todos') // pre-existing, the app's
  })

  it('rejects a schema-less (blob) collection — uncontrolled mode is embedded-only', async () => {
    const fake = new FakeD1()
    const adapter = new D1Adapter(asD1(fake), [definePartyCollection({ name: 'logs', key: 'id' })])
    await expect(adapter.init()).rejects.toThrow(/embedded-only|no readable schema/i)
  })
})

describe('D1Adapter — write assembles ONE batch (CRUD + oplog + compaction)', () => {
  it('orders statements: per-batch CRUD, then that batch oplog INSERT, then compaction', async () => {
    const { fake, adapter } = await setup({ oplogRetention: 50 })
    fake.prepared.length = 0 // ignore init's DDL prepares (exec, not prepare, but be safe)
    await adapter.write([
      { channel: 'todos', ops: [{ type: 'insert', value: { id: 'a', text: 'x' } }, { type: 'insert', value: { id: 'b', text: 'y' } }] },
    ])
    // 2 CRUD inserts, 1 oplog INSERT, 1 compaction DELETE
    expect(fake.prepared).toHaveLength(4)
    expect(fake.prepared[0]).toMatch(/^INSERT INTO "todos"/)
    expect(fake.prepared[1]).toMatch(/^INSERT INTO "todos"/)
    expect(fake.prepared[2]).toMatch(/^INSERT INTO _oplog .* json_array\(/)
    expect(fake.prepared[2]).toMatch(/RETURNING seq$/)
    expect(fake.prepared[3]).toMatch(/^DELETE FROM _oplog/)
  })

  it('omits the compaction DELETE when retention is unbounded (0)', async () => {
    const { fake, adapter } = await setup()
    fake.prepared.length = 0
    await adapter.write([ins({ id: 'a', text: 'x' })])
    expect(fake.prepared.some((s) => s.startsWith('DELETE FROM _oplog'))).toBe(false)
  })

  it('interleaves multiple channel-batches: crud₁, oplog₁, crud₂, oplog₂', async () => {
    const { fake, adapter } = await setup()
    fake.prepared.length = 0
    await adapter.write([ins({ id: 'a', text: 'x' }), ins({ id: 'b', text: 'y' })])
    const kind = (s: string) => (s.startsWith('INSERT INTO _oplog') ? 'oplog' : s.startsWith('INSERT INTO "todos"') ? 'crud' : s.slice(0, 12))
    expect(fake.prepared.map(kind)).toEqual(['crud', 'oplog', 'crud', 'oplog'])
  })
})

describe('D1Adapter — result mapping (resolved rows + seq)', () => {
  it('maps each CRUD RETURNING row back to its resolved op, with DB defaults', async () => {
    const { adapter } = await setup()
    const [batch] = await adapter.write([ins({ id: 'a', text: 'hi' })]) // done/rev/meta omitted
    expect(batch.channel).toBe('todos')
    expect(batch.seq).toBe(1)
    expect(batch.ops).toEqual([{ type: 'insert', value: { id: 'a', text: 'hi', done: false, rev: 1, meta: null } }])
  })

  it('round-trips booleans and json columns in the resolved row', async () => {
    const { adapter } = await setup()
    const [batch] = await adapter.write([ins({ id: 'c', text: 't', done: true, meta: { tag: 'x', n: 2 } })])
    expect(batch.ops[0].value).toEqual({ id: 'c', text: 't', done: true, rev: 1, meta: { tag: 'x', n: 2 } })
  })

  it('assigns a monotonic seq per committed batch', async () => {
    const { adapter } = await setup()
    const a = await adapter.write([ins({ id: 'a', text: '1' })])
    const b = await adapter.write([ins({ id: 'b', text: '2' })])
    expect([a[0].seq, b[0].seq]).toEqual([1, 2])
  })

  it('update-of-a-missing-row is a no-op that echoes the sent value', async () => {
    const { fake, adapter } = await setup()
    const [batch] = await adapter.write([
      { channel: 'todos', ops: [{ type: 'update', value: { id: 'ghost', done: true }, previousValue: { id: 'ghost' } }] },
    ])
    expect(batch.ops[0].value).toEqual({ id: 'ghost', done: true }) // sent value, no crash
    expect(fake.rows(`SELECT COUNT(*) c FROM todos`)[0].c).toBe(0) // nothing created
    // and the oplog entry carries the sent value (the COALESCE fallback)
    const oplog = fake.rows(`SELECT ops FROM _oplog ORDER BY seq DESC LIMIT 1`)[0]
    expect(JSON.parse(oplog.ops as string)).toEqual([{ type: 'update', value: { id: 'ghost', done: true }, previousValue: { id: 'ghost' } }])
  })
})

describe('D1Adapter — atomicity: the oplog rolls back with the data', () => {
  it('a POST whose later batch violates a constraint commits NOTHING (data or oplog)', async () => {
    const { fake, adapter } = await setup()
    await adapter.write([ins({ id: 'a', text: 'seed' })]) // seq 1, real row
    await expect(
      adapter.write([
        ins({ id: 'b', text: 'valid' }), // would-be seq 2…
        ins({ id: 'a', text: 'dup' }), // …but PK collision rolls the whole POST back
      ]),
    ).rejects.toThrow(/constraint failed/i)
    // 'b' never landed, and the oplog gained no rows — the log rolled back with the data
    expect(fake.rows(`SELECT id FROM todos ORDER BY id`).map((r) => r.id)).toEqual(['a'])
    expect(fake.rows(`SELECT COUNT(*) c FROM _oplog`)[0].c).toBe(1) // only the first write's entry
  })
})

describe('D1Adapter — snapshot + replaySince (parity with embedded semantics)', () => {
  let fake: FakeD1
  let adapter: D1Adapter
  beforeEach(async () => {
    ;({ fake, adapter } = await setup({ oplogRetention: 3 }))
  })

  it('snapshot returns current rows with the latest seq, ready + reset', async () => {
    await adapter.write([ins({ id: 'a', text: '1' })])
    await adapter.write([ins({ id: 'b', text: '2' })])
    const snap = await adapter.snapshot()
    const t = snap.find((s) => s.channel === 'todos')!
    expect(t.ready).toBe(true)
    expect(t.reset).toBe(true)
    expect(t.seq).toBe(2)
    expect(new Set(t.ops.map((o) => (o.value as { id: string }).id))).toEqual(new Set(['a', 'b']))
  })

  it('replaySince returns only the resolved ops after the cursor, in order', async () => {
    await adapter.write([ins({ id: 'a', text: '1' })]) // seq 1
    await adapter.write([ins({ id: 'b', text: '2' })]) // seq 2
    const delta = await adapter.replaySince(1)
    expect(delta).not.toBeNull()
    expect(delta!.map((b) => b.seq)).toEqual([2])
    expect(delta![0].ops[0].value).toEqual({ id: 'b', text: '2', done: false, rev: 1, meta: null })
  })

  it('replaySince returns null when the cursor predates the compacted floor', async () => {
    // retention 3: after 5 writes the floor sits at seq 3, so a cursor of 1 is stale
    for (let i = 1; i <= 5; i++) await adapter.write([ins({ id: `r${i}`, text: `${i}` })])
    expect(await adapter.replaySince(1)).toBeNull()
    // a cursor inside the retained window still gets a delta
    const delta = await adapter.replaySince(4)
    expect(delta!.map((b) => b.seq)).toEqual([5])
  })

  it('replaySince returns an empty (complete) delta when the client missed nothing', async () => {
    await adapter.write([ins({ id: 'a', text: '1' })])
    expect(await adapter.replaySince(1)).toEqual([])
  })
})
