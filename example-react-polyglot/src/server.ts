import { routePartykitRequest } from 'partyserver'
import { PartyDbServer, getTokenFromRequest, type WriteIdentity } from '../../src/server/index.ts'
import { collections } from './collections.ts'
import { migrate } from './migrations/index.ts'

// The whole server: the shared `collections` (which carry their own `access`
// rules) plus `auth` — how to turn a request into a verified writer identity.
//
// PartyDbServer enforces `access` and `ownerColumn` (cookbook 05, architecture §17):
// each socket reads only its own user's private rows, and the write gate checks
// every op. `auth` is the one seam it all runs on. See this folder's README.
export class Main extends PartyDbServer {
  collections = collections

  // Resolve the writer's identity, or null for anon. A real app verifies a JWT
  // and returns its claims (see cookbook 08 / recipe 3); the demo shortcuts to
  // "the token IS the uid" so it runs with no JWKS, and rides that uid as `sub`.
  //
  // `auth` returns a `WriteIdentity`, not a bare uid; its `sub` is the uid every
  // read filter and the write gate compare against. An anonymous write to a
  // private collection is rejected 401, which App.tsx shows as "Log in to save
  // your progress." A socket resolves it once, at connect, from `?token=`.
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
