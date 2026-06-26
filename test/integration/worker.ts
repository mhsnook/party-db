// The worker under test: a real PartyDbServer on a real (miniflare) Durable
// Object with SQLite. The integration test drives it through `SELF.fetch` — the
// full HTTP + WebSocket path, partyserver routing, DO storage and all.

import { routePartykitRequest } from 'partyserver'
import { PartyDbServer, definePartyCollection, bearer, type AuthKind } from '../../src/server/index.ts'
import { z } from 'zod'

// `done` and `rev` are optional on the wire but defaulted in the table, so the
// committed (resolved) row differs from what the client sends — which is exactly
// what reconciliation has to carry back.
const todoSchema = z.object({
  id: z.string(),
  text: z.string(),
  done: z.boolean().optional(),
  rev: z.number().optional(),
})

export class Main extends PartyDbServer {
  collections = [definePartyCollection({ name: 'todos', key: 'id', schema: todoSchema })]
  oplogRetention = 50

  // the app owns its table; we only CRUD over it.
  onStart() {
    this.ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS todos (
         id TEXT PRIMARY KEY,
         text TEXT NOT NULL,
         done INTEGER NOT NULL DEFAULT 0,
         rev INTEGER NOT NULL DEFAULT 1
       )`,
    )
    return super.onStart()
  }
}

// The shared secret the guarded room expects. Exported so the auth test can send
// it (header on POST, `?token=` on the WS upgrade).
export const SECRET = 's3cret'

// Same room as Main, but auth-gated: it overrides `authorize` to require the
// token on both doors (connect = read, write = POST). This is the "room owner
// supplies the check" story the v1 plan asks for.
export class Guarded extends Main {
  protected authorize(req: Request, kind: AuthKind) {
    // POSTs carry the bearer header; a browser WS upgrade can't, so the connect
    // door reads `?token=` instead. authorize() sees the raw Request either way.
    const token = bearer(req) ?? new URL(req.url).searchParams.get('token')
    if (token === SECRET) return true
    return { ok: false, status: 401, error: `unauthorized (${kind})` }
  }
}

export default {
  async fetch(req: Request, env: unknown): Promise<Response> {
    return (await routePartykitRequest(req, env as never)) ?? new Response('not found', { status: 404 })
  },
}
