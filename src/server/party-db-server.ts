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
//     collections = [definePartyCollection({ name: 'todos', key: 'id', schema: todoSchema })]
//     // create YOUR tables however you migrate them; we only CRUD over them:
//     onStart() {
//       this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS todos (...)`)
//       return super.onStart()
//     }
//   }
//
// Everything below `onConnect`/`onRequest` lives in `PartyDbCore` (core.ts): this
// class only builds the core over the DO's storage and hands it the lifecycle
// events. A host that cannot subclass — it already extends another partyserver
// `Server` — holds a `PartyDbCore` itself and does the same wiring (§15).

import { Server, type Connection, type ConnectionContext, type WSMessage } from 'partyserver'
import { CLOSE_IDENTITY_CHANGED, type SequencedBatch, type WriteBatch } from '../protocol.ts'
import type { PartyCollection } from '../schema.ts'
import type { PersistenceAdapter, WriteIdentity } from './persistence.ts'
import { SqliteAdapter, type SqlEngine } from './sqlite-adapter.ts'
import { PartyDbCore, DEFAULT_MAX_WRITE_BYTES, DEFAULT_MAX_WRITE_OPS } from './core.ts'
import { assertConnectionId, audienceTag, viewerFromTags, viewerTags } from './access.ts'
import type { PartyDbConnection, Subscription } from './slices.ts'

export class PartyDbServer<Env extends Cloudflare.Env = Cloudflare.Env> extends Server<Env> {
  static options = { hibernate: true }
  collections: PartyCollection<any>[] = []
  // keep at most this many _oplog rows per room (older entries are compacted away
  // after each write); a client whose `since` predates the retained window gets a
  // fresh reset snapshot (see docs/architecture.md §8). Override in your subclass;
  // set 0 for unbounded (the pre-1.0 behavior).
  oplogRetention = 10_000
  // reject a POST /write whose body exceeds this many bytes (413; 1 MiB). Bounds
  // DO memory per request. Override to tune; 0 disables the check.
  maxWriteBytes = DEFAULT_MAX_WRITE_BYTES
  // reject a POST /write carrying more than this many ops across all batches
  // (413). Override to tune; 0 disables the check.
  maxWriteOps = DEFAULT_MAX_WRITE_OPS

  // Resolve the writer's verified identity from the POST — fresh every request,
  // never a stale value — so the storage layer can enforce it. On Postgres the
  // returned claims/role are injected into the write transaction (transaction-
  // local `SET`) and the app's own Row-Level Security policies decide what the
  // write may touch; a forged or unauthorized write comes back 403. Adapters with
  // no RLS (embedded SQLite, D1) ignore the result in the database itself.
  //
  // It is also the identity the collections' access policies judge (cookbook 5),
  // on every adapter: the uid they compare against is the claims' `sub`. Writes
  // resolve it fresh; a socket resolves it once, at connect, from its upgrade
  // request (a browser sends the token in `?token=`), and keeps it until it
  // reconnects.
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

  private core!: PartyDbCore

  // Override to swap the storage target (e.g. a D1 adapter). Default: the DO's
  // own embedded SQLite.
  protected createAdapter(): PersistenceAdapter {
    const engine: SqlEngine = {
      exec: (query, ...bindings) => this.ctx.storage.sql.exec(query, ...bindings),
      transaction: (fn) => this.ctx.storage.transactionSync(fn),
    }
    return new SqliteAdapter(engine, this.collections, { oplogRetention: this.oplogRetention })
  }

  async onStart() {
    this.core = new PartyDbCore({
      collections: this.collections,
      adapter: this.createAdapter(),
      // 'all' is partyserver's own room-wide broadcast (§9's one serialization);
      // any narrower audience is looked up by the tags `getConnectionTags` pinned
      // to each socket at connect.
      broadcast: (message, audience) => {
        if (audience === 'all') return this.broadcast(message)
        for (const conn of this.getConnections(audienceTag(audience))) conn.send(message)
      },
      // `auth` threads as a live read: the core asks for the hook on every
      // write, so its presence — the fail-closed switch — is judged at write
      // time, exactly like the field read it replaces. The other options are
      // read once here: `anonRole` deliberately, because `onStart` probes the
      // role at boot and a later value would skip the probe; the caps because
      // a later field change simply isn't picked up.
      auth: () => this.auth?.bind(this),
      anonRole: this.anonRole,
      maxWriteBytes: this.maxWriteBytes,
      maxWriteOps: this.maxWriteOps,
      connections: (audience) => [...this.getConnections(audience && audienceTag(audience))].map(partyConnection),
    })
    await this.core.init()
  }

