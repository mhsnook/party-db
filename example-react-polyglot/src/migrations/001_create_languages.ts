// 001 — the public catalog of languages. Columns mirror languageSchema
// (id, name, flag). Publicly readable; `access: { read: 'public', insert: 'authed' }`
// means any signed-in member can add one, and edits/deletes don't go through CRUD.
export default `
  CREATE TABLE IF NOT EXISTS public_languages (
    id   TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    flag TEXT NOT NULL
  )
`
