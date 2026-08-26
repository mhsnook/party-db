// The core functionality of a party-db room: the adapter seam, the write queue,
// `connect` (the `?since` replay), `handleWrite` (the POST path), and `commit`.
//
// `PartyDbServer` is a thin subclass over this core, and the common case. The
// core exists for the host that cannot subclass — one that already extends
// another partyserver `Server` (an agents-SDK `AIChatAgent`, say). Such a host
// constructs the core in its `onStart`, calls `init()`, and forwards its
// `onConnect` / `onRequest` events, routing party-db traffic with
// `isPartyDbRequest`. Worked example: README §"A Server that can't subclass
// holds the core instead". Tested copy: `Composed` in
// `test/integration/worker.ts`. Design record: docs/architecture.md §15.

import { PROTO_PARAM, PROTO_VALUE, type SequencedBatch, type WriteAck, type WriteBatch, type WriteReject } from '../protocol.ts'
import type { PartyCollection } from '../schema.ts'
import type { PersistenceAdapter, WriteIdentity } from './persistence.ts'
import { warnUnenforcedAccess } from './access.ts'

// The write-identity hook: resolve the writer's verified identity from a POST.
// Full semantics on `PartyDbServer.auth`, which is this same hook as a field.
export type AuthHook = (req: Request) => WriteIdentity | null | Promise<WriteIdentity | null>

// True when a request (or an already-parsed URL) is party-db traffic: the client
// marks every connect and write POST with `?proto=party-db`. A host that serves
// other traffic on the same room routes with this — tag marked connects in
// `getConnectionTags`, hand marked POSTs to `handleWrite`. A `PartyDbServer`
// room serves only party-db traffic and never checks it.
export function isPartyDbRequest(source: Request | URL): boolean {
  const url = source instanceof URL ? source : new URL(source.url)
  return url.searchParams.get(PROTO_PARAM) === PROTO_VALUE
}

export interface PartyDbCoreOptions {
  // the same declaration a `PartyDbServer` subclass makes: name, key, shared schema.
  collections: PartyCollection<any>[]
  // the storage target, built by the host over its own storage (its DO's SQLite,
  // a D1 binding, a Postgres connection). The core calls `init()` on it in `init`.
  adapter: PersistenceAdapter
  // fan one committed frame out to every party-db subscriber. The host owns the
  // sockets, so it decides which connections those are; the core calls this
  // inline inside the serialized commit section, so send order equals seq order
  // as long as the callback sends synchronously (a plain `conn.send` loop does).
  broadcast: (message: string) => void
  // read once per write: return the CURRENT identity hook, or undefined when
  // writes are anonymous. A getter rather than the hook itself so presence stays
  // live — whether a hook exists at write time decides fail-closed handling (no
  // hook ⇒ anonymous writes pass; hook ⇒ they are rejected 401 unless `anonRole`
  // names the role they run as). Hook semantics: `PartyDbServer.auth`.
  auth?: () => AuthHook | undefined
  // the anonymous-write latch — see `PartyDbServer.anonRole`. Postgres only.
  // Fixed at construction on purpose, unlike `auth`: `init()` probes the role
  // once at boot (`verifyAnonRole`), and a later value would skip that probe.
  anonRole?: string
  // reject a write body over this many bytes (413). 0 disables. Default 1 MiB.
  maxWriteBytes?: number
  // reject a write carrying more ops than this across all batches (413). 0
  // disables. Default 1000.
  maxWriteOps?: number
}

// One owner for the write-cap defaults: `PartyDbServer`'s field initializers and
// the core's option fallbacks both read these, so the two host styles can't drift.
export const DEFAULT_MAX_WRITE_BYTES = 1_048_576 // 1 MiB
export const DEFAULT_MAX_WRITE_OPS = 1_000

export class PartyDbCore {
  private adapter: PersistenceAdapter
  private collections: PartyCollection<any>[]
  private broadcast: (message: string) => void
  private auth?: () => AuthHook | undefined
  private anonRole?: string
  private maxWriteBytes: number
  private maxWriteOps: number
  private channels: Set<string>
  // serializes the write → seq → broadcast section. A no-op for embedded SQLite
  // (the apply is synchronous), but the contract is async for D1, where two
  // concurrent POSTs' awaits could otherwise interleave the ordering.
  private queue: Promise<unknown> = Promise.resolve()