  // Pin the socket's user to it, as tags that survive hibernation, when some
  // collection's reads depend on who is asking. A room whose reads are all public
  // tags nothing and never calls `auth` here. Overriding this? Keep these tags:
  // `return [...(await super.getConnectionTags(conn, ctx)), ...yours]`. A socket
  // holds 9 tags and these take up to 2 + MAX_ROLE_TAGS of them; past 9 in total,
  // partyserver refuses the connect.
  async getConnectionTags(conn: Connection, ctx: ConnectionContext): Promise<string[]> {
    assertConnectionId(conn.id)
    return viewerTags(await this.core.resolveViewer(ctx.request))
  }

  onConnect(conn: Connection, ctx: ConnectionContext): Promise<void> {
    return this.core.connect(partyConnection(conn), ctx.request.url)
  }

  // The frames a client sends up the socket: subscribe and unsubscribe, for a
  // sliced collection's slices and for a collection that registered a second time
  // (docs/architecture.md §8a, §18). The core answers this connection alone;
  // anything else it drops.
  //
  // Serving your own socket traffic from the same room? Override this and chain —
  // `return super.onMessage(conn, message)` — the way `onStart` does above. An
  // override that doesn't chain leaves a re-registered collection empty and a
  // sliced one loading forever.
  onMessage(conn: Connection, message: WSMessage): Promise<void> {
    return this.core.handleMessage(partyConnection(conn), message)
  }

  // Overriding this? Chain `super.onClose(conn, code, reason, wasClean)`.
  onClose(conn: Connection, _code: number, _reason: string, _wasClean: boolean): void {
    this.core.disconnect(conn.id)
  }

  // controlled mode writes come over HTTP, not the (hibernating) socket.
  onRequest(req: Request): Promise<Response> {
    return this.core.handleWrite(req)
  }

  // Close every socket of `uid`, so each redials and is judged by the identity
  // the `auth` hook resolves now. Call it when a user's roles change or they are
  // deactivated: a socket's identity is fixed at connect. The client drops its
  // cursor on this close (`CLOSE_IDENTITY_CHANGED`) and reloads a full snapshot,
  // which also takes back rows the old identity could read. A room whose reads are
  // all public tags no socket by user, so there this closes nothing.
  reconnectUser(uid: string, reason = 'identity changed'): void {
    for (const conn of this.getConnections(audienceTag({ uid }))) conn.close(CLOSE_IDENTITY_CHANGED, reason)
  }

  // The write → seq → broadcast section, for a row the server itself authors
  // (docs/architecture.md §14). Delegates to the core, which documents the
  // ordering and layering properties in full.
  protected commit(batches: WriteBatch[], identity?: WriteIdentity): Promise<SequencedBatch[]> {
    return this.core.commit(batches, identity)
  }
}

// The key party-db keeps a socket's slice subscriptions under, in partyserver's
// per-connection `state` — the one slot that survives hibernation. The rest of
// `state` is yours. Replacing `state` wholesale with `setState(value)` drops this
// key; the room then sends that socket every sliced collection whole, which is
// correct but heavy. Merge instead: `conn.setState((s) => ({ ...s, mine }))`.
export const SUBSCRIPTIONS_KEY = 'partyDbSubscriptions'

function partyConnection(conn: Connection): PartyDbConnection {
  return {
    id: conn.id,
    send: (message) => conn.send(message),
    viewer: viewerFromTags(conn.tags),
    loadSubscriptions: () => {
      const saved = (conn.state as Record<string, unknown> | null)?.[SUBSCRIPTIONS_KEY]
      return Array.isArray(saved) ? (saved as Subscription[]) : null
    },
    saveSubscriptions: (subscriptions) =>
      conn.setState((state: unknown) => ({ ...(isRecord(state) ? state : {}), [SUBSCRIPTIONS_KEY]: subscriptions })),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
