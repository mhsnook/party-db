// 001 — the todos table. Its columns mirror the Todo Struct in src/domain/Todo.ts.
// The room writes straight into them: `done` is an INTEGER, which the server's
// codec turns into a boolean on the way back.
export default `
  CREATE TABLE IF NOT EXISTS todos (
    id   TEXT PRIMARY KEY,
    text TEXT NOT NULL,
    done INTEGER NOT NULL DEFAULT 0
  )
`