  constructor(opts: PartyDbCoreOptions) {
    this.adapter = opts.adapter
    this.collections = opts.collections
    this.broadcast = opts.broadcast
    this.auth = opts.auth
    this.anonRole = opts.anonRole
    this.maxWriteBytes = opts.maxWriteBytes ?? DEFAULT_MAX_WRITE_BYTES
    this.maxWriteOps = opts.maxWriteOps ?? DEFAULT_MAX_WRITE_OPS
    this.channels = new Set(opts.collections.map((c) => c.name))
  }

  // Run `fn` after every previously-queued section completes, so the ordering of
  // write → seq → broadcast across concurrent writes and connects stays total.
  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn)
    this.queue = run.then(
      () => {},
      () => {},
    )
    return run
  }

  // Call once from the host's `onStart`, before any connect or write.
  async init(): Promise<void> {
    // Until access policies are implemented (#33) this warns you if you set up
    // access policies that don't do anything yet.
    warnUnenforcedAccess(this.collections)
    await this.adapter.init()
    // Latch check, at boot, not on the first anonymous request: if you've opened
    // anonymous writes with `anonRole`, prove the role is real and safe now — it
    // exists, this connection can assume it, and it does NOT bypass RLS. A throw
    // here fails the host loudly at startup rather than silently accepting
    // anonymous writes that wouldn't actually be governed. Adapters with no RLS
    // (SQLite/D1) have no `verifyAnonRole` and skip this.
    if (this.anonRole) await this.adapter.verifyAnonRole?.(this.anonRole)
  }

  // Serve one party-db client's connect: a reconnecting client passes
  // ?since=<lastSeq> and gets only what it missed; a fresh client gets a full
  // snapshot. We fall back to a snapshot when `since` is absent, not a valid
  // cursor, or older than the oplog still retains (replaySince → null) — never
  // a gappy delta (docs/architecture.md §8).
  //
  // Runs through the same queue as writes so the snapshot read and its send are
  // atomic w.r.t. writes — otherwise a concurrent commit could broadcast a newer
  // seq to this socket before its snapshot lands. The send loop is synchronous
  // ws.send enqueues, so the queue is never held on network I/O.
  connect(send: (message: string) => void, url: string | URL): Promise<void> {
    return this.serialize(async () => {
      const parsed = url instanceof URL ? url : new URL(url)
      const cursor = cursorParam(parsed.searchParams.get('since'))
      const delta = cursor === null ? null : await this.adapter.replaySince(cursor)
      const batches = delta ?? (await this.adapter.snapshot())
      for (const b of batches) send(JSON.stringify(b))
    })
  }

  // Serve one POST /write. The WHOLE body commits in one transaction, so a
  // cross-collection write (e.g. a post + its tags) is all-or-nothing — matching
  // the client's atomic intent.
  async handleWrite(req: Request): Promise<Response> {
    if (req.method !== 'POST') return new Response('not found', { status: 404 })

    // bound memory per request BEFORE buffering the body: trust content-length
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
    // transaction, so it can be injected into the write (Postgres RLS). The hook
    // itself is also read fresh, so its presence — which flips anonymous writes
    // to fail-closed below — is judged at write time, not at boot. A verifier
    // that throws (malformed/expired token) is an auth failure → 401, not a 500;
    // the app's lobby gate may also have refused earlier, this is belt-and-braces.
    const auth = this.auth?.()
    let identity: WriteIdentity | null = null
    if (auth) {
      try {
        identity = await auth(req)
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
      } else if (auth) {
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
  // whole call, a `seq` and an `_oplog` entry per batch, then fan-out through the
  // host's `broadcast`. Returns the sequenced batches — the resolved rows the
  // database committed, each with its seq.
  //
  // Call it for a write the SERVER authors: a job, an agent, host code running in
  // the room's own DO. Writing those rows with your own SQL instead splits the
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
  // A rejection from the database THROWS. `handleWrite` turns that into a
  // 409/403/500; host code catches it however it reports its own failures.
  commit(batches: WriteBatch[], identity?: WriteIdentity): Promise<SequencedBatch[]> {
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
