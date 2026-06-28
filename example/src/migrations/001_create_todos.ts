// 001 — the todos table. Its columns mirror todoSchema (id, text, done), the
// shape the client and server share. Storage here is schema-agnostic blobs, so
// the server doesn't strictly need these columns — but a real app's table looks
// like this, and the rdbms example CRUDs into exactly these columns.
export default `
  CREATE TABLE IF NOT EXISTS todos (
    id   TEXT PRIMARY KEY,
    text TEXT NOT NULL,
    done INTEGER NOT NULL DEFAULT 0
  )
`
