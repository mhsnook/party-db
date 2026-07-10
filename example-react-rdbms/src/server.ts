import { routePartykitRequest } from 'partyserver'
import {
  PartyDbServer,
  D1Adapter,
  definePartyCollection,
  authHooks,
  bearer,
  type AuthContext,
  type PersistenceAdapter,
} from '../../src/server/index.ts'
import { todoSchema, type Todo } from './schema.ts'
import { migrate } from './migrations/index.ts'

// Demo password, printed on the page on purpose; real apps verify a session/JWT and compare constant-time, never echoing it.
const PASSWORD = 's3cret'

// 🆕 (1) share the zod schema so writes CRUD real columns of a table you own; you bring it, so it lives in ./migrations, applied on start.
export class Main extends PartyDbServer {
  collections = [definePartyCollection<Todo>({ name: 'todos', key: 'id', schema: todoSchema })]

  // 🆕 (2) the storage target is a runtime switch, flipped in wrangler.jsonc, not
  // in code: if a D1 binding is configured (`env.DB`), persist the `todos` table AND
  // party-db's `_oplog` into D1, where other services and jobs can read them;
  // otherwise fall back to the DO's own embedded SQLite (`super.createAdapter()`).
  // The DO stays the room server either way — same client, schema, auth, and wire.
  protected createAdapter(): PersistenceAdapter {
    return this.env.DB
      ? new D1Adapter(this.env.DB, this.collections, { oplogRetention: this.oplogRetention })
      : super.createAdapter()
  }

  // bring your own DB — run the migration against whichever engine is active. The
  // D1 runner uses prepare().run(), not D1's exec(): exec() splits on newlines, and
  // our DDL is multi-line.
  async onStart() {
    const db = this.env.DB
    await migrate(db ? (sql) => db.prepare(sql).run() : (sql) => this.ctx.storage.sql.exec(sql))
    return super.onStart()
  }
}

// 🆕 (3) one lobby check: `kind` makes reads open and writes password-protected (a rejected write is the 401 App.tsx turns into an unlock prompt).
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
