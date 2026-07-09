// Step-1 spike (plan 014): prove D1's semantics inside the real (miniflare) D1
// binding BEFORE building the adapter on top of them. These are premises the
// design depends on — if any fails it's a STOP condition, not something to code
// around. Driven against the RAW `env.DB`, no adapter involved.

import { describe, it, expect } from 'vitest'
import { env } from 'cloudflare:test'

// Each test uses its own tables so the shared local D1 doesn't cross-contaminate.
async function reset(...tables: string[]) {
  for (const t of tables) await env.DB.exec(`DROP TABLE IF EXISTS ${t}`)
}

describe('D1 premise: batch() is one atomic transaction', () => {
  it('rolls the whole batch back when a later statement violates a constraint', async () => {
    await reset('atom')
    await env.DB.exec(`CREATE TABLE atom (id TEXT PRIMARY KEY, n INTEGER)`)

    // second insert collides on the PK the first one wrote → the batch must fail
    // AND leave no rows (the first insert rolled back with it).
    let err: unknown
    try {
      await env.DB.batch([
        env.DB.prepare(`INSERT INTO atom (id, n) VALUES (?, ?)`).bind('a', 1),
        env.DB.prepare(`INSERT INTO atom (id, n) VALUES (?, ?)`).bind('a', 2),
      ])
    } catch (e) {
      err = e
    }
    expect(err).toBeTruthy()
    // plan 006's isConstraintError keys on this exact substring
    expect(String((err as Error).message)).toMatch(/constraint failed/i)

    const rows = await env.DB.prepare(`SELECT * FROM atom`).all()
    expect(rows.results).toHaveLength(0) // the first insert did NOT commit
  })
})

describe('D1 premise: each batch result carries its own RETURNING rows', () => {
  it('returns the resolved row per INSERT … RETURNING * statement', async () => {
    await reset('ret')
    await env.DB.exec(`CREATE TABLE ret (id TEXT PRIMARY KEY, n INTEGER NOT NULL DEFAULT 7)`)

    const results = await env.DB.batch([
      env.DB.prepare(`INSERT INTO ret (id) VALUES (?) RETURNING *`).bind('x'),
      env.DB.prepare(`INSERT INTO ret (id, n) VALUES (?, ?) RETURNING *`).bind('y', 3),
    ])
    expect(results[0].results).toEqual([{ id: 'x', n: 7 }]) // DB default applied
    expect(results[1].results).toEqual([{ id: 'y', n: 3 }])
  })
})

describe('D1 premise: the resolved-op JSON assembles in SQL', () => {
  it('reads back a just-written row into correctly-typed JSON in the same batch', async () => {
    await reset('t', 'probe_log')
    // a table with the three column kinds the codec cares about: scalar (id/text),
    // boolean-ish (done INTEGER 0/1), and json-text (meta).
    await env.DB.exec(`CREATE TABLE t (id TEXT PRIMARY KEY, text TEXT, done INTEGER, meta TEXT)`)
    await env.DB.exec(`CREATE TABLE probe_log (rowid INTEGER PRIMARY KEY AUTOINCREMENT, ops TEXT NOT NULL)`)

    // one batch: insert the row, then assemble the resolved-op JSON by reading it
    // back — the design's core move. json() re-wraps each element because the JSON
    // subtype does not survive the scalar-subquery boundary.
    const valueObj =
      `json_object('id', id, 'text', text, ` +
      `'done', json(CASE WHEN done IS NULL THEN 'null' WHEN done = 0 THEN 'false' ELSE 'true' END), ` +
      `'meta', json(meta))`
    const results = await env.DB.batch([
      env.DB.prepare(`INSERT INTO t (id, text, done, meta) VALUES (?, ?, ?, ?)`).bind('a', 'hi', 1, JSON.stringify({ tag: 'x', n: 2 })),
      env.DB
        .prepare(
          `INSERT INTO probe_log (ops) VALUES (json_array(json(COALESCE(` +
            `(SELECT json_object('type', 'insert', 'value', ${valueObj}) FROM t WHERE id = ?), ?)))) RETURNING rowid`,
        )
        .bind('a', JSON.stringify({ type: 'insert', value: { id: 'a' } })),
    ])
    expect(results[1].results).toHaveLength(1)

    const stored = await env.DB.prepare(`SELECT ops FROM probe_log`).first<{ ops: string }>()
    const parsed = JSON.parse(stored!.ops)
    expect(parsed).toEqual([
      { type: 'insert', value: { id: 'a', text: 'hi', done: true, meta: { tag: 'x', n: 2 } } },
    ])
    // the load-bearing details: `done` is a JSON boolean (not 1, not "true"), and
    // `meta` is a nested object (not a double-encoded string).
    expect(parsed[0].value.done).toBe(true)
    expect(typeof parsed[0].value.meta).toBe('object')
  })

  it('falls back to the sent op when the read-back finds no row (COALESCE branch)', async () => {
    await reset('t2', 'probe_log2')
    await env.DB.exec(`CREATE TABLE t2 (id TEXT PRIMARY KEY, text TEXT)`)
    await env.DB.exec(`CREATE TABLE probe_log2 (rowid INTEGER PRIMARY KEY AUTOINCREMENT, ops TEXT NOT NULL)`)

    // update of a row that doesn't exist: the subquery is empty → COALESCE picks
    // the pre-serialized sent op, and the outer json() parses it (not stringifies).
    const sent = { type: 'update', value: { id: 'ghost', text: 'boo' } }
    await env.DB.batch([
      env.DB.prepare(`UPDATE t2 SET text = ? WHERE id = ?`).bind('boo', 'ghost'),
      env.DB
        .prepare(
          `INSERT INTO probe_log2 (ops) VALUES (json_array(json(COALESCE(` +
            `(SELECT json_object('type', 'update', 'value', json_object('id', id, 'text', text)) FROM t2 WHERE id = ?), ?))))`,
        )
        .bind('ghost', JSON.stringify(sent)),
    ])
    const stored = await env.DB.prepare(`SELECT ops FROM probe_log2`).first<{ ops: string }>()
    expect(JSON.parse(stored!.ops)).toEqual([sent]) // exact echo, parsed as JSON
  })
})

describe('D1 spike: recorded limits (informational)', () => {
  it('binds well past a plan-005-sized write in one statement', async () => {
    await reset('lim')
    await env.DB.exec(`CREATE TABLE lim (id INTEGER PRIMARY KEY, a, b, c, d)`)
    // D1's documented bound-parameter ceiling is high (hundreds); a single write
    // op binds a handful of columns, and maxWriteOps caps ops per POST at 1000, so
    // a comfortable margin is all we need to confirm. Bind 100 params in one stmt.
    const cols = Array.from({ length: 100 }, (_, i) => `p${i}`)
    await env.DB.exec(`DROP TABLE lim`)
    await env.DB.exec(`CREATE TABLE lim (${cols.map((c) => `${c} INTEGER`).join(', ')})`)
    const stmt = env.DB
      .prepare(`INSERT INTO lim (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
      .bind(...cols.map((_, i) => i))
    await expect(env.DB.batch([stmt])).resolves.toBeTruthy()
    const row = await env.DB.prepare(`SELECT COUNT(*) AS c FROM lim`).first<{ c: number }>()
    expect(row!.c).toBe(1)
  })
})
