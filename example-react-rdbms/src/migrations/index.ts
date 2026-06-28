// Your app's database — its tables, its constraints. This lives OUTSIDE
// server.ts on purpose: party-db never DDLs your tables, you bring them. Keeping
// the schema here leaves the server as just `collections = [...]` (plus auth) —
// the PartyDB, not the database plumbing.
//
// Each migration is idempotent DDL (IF NOT EXISTS), applied in order on DO start.
// A real app would record which versions ran in a table; for the demo, idempotent
// statements re-run harmlessly.

import createTodos from './001_create_todos.ts'

// the DO's SqlStorage (ctx.storage.sql), typed structurally so this module needs
// no workers-types.
export interface Migrator {
  exec(query: string): unknown
}

export const migrations: string[] = [createTodos]

export function migrate(sql: Migrator): void {
  for (const stmt of migrations) sql.exec(stmt)
}
