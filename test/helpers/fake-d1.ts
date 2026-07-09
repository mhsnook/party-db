// A D1Database stand-in backed by node:sqlite, so the D1Adapter's unit tests run
// the REAL assembled SQL (the json_array/json_object oplog builder, RETURNING, the
// batch as one transaction) without standing up miniflare — the same trick
// `sql-engine.ts` uses for the embedded adapter. It emulates the parts of the D1
// contract the adapter leans on (plan-014 Step 1's confirmed premises):
//   - batch() runs its statements as ONE transaction, rolling all back on any error
//   - each result's `results` carries that statement's rows (incl. RETURNING)
//   - exec() runs DDL, splitting on newlines like D1 (so we pass single-line DDL)
//
// The real workerd D1 engine is covered by the integration suite (Step 5); this is
// the fast layer that pins statement assembly and result-mapping.

import { DatabaseSync } from 'node:sqlite'

class FakeStatement {
  binds: unknown[] = []
  constructor(
    private db: DatabaseSync,
    readonly sql: string,
  ) {}
  bind(...values: unknown[]): FakeStatement {
    this.binds = values
    return this
  }
  async all<T = Record<string, unknown>>(): Promise<{ success: true; results: T[]; meta: Record<string, unknown> }> {
    const results = this.db.prepare(this.sql).all(...(this.binds as any[])) as T[]
    return { success: true, results, meta: {} }
  }
  async first<T = Record<string, unknown>>(colName?: string): Promise<T | null> {
    const row = this.db.prepare(this.sql).get(...(this.binds as any[])) as Record<string, unknown> | undefined
    if (colName != null) return (row ? (row[colName] as T) : null)
    return (row as T) ?? null
  }
  async run<T = Record<string, unknown>>() {
    return this.all<T>()
  }
}

export class FakeD1 {
  db = new DatabaseSync(':memory:')
  // every SQL string handed to prepare(), in order — lets tests assert the shape of
  // the assembled statement list.
  prepared: string[] = []

  prepare(sql: string): FakeStatement {
    this.prepared.push(sql)
    return new FakeStatement(this.db, sql)
  }

  async batch<T = Record<string, unknown>>(statements: FakeStatement[]) {
    this.db.exec('BEGIN')
    try {
      const out = statements.map((s) => ({
        success: true as const,
        results: this.db.prepare(s.sql).all(...(s.binds as any[])) as T[],
        meta: {},
      }))
      this.db.exec('COMMIT')
      return out
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
  }

  async exec(query: string) {
    let count = 0
    for (const line of query.split('\n').map((l) => l.trim()).filter(Boolean)) {
      this.db.exec(line)
      count++
    }
    return { count, duration: 0 }
  }

  // convenience for assertions in tests — a raw query outside the adapter
  rows(sql: string, ...binds: unknown[]): Record<string, unknown>[] {
    return this.db.prepare(sql).all(...(binds as any[])) as Record<string, unknown>[]
  }
}

// The adapter takes a D1Database; the shim satisfies the slice it uses.
export const asD1 = (f: FakeD1): D1Database => f as unknown as D1Database
