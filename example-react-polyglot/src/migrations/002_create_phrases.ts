// 002 — the public catalog of phrases, each belonging to a language. The FK is
// the relationship the transport happily forgets and TanStack rebuilds as a join
// index on the client only when a live query uses it.
export default `
  CREATE TABLE IF NOT EXISTS public_phrases (
    id          TEXT PRIMARY KEY,
    language_id TEXT NOT NULL REFERENCES public_languages(id),
    text        TEXT NOT NULL,
    translation TEXT NOT NULL
  )
`
