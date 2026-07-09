// A SqlEngine backed by node:sqlite's in-process SQLite, so the structured
// adapter's tests exercise a REAL engine — real constraints, real RETURNING, real
// defaults/serials — without standing up miniflare. It presents the same exec /
// transaction surface the adapter uses against ctx.storage in the DO.

import { DatabaseSync } from 'node:sqlite'
import type { SqlEngine, SqlResult } from '../../src/server/sqlite-adapter.ts'

export function memoryEngine(): { engine: SqlEngine; db: DatabaseSync } {
  const db = new DatabaseSync(':memory:')
  const engine: SqlEngine = {
    exec(query: string, ...bindings: unknown[]): SqlResult {
      const rows = db.prepare(query).all(...(bindings as any[])) as Record<string, unknown>[]
      return {
        toArray: () => rows,
        // mirror the real DO SqlStorageCursor: one() throws unless the result is
        // exactly one row, so the unit suite catches any one()-on-maybe-empty misuse.
        one: () => {
          if (rows.length !== 1) throw new Error(`one(): expected exactly one row, got ${rows.length}`)
          return rows[0]
        },
      }
    },
    transaction<T>(fn: () => T): T {
      db.exec('BEGIN')
      try {
        const result = fn()
        db.exec('COMMIT')
        return result
      } catch (e) {
        db.exec('ROLLBACK')
        throw e
      }
    },
  }
  return { engine, db }
}
