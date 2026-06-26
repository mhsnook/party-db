import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { SqliteAdapter } from '../src/server/sqlite-adapter.ts'
import { definePartyCollection } from '../src/schema.ts'
import { memoryEngine } from './helpers/sql-engine.ts'

// The app's own schemas + tables. The adapter never creates the structured
// tables — the app brings them; we only CRUD over them.
const todoSchema = z.object({
  id: z.string(),
  text: z.string(),
  done: z.boolean(),
  meta: z.object({}).passthrough().nullable().optional(),
})
const noteSchema = z.object({
  id: z.number().optional(), // serial PK, assigned by the DB
  body: z.string(),
  created: z.string().optional(), // DB default
})

const collections = [
  definePartyCollection({ name: 'todos', key: 'id', schema: todoSchema }),
  definePartyCollection({ name: 'notes', key: 'id', schema: noteSchema }),
  definePartyCollection({ name: 'logs', key: 'id' }), // no schema → blob fallback
]

function setup() {
  const { engine, db } = memoryEngine()
  // the app's migrations — its tables, its constraints, its defaults/serials.
  db.exec(`CREATE TABLE todos (
     id TEXT PRIMARY KEY,
     text TEXT NOT NULL,
     done INTEGER NOT NULL DEFAULT 0,
     meta TEXT
   )`)
  db.exec(`CREATE TABLE notes (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     body TEXT NOT NULL,
     created TEXT NOT NULL DEFAULT 'genesis'
   )`)
  const adapter = new SqliteAdapter(engine, collections)
  adapter.init()
  return { engine, db, adapter }
}

const ins = (channel: string, value: Record<string, unknown>) => ({
  channel,
  ops: [{ type: 'insert' as const, value }],
})

