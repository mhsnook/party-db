// The auth seam. party-db gates two doors into a room: the socket open
// (`onConnect` — controls who can READ the room) and the POST (`onRequest` —
// controls who can WRITE it). Both run the SAME pluggable check, so the room
// owner supplies authorization once and it covers reads and writes.
//
// Default is open — v0 behavior: any client can read the whole room and write to
// it. Lock a room down by overriding `PartyDbServer.authorize`:
//
//   protected async authorize(req: Request, kind: AuthKind) {
//     const token = bearer(req) ?? new URL(req.url).searchParams.get('token')
//     if (!token) return { ok: false, error: 'missing token' }
//     return (await this.verify(token, kind)) ? true : { ok: false, status: 403 }
//   }
//
// Browsers can't set headers on a WebSocket upgrade, so for the `connect` door a
// token usually rides in the query string (`?token=…`); the POST door can use an
// Authorization header. `authorize` is handed the raw Request either way — it is
// the owner's call where to read the credential from. The check runs *before* any
// snapshot is sent or any body is parsed, so an unauthorized peer learns nothing.

// Which door is being authorized: the socket open (read) or a POST (write).
export type AuthKind = 'connect' | 'write'

// What `authorize` returns. A bare boolean is the common case; the object form
// lets the owner pick the HTTP status (POST) and a reason the client can see.
export type AuthDecision = boolean | { ok: boolean; status?: number; error?: string }

export function isAllowed(d: AuthDecision): boolean {
  return typeof d === 'boolean' ? d : d.ok
}

// The rejection reason. Never leaks more than the owner chose to put in `error`;
// defaults to a generic message.
export function rejectionReason(d: AuthDecision): string {
  return (typeof d === 'object' && d.error) || 'unauthorized'
}

// The HTTP status for a rejected POST (the object form may override; default 401).
export function rejectionStatus(d: AuthDecision): number {
  return (typeof d === 'object' && d.status) || 401
}

// Convenience for the common bearer-token case: pull the token out of the
// Authorization header (`Authorization: Bearer <token>`), or null if absent.
export function bearer(req: Request): string | null {
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.get('authorization') ?? '')
  return m ? m[1] : null
}
