// PgAdapter unit tests, run against the REAL Postgres from the harness (skips when
// PG_URL is unset, like every PG lane). These are the bulk of the adapter's
// coverage: the workerd integration lane (test/integration/pg.test.ts) proves the
// same behaviour end-to-end through a Durable Object, but the semantics — resolved
// rows, whole-POST atomicity incl. the oplog, compaction + floor, injection
// safety, SQLSTATE classification — are pinned here where a real client is cheap.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import pg from 'pg'
import { z } from 'zod'
import { PgAdapter, type PgClient } from '../../src/server/pg-adapter.ts'
import { SqliteAdapter } from '../../src/server/sqlite-adapter.ts'
import { definePartyCollection } from '../../src/schema.ts'
import type { WriteBatch } from '../../src/protocol.ts'
import { memoryEngine } from '../helpers/sql-engine.ts'

const PG_URL = process.env.PG_URL

const todoSchema = z.object({
  id: z.string(),
  text: z.string(),
  done: z.boolean().optional(),
  rev: z.number().optional(),
  meta: z.object({}).passthrough().nullable().optional(),
})
const noteSchema = z.object({
  id: z.number().optional(), // serial PK, assigned by the DB
  body: z.string(),
  created: z.string().optional(), // DB default
})
const todos = definePartyCollection({ name: 'todos', key: 'id', schema: todoSchema })
const notes = definePartyCollection({ name: 'notes', key: 'id', schema: noteSchema })
const collections = [todos, notes]

// The app's own tables — the adapter never DDLs these; it only CRUDs over them.
// Postgres-native column types where SQLite had its narrow set: boolean (not 0/1),
// jsonb (not text), serial (not AUTOINCREMENT).
const PG_DDL = [
  `CREATE TABLE todos (id text PRIMARY KEY, text text NOT NULL, done boolean NOT NULL DEFAULT false, rev integer NOT NULL DEFAULT 1, meta jsonb)`,
  `CREATE TABLE notes (id serial PRIMARY KEY, body text NOT NULL, created text NOT NULL DEFAULT 'genesis')`,
]

const ins = (value: Record<string, unknown>, channel = 'todos'): WriteBatch => ({ channel, ops: [{ type: 'insert', value }] })

