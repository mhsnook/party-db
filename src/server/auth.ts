// The auth seam: one `authorize` check, supplied by the room owner, gating both
// doors into a room — the socket open (read) and the POST (write).
//
// We gate at partyserver's *lobby* (`onBeforeConnect`/`onBeforeRequest` on
// `routePartykitRequest`), which runs in the worker before the request reaches
// the Durable Object. That's the idiomatic Cloudflare/PartyKit place for
// credential auth: a rejected connect is refused with a plain HTTP 401 before the
// WebSocket upgrade, and never wakes the DO. (Authorization that needs per-room DO
// *state* is a separate, in-object concern; this seam is for stateless checks.)
//
//   const authorize = async (req: Request, { kind, party }: AuthContext) => {
//     if (party !== 'PrivateRoom') return true // gate some parties, leave others open
//     const token = bearer(req) ?? new URL(req.url).searchParams.get('token')
//     return (await verify(token, kind)) ? true : { ok: false, status: 401 }
//   }
//   export default {
//     fetch: (req, env) =>
//       routePartykitRequest(req, env, authHooks(authorize))
//         .then((r) => r ?? new Response('not found', { status: 404 })),
//   }
//
// A browser can't set headers on a WS upgrade, so a connect token usually rides in
// the query (`?token=…`) while the POST uses an Authorization header; `authorize`
// gets the raw Request and reads whichever.

import type { WriteReject } from '../protocol.ts'

// The subset of partyserver's `Lobby` we read. Kept structural (not `Lobby<Env>`)
// so the hooks assign to `routePartykitRequest` regardless of the worker's `Env`
// binding type — a `Lobby<Env>` param would otherwise only line up when `Env` is
// `never`.
type ResolvedRoom = { className: string; name: string }

export type AuthKind = 'connect' | 'write'

// The resolved routing context partyserver already knows, handed to `authorize`
// so it can branch per party/room without re-parsing the URL. `party` is the
// Durable Object class name (e.g. `'PrivateRoom'`); `room` is the instance name.
export type AuthContext = { kind: AuthKind; party: string; room: string }

// A bare boolean for the common case; the object form lets the owner pick the
// HTTP status and a reason the client sees.
export type AuthDecision = boolean | { ok: boolean; status?: number; error?: string }

export type Authorize = (req: Request, ctx: AuthContext) => AuthDecision | Promise<AuthDecision>

// The hooks gate every party routed through this `routePartykitRequest` call —
// branch on `ctx.party` inside `authorize` to leave some parties open.
export function authHooks(authorize: Authorize) {
  const decide = async (req: Request, lobby: ResolvedRoom, kind: AuthKind) =>
    normalize(await authorize(req, { kind, party: lobby.className, room: lobby.name }))
  return {
    onBeforeConnect: async (req: Request, lobby: ResolvedRoom) => {
      const v = await decide(req, lobby, 'connect')
      return v.ok ? undefined : new Response(v.error, { status: v.status })
    },
    onBeforeRequest: async (req: Request, lobby: ResolvedRoom) => {
      // non-writes fall through to the DO (which 404s them); a rejected write is a
      // WriteReject so the client rolls back like any other POST rejection.
      if (req.method !== 'POST') return undefined
      const v = await decide(req, lobby, 'write')
      return v.ok ? undefined : Response.json({ error: v.error } satisfies WriteReject, { status: v.status })
    },
  }
}

// Collapse either decision form to a filled-in verdict (defaults: 401 / 'unauthorized').
function normalize(d: AuthDecision): { ok: boolean; status: number; error: string } {
  return typeof d === 'boolean'
    ? { ok: d, status: 401, error: 'unauthorized' }
    : { ok: d.ok, status: d.status ?? 401, error: d.error ?? 'unauthorized' }
}

// Pull the token out of an `Authorization: Bearer <token>` header, or null.
export function bearer(req: Request): string | null {
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.get('authorization') ?? '')
  return m ? m[1] : null
}
