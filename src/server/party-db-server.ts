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
//
// Everything below `onConnect`/`onRequest` lives in `PartyDbCore` (core.ts): this
// class only builds the core over the DO's storage and hands it the lifecycle
// events. A host that cannot subclass — it already extends another partyserver
// `Server` — holds a `PartyDbCore` itself and does the same wiring (§15).

import { Server, type Connection, type ConnectionContext, type WSMessage } from 'partyserver'
import type { SequencedBatch, WriteBatch } from '../protocol.ts'
import type { PartyCollection } from '../schema.ts'
import type { PersistenceAdapter, WriteIdentity } from './persistence.ts'
import { SqliteAdapter, type SqlEngine } from './sqlite-adapter.ts'
import { PartyDbCore, DEFAULT_MAX_WRITE_BYTES, DEFAULT_MAX_WRITE_OPS } from './core.ts'

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
      broadcast: (message) => this.broadcast(message),
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
    })
    await this.core.init()
  }

  onConnect(conn: Connection, ctx: ConnectionContext): Promise<void> {
    return this.core.connect((message) => conn.send(message), ctx.request.url)
  }

  // The one frame a client sends up the socket: `{ snapshot: <channel> }`, from a
  // collection that registered a second time (docs/architecture.md §8a). The core
  // answers this connection alone; anything else it drops.
  //
  // Serving your own socket traffic from the same room? Override this and chain —
  // `return super.onMessage(conn, message)` — the way `onStart` does above. An
  // override that doesn't chain leaves a re-registered collection empty.
  onMessage(conn: Connection, message: WSMessage): Promise<void> {
    return this.core.handleMessage((reply) => conn.send(reply), message)
  }

  // controlled mode writes come over HTTP, not the (hibernating) socket.
  onRequest(req: Request): Promise<Response> {
    return this.core.handleWrite(req)
  }

  // The write → seq → broadcast section, for a row the server itself authors
  // (docs/architecture.md §14). Delegates to the core, which documents the
  // ordering and layering properties in full.
  protected commit(batches: WriteBatch[], identity?: WriteIdentity): Promise<SequencedBatch[]> {
    return this.core.commit(batches, identity)
  }
}
