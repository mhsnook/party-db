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

import {
  isSnapshotRequest,
  parseFrame,
  PROTO_PARAM,
  PROTO_VALUE,
  type SequencedBatch,
  type WriteAck,
  type WriteBatch,
  type WriteReject,
} from '../protocol.ts'
import type { PartyCollection } from '../schema.ts'
import { MissedUpdateError, type PersistenceAdapter, type WriteIdentity } from './persistence.ts'
import {
  accessOf,
  AccessDenied,
  ANONYMOUS,
  audiencesOf,
  checkAccess,
  checkStored,
  gateWrite,
  isOpen,
  storedKeysNeeded,
  uidOf,
  visibleTo,
  type Audience,
  type CollectionAccess,
  type Viewer,
} from './access.ts'
import { columnsOf } from './columns.ts'

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
  // fan one frame out to part of the room only: `'authed'` is every party-db
  // socket with a signed-in user, `{ uid }` is that user's sockets. Required when
  // any collection's read policy is 'owner' or 'authed' — `init()` refuses to
  // start without it, so a host can never fan a private row out to everyone.
  // Same synchronous-send rule as `broadcast`. Pin each socket's user at connect
  // (`resolveViewer`), and look sockets up by it here; `viewerTags` and
  // `audienceTag` are the tag scheme `PartyDbServer` uses.
  broadcastTo?: (message: string, audience: Exclude<Audience, 'all'>) => void
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
  private broadcastTo?: (message: string, audience: Exclude<Audience, 'all'>) => void
  private access: Map<string, CollectionAccess>
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
    this.broadcastTo = opts.broadcastTo
    this.access = new Map(opts.collections.map((c) => [c.name, accessOf(c)]))
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
    this.checkAccessConfig()
    await this.adapter.init()
    // Latch check, at boot, not on the first anonymous request: if you've opened
    // anonymous writes with `anonRole`, prove the role is real and safe now — it
    // exists, this connection can assume it, and it does NOT bypass RLS. A throw
    // here fails the host loudly at startup rather than silently accepting
    // anonymous writes that wouldn't actually be governed. Adapters with no RLS
    // (SQLite/D1) have no `verifyAnonRole` and skip this.
    if (this.anonRole) await this.adapter.verifyAnonRole?.(this.anonRole)
  }

  // Refuse to start on an access declaration the room cannot enforce as written
  // (cookbook 5): an 'owner' policy with no column, a column the schema lacks, a
  // private read with no way to fan out privately, an 'owner' update or delete on
  // an adapter that cannot read the stored row.
  private checkAccessConfig(): void {
    for (const c of this.collections) checkAccess(c, columnsOf(c.schema)?.map((col) => col.name) ?? null)
    const accesses = [...this.access.values()]
    const privateRead = this.collections.filter((c) => ['owner', 'authed'].includes(this.access.get(c.name)!.policies.read))
    if (privateRead.length && !this.broadcastTo) {
      throw new Error(
        `collection(s) ${privateRead.map((c) => `"${c.name}"`).join(', ')} read as 'owner' or 'authed', ` +
          'so the room needs a `broadcastTo` to fan their rows out to the right sockets only',
      )
    }
    const storedCheck = accesses.some((a) => a.policies.update === 'owner' || a.policies.delete === 'owner')
    if (storedCheck && !this.adapter.readRows) {
      throw new Error("an 'owner' update or delete needs an adapter with readRows, to check the stored row's owner")
    }
    if (accesses.some((a) => !isOpen(a)) && !this.auth?.()) {
      console.warn(
        'party-db: collections declare access policies, but the room has no `auth` hook, so every request is ' +
          "anonymous: 'authed' and 'owner' verbs are refused, and their rows are never read.",
      )
    }
  }

  // True when a connect needs to know who the socket belongs to: some collection
  // reads as 'owner' or 'authed'. A room where every read is public never calls
  // the `auth` hook on connect.
  get readsNeedIdentity(): boolean {
    return [...this.access.values()].some((a) => a.policies.read === 'owner' || a.policies.read === 'authed')
  }

  // Resolve who a connecting socket belongs to, from its upgrade request, with the
  // same `auth` hook writes use. Pin the result to the socket (it survives
  // hibernation as a tag, see `viewerTags`) and pass it to `connect`,
  // `handleMessage`, and `broadcastTo`'s lookup. A hook that throws, or a room
  // with no private reads, resolves anonymous.
  async resolveViewer(req: Request): Promise<Viewer> {
    const auth = this.auth?.()
    if (!auth || !this.readsNeedIdentity) return ANONYMOUS
    try {
      return { uid: uidOf(await auth(req)) }
    } catch {
      return ANONYMOUS
    }
  }

  // `batch` as `viewer` may read it, or null for nothing to send.
  private visible(batch: SequencedBatch, viewer: Viewer): SequencedBatch | null {
    return visibleTo(this.access.get(batch.channel), batch, viewer)
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
  //
  // `viewer` is who the socket belongs to (`resolveViewer`): the snapshot and the
  // delta carry only the rows its read policies allow. Omitted, it is anonymous.
  connect(send: (message: string) => void, url: string | URL, viewer: Viewer = ANONYMOUS): Promise<void> {
    return this.serialize(async () => {
      const parsed = url instanceof URL ? url : new URL(url)
      const cursor = cursorParam(parsed.searchParams.get('since'))
      const delta = cursor === null ? null : await this.adapter.replaySince(cursor)
      const batches = delta ?? (await this.adapter.snapshot())
      for (const b of batches) {
        const visible = this.visible(b, viewer)
        if (visible) send(JSON.stringify(visible))
      }
    })
  }

  // Serve one frame a client sent UP the socket. Today there is exactly one:
  // `{ snapshot: <channel> }`, which a client sends when a collection registers
  // a second time and its rows are gone (docs/architecture.md §8a, #47). We answer
  // with an ordinary snapshot batch for that channel — `reset: true`, so the
  // client truncates before applying — to this connection alone.
  //
  // Everything else is dropped: a frame that isn't ours (a composed host shares
  // the socket, §15) and a channel this room doesn't serve, mirroring the client's
  // own posture on frames it can't route (#48). A drop is silent — a socket has no
  // reply channel for an error, and the client is not waiting on one.
  //
  // Runs through the same queue as writes and connects, so the read and its send
  // cannot interleave with a concurrent commit's broadcast: the client sees the
  // snapshot, then every seq after it, in order.
  handleMessage(send: (message: string) => void, message: unknown, viewer: Viewer = ANONYMOUS): Promise<void> {
    const channel = parseFrame(message, isSnapshotRequest)?.snapshot
    if (channel === undefined || !this.channels.has(channel)) return Promise.resolve()
    return this.serialize(async () => {
      const batches = await this.adapter.snapshot(channel)
      // an adapter that ignores the argument hands back every channel; send only
      // the one that was asked for, as this socket's user may read it.
      for (const b of batches) {
        const visible = b.channel === channel ? this.visible(b, viewer) : null
        if (visible) send(JSON.stringify(visible))
      }
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

    // The access policies (cookbook 5): each op's verb against its collection's
    // policy, the owner column stamped or checked, before any transaction opens.
    // The stored-row half of an 'owner' update or delete runs inside the queue.
    const viewer: Viewer = { uid: uidOf(identity) }
    let gated: WriteBatch[]
    try {
      gated = gateWrite(this.access, body, viewer)
    } catch (e) {
      if (!(e instanceof AccessDenied)) throw e
      return Response.json({ error: e.message, channel: e.channel } satisfies WriteReject, { status: e.status })
    }

    let sequenced: SequencedBatch[]
    try {
      sequenced = await this.commitSection(gated, identity ?? undefined, viewer)
    } catch (e) {
      if (e instanceof AccessDenied) {
        return Response.json({ error: e.message, channel: e.channel } satisfies WriteReject, { status: e.status })
      }
      // a constraint rejection is the database's verdict on the DATA — hand it
      // back faithfully (409) so the client can roll back and report it. Anything
      // else (missing table, adapter bug) is an internal fault: log the detail
      // server-side and keep the response generic, or we'd echo schema internals
      // to any writer and mislabel 500-class faults as data rejections.
      //
      // A missed update (§16) carries its own rejection; otherwise the adapter
      // classifies if it can (Postgres reads SQLSTATE + constraint name off the
      // error), and adapters without a classifier (embedded + D1) fall through to
      // the SQLite-message regex. The rejection picks the status too — 409 for an
      // integrity conflict (default), 403 for an RLS denial — stripped from the
      // client body.
      const rejection = e instanceof MissedUpdateError ? e.rejection : this.adapter.classifyError?.(e)
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
    // subscription; `accepted` is the match token it awaits on the stream. Both
    // hold only what the writer may read: a batch the writer cannot read never
    // streams back to it, so waiting on it would only time out.
    const readable = sequenced.map((b) => this.visible(b, viewer)).filter((b): b is SequencedBatch => b !== null)
    const ack: WriteAck = {
      accepted: readable.map((b) => ({ channel: b.channel, seq: b.seq })),
      changed: readable,
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
  //
  // Host-authored writes skip the access policies' write gate — the host is
  // trusted — but their fan-out still follows each collection's read policy.
  commit(batches: WriteBatch[], identity?: WriteIdentity): Promise<SequencedBatch[]> {
    return this.commitSection(batches, identity)
  }

  // The serialized write → seq → broadcast section. With a `viewer`, it first
  // checks every 'owner' update and delete against the stored row, inside the
  // queue, so no other write can change that row between the check and the commit.
  private commitSection(batches: WriteBatch[], identity?: WriteIdentity, viewer?: Viewer): Promise<SequencedBatch[]> {
    return this.serialize(async () => {
      const checked = viewer ? await this.checkOwners(batches, viewer) : batches
      const sequenced = await this.adapter.write(checked, identity)
      // broadcast only after the commit succeeds, inline inside the queued
      // section, which is what keeps broadcast order == seq order.
      for (const batch of sequenced) this.fanOut(batch)
      return sequenced
    })
  }

  private async checkOwners(batches: WriteBatch[], viewer: Viewer): Promise<WriteBatch[]> {
    const needed = storedKeysNeeded(this.access, batches)
    if (!needed.size) return batches
    const stored = new Map<string, Map<string, Record<string, unknown>>>()
    for (const [channel, keys] of needed) {
      const key = this.access.get(channel)!.key
      const rows = (await this.adapter.readRows?.(channel, keys)) ?? []
      stored.set(channel, new Map(rows.map((row) => [String(row[key]), row])))
    }
    return checkStored(this.access, batches, stored, viewer)
  }

  // Send one committed batch to the sockets allowed to read it: everyone for a
  // public collection (one serialization, §9's fast path), otherwise per audience.
  private fanOut(batch: SequencedBatch): void {
    for (const { audience, batch: frame } of audiencesOf(this.access.get(batch.channel), batch)) {
      const message = JSON.stringify(frame)
      if (audience === 'all') this.broadcast(message)
      else this.broadcastTo?.(message, audience)
    }
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
