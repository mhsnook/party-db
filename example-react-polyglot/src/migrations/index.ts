// Your app's database — its tables, its constraints, its foreign keys. This lives
// OUTSIDE server.ts on purpose: party-db never DDLs your tables, you bring them.
// Keeping the schema here leaves the server as `collections = [...]` plus `auth`.
//
// Each statement is idempotent (IF NOT EXISTS / INSERT OR IGNORE), applied in
// order on DO start. A real app would track applied versions; for the demo,
// idempotent statements re-run harmlessly.

import createLanguages from './001_create_languages.ts'
import createPhrases from './002_create_phrases.ts'
import createDecks from './003_create_decks.ts'
import createFlashcards from './004_create_flashcards.ts'
import seedCatalog from './005_seed_catalog.ts'

// the DO's SqlStorage (ctx.storage.sql), typed structurally so this module needs
// no workers-types.
export interface Migrator {
  exec(query: string): unknown
}

export const migrations: string[] = [createLanguages, createPhrases, createDecks, createFlashcards, seedCatalog]

export function migrate(sql: Migrator): void {
  for (const stmt of migrations) sql.exec(stmt)
}
