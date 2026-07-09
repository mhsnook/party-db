// The shared statement builders (src/server/statements.ts), and — the load-bearing
// case — PARITY between the two ways the oplog's resolved-op JSON gets built:
//   - the embedded adapter decodes the RETURNING row in JS (`resolveStructured` →
//     `decodeRow`) and JSON.stringifies it, vs.
//   - `resolvedOpJsonExpr`, which assembles the same JSON *in SQL* (what D1 runs).
// If these ever diverge, the D1 oplog would replay silently-different rows than the
// embedded one. So we run the same writes through both and assert the stored `ops`
// parse to deep-equal values.

import { describe, it, expect } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { SqliteAdapter } from '../src/server/sqlite-adapter.ts'
import { definePartyCollection } from '../src/schema.ts'
import {
  buildPlans,
  oplogInsertStmt,
  resolvedOpJsonExpr,
  structuredStmt,
  type StructuredPlan,
} from '../src/server/statements.ts'
import type { WriteBatch } from '../src/protocol.ts'
import { memoryEngine } from './helpers/sql-engine.ts'

// One schema/table exercising every column kind the codec distinguishes:
// scalar-string (id, text), scalar-number (rev), boolean (done), json (meta).
const todoSchema = z.object({
  id: z.string(),
  text: z.string(),
  done: z.boolean().optional(),
  rev: z.number().optional(),
  meta: z.object({}).passthrough().nullable().optional(),
})
const collection = definePartyCollection({ name: 'todos', key: 'id', schema: todoSchema })
const TODOS_DDL = `CREATE TABLE todos (
   id TEXT PRIMARY KEY,
   text TEXT NOT NULL,
   done INTEGER NOT NULL DEFAULT 0,
   rev INTEGER NOT NULL DEFAULT 1,
   meta TEXT
 )`
const OPLOG_DDL = `CREATE TABLE _oplog (seq INTEGER PRIMARY KEY AUTOINCREMENT, channel TEXT NOT NULL, ops TEXT NOT NULL)`

const plan = buildPlans([collection]).get('todos') as StructuredPlan

// The embedded path: run the sequence through SqliteAdapter, read back each oplog
// row's parsed ops. This is the JS-decode-then-stringify side of the parity.
function embeddedOplog(batches: WriteBatch[]): unknown[] {
  const { engine, db } = memoryEngine()
  db.exec(TODOS_DDL)
  const adapter = new SqliteAdapter(engine, [collection])
  adapter.init()
  for (const b of batches) void adapter.write([b])
  return db
    .prepare(`SELECT ops FROM _oplog ORDER BY seq`)
    .all()
    .map((r: any) => JSON.parse(r.ops))
}

// The SQL-assembled path (what D1 runs): apply each batch's CRUD statements then
// its oplog INSERT built from `resolvedOpJsonExpr`, on a plain node:sqlite (the
// same SQLite JSON functions D1 has). Read back each oplog row's parsed ops.
function sqlOplog(batches: WriteBatch[]): unknown[] {
  const db = new DatabaseSync(':memory:')
  db.exec(TODOS_DDL)
  db.exec(OPLOG_DDL)
  for (const b of batches) {
    for (const op of b.ops) {
      const { sql, binds } = structuredStmt(plan, op)
      db.prepare(sql).all(...(binds as any[]))
    }
    const { sql, binds } = oplogInsertStmt(b.channel, b.ops, plan)
    db.prepare(sql).all(...(binds as any[]))
  }
  return db
    .prepare(`SELECT ops FROM _oplog ORDER BY seq`)
    .all()
    .map((r: any) => JSON.parse(r.ops))
}

// Assert the two paths produce deep-equal oplog ops for the same write sequence.
function expectParity(batches: WriteBatch[]) {
  const embedded = embeddedOplog(batches)
  const sql = sqlOplog(batches)
  expect(sql).toEqual(embedded)
  return embedded
}

const insert = (value: Record<string, unknown>): WriteBatch => ({ channel: 'todos', ops: [{ type: 'insert', value }] })

