// The single source of truth: schemas + the collection list, defined ONCE and
// imported by both the client (App.tsx) and the server (server.ts). Flattening
// them into one `collections` array is the whole wiring; the `access` rule and
// the `user_id` owner column on the private two are the only new ideas.
//
// `definePartyCollection` comes from the neutral package root (`party-db`, here
// the repo's ../../src) — no client/server coupling, so this file is safe to
// import from either half.

import { z } from 'zod'
import { definePartyCollection } from '../../src/index.ts'

// public catalog — everyone reads, any signed-in member adds, nobody CRUD-edits
const languageSchema = z.object({ id: z.string(), name: z.string(), flag: z.string() })
const phraseSchema = z.object({
  id: z.string(),
  language_id: z.string(), // → public_languages.id
  text: z.string(),
  translation: z.string(),
})

// per-user — the `user_id` column is the only new idea.
// NB: no z.default() on daily_goal/direction/status — a zod .default() makes the
// schema's INPUT type optional while z.infer (the output) stays required, which
// breaks the single-T StandardSchema match on definePartyCollection<T>. These are
// app settings anyway, so their defaults live in the DDL (see migrations).
const deckSchema = z.object({
  id: z.string(),
  user_id: z.string(), // ← the owner column
  language_id: z.string(),
  daily_goal: z.number().int(),
  direction: z.enum(['recognize', 'produce']),
})
const flashcardSchema = z.object({
  id: z.string(),
  user_id: z.string(), // ← the owner column
  phrase_id: z.string(), // → public_phrases.id
  status: z.enum(['new', 'learning', 'known']),
  due_at: z.number().int(), // epoch ms
})

export type Language = z.infer<typeof languageSchema>
export type Phrase = z.infer<typeof phraseSchema>
export type Deck = z.infer<typeof deckSchema>
export type Flashcard = z.infer<typeof flashcardSchema>

export const collections = [
  // public read, members-only insert, no edits/deletes (unnamed verbs deny by default)
  definePartyCollection<Language>({ name: 'public_languages', key: 'id', schema: languageSchema, access: { read: 'public', insert: 'authed' } }),
  definePartyCollection<Phrase>({ name: 'public_phrases', key: 'id', schema: phraseSchema, access: { read: 'public', insert: 'authed' } }),
  // per-user — `ownerColumn` alone is sugar for fully-private (owner read + owner write)
  definePartyCollection<Deck>({ name: 'user_decks', key: 'id', schema: deckSchema, ownerColumn: 'user_id' }),
  definePartyCollection<Flashcard>({ name: 'user_flashcards', key: 'id', schema: flashcardSchema, ownerColumn: 'user_id' }),
]
