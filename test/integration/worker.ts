// The worker under test: a real PartyDbServer on a real (miniflare) Durable
// Object with SQLite. The integration test drives it through `SELF.fetch` — the
// full HTTP + WebSocket path, partyserver routing, DO storage and all.

import { routePartykitRequest, Server, type Connection, type ConnectionContext } from 'partyserver'
import {
  PartyDbServer,
  PartyDbCore,
  isPartyDbRequest,
  D1Adapter,
  PgAdapter,
  SqliteAdapter,
  definePartyCollection,
  authHooks,
  bearer,
  type AuthContext,
  type PartyCollection,
  type PersistenceAdapter,
  type PgClient,
  type SqlEngine,
  type WriteIdentity,
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

// The `docs` collection the RLS room enforces per-user writes over. `owner` is
// optional on the wire — omitted, the table's DEFAULT stamps it from the injected
// claim, so a client never even names an owner.
const docsRls = definePartyCollection({
  name: 'docs',
  key: 'id',
  schema: z.object({ id: z.string(), owner: z.string().optional(), body: z.string() }),
})

// Postgres-native RLS end-to-end through a Durable Object. The DO connects as the
// superuser PG_URL, but every write ASSUMES an RLS-subject role (`party_rls`, via
// SET LOCAL role) and carries the caller's verified claims (SET LOCAL
// request.jwt.claims) — so Postgres' OWN policies decide what each write may
// touch, and a forged write comes back 403 at the wire. The `auth` hook is the
// identity seam: here the test's Bearer token IS the user id (a real app would
// verify a JWT and read `sub`). Anonymous requests (no token) resolve to NO
// identity — and `anonRole` then downgrades them to the RLS-subject `party_rls`
// role, so the superuser connection can never write past the policies even with
// no claims. (Without an `anonRole` latch, anonymous writes are rejected 401
// instead — see the `Authed` room.)
export class PgRlsRoom extends PartyDbServer {
  collections: PartyCollection<any>[] = [docsRls]
  oplogRetention = 50
  // fail-closed anonymous: run tokenless writes as the low-privilege RLS-subject
  // role rather than the privileged connection role.
  anonRole = 'party_rls'

  auth = (req: Request): WriteIdentity | null => {
    const sub = bearer(req)
    return sub ? { role: 'party_rls', claims: { sub } } : null
  }

  protected createAdapter(): PersistenceAdapter {
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

  // Build the RLS contract the app owns: the table + owner policy keyed on the
  // injected claim, the RLS-subject role, and the grants — then let super.onStart()
  // create the library `_oplog` (as the superuser connection) and grant the role
  // access to it. The `NULLIF(current_setting(...), '')` guard is load-bearing: a
  // namespaced setting reverts to the EMPTY STRING (not NULL) on a reused
  // connection, and a bare `''::json` throws — NULLIF makes a claimless write deny
  // cleanly (owner = NULL → 42501) instead.
  async onStart() {
    const { default: pg } = await import('pg')
    const claim = `NULLIF(current_setting('request.jwt.claims', true), '')::json->>'sub'`
    const admin = new pg.Client({ connectionString: this.env.PG_URL })
    await admin.connect()
    try {
      await admin.query(
        `CREATE TABLE IF NOT EXISTS docs (id text PRIMARY KEY, owner text NOT NULL DEFAULT ${claim}, body text NOT NULL)`,
      )
      await admin.query(`ALTER TABLE docs ENABLE ROW LEVEL SECURITY`)
      await admin.query(`DROP POLICY IF EXISTS docs_owner ON docs`)
      await admin.query(`CREATE POLICY docs_owner ON docs USING (owner = ${claim}) WITH CHECK (owner = ${claim})`)
      await admin.query(
        `DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='party_rls') THEN CREATE ROLE party_rls NOSUPERUSER NOBYPASSRLS; END IF; END $$`,
      )
      await admin.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON docs TO party_rls`)
    } finally {
      await admin.end()
    }
    await super.onStart() // adapter.init() creates _oplog on the (superuser) adapter connection
    const grant = new pg.Client({ connectionString: this.env.PG_URL })
    await grant.connect()
    try {
      await grant.query(`GRANT SELECT, INSERT, DELETE ON _oplog TO party_rls`)
      await grant.query(`GRANT USAGE, SELECT ON SEQUENCE _oplog_seq_seq TO party_rls`)
    } finally {
      await grant.end()
    }
  }
}

// The identity SEAM at the server layer, on plain DO-SQLite (no RLS needed). Proves
// the fail-closed gate that ALSO protects the Postgres privileged-connection
// footgun: with `auth` set and no `anonRole` latch, an anonymous write is rejected
// 401 BEFORE any transaction opens — it never reaches the adapter
// — and a verifier that throws is a 401 too. A valid token passes (SQLite ignores
// the injected identity itself; the point here is the server gate, not enforcement).
export class Authed extends Main {
  auth = (req: Request): WriteIdentity | null => {
    const token = bearer(req)
    if (token === 'boom') throw new Error('token verification failed')
    return token ? { claims: { sub: token } } : null
  }
}

// A room whose OWN host code writes rows — the case #41 opens: a job, an agent,
// or anything running inside this Durable Object that is not a client POST.
// `commit()` is the seam it goes through, so the rows get a seq, an `_oplog`
// entry, and fan-out exactly as a POST's would.
//
// Three test-only GET endpoints stand in for that host code, since a test has to
// be able to trigger it:
//   ?host=<id>      commit inline; answer with the sequenced batches
//   ?deferred=<id>  answer 202 first, commit under waitUntil — journo-harness's
//                   shape, where the request returns and the work settles later
//   ?raw=<id>       write the table directly with our own SQL: the split commit()
//                   exists to close. Nothing broadcasts, nothing reaches the oplog.
// POSTs fall through to the normal /write path.
export class Hosted extends Main {
  async onRequest(req: Request): Promise<Response> {
    const q = new URL(req.url).searchParams
    const id = q.get('host') ?? q.get('deferred')
    if (id === null) {
      const raw = q.get('raw')
      if (raw === null) return super.onRequest(req)
      this.ctx.storage.sql.exec(`INSERT INTO todos (id, text) VALUES (?, ?)`, raw, 'out of band')
      return Response.json({ raw })
    }
    const batches = [{ channel: 'todos', ops: [{ type: 'insert' as const, value: { id, text: `host ${id}` } }] }]
    if (q.has('deferred')) {
      this.ctx.waitUntil(this.commit(batches))
      return Response.json({ deferred: id }, { status: 202 })
    }
    try {
      return Response.json({ sequenced: await this.commit(batches) })
    } catch (e) {
      // host code owns its own failure reporting; the test asserts the throw.
      return Response.json({ error: String((e as Error)?.message ?? e) }, { status: 500 })
    }
  }
}

// The host issue #43 opens the core for: a room that cannot subclass
// PartyDbServer because it already extends another partyserver `Server` (the
// stand-in here for an agents-SDK AIChatAgent). It holds a `PartyDbCore`
// instead: it builds the adapter over its own storage, routes party-db traffic
// with `isPartyDbRequest` (the client marks every request with
// `?proto=party-db`, so the app configures nothing), tags those connections so
// hibernation keeps the routing, and scopes the fan-out to that tag. Its own
// socket traffic — a greeting frame — and its own HTTP route stay separate.
export class Composed extends Server {
  static options = { hibernate: true }
  private db!: PartyDbCore

  async onStart() {
    // the app owns its table, exactly as under PartyDbServer.
    this.ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS todos (
         id TEXT PRIMARY KEY,
         text TEXT NOT NULL,
         done INTEGER NOT NULL DEFAULT 0,
         rev INTEGER NOT NULL DEFAULT 1
       )`,
    )
    const engine: SqlEngine = {
      exec: (query, ...bindings) => this.ctx.storage.sql.exec(query, ...bindings),
      transaction: (fn) => this.ctx.storage.transactionSync(fn),
    }
    this.db = new PartyDbCore({
      collections: [todos],
      adapter: new SqliteAdapter(engine, [todos], { oplogRetention: 50 }),
      broadcast: (message) => {
        for (const conn of this.getConnections('party-db')) conn.send(message)
      },
    })
    await this.db.init()
  }

  getConnectionTags(_conn: Connection, ctx: ConnectionContext): string[] {
    return isPartyDbRequest(ctx.request) ? ['party-db'] : []
  }

  onConnect(conn: Connection, ctx: ConnectionContext): void | Promise<void> {
    // parse once: the same URL answers the routing question and carries `?since`.
    const url = new URL(ctx.request.url)
    if (isPartyDbRequest(url)) return this.db.connect((message) => conn.send(message), url)
    // the host's own protocol on its own connections — never a party-db frame.
    conn.send('host: hello')
  }

  onRequest(req: Request): Promise<Response> | Response {
    if (isPartyDbRequest(req)) return this.db.handleWrite(req)
    // the host's own HTTP surface — party-db traffic never reaches it.
    if (new URL(req.url).searchParams.has('host-status')) return Response.json({ host: 'ok' })
    return new Response('not found', { status: 404 })
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
