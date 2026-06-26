import { routePartykitRequest } from 'partyserver'
import { PartyDbServer, definePartyCollection } from '../../src/server/index.ts'
import { todoSchema, type Todo } from './schema.ts'

// One room class. Declaring the collections — sharing the SAME schema the client
// uses — is the whole server.
export class Main extends PartyDbServer {
  collections = [definePartyCollection<Todo>({ name: 'todos', key: 'id', schema: todoSchema })]

  // This demo's table lives in the DO's own SQLite, so we create it here.
  onStart() {
    this.ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS todos (
         id TEXT PRIMARY KEY,
         text TEXT NOT NULL,
         done INTEGER NOT NULL DEFAULT 0
       )`,
    )
    return super.onStart()
  }
}

export default {
  async fetch(req: Request, env: unknown): Promise<Response> {
    return (
      (await routePartykitRequest(req, env as never)) ??
      new Response('not found', { status: 404 })
    )
  },
}
