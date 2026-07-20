// The worker under test: a real PartyDbServer on a real (miniflare) Durable
// Object with SQLite. The integration test drives it through `SELF.fetch` — the
// full HTTP + WebSocket path, partyserver routing, DO storage and all.

import { routePartykitRequest } from 'partyserver'
import {
  PartyDbServer,
  D1Adapter,
  PgAdapter,
  definePartyCollection,
  authHooks,
  bearer,
  type AuthContext,
  type PartyCollection,
  type PersistenceAdapter,
  type PgClient,
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

// The same room persisting into a real Postgres (data + _oplog both in PG) — the
// third v1 target, proving mode 3's write path end-to-end through a DO. Like
// `D1Room` it overrides only `createAdapter()`; the transport is invariant. The
// connection string arrives as the `PG_URL` binding; `pg` connects over
// `cloudflare:sockets` (proven by the pg-connect spike). Small oplogRetention so
// the stale-cursor reset path is reachable, mirroring the other rooms.
export class PgRoom extends PartyDbServer {
  collections: PartyCollection<any>[] = [todos]
  oplogRetention = 50

  protected createAdapter(): PersistenceAdapter {
    // lazy factory: open + connect a fresh pg client on first use (and again if the
    // adapter ever discards a bad connection). One room per Postgres database, so a
    // single connection per DO is all we need.
    return new PgAdapter(
      async () => {
        const { default: pg } = await import('pg')
        const client = new pg.Client({ connectionString: this.env.PG_URL })
        await client.connect()
        return client as unknown as PgClient
      },
      this.collections,
      { oplogRetention: this.oplogRetention },
    )
  }

  // the app owns its table — here it lives in Postgres. Create it via a throwaway
  // connection before super.onStart() runs the adapter's init() (which creates the
  // _oplog through the adapter's own connection).
  async onStart() {
    const { default: pg } = await import('pg')
    const client = new pg.Client({ connectionString: this.env.PG_URL })
    await client.connect()
    try {
      await client.query(
        `CREATE TABLE IF NOT EXISTS todos (id text PRIMARY KEY, text text NOT NULL, done boolean NOT NULL DEFAULT false, rev integer NOT NULL DEFAULT 1)`,
      )
    } finally {
      await client.end()
    }
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
    // Test-only endpoint: prove a Postgres driver can open a TCP connection to a
    // real PG from inside the workers pool. Kept off the party routing path so it
    // can't collide with a room name.
    const url = new URL(req.url)
    if (url.pathname === '/__pg-probe') return pgProbe((env as { PG_URL: string }).PG_URL)
    return (await routePartykitRequest(req, env as never, authHooks(authorize))) ?? new Response('not found', { status: 404 })
  },
}

// Connect with node-postgres (`pg`), run `SELECT 1` and one parameterized
// `INSERT … RETURNING`, and report the resolved JS types so the test can assert
// workerd matches the node lane. `pg` drives `node:net`/`node:tls`, which
// `nodejs_compat` maps onto `cloudflare:sockets`; postgres.js also connects here
// but its CF socket polyfill leaks an unhandled "Stream was cancelled" rejection
// on teardown. All work happens in this one request so the socket's lifetime is
// bounded.
async function pgProbe(pgUrl: string): Promise<Response> {
  const { default: pg } = await import('pg')
  const client = new pg.Client({ connectionString: pgUrl })
  try {
    await client.connect()
    const one = await client.query('SELECT 1 AS n')
    // a throwaway per-connection temp table keeps the probe self-contained and
    // avoids cross-test contamination on the shared PG.
    await client.query('CREATE TEMP TABLE pg_probe (id serial PRIMARY KEY, flag boolean NOT NULL, big bigint)')
    const ins = await client.query('INSERT INTO pg_probe (flag, big) VALUES ($1, $2) RETURNING *', [true, '9007199254740993'])
    const row = ins.rows[0]
    const types = Object.fromEntries(Object.entries(row).map(([k, v]) => [k, typeof v]))
    return Response.json({ ok: true, select1: one.rows[0].n, row, types })
  } catch (e) {
    return Response.json({ ok: false, error: String((e as Error)?.message ?? e), name: (e as Error)?.name }, { status: 500 })
  } finally {
    await client.end()
  }
}
