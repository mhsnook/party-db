// 004 — a user's flashcard: their status on one public phrase. Private, owned by
// user_id. Joining public_phrases ⟕ user_flashcards is "the same library, your
// progress laid over it" — and the private side only ever reaches its owner.
export default `
  CREATE TABLE IF NOT EXISTS user_flashcards (
    id        TEXT PRIMARY KEY,
    user_id   TEXT NOT NULL,
    phrase_id TEXT NOT NULL REFERENCES public_phrases(id),
    status    TEXT NOT NULL DEFAULT 'new',
    due_at    INTEGER NOT NULL
  )
`
