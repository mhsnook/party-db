// The slim DO-controlled server: a partyserver `Server` that serves BOTH the
// hibernatable WebSocket (down) and POST /write (up) for a room, persisting into
// the DO's own SQLite via a PersistenceAdapter.
//
// What it is: the transport. It replaces the `onInsert/onUpdate/onDelete` + REST
// endpoint + realtime fan-out + client ingest you'd otherwise hand-write. It does
// NOT own your schema or your tables — you bring those (your app already has a
// database). Declaring the collections (name, key, shared schema) is the whole
// server:
//
//   export class Room extends PartyDbServer {
//     collections = [definePartyCollection<Todo>({ name: 'todos', key: 'id', schema: todoSchema })]
//     // create YOUR tables however you migrate them; we only CRUD over them:
//     onStart() {
//       this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS todos (...)`)
//       return super.onStart()
//     }
//   }

import { Server, type Connection, type ConnectionContext } from 'partyserver'
import type { SequencedBatch, WriteAck, WriteBatch, WriteReject } from '../protocol.ts'
import type { PartyCollection } from '../schema.ts'
import type { PersistenceAdapter, WriteIdentity } from './persistence.ts'
import { SqliteAdapter, type SqlEngine } from './sqlite-adapter.ts'
import { warnUnenforcedAccess } from './access.ts'

export class PartyDbServer<Env extends Cloudflare.Env = Cloudflare.Env> extends Server<Env> {
  static options = { hibernate: true }
  collections: PartyCollection<any>[] = []
  // keep at most this many _oplog rows per room (older entries are compacted away
  // after each write); a client whose `since` predates the retained window gets a
  // fresh reset snapshot (see docs/architecture.md §8). Override in your subclass;
  // set 0 for unbounded (the pre-1.0 behavior).
  oplogRetention = 10_000
  // reject a POST /write whose body exceeds this many bytes (413). Bounds DO
  // memory per request. Override to tune; 0 disables the check.
  maxWriteBytes = 1_048_576 // 1 MiB
  // reject a POST /write carrying more than this many ops across all batches
  // (413). Override to tune; 0 disables the check.
  maxWriteOps = 1_000

  // Resolve the writer's verified identity from the POST — fresh every request,
  // never a stale value — so the storage layer can enforce it. On Postgres the
  // returned claims/role are injected into the write transaction (transaction-
  // local `SET`) and the app's own Row-Level Security policies decide what the
  // write may touch; a forged or unauthorized write comes back 403. Adapters with
  // no RLS (embedded SQLite, D1) ignore the result, so this is a no-op there.
  //
  // The library does NOT verify the token — you do, here: read the credential
  // (`getTokenFromRequest`), verify it however you verify JWTs (JWKS, shared
  // secret — your call), and return its claims. Return `null` for an anonymous /
  // unauthenticated write — which is REJECTED (401) unless you've latched anonymous
  // writes open with `anonRole` (see below). This is orthogonal to the lobby
  // `authHooks` gate (a coarse allow/deny before the DO wakes); this hook produces
  // the identity the DATABASE enforces against. A throw is an auth failure → 401.
  auth?: (req: Request) => WriteIdentity | null | Promise<WriteIdentity | null>

  // The single latch for anonymous writes, and it is a DELIBERATE one. When `auth`
  // is configured, a write that resolves NO identity is REJECTED (401) unless you
  // name an `anonRole` here — then it runs as that role via `SET LOCAL role`.
  // Anonymous is never inferred, never inherited, never the privileged connection:
  // the server assigns this role itself (nothing from the client is trusted), and
  // because only a role switch drops privilege — an absent claim does not — the
  // role governs the write even on a privileged connection. Make it a low-privilege,
  // RLS-subject role (e.g. `anon`, PostgREST/Supabase's convention); `onStart`
  // probes at boot that it exists, is assumable from the adapter's connection, and
  // does NOT bypass RLS, and throws loudly if not. Unset ⇒ every unsigned write is
  // rejected. Postgres only; SQLite/D1 have no roles and ignore it.
  anonRole?: string

  private adapter!: PersistenceAdapter
  private channels = new Set<string>()
  // serializes the write → seq → broadcast section. A no-op for embedded SQLite
  // (the apply is synchronous), but the contract is async for D1, where two
  // concurrent POSTs' awaits could otherwise interleave the ordering.
  private queue: Promise<unknown> = Promise.resolve()

  // Override to swap the storage target (e.g. a D1 adapter). Default: the DO's
  // own embedded SQLite.
  protected createAdapter(): PersistenceAdapter {
    const engine: SqlEngine = {
      exec: (query, ...bindings) => this.ctx.storage.sql.exec(query, ...bindings),
      transaction: (fn) => this.ctx.storage.transactionSync(fn),
    }
    return new SqliteAdapter(engine, this.collections, { oplogRetention: this.oplogRetention })
  }

