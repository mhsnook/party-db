// 001 — the todos table. Its columns mirror todoSchema (id, text, done), the
// shape the client and server share. The server builds its column allowlist from
// that schema and CRUDs into exactly these real columns (not a blob).
export default `
  CREATE TABLE IF NOT EXISTS todos (
    id   TEXT PRIMARY KEY,
    text TEXT NOT NULL,
    done INTEGER NOT NULL DEFAULT 0
  )
`
