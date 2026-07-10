import { routePartykitRequest } from 'partyserver'
import { PartyDbServer, getTokenFromRequest } from '../../src/server/index.ts'
import { collections } from './collections.ts'
import { migrate } from './migrations/index.ts'

// The whole server: the shared `collections` (which carry their own `access`
// rules) plus `auth` — how to turn a request into a stable user id.
//
// 🚧 NOTE: `access`/`owner`/`auth` are the PROPOSED per-user surface (cookbook 05
// + postgres-todo.md §5). The base PartyDbServer does not enforce them yet, so in
// this running demo every collection behaves as public read/write — the point of
// the scaffold is the userspace shape and that it typechecks, not the (unbuilt)
// server-side filtering. See this folder's README.
export class Main extends PartyDbServer {
  collections = collections

  // Resolve the request's user id, or null for anon. A real app verifies a JWT
  // and reads its `sub` claim (see cookbook 05 / recipe 3); the demo shortcuts to
  // "the token IS the uid" so it runs with no JWKS. Once the framework enforces
  // owner/access, this is the single seam that drives every read filter and the
  // write gate.
  auth = (req: Request): string | null => getTokenFromRequest(req)

  onStart() {
    migrate(this.ctx.storage.sql) // your tables, your FKs; party-db only CRUDs over them
    return super.onStart()
  }
}

export default {
  fetch: (req: Request, env: unknown) =>
    routePartykitRequest(req, env as never).then((r) => r ?? new Response('not found', { status: 404 })),
}