describe('resolvedOpJsonExpr — per-column-kind SQL shape', () => {
  it('mirrors decode per kind: boolean via CASE, json via json(), scalar bare', () => {
    const { expr } = resolvedOpJsonExpr(plan, { type: 'insert', value: { id: 'a', text: 't' } })
    // boolean column → a JSON true/false/null, never a bare 0/1 or the string "true"
    expect(expr).toContain(`json(CASE WHEN "done" IS NULL THEN 'null' WHEN "done" = 0 THEN 'false' ELSE 'true' END)`)
    // json column → re-parsed so it embeds as an object, not double-encoded text
    expect(expr).toContain(`json("meta")`)
    // scalar columns → bare identifiers, typed by json_object
    expect(expr).toContain(`'text', "text"`)
    expect(expr).toContain(`'rev', "rev"`)
    // reads the row back by key, with a COALESCE fallback to the sent op
    expect(expr).toContain(`FROM "todos" WHERE "id" = ?`)
    expect(expr).toContain('COALESCE')
  })

  it('a delete carries the sent value up front — no read-back', () => {
    const { expr, binds } = resolvedOpJsonExpr(plan, { type: 'delete', value: { id: 'x' } })
    expect(expr).toBe('json(?)')
    expect(binds).toEqual([JSON.stringify({ type: 'delete', value: { id: 'x' } })])
  })

  it('omits previousValue when the update carries none', () => {
    const withPrev = resolvedOpJsonExpr(plan, { type: 'update', value: { id: 'a' }, previousValue: { id: 'a' } })
    const without = resolvedOpJsonExpr(plan, { type: 'update', value: { id: 'a' } })
    expect(withPrev.expr).toContain('previousValue')
    expect(without.expr).not.toContain('previousValue')
  })
})

describe('oplog-JSON parity: embedded decode vs SQL assembly', () => {
  it('insert with DB defaults applied (done/rev omitted by the client)', () => {
    const ops = expectParity([insert({ id: 'a', text: 'hi' })])
    expect(ops).toEqual([[{ type: 'insert', value: { id: 'a', text: 'hi', done: false, rev: 1, meta: null } }]])
  })

  it('insert with an explicit boolean and a nested json column', () => {
    const ops = expectParity([insert({ id: 'b', text: 't', done: true, meta: { tag: 'x', n: 2 } })])
    expect(ops[0]).toEqual([{ type: 'insert', value: { id: 'b', text: 't', done: true, rev: 1, meta: { tag: 'x', n: 2 } } }])
  })

  it('insert with done:false stays a JSON false (not 0, not "false")', () => {
    const ops = expectParity([insert({ id: 'c', text: 't', done: false })])
    expect((ops[0] as any)[0].value.done).toBe(false)
  })

  it('partial update resolves the full current row (untouched columns kept)', () => {
    expectParity([
      insert({ id: 'a', text: 'orig', done: false }),
      { channel: 'todos', ops: [{ type: 'update', value: { id: 'a', done: true }, previousValue: { id: 'a', done: false } }] },
    ])
  })

  it('update of a missing row echoes the sent value (COALESCE fallback branch)', () => {
    const ops = expectParity([
      { channel: 'todos', ops: [{ type: 'update', value: { id: 'ghost', done: true }, previousValue: { id: 'ghost' } }] },
    ])
    expect(ops[0]).toEqual([{ type: 'update', value: { id: 'ghost', done: true }, previousValue: { id: 'ghost' } }])
  })

  it('delete carries the sent value', () => {
    const ops = expectParity([
      insert({ id: 'a', text: 'x' }),
      { channel: 'todos', ops: [{ type: 'delete', value: { id: 'a' } }] },
    ])
    expect(ops[1]).toEqual([{ type: 'delete', value: { id: 'a' } }])
  })

  it('a multi-op batch keeps op order and shapes each op', () => {
    expectParity([
      {
        channel: 'todos',
        ops: [
          { type: 'insert', value: { id: 'm1', text: 'one', meta: { a: 1 } } },
          { type: 'insert', value: { id: 'm2', text: 'two', done: true } },
        ],
      },
    ])
  })
})
