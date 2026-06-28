import { routePartykitRequest } from 'partyserver'
import { PartyDbServer, definePartyCollection } from '../../src/server/index.ts'
import { todoSchema, type Todo } from './schema.ts'
import { migrate } from './migrations/index.ts'

// One room class. Declaring the collections — sharing the SAME schema the client
// uses — is the whole server. The table itself is your app's, so it lives in
// ./migrations (party-db never DDLs your tables); we just apply them on start.
export class Main extends PartyDbServer {
  collections = [definePartyCollection<Todo>({ name: 'todos', key: 'id', schema: todoSchema })]

  onStart() {
    migrate(this.ctx.storage.sql)
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
