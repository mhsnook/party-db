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
import type { PersistenceAdapter } from './persistence.ts'
import { SqliteAdapter, type SqlEngine } from './sqlite-adapter.ts'

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
    this.adapter = this.createAdapter()
    for (const c of this.collections) this.channels.add(c.name)
    await this.adapter.init()
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

    return this.serialize(async () => {
      let sequenced: SequencedBatch[]
      try {
        sequenced = await this.adapter.write(body)
      } catch (e) {
        // a constraint rejection is the database's verdict on the DATA — hand it
        // back faithfully (409) so the client can roll back and report it. Anything
        // else (missing table, adapter bug) is an internal fault: log the detail
        // server-side and keep the response generic, or we'd echo schema internals
        // to any writer and mislabel 500-class faults as data rejections.
        //
        // The adapter classifies first if it can (Postgres reads SQLSTATE +
        // constraint name off the error); adapters without their own classifier
        // (embedded + D1) fall through to the SQLite-message regex, unchanged.
        const rejection = this.adapter.classifyError?.(e)
        if (rejection) return Response.json(rejection satisfies WriteReject, { status: 409 })
        if (isConstraintError(e)) {
          return Response.json({ error: messageOf(e), ...constraintOf(e) } satisfies WriteReject, { status: 409 })
        }
        console.error('party-db write failed:', e)
        return Response.json({ error: 'internal error applying write' } satisfies WriteReject, { status: 500 })
      }

      // broadcast only after the commit succeeds; inline before responding keeps
      // broadcast order == seq order. `changed` carries the resolved rows for a
      // caller that holds no stream subscription.
      const ack: WriteAck = { accepted: [], changed: sequenced }
      for (const batch of sequenced) {
        this.broadcast(JSON.stringify(batch))
        ack.accepted.push({ channel: batch.channel, seq: batch.seq })
      }
      return Response.json(ack)
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
