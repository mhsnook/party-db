// 003 — a user's deck for a language: their own settings for how they want to
// learn it. Private: `owner: 'user_id'` scopes every read and write to the owner.
export default `
  CREATE TABLE IF NOT EXISTS user_decks (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL,
    language_id TEXT NOT NULL REFERENCES public_languages(id),
    daily_goal  INTEGER NOT NULL DEFAULT 20,
    direction   TEXT NOT NULL DEFAULT 'recognize'
  )
`
