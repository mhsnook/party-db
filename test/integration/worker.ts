// The worker under test: a real PartyDbServer on a real (miniflare) Durable
// Object with SQLite. The integration test drives it through `SELF.fetch` — the
// full HTTP + WebSocket path, partyserver routing, DO storage and all.

import { routePartykitRequest } from 'partyserver'
import { PartyDbServer, definePartyCollection, authHooks, bearer, type AuthKind } from '../../src/server/index.ts'
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

export const SECRET = 's3cret'

// A binding so the `guarded` party has somewhere to route; the auth is in the
// lobby (below), not the class.
export class Guarded extends Main {}

// Only `guarded` requires the token; `main` stays open — the mixed public/private
// case under one routePartykitRequest call.
const authorize = (req: Request, kind: AuthKind) => {
  if (!new URL(req.url).pathname.includes('/parties/guarded/')) return true
  const token = bearer(req) ?? new URL(req.url).searchParams.get('token')
  if (token === SECRET) return true
  return { ok: false, status: 401, error: `unauthorized (${kind})` }
}

export default {
  async fetch(req: Request, env: unknown): Promise<Response> {
    return (await routePartykitRequest(req, env as never, authHooks(authorize))) ?? new Response('not found', { status: 404 })
  },
}
