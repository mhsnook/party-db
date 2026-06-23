import { routePartykitRequest } from 'partyserver'
import { PartyDbServer } from '../../src/server/index.ts'

// One room class. Declaring the collections is the whole server.
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
