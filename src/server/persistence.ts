// The seam between the transport (onRequest / onConnect) and the storage target.
//
// `onRequest` calls `write` blind to what's underneath: the schema-agnostic blob
// store (v0), structured SQL against your real tables (v1), or D1 later. That's
// the win — going v0 → v1 → D1 is "swap the adapter," not "rewrite onRequest."
//
// The contract is async on purpose. Embedded DO-SQLite is synchronous, but D1 is
// not (its atomic commit is `batch()`), so the interface is async and the DO
// serializes its write → seq → broadcast section (see PartyDbServer) to keep the
// ordering total even when the apply itself awaits.

import type { SequencedBatch, WriteBatch, WriteReject } from '../protocol.ts'

// The writer's verified identity for a single POST, resolved fresh each write by
// the server's `auth` hook and threaded into `write()`. Adapters that can enforce
// identity IN THE DATABASE (Postgres, via Row-Level Security) inject it into the
// write transaction so the user's own RLS policies decide what the write may
// touch; adapters with no RLS (embedded SQLite, D1) ignore it — passing it is a
// no-op there. The library does NOT verify the token; this is only the verified
// OUTPUT of the app's verifier.
//
//  - `claims`: the JWT's verified claims, injected as the transaction-local
//    `request.jwt.claims` setting, so RLS policies and owner-column defaults read
//    `current_setting('request.jwt.claims', true)::json->>'sub'` (PostgREST's
//    convention).
//  - `role`: an optional Postgres role to assume for the transaction, when the
//    app models tenants/users as database roles rather than a claim.
export type WriteIdentity = {
  claims?: Record<string, unknown>
  role?: string
}

// What `classifyError` returns: the client-facing `WriteReject` plus the HTTP
// status the server should answer with. `status` defaults to 409 (a data /
// integrity conflict) when omitted; an adapter sets 403 for an AUTHORIZATION
// denial — Postgres RLS surfaces one as SQLSTATE 42501 — so a forged or
// unauthorized write reads as a normal client rejection, not a conflict.
export type WriteRejection = WriteReject & { status?: number }

// An UPDATE whose key matched no row. Every SQL dialect treats that as a silent
// success, so the adapters raise this instead, and it rolls the POST back like a
// constraint rejection. Why, and how each adapter detects it: architecture §16.
//
// `rejection` is what the writer gets back; `channel`/`key` are absent when the
// adapter cannot tell which op missed (D1's rolled-back batch).
export class MissedUpdateError extends Error {
  readonly rejection: WriteRejection

  constructor(
    readonly channel?: string,
    readonly key?: unknown,
  ) {
    const where = [channel && `channel "${channel}"`, key !== undefined && `key ${JSON.stringify(key)}`].filter(Boolean)
    super(`update matched no row${where.length ? ` (${where.join(', ')})` : ''}`)
    this.name = 'MissedUpdateError'
    this.rejection = { error: this.message, channel, code: 'missing-row', status: 409 }
  }
}

export interface PersistenceAdapter {
  // ensure our own infrastructure exists (the _oplog; the blob tables we own for
  // schema-less collections). It does NOT create your tables.
  init(): void | Promise<void>

  // Apply the WHOLE POST body in one transaction — all batches, all-or-nothing,
  // in the order given (the database judges; we don't re-derive ordering). Each
  // returned batch carries its assigned `seq` and its ops REPLACED by the
  // resolved rows the database actually committed (defaults, generated columns,
  // serials, same-row trigger effects).
  //
  // `identity`, when present, is the writer's verified claims/role for THIS POST.
  // An RLS-capable adapter injects it at the top of the transaction (see
  // `WriteIdentity`); others ignore it.
  write(batches: WriteBatch[], identity?: WriteIdentity): Promise<SequencedBatch[]>

  // Full current state per collection + the latest seq, for a fresh connection.
  // Pass `channel` to snapshot that one collection alone — what a client asks for
  // when a collection re-registers and its rows are gone (docs/architecture.md §8a).
  // An unknown name returns no batches. Ignoring the argument is safe but wasteful:
  // the caller sends only the batch for the channel it asked about.
  snapshot(channel?: string): Promise<SequencedBatch[]>

  // The delta a reconnecting client missed — oplog entries after `since`, in
  // order. Returns `null` when `since` predates what's still retained (compacted
  // away), so the caller must send a fresh snapshot instead of a gappy delta. An
  // empty array is a complete delta (the client missed nothing).
  replaySince(since: number): Promise<SequencedBatch[] | null>

  // Optional: turn a `write()` failure into the client-facing rejection (→ 409),
  // or return `null` to let the server treat it as an internal fault (→ 500). Each
  // engine knows how it phrases a constraint violation — Postgres has a structured
  // SQLSTATE + constraint name, strictly better than a message regex — so
  // classification belongs with the dialect. Adapters that omit this fall back to
  // the server's built-in SQLite-message classifier (embedded + D1). The optional
  // `status` on the result lets the adapter distinguish an integrity conflict
  // (409, the default) from an RLS/authorization denial (403).
  classifyError?(e: unknown): WriteRejection | null

  // Optional boot-time validation of the server's `anonRole` (the anonymous-write
  // latch). Called from `onStart` when `anonRole` is set. An RLS-capable adapter
  // proves the role is real and safe — exists, is assumable from this connection,
  // does NOT bypass RLS — and THROWS with an actionable message if not, so a
  // misconfigured latch fails at boot rather than silently accepting anonymous
  // writes it can't govern. Adapters with no roles/RLS (embedded SQLite, D1) omit it.
  verifyAnonRole?(role: string): Promise<void>
}
