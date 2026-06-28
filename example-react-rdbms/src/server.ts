import { routePartykitRequest } from 'partyserver'
import { PartyDbServer, definePartyCollection, authHooks, bearer, type AuthContext } from '../../src/server/index.ts'
import { todoSchema, type Todo } from './schema.ts'
import { migrate } from './migrations/index.ts'

// The password. Real apps verify a session/JWT here; a shared string keeps the
// demo to one moving part. It's printed on the page on purpose.
const PASSWORD = 's3cret'

// 🆕 vs the schemaless example, TWO things change here:
//
// (1) We share the zod schema with the server, so writes CRUD into the REAL
//     columns of a table WE own — not a generic blob. The server never DDLs your
//     tables; you bring them, so the schema lives in ./migrations and we apply it
//     on start — server.ts stays the PartyDB, not the database setup.
export class Main extends PartyDbServer {
  collections = [definePartyCollection<Todo>({ name: 'todos', key: 'id', schema: todoSchema })]

  onStart() {
    migrate(this.ctx.storage.sql)
    return super.onStart()
  }
}

// (2) One `authorize` check, gating at partyserver's lobby (before the request
//     reaches the DO). The `kind` lets the SAME check make reads open and writes
//     password-protected — so anyone can watch the list, but editing it needs the
//     token. A rejected write is a 401, which the client turns into the unlock
//     prompt (see App.tsx). `ctx` also carries the resolved { party, room } if you
//     want to gate per-room.
const authorize = (req: Request, { kind }: AuthContext) => {
  if (kind === 'connect') return true // reads are open to everyone
  return bearer(req) === PASSWORD ? true : { ok: false, status: 401, error: `enter "${PASSWORD}" to write` }
}

export default {
  async fetch(req: Request, env: unknown): Promise<Response> {
    // 🆕 the hooks are the third arg to routePartykitRequest (the schemaless
    // example passes nothing here).
    return (await routePartykitRequest(req, env as never, authHooks(authorize))) ?? new Response('not found', { status: 404 })
  },
}
