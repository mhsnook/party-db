// Errors the transport's write path can throw, classified by whether replaying
// the same write could help — mirroring TanStack DB's hierarchy so apps catch
// them alongside everything else from the data layer.
//
//   WriteError      — the server received the write and rejected it (401/409/400).
//                     Non-retriable: replaying the same batch won't change the
//                     verdict. Carries the status + parsed WriteReject.
//   TransportError  — the request never got a response (offline, DNS, reset). A
//                     plain TanStackDBError (NOT NonRetriable), so a retry-aware
//                     layer may re-send. Wraps the underlying error as `cause`.
//   AuthError       — the down-stream (WebSocket) was closed 1008 (policy
//                     violation) by a room-aware auth check. The write path's
//                     verdict for the *down* path: terminal, no reconnect.
//
// Both reach the app intact: the transport throws from the write mutationFn, and
// TanStack rejects the transaction's `isPersisted.promise` with that very
// instance — so `catch (e) { if (e instanceof WriteError) … }` works.

import { NonRetriableError, TanStackDBError } from '@tanstack/db'
import type { WriteReject, WriteRejectCode } from '../protocol.ts'

// The server's verdict on a write (401 → log in, 409 → constraint, 400 → bad
// request). `message` is its human reason; the optimistic mutation already rolled
// back. Non-retriable: a different payload or re-auth is needed, not a replay.
export class WriteError extends NonRetriableError {
  readonly status: number
  readonly channel?: string
  readonly constraint?: string
  // the verdict to branch on when the status alone is ambiguous. `missing-row`
  // is an update whose key matched no row — the row was deleted, or never
  // existed, or your RLS policy makes it invisible (docs/architecture.md §16).
  readonly code?: WriteRejectCode

  constructor(status: number, reject: WriteReject) {
    super(reject.error)
    this.name = 'WriteError'
    this.status = status
    this.channel = reject.channel
    this.constraint = reject.constraint
    this.code = reject.code
  }
}

// The server closed the down-stream WebSocket with 1008 (policy violation) — a
// room-aware auth check rejected the connection (see docs/auth.md §2). party-db
// treats this as terminal: it stops the socket re-dialing (a rejected client
// would otherwise close-reconnect-close in a loop) and hands the app this error
// so it can prompt re-auth. Non-retriable, mirroring the write path's 401: the
// same token won't be accepted on a blind reconnect, a fresh one is needed.
export class AuthError extends NonRetriableError {
  // the WebSocket close code (1008); kept so a consumer can branch on it and to
  // leave room for other policy codes later without changing the type.
  readonly code: number

  constructor(message: string, code = 1008) {
    super(message)
    this.name = 'AuthError'
    this.code = code
  }
}

// The write never reached a verdict (no HTTP response: offline, DNS, reset). A
// plain TanStackDBError — NOT NonRetriable — so a retry-aware layer may re-send.
// We don't auto-retry: the app owns idempotency, since a write that landed before
// the connection dropped would duplicate on a blind re-send. This just makes a
// transport failure distinguishable from a server rejection.
export class TransportError extends TanStackDBError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message)
    this.name = 'TransportError'
    if (options?.cause !== undefined) this.cause = options.cause
  }
}

// Read a non-ok Response into a WriteReject, defensively: the server sends a
// `WriteReject` JSON body for the rejections it controls (400/401/409), but a
// bare 404/500 (or a proxy) may return plain text — fall back to that.
export async function toWriteReject(res: { status: number; text: () => Promise<string> }): Promise<WriteReject> {
  const text = await res.text().catch(() => '')
  try {
    const body = JSON.parse(text)
    if (body && typeof body.error === 'string') return body as WriteReject
  } catch {
    // not JSON — fall through
  }
  return { error: text || `write failed (${res.status})` }
}
