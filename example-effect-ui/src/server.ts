import { routePartykitRequest } from 'partyserver'
import { PartyDbServer } from '../../src/server/index.ts'
import { todos } from './domain/Todo.ts'
import { migrate } from './migrations/index.ts'

// The collection carries an Effect Schema. The server reads its Struct for the
// column allowlist, so the room CRUDs the todos table from ./migrations.
export class Main extends PartyDbServer {
  collections = [todos]

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
