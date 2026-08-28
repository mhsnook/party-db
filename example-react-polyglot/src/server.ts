import { routePartykitRequest } from 'partyserver'
import { PartyDbServer, getTokenFromRequest, type WriteIdentity } from '../../src/server/index.ts'
import { collections } from './collections.ts'
import { migrate } from './migrations/index.ts'

// The whole server: the shared `collections` (which carry their own `access`
// rules) plus `auth` — how to turn a request into a verified writer identity.
//
// 🚧 NOTE: `access` and `ownerColumn` are the PROPOSED per-user surface (cookbook 05
// + postgres-todo.md §5). The base PartyDbServer does not enforce them yet, so in
// this running demo every logged-in member can write every collection — the point
// of the scaffold is the userspace shape and that it typechecks, not the (unbuilt)
// server-side filtering. `auth` is NOT proposed: it ships, and it decides who may
// write at all. See this folder's README.
export class Main extends PartyDbServer {
  collections = collections

  // Resolve the writer's identity, or null for anon. A real app verifies a JWT
  // and returns its claims (see cookbook 08 / recipe 3); the demo shortcuts to
  // "the token IS the uid" so it runs with no JWKS, and rides that uid as `sub`.
  //
  // `auth` returns a `WriteIdentity` — the claims the DATABASE judges the write
  // by — not a bare uid. On this room's embedded SQLite there is no RLS to judge
  // them, so the claims go unread and only the null case bites: an anonymous
  // write is rejected 401, which App.tsx shows as "Log in to save your progress."
  // Once the framework enforces owner/access, this is the single seam that drives
  // every read filter and the write gate.
  auth = (req: Request): WriteIdentity | null => {
    const uid = getTokenFromRequest(req)
    return uid ? { claims: { sub: uid } } : null
  }

  onStart() {
    migrate(this.ctx.storage.sql) // your tables, your FKs; party-db only CRUDs over them
    return super.onStart()
  }
}

export default {
  fetch: (req: Request, env: unknown) =>
    routePartykitRequest(req, env as never).then((r) => r ?? new Response('not found', { status: 404 })),
}