describe('SqliteAdapter — init', () => {
  it('creates the _oplog and the blob table it owns, but not the app tables', () => {
    const { db } = setup()
    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`)
      .all()
      .map((r: any) => r.name)
    expect(tables).toContain('_oplog')
    expect(tables).toContain('logs') // blob table is ours to make
    expect(tables).toContain('todos') // pre-existing (the app made it)
    // never an attempt to recreate / shadow the app's structured table
  })
})

describe('SqliteAdapter — structured CRUD against typed columns', () => {
  it('inserts into real columns and returns the decoded resolved row', async () => {
    const { db, adapter } = setup()
    const [batch] = await adapter.write([ins('todos', { id: 'a', text: 'hi', done: false })])

    // landed in typed columns, not a blob
    const row = db.prepare(`SELECT id, text, done, meta FROM todos WHERE id='a'`).get() as any
    expect(row).toEqual({ id: 'a', text: 'hi', done: 0, meta: null }) // boolean stored as 0

    // resolved op carries the schema-shaped row (done back to a real boolean)
    expect(batch.seq).toBe(1)
    expect(batch.ops).toEqual([{ type: 'insert', value: { id: 'a', text: 'hi', done: false, meta: null } }])
  })

  it('fills DB defaults into the resolved row (column omitted by the client)', async () => {
    const { adapter } = setup()
    const [batch] = await adapter.write([ins('todos', { id: 'b', text: 'no done sent' })])
    expect((batch.ops[0].value as any).done).toBe(false) // DEFAULT 0 → decoded boolean
  })

  it('supports DB-assigned serial PKs via the resolved row', async () => {
    const { adapter } = setup()
    const [batch] = await adapter.write([ins('notes', { body: 'first' })])
    expect(batch.ops[0].value).toEqual({ id: 1, body: 'first', created: 'genesis' })
    const [batch2] = await adapter.write([ins('notes', { body: 'second' })])
    expect((batch2.ops[0].value as any).id).toBe(2)
  })

  it('round-trips booleans and json columns faithfully', async () => {
    const { adapter } = setup()
    await adapter.write([ins('todos', { id: 'c', text: 't', done: true, meta: { tag: 'x', n: 2 } })])
    const snap = await adapter.snapshot()
    const todos = snap.find((b) => b.channel === 'todos')!
    expect(todos.ops[0].value).toEqual({ id: 'c', text: 't', done: true, meta: { tag: 'x', n: 2 } })
  })

  it('updates only the columns the client sent, keeping the rest', async () => {
    const { db, adapter } = setup()
    await adapter.write([ins('todos', { id: 'a', text: 'orig', done: false })])
    const [batch] = await adapter.write([
      { channel: 'todos', ops: [{ type: 'update', value: { id: 'a', done: true }, previousValue: { id: 'a', done: false } }] },
    ])
    expect(batch.ops[0].value).toEqual({ id: 'a', text: 'orig', done: true, meta: null }) // text untouched
    const row = db.prepare(`SELECT text, done FROM todos WHERE id='a'`).get() as any
    expect(row).toEqual({ text: 'orig', done: 1 })
  })

  it('treats an update of a nonexistent row as a no-op (returns the sent value)', async () => {
    const { db, adapter } = setup()
    const [batch] = await adapter.write([
      { channel: 'todos', ops: [{ type: 'update', value: { id: 'ghost', done: true }, previousValue: { id: 'ghost' } }] },
    ])
    expect(batch.ops[0].value).toEqual({ id: 'ghost', done: true }) // sent value, no crash
    expect(db.prepare(`SELECT COUNT(*) c FROM todos`).get()).toEqual({ c: 0 }) // nothing created
  })

  it('deletes the row by key', async () => {
    const { db, adapter } = setup()
    await adapter.write([ins('todos', { id: 'a', text: 'x', done: false })])
    await adapter.write([{ channel: 'todos', ops: [{ type: 'delete', value: { id: 'a' } }] }])
    expect(db.prepare(`SELECT COUNT(*) c FROM todos`).get()).toEqual({ c: 0 })
  })
})

describe('SqliteAdapter — the database is the authority', () => {
  it('rejects a constraint violation (PK collision) by throwing', async () => {
    const { adapter } = setup()
    await adapter.write([ins('todos', { id: 'a', text: 'x', done: false })])
    await expect(adapter.write([ins('todos', { id: 'a', text: 'dup', done: false })])).rejects.toThrow()
  })

  it('rejects a NOT NULL violation surfaced from the app schema', async () => {
    const { adapter } = setup()
    // text is NOT NULL in the app table; sending null is the DB's call to reject
    await expect(adapter.write([ins('todos', { id: 'z', text: null, done: false })])).rejects.toThrow()
  })

  it('commits the whole POST atomically — one failing batch rolls back the rest', async () => {
    const { db, adapter } = setup()
    await adapter.write([ins('todos', { id: 'a', text: 'x', done: false })]) // seed a conflict
    await expect(
      adapter.write([
        ins('notes', { body: 'should not survive' }), // valid…
        ins('todos', { id: 'a', text: 'dup', done: false }), // …but this fails
      ]),
    ).rejects.toThrow()
    // the valid batch must have rolled back too
    expect(db.prepare(`SELECT COUNT(*) c FROM notes`).get()).toEqual({ c: 0 })
  })
})

describe('SqliteAdapter — oplog: seq, snapshot, replaySince', () => {
  it('assigns a monotonic seq per committed batch', async () => {
    const { adapter } = setup()
    const a = await adapter.write([ins('todos', { id: 'a', text: '1', done: false })])
    const b = await adapter.write([ins('todos', { id: 'b', text: '2', done: false })])
    expect([a[0].seq, b[0].seq]).toEqual([1, 2])
  })

  it('snapshot returns current rows per channel with the latest seq and ready', async () => {
    const { adapter } = setup()
    await adapter.write([ins('todos', { id: 'a', text: '1', done: false })])
    await adapter.write([ins('notes', { body: 'n' })])
    const snap = await adapter.snapshot()
    const todos = snap.find((b) => b.channel === 'todos')!
    expect(todos.ready).toBe(true)
    expect(todos.seq).toBe(2) // max seq across the room
    expect(todos.ops).toEqual([{ type: 'insert', value: { id: 'a', text: '1', done: false, meta: null } }])
  })

  it('replaySince returns only the resolved ops after the cursor, in order', async () => {
    const { adapter } = setup()
    await adapter.write([ins('notes', { body: 'one' })]) // seq 1
    await adapter.write([ins('notes', { body: 'two' })]) // seq 2
    const delta = await adapter.replaySince(1)
    expect(delta).not.toBeNull()
    expect(delta!.map((b) => b.seq)).toEqual([2])
    expect(delta![0].ops[0].value).toEqual({ id: 2, body: 'two', created: 'genesis' }) // resolved, from the oplog
  })
})

describe('SqliteAdapter — blob fallback (schema-less collection)', () => {
  it('stores a schema-less collection as a blob and snapshots it back', async () => {
    const { adapter } = setup()
    await adapter.write([ins('logs', { id: 'l1', anything: { nested: true }, n: 5 })])
    const snap = await adapter.snapshot()
    const logs = snap.find((b) => b.channel === 'logs')!
    expect(logs.ops[0].value).toEqual({ id: 'l1', anything: { nested: true }, n: 5 })
  })
})

describe('SqliteAdapter — injection safety', () => {
  it('builds column lists from the schema allowlist, ignoring stray payload keys', async () => {
    const { db, adapter } = setup()
    // a client tries to smuggle an extra/never-declared column
    await adapter.write([ins('todos', { id: 'a', text: 'ok', done: false, ['evil) ; DROP TABLE todos --']: 1 })])
    // the table still exists and only the declared columns were written
    expect(db.prepare(`SELECT COUNT(*) c FROM todos`).get()).toEqual({ c: 1 })
    const row = db.prepare(`SELECT id, text, done FROM todos WHERE id='a'`).get() as any
    expect(row).toEqual({ id: 'a', text: 'ok', done: 0 })
  })

  it('rejects an unsafe collection name at construction', () => {
    const { engine } = memoryEngine()
    expect(() => new SqliteAdapter(engine, [{ name: 'bad; drop', key: 'id' } as any])).toThrow(/unsafe SQL identifier/)
  })
})
