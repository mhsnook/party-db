// The worker under test: a real PartyDbServer on a real (miniflare) Durable
// Object with SQLite. The integration test drives it through `SELF.fetch` — the
// full HTTP + WebSocket path, partyserver routing, DO storage and all.

import { routePartykitRequest } from 'partyserver'
import {
  PartyDbServer,
  D1Adapter,
  definePartyCollection,
  authHooks,
  bearer,
  type AuthContext,
  type PartyCollection,
  type PersistenceAdapter,
} from '../../src/server/index.ts'
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

const todos = definePartyCollection({ name: 'todos', key: 'id', schema: todoSchema })

export class Main extends PartyDbServer {
  // typed as the base's PartyCollection<any>[] so Faulty can widen the list
  collections: PartyCollection<any>[] = [todos]
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

// A party whose `untabled` collection declares a schema but no CREATE TABLE — a
// write to it fails inside the adapter (no such table), the reliably-internal
// fault for the 500 path. Kept separate from `Main` so Main's snapshot shape
// stays stable; keeps `todos` so the same DO can prove it still serves after a 500.
export class Faulty extends Main {
  collections = [todos, definePartyCollection({ name: 'untabled', key: 'id', schema: z.object({ id: z.string() }) })]
}

// The same room, but persisting into D1 (data + _oplog both live in `env.DB`)
// instead of the DO's own SQLite — the second v1 target. `createAdapter()` is the
// only override; the transport (queue, socket, broadcast) is invariant. Small
// oplogRetention so the stale-cursor reset path is reachable, mirroring `Main`.
export class D1Room extends PartyDbServer {
  collections: PartyCollection<any>[] = [todos]
  oplogRetention = 50

  protected createAdapter(): PersistenceAdapter {
    return new D1Adapter(this.env.DB, this.collections, { oplogRetention: this.oplogRetention })
  }

  // the app owns its table — here it lives in D1, and D1 DDL is async, so await it
  // before super.onStart() (which runs the adapter's init()).
  async onStart() {
    await this.env.DB.exec(
      `CREATE TABLE IF NOT EXISTS todos (id TEXT PRIMARY KEY, text TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0, rev INTEGER NOT NULL DEFAULT 1)`,
    )
    return super.onStart()
  }
}

export const SECRET = 's3cret'

// A binding so the `guarded` party has somewhere to route; the auth is in the
// lobby (below), not the class.
export class Guarded extends Main {}

// Only the `Guarded` party requires the token; `Main` stays open — the mixed
// public/private case under one routePartykitRequest call.
const authorize = (req: Request, { kind, party }: AuthContext) => {
  if (party !== 'Guarded') return true
  const token = bearer(req) ?? new URL(req.url).searchParams.get('token')
  if (token === SECRET) return true
  return { ok: false, status: 401, error: `unauthorized (${kind})` }
}

export default {
  async fetch(req: Request, env: unknown): Promise<Response> {
    return (await routePartykitRequest(req, env as never, authHooks(authorize))) ?? new Response('not found', { status: 404 })
  },
}
