// Your app's database — its tables, its constraints. This lives OUTSIDE
// server.ts on purpose: party-db never DDLs your tables, you bring them. Keeping
// the schema here leaves the server as just `collections = [...]` (plus auth) —
// the PartyDB, not the database plumbing.
//
// Each migration is idempotent DDL (IF NOT EXISTS), applied in order on DO start.
// A real app would record which versions ran in a table; for the demo, idempotent
// statements re-run harmlessly.

import createTodos from './001_create_todos.ts'

export const migrations: string[] = [createTodos]

// Apply the migrations against whichever engine is active — the caller passes a
// runner that executes one statement. Embedded DO-SQLite is synchronous
// (`ctx.storage.sql.exec`); D1 is async (`prepare(sql).run()`). We `await` the
// result either way (awaiting a non-promise is a no-op), so one migrate() serves
// both targets. (Note: D1's `exec()` splits on newlines, which is why the D1
// runner uses `prepare().run()` for our multi-line DDL — see server.ts.)
export async function migrate(run: (sql: string) => unknown | Promise<unknown>): Promise<void> {
  for (const stmt of migrations) await run(stmt)
}