  private send(conn: Connection, batch: SequencedBatch) {
    conn.send(JSON.stringify(batch))
  }

  // Run `fn` after every previously-queued write section completes, so the
  // ordering of write → seq → broadcast across concurrent POSTs stays total.
  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn)
    this.queue = run.then(
      () => {},
      () => {},
    )
    return run
  }

  async onStart() {
    // Until access policies are implemented (#33) this will warn you if you set up
    // access policies that don't do anything yet.
    warnUnenforcedAccess(this.collections)
    this.adapter = this.createAdapter()
    for (const c of this.collections) this.channels.add(c.name)
    await this.adapter.init()
    // Latch check, at boot, not on the first anonymous request: if you've opened
    // anonymous writes with `anonRole`, prove the role is real and safe now — it
    // exists, this connection can assume it, and it does NOT bypass RLS. A throw
    // here fails the DO loudly at startup rather than silently accepting anonymous
    // writes that wouldn't actually be governed. Adapters with no RLS (SQLite/D1)
    // have no `verifyAnonRole` and skip this.
    if (this.anonRole) await this.adapter.verifyAnonRole?.(this.anonRole)
  }

  // a reconnecting client passes ?since=<lastSeq> and gets only what it missed;
  // a fresh client gets a full snapshot. We fall back to a snapshot when `since` is
  // absent, not a valid cursor, or older than the oplog still retains (replaySince
  // → null) — never a gappy delta (docs/architecture.md §8).
  //
  // Runs through the same queue as writes so the snapshot read and its send are
  // atomic w.r.t. writes — otherwise a concurrent commit could broadcast a newer
  // seq to this socket before its snapshot lands. The send loop is synchronous
  // ws.send enqueues, so the queue is never held on network I/O.
  async onConnect(conn: Connection, ctx: ConnectionContext) {
    await this.serialize(async () => {
      const cursor = cursorParam(new URL(ctx.request.url).searchParams.get('since'))
      const delta = cursor === null ? null : await this.adapter.replaySince(cursor)
      const batches = delta ?? (await this.adapter.snapshot())
      for (const b of batches) this.send(conn, b)
    })
  }

  // controlled mode writes come over HTTP, not the (hibernating) socket. The
  // WHOLE body commits in one transaction, so a cross-collection write (e.g. a
  // post + its tags) is all-or-nothing — matching the client's atomic intent.
  async onRequest(req: Request): Promise<Response> {
    if (req.method !== 'POST') return new Response('not found', { status: 404 })

    // bound DO memory per request BEFORE buffering the body: trust content-length
    // when the client sends one, and re-check the actual text for those that don't.
    const declared = Number(req.headers.get('content-length'))
    if (this.maxWriteBytes > 0 && declared > this.maxWriteBytes) {
      return Response.json({ error: `write too large (max ${this.maxWriteBytes} bytes)` } satisfies WriteReject, { status: 413 })
    }
    const text = await req.text()
    if (this.maxWriteBytes > 0 && text.length > this.maxWriteBytes) {
      return Response.json({ error: `write too large (max ${this.maxWriteBytes} bytes)` } satisfies WriteReject, { status: 413 })
    }

    let body: WriteBatch[]
    try {
      body = JSON.parse(text) as WriteBatch[]
    } catch {
      return Response.json({ error: 'invalid JSON body' } satisfies WriteReject, { status: 400 })
    }
    if (!Array.isArray(body)) {
      return Response.json({ error: 'body must be a WriteBatch[]' } satisfies WriteReject, { status: 400 })
    }
    for (const batch of body) {
      if (!this.channels.has(batch?.channel)) {
        return Response.json({ error: `unknown channel: ${batch?.channel}`, channel: batch?.channel } satisfies WriteReject, {
          status: 400,
        })
      }
      if (!Array.isArray(batch.ops)) {
        return Response.json({ error: `ops must be an array (channel: ${batch.channel})`, channel: batch.channel } satisfies WriteReject, {
          status: 400,
        })
      }
    }
    const opCount = body.reduce((n, b) => n + (b?.ops?.length ?? 0), 0)
    if (this.maxWriteOps > 0 && opCount > this.maxWriteOps) {
      return Response.json({ error: `write carries too many ops (max ${this.maxWriteOps})` } satisfies WriteReject, { status: 413 })
    }

    // resolve the writer's identity fresh for THIS POST, before opening any
    // transaction, so it can be injected into the write (Postgres RLS). A verifier
    // that throws (malformed/expired token) is an auth failure → 401, not a 500;
    // the app's lobby gate may also have refused earlier, this is belt-and-braces.
    let identity: WriteIdentity | null = null
    if (this.auth) {
      try {
        identity = await this.auth(req)
      } catch {
        return Response.json({ error: 'unauthorized' } satisfies WriteReject, { status: 401 })
      }
    }

    // The anonymous case — no resolved claims or role — is fail-closed. `anonRole`
    // is the deliberate latch: set → run as that low-privilege role; unset (with
    // `auth` in use) → reject before any SQL, rather than run identity-less, which
    // on a privileged connection would bypass RLS. With no `auth` hook at all this
    // block is inert: the write proceeds as the connection role, as a non-RLS
    // server always has.
    if (!identity?.claims && !identity?.role) {
      if (this.anonRole) {
        identity = { role: this.anonRole }
      } else if (this.auth) {
        return Response.json({ error: 'authentication required' } satisfies WriteReject, { status: 401 })
      }
      // else: no `auth` hook at all → anonymous is fine, `identity` stays null and
      // the write proceeds as the connection role, as a non-RLS server always has.
    }

    let sequenced: SequencedBatch[]
    try {
      sequenced = await this.commit(body, identity ?? undefined)
    } catch (e) {
      // a constraint rejection is the database's verdict on the DATA — hand it
      // back faithfully (409) so the client can roll back and report it. Anything
      // else (missing table, adapter bug) is an internal fault: log the detail
      // server-side and keep the response generic, or we'd echo schema internals
      // to any writer and mislabel 500-class faults as data rejections.
      //
      // The adapter classifies first if it can (Postgres reads SQLSTATE +
      // constraint name off the error); adapters without their own classifier
      // (embedded + D1) fall through to the SQLite-message regex, unchanged. The
      // adapter picks the status too — 409 for an integrity conflict (default),
      // 403 for an RLS/authorization denial — stripped from the client body.
      const rejection = this.adapter.classifyError?.(e)
      if (rejection) {
        const { status = 409, ...reject } = rejection
        return Response.json(reject satisfies WriteReject, { status })
      }
      if (isConstraintError(e)) {
        return Response.json({ error: messageOf(e), ...constraintOf(e) } satisfies WriteReject, { status: 409 })
      }
      console.error('party-db write failed:', e)
      return Response.json({ error: 'internal error applying write' } satisfies WriteReject, { status: 500 })
    }

    // `changed` carries the resolved rows for a caller that holds no stream
    // subscription; `accepted` is the match token it awaits on the stream.
    const ack: WriteAck = {
      accepted: sequenced.map((b) => ({ channel: b.channel, seq: b.seq })),
      changed: sequenced,
    }
    return Response.json(ack)
  }

  // Commit batches into the room exactly as a POST does: one transaction for the
  // whole call, a `seq` and an `_oplog` entry per batch, then fan-out to every
  // connected socket. Returns the sequenced batches — the resolved rows the
  // database committed, each with its seq.
  //
  // Call it for a write the SERVER authors: a job, an agent, host code running in
  // this room's own DO. Writing those rows with your own SQL instead splits the
  // room — the rows reach a freshly-connecting client through the snapshot, but
  // never reach an already-connected one and never appear in a reconnect delta.
  //
  // Two properties come with the queue this runs through. Ordering holds:
  // `commit` shares the `serialize` queue with concurrent POSTs, so broadcast
  // order stays equal to seq order. And it sits BELOW the HTTP path's size, shape
  // and token checks — right for a write the server itself authors, since the
  // caller is privileged host code. Pass `identity` to have the database judge it
  // anyway (Postgres RLS); omit it and the write runs as the connection's role.
  //
  // A rejection from the database THROWS. `onRequest` turns that into a 409/403/500;
  // host code catches it however it reports its own failures.
  protected commit(batches: WriteBatch[], identity?: WriteIdentity): Promise<SequencedBatch[]> {
    return this.serialize(async () => {
      const sequenced = await this.adapter.write(batches, identity)
      // broadcast only after the commit succeeds, inline inside the queued
      // section, which is what keeps broadcast order == seq order.
      for (const batch of sequenced) this.broadcast(JSON.stringify(batch))
      return sequenced
    })
  }
}

// Parse the `?since` query param into a usable cursor. null → snapshot: missing,
// or garbage (NaN, negative, non-integer) that we won't turn into a `seq > NaN`
// query that silently returns nothing.
function cursorParam(raw: string | null): number | null {
  if (raw === null) return null
  const n = Number(raw)
  return Number.isInteger(n) && n >= 0 ? n : null
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

// SQLite phrases every constraint rejection with this substring; anything else
// coming out of the adapter is an internal fault, not a data verdict.
function isConstraintError(e: unknown): boolean {
  return /constraint failed/i.test(messageOf(e))
}

// best-effort: pull the offending constraint out of a SQLite error message like
// "UNIQUE constraint failed: todos.id". Absent on non-constraint errors.
function constraintOf(e: unknown): { constraint?: string } {
  const m = /(\w+) constraint failed: ([^\s]+)/i.exec(messageOf(e))
  return m ? { constraint: `${m[1].toUpperCase()}: ${m[2]}` } : {}
}
