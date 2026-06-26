// The auth seam. party-db gates two doors into a room: the socket open (controls
// who can READ the room) and the POST (controls who can WRITE it). Both run the
// SAME pluggable check, so the room owner supplies authorization once and it
// covers reads and writes.
//
// We gate at partyserver's *lobby* — the `onBeforeConnect` / `onBeforeRequest`
// hooks on `routePartykitRequest`, which run in the worker BEFORE the request is
// routed to the Durable Object. This is the idiomatic Cloudflare/PartyKit place
// for token/session auth: a rejected connect gets a clean HTTP 401 *before* the
// WebSocket upgrade (not an accepted-then-closed socket), and a rejected request
// never wakes the DO. Authorization that needs per-room DO *state* is a different
// problem — do that inside the object; this seam is for stateless credential
// checks, which is what item 5 asks for.
//
// Wire it into your worker:
//
//   import { routePartykitRequest } from 'partyserver'
//   import { authHooks, bearer } from 'party-db/server'
//
//   const authorize = async (req: Request, kind: AuthKind) => {
//     const token = bearer(req) ?? new URL(req.url).searchParams.get('token')
//     return (await verify(token, kind)) ? true : { ok: false, status: 401 }
//   }
//
//   export default {
//     fetch: (req, env) =>
//       routePartykitRequest(req, env, authHooks(authorize))
//         .then((r) => r ?? new Response('not found', { status: 404 })),
//   }
//
// Browsers can't set headers on a WebSocket upgrade, so for the `connect` door a
// token usually rides in the query string (`?token=…`); the POST door can use an
// Authorization header. `authorize` is handed the raw Request either way.

import type { WriteReject } from '../protocol.ts'

type Awaitable<T> = T | Promise<T>

// Which door is being authorized: the socket open (read) or a POST (write).
export type AuthKind = 'connect' | 'write'

// What `authorize` returns. A bare boolean is the common case; the object form
// lets the owner pick the HTTP status and a reason the client can see.
export type AuthDecision = boolean | { ok: boolean; status?: number; error?: string }

// The one check the room owner supplies, gating both doors.
export type Authorize = (req: Request, kind: AuthKind) => Awaitable<AuthDecision>

// Build the partyserver lobby hooks from one `authorize` check. The hooks apply
// to every party routed through this `routePartykitRequest` call — branch on
// `req.url` inside `authorize` if you mix public and private parties.
export function authHooks(authorize: Authorize): {
  onBeforeConnect: (req: Request) => Promise<Response | undefined>
  onBeforeRequest: (req: Request) => Promise<Response | undefined>
} {
  return {
    // the socket open (read). A rejection short-circuits the upgrade with a plain
    // HTTP response — the client never gets a 101, never sees a snapshot.
    onBeforeConnect: async (req) => {
      const d = await authorize(req, 'connect')
      return isAllowed(d) ? undefined : new Response(rejectionReason(d), { status: rejectionStatus(d) })
    },
    // the POST (write). Non-writes fall through to the DO (which 404s them); a
    // rejected write returns a WriteReject so the client rolls its optimistic
    // mutation back like any other POST rejection.
    onBeforeRequest: async (req) => {
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

// The rejection reason. Never leaks more than the owner chose to put in `error`;
// defaults to a generic message.
export function rejectionReason(d: AuthDecision): string {
  return (typeof d === 'object' && d.error) || 'unauthorized'
}

// The HTTP status for a rejection (the object form may override; default 401).
export function rejectionStatus(d: AuthDecision): number {
  return (typeof d === 'object' && d.status) || 401
}

// Convenience for the common bearer-token case: pull the token out of the
// Authorization header (`Authorization: Bearer <token>`), or null if absent.
export function bearer(req: Request): string | null {
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.get('authorization') ?? '')
  return m ? m[1] : null
}
