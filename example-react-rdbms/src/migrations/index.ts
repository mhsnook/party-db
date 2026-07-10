// Your app's database — its tables, its constraints. This lives OUTSIDE
// server.ts on purpose: party-db never DDLs your tables, you bring them. Keeping
// the schema here leaves the server as just `collections = [...]` (plus auth) —
// the PartyDB, not the database plumbing.
//
// Each migration is idempotent DDL (IF NOT EXISTS), applied in order on DO start.
// A real app would record which versions ran in a table; for the demo, idempotent
// statements re-run harmlessly.

import createTodos from './001_create_todos.ts'

// D1 (env.DB), typed structurally so this module needs no workers-types. We run DDL
// via prepare().run() rather than D1's exec(), because exec splits its input on
// newlines and our migrations are multi-line.
export interface Migrator {
  prepare(query: string): { run(): Promise<unknown> }
}

export const migrations: string[] = [createTodos]

export async function migrate(db: Migrator): Promise<void> {
  for (const stmt of migrations) await db.prepare(stmt).run()
}