describe.skipIf(!PG_URL)('PgAdapter (real Postgres)', () => {
  let client: pg.Client
  // wrap the pg.Client as the narrow PgClient the adapter accepts, and hand it back
  // from the factory. A single connection is right: the server serializes writes, so
  // there's only ever one transaction on it at a time — and the tests query the same
  // connection for assertions between adapter calls (no transaction is ever left open).
  const pgc: PgClient = { query: (text, values) => client.query(text, values) as any }

  beforeAll(async () => {
    client = new pg.Client({ connectionString: PG_URL })
    await client.connect()
  })
  afterAll(async () => {
    await client?.query('DROP TABLE IF EXISTS todos, notes, _oplog')
    await client?.end()
  })

  async function setup(opts: { oplogRetention?: number } = {}) {
    await client.query('DROP TABLE IF EXISTS todos, notes, _oplog')
    for (const ddl of PG_DDL) await client.query(ddl)
    const adapter = new PgAdapter(() => Promise.resolve(pgc), collections, opts)
    await adapter.init()
    return adapter
  }

  const rows = async (sql: string) => (await client.query(sql)).rows
  const count = async (table: string) => Number((await client.query(`SELECT count(*)::int AS c FROM ${table}`)).rows[0].c)

  describe('init', () => {
    it('creates the _oplog (BIGSERIAL/JSONB) — and only the _oplog, never the app table', async () => {
      await setup()
      const tables = (await rows(`SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename`)).map((r) => r.tablename)
      expect(tables).toContain('_oplog')
      expect(tables).toContain('todos') // pre-existing, the app's
      // seq is a bigint (BIGSERIAL); ops is jsonb
      const cols = await rows(`SELECT column_name, data_type FROM information_schema.columns WHERE table_name='_oplog'`)
      expect(cols.find((c) => c.column_name === 'seq')?.data_type).toBe('bigint')
      expect(cols.find((c) => c.column_name === 'ops')?.data_type).toBe('jsonb')
    })

    it('rejects a schema-less (blob) collection — uncontrolled mode is embedded-only', async () => {
      const adapter = new PgAdapter(() => Promise.resolve(pgc), [definePartyCollection({ name: 'logs', key: 'id' })])
      await expect(adapter.init()).rejects.toThrow(/embedded-only|no readable schema/i)
    })
  })

  describe('write — resolved rows', () => {
    it('applies DB defaults and hands back the resolved row (booleans native, jsonb parsed)', async () => {
      const adapter = await setup()
      const [batch] = await adapter.write([ins({ id: 'a', text: 'hi' })]) // done/rev/meta omitted
      expect(batch.channel).toBe('todos')
      expect(batch.seq).toBe(1)
      expect(batch.ops).toEqual([{ type: 'insert', value: { id: 'a', text: 'hi', done: false, rev: 1, meta: null } }])
    })

    it('round-trips booleans and jsonb columns in the resolved row', async () => {
      const adapter = await setup()
      const [batch] = await adapter.write([ins({ id: 'c', text: 't', done: true, meta: { tag: 'x', n: 2 } })])
      expect(batch.ops[0].value).toEqual({ id: 'c', text: 't', done: true, rev: 1, meta: { tag: 'x', n: 2 } })
    })

    it('hands back a DB-assigned serial PK and default (notes)', async () => {
      const adapter = await setup()
      const [batch] = await adapter.write([ins({ body: 'first' }, 'notes')]) // id serial, created default
      expect(batch.ops[0].value).toEqual({ id: 1, body: 'first', created: 'genesis' })
    })

    it('assigns a monotonic seq per committed batch', async () => {
      const adapter = await setup()
      const a = await adapter.write([ins({ id: 'a', text: '1' })])
      const b = await adapter.write([ins({ id: 'b', text: '2' })])
      expect([a[0].seq, b[0].seq]).toEqual([1, 2])
    })

    it('ignores payload keys outside the schema allowlist (injection safety)', async () => {
      const adapter = await setup()
      // a smuggled column name that isn't in the schema must never reach the SQL —
      // the allowlist is the schema's columns, not the payload's keys.
      const [batch] = await adapter.write([ins({ id: 'a', text: 'hi', 'evil"; DROP TABLE todos; --': 1 } as Record<string, unknown>)])
      expect(batch.ops[0].value).toEqual({ id: 'a', text: 'hi', done: false, rev: 1, meta: null })
      expect(await count('todos')).toBe(1) // table intact, one row
    })

    it('update-of-a-missing-row is a no-op that echoes the sent value', async () => {
      const adapter = await setup()
      const [batch] = await adapter.write([
        { channel: 'todos', ops: [{ type: 'update', value: { id: 'ghost', done: true }, previousValue: { id: 'ghost' } }] },
      ])
      expect(batch.ops[0].value).toEqual({ id: 'ghost', done: true }) // sent value, no crash
      expect(await count('todos')).toBe(0) // nothing created
      // and the oplog entry carries the sent value (JSONB round-trips, no parse)
      const oplog = (await rows(`SELECT ops FROM _oplog ORDER BY seq DESC LIMIT 1`))[0]
      expect(oplog.ops).toEqual([{ type: 'update', value: { id: 'ghost', done: true }, previousValue: { id: 'ghost' } }])
    })
  })

  describe('write — whole-POST atomicity (data + oplog + seq)', () => {
    it('a POST whose later batch violates a constraint commits NOTHING, and burns the seq', async () => {
      const adapter = await setup()
      await adapter.write([ins({ id: 'a', text: 'seed' })]) // seq 1, real row

      await expect(
        adapter.write([
          ins({ id: 'b', text: 'valid' }), // would-be next seq…
          ins({ id: 'a', text: 'dup' }), // …but the PK collision rolls the whole POST back
        ]),
      ).rejects.toMatchObject({ code: '23505' })

      // 'b' never landed; only the seed remains; the _oplog did not grow
      expect((await rows(`SELECT id FROM todos ORDER BY id`)).map((r) => r.id)).toEqual(['a'])
      expect(await count('_oplog')).toBe(1)

      // the BIGSERIAL advanced during the rolled-back attempt (Postgres sequences
      // are non-transactional), so the seq it allocated was BURNED, not emitted: the
      // next successful write is seq 3, not 2. Harmless — nothing assumes contiguity.
      const [after] = await adapter.write([ins({ id: 'after', text: 'ok' })])
      expect(after.seq).toBe(3)
    })
  })

  describe('snapshot + replaySince (parity with the other modes)', () => {
    it('snapshot returns current rows at the latest seq, ready + reset', async () => {
      const adapter = await setup({ oplogRetention: 3 })
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
      const adapter = await setup({ oplogRetention: 3 })
      await adapter.write([ins({ id: 'a', text: '1' })]) // seq 1
      await adapter.write([ins({ id: 'b', text: '2' })]) // seq 2
      const delta = await adapter.replaySince(1)
      expect(delta).not.toBeNull()
      expect(delta!.map((b) => b.seq)).toEqual([2])
      expect(delta![0].ops[0].value).toEqual({ id: 'b', text: '2', done: false, rev: 1, meta: null })
    })

    it('replaySince returns null when the cursor predates the compacted floor', async () => {
      const adapter = await setup({ oplogRetention: 3 })
      for (let i = 1; i <= 5; i++) await adapter.write([ins({ id: `r${i}`, text: `${i}` })])
      // retention 3, seqs 1..5 contiguous (no rollbacks) → floor at seq 3
      expect(await adapter.replaySince(1)).toBeNull()
      const delta = await adapter.replaySince(4)
      expect(delta!.map((b) => b.seq)).toEqual([5])
    })

    it('replaySince returns an empty (complete) delta when the client missed nothing', async () => {
      const adapter = await setup()
      await adapter.write([ins({ id: 'a', text: '1' })])
      expect(await adapter.replaySince(1)).toEqual([])
    })
  })

  describe('classifyError (SQLSTATE → WriteReject with the constraint name)', () => {
    it('maps a unique violation to a 409-shaped rejection carrying the real constraint name', async () => {
      const adapter = await setup()
      await adapter.write([ins({ id: 'dup', text: 'first' })])
      let err: unknown
      try {
        await adapter.write([ins({ id: 'dup', text: 'again' })])
      } catch (e) {
        err = e
      }
      const rejection = adapter.classifyError(err)
      expect(rejection).not.toBeNull()
      expect(rejection!.constraint).toBe('todos_pkey') // the PK constraint's real name
      expect(rejection!.error).toMatch(/duplicate key|todos_pkey/i)
    })

    it('returns null for a non-constraint (internal) error, so the server 500s it', async () => {
      const adapter = await setup()
      expect(adapter.classifyError(new Error('boom'))).toBeNull()
      expect(adapter.classifyError({ code: '42P01' })).toBeNull() // undefined_table is not a 23-class
    })
  })
})

