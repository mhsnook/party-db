import { routePartykitRequest } from 'partyserver'
import { PartyDbServer, definePartyCollection, authHooks, bearer, type AuthContext } from '../../src/server/index.ts'
import { todoSchema, type Todo } from './schema.ts'
import { migrate } from './migrations/index.ts'

// Demo password, printed on the page on purpose; real apps verify a session/JWT and compare constant-time, never echoing it.
const PASSWORD = 's3cret'

// 🆕 (1) share the zod schema so writes CRUD real columns of a table you own; you bring it, so it lives in ./migrations, applied on start.
export class Main extends PartyDbServer {
  collections = [definePartyCollection<Todo>({ name: 'todos', key: 'id', schema: todoSchema })]

  onStart() {
    migrate(this.ctx.storage.sql)
    return super.onStart()
  }
}

// 🆕 (2) one lobby check: `kind` makes reads open and writes password-protected (a rejected write is the 401 App.tsx turns into an unlock prompt).
const authorize = (req: Request, { kind }: AuthContext) => {
  if (kind === 'connect') return true // reads are open to everyone
  return bearer(req) === PASSWORD ? true : { ok: false, status: 401, error: 'a write token is required' }
}

export default {
  // 🆕 the hooks are the third arg to routePartykitRequest (the schemaless example passes nothing)
  async fetch(req: Request, env: unknown): Promise<Response> {
    const response = await routePartykitRequest(req, env as never, authHooks(authorize))
    return response ?? new Response('not found', { status: 404 })
  },
}
