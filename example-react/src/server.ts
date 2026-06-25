import { routePartykitRequest } from 'partyserver'
import { PartyDbServer } from '../../src/server/index.ts'

// Export class Main just like you would with any durable objects
// server setup. PartyDbServer is a thin wrapper on PartyServer.
export class Main extends PartyDbServer {
  collections = [{ name: 'todos', key: 'id' }]
}

export default {
  async fetch(req: Request, env: unknown): Promise<Response> {
    return (
      (await routePartykitRequest(req, env as never)) ??
      new Response('not found', { status: 404 })
    )
  },
}
