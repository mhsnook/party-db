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
//   const authorize = async (req: Request, kind: AuthKind) => {
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

type Awaitable<T> = T | Promise<T>

export type AuthKind = 'connect' | 'write'

// A bare boolean for the common case; the object form lets the owner pick the
// HTTP status and a reason the client sees.
export type AuthDecision = boolean | { ok: boolean; status?: number; error?: string }

export type Authorize = (req: Request, kind: AuthKind) => Awaitable<AuthDecision>

// The hooks gate every party routed through this `routePartykitRequest` call —
// branch on `req.url` inside `authorize` to leave some parties open.
export function authHooks(authorize: Authorize): {
  onBeforeConnect: (req: Request) => Promise<Response | undefined>
  onBeforeRequest: (req: Request) => Promise<Response | undefined>
} {
  return {
    onBeforeConnect: async (req) => {
      const d = await authorize(req, 'connect')
      return isAllowed(d) ? undefined : new Response(rejectionReason(d), { status: rejectionStatus(d) })
    },
    onBeforeRequest: async (req) => {
      // non-writes fall through to the DO (which 404s them); a rejected write is a
      // WriteReject so the client rolls back like any other POST rejection.
      if (req.method !== 'POST') return undefined
      const d = await authorize(req, 'write')
      return isAllowed(d)
        ? undefined
        : Response.json({ error: rejectionReason(d) } satisfies WriteReject, { status: rejectionStatus(d) })
    },
  }
}

export function isAllowed(d: AuthDecision): boolean {
  return typeof d === 'boolean' ? d : d.ok
}

export function rejectionReason(d: AuthDecision): string {
  return (typeof d === 'object' && d.error) || 'unauthorized'
}

export function rejectionStatus(d: AuthDecision): number {
  return (typeof d === 'object' && d.status) || 401
}

// Pull the token out of an `Authorization: Bearer <token>` header, or null.
export function bearer(req: Request): string | null {
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.get('authorization') ?? '')
  return m ? m[1] : null
}