// Step-1 parity: the wire must not care which database resolved a write. The same
// logical batch, applied through the SQLite adapter (node:sqlite) and the Postgres
// adapter, must resolve to deep-equal ops — proving the dialect seam (placeholders,
// codec) preserves the resolved shape across engines.
describe.skipIf(!PG_URL)('wire parity: SQLite vs Postgres resolve the same ops', () => {
  let client: pg.Client
  const pgc: PgClient = { query: (text, values) => client.query(text, values) as any }
  beforeAll(async () => {
    client = new pg.Client({ connectionString: PG_URL })
    await client.connect()
  })
  afterAll(async () => {
    await client?.query('DROP TABLE IF EXISTS todos, notes, _oplog')
    await client?.end()
  })

  async function pgAdapter() {
    await client.query('DROP TABLE IF EXISTS todos, notes, _oplog')
    for (const ddl of PG_DDL) await client.query(ddl)
    const a = new PgAdapter(() => Promise.resolve(pgc), collections)
    await a.init()
    return a
  }
  function sqliteAdapter() {
    const { engine, db } = memoryEngine()
    // the same logical tables in SQLite's narrow types: boolean→INTEGER 0/1, jsonb→TEXT
    db.exec(`CREATE TABLE todos (id TEXT PRIMARY KEY, text TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0, rev INTEGER NOT NULL DEFAULT 1, meta TEXT)`)
    db.exec(`CREATE TABLE notes (id INTEGER PRIMARY KEY AUTOINCREMENT, body TEXT NOT NULL, created TEXT NOT NULL DEFAULT 'genesis')`)
    const a = new SqliteAdapter(engine, collections)
    a.init()
    return a
  }

  it.each([
    { name: 'insert with DB defaults', batch: ins({ id: 'a', text: 'hi' }) },
    { name: 'boolean + jsonb round-trip', batch: ins({ id: 'b', text: 't', done: true, meta: { tag: 'x', n: 2 } }) },
    { name: 'explicit false + null json', batch: ins({ id: 'c', text: 'u', done: false, meta: null }) },
    { name: 'serial PK + default (notes)', batch: ins({ body: 'first' }, 'notes') },
  ])('$name resolves deep-equal on both engines', async ({ batch }) => {
    const pgA = await pgAdapter()
    const sqlA = sqliteAdapter()
    const [pgBatch] = await pgA.write([batch])
    const [sqlBatch] = await sqlA.write([batch])
    expect(pgBatch.ops).toEqual(sqlBatch.ops)
  })
})
