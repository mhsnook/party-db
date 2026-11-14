import { routePartykitRequest } from 'partyserver'
import { PartyDbServer } from '../../src/server/index.ts'
import { comments } from './schema.ts'

// Export class Main like any Durable Object server; PartyDbServer is a thin wrapper on PartyServer.
export class Main extends PartyDbServer {
  collections = [{ name: 'todos', key: 'id' }, comments]

  // a sliced collection reads by column, so it needs a real table: you own it
  onStart() {
    this.ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS comments (id TEXT PRIMARY KEY, todo_id TEXT NOT NULL, body TEXT NOT NULL)`,
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
